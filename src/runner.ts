import { setTimeout as sleep } from "node:timers/promises";
import type { Agent, AgentRun } from "./agent.js";
import { runCheck, type CallTool } from "./check.js";
import { ConsoleError, type ConsoleApi, type Outcome, type ResultRow, type RowOutcome, type Step } from "./console.js";
import type { ServerStart } from "./server.js";
import { taskRefs, taskSetHash, type Task } from "./tasks.js";

export interface RunOptions {
  api: ConsoleApi;
  agent: Agent;
  tasks: Task[];
  /** The server's start without the change; the runner adds BATON_DSN, BATON_CANDIDATE and BATON_TASK. */
  server: ServerStart;
  dsn: string;
  callToolFor: (server: ServerStart) => CallTool;
  budgetSessions?: number | undefined;
  /** Called when the Console picked the held-out tasks because the file marked none. */
  onHeldOutPicked?: (ids: string[]) => void;
  log?: (line: string) => void;
  waitMs?: number;
  /** Events reach the Console a little after the run ends, so `loaded` is asked a few times. */
  loadedPolls?: { tries: number; delayMs: number };
}

interface RunSummary {
  experimentId: string;
  steps: number;
  outcomes: Record<Outcome, number>;
  stoppedFor?: string;
}

export async function runExperiment(options: RunOptions): Promise<RunSummary> {
  const log = options.log ?? (() => {});
  const started = await options.api.start({
    tasks: taskRefs(options.tasks),
    task_set_hash: taskSetHash(options.tasks),
    agents: [`${options.agent.name}:${options.agent.model}`],
    budget_sessions: options.budgetSessions,
  });
  const experiment = started.experiment_id;
  log(`experiment ${experiment}: ${options.tasks.length} tasks, budget ${started.budget_sessions} sessions`);
  if (options.tasks.every((t) => t.held_out === undefined) && started.held_out.length > 0) {
    options.onHeldOutPicked?.(started.held_out);
  }
  if (started.held_out.length === 0) log("no task is held out, so the Console can't confirm a change: mark some tasks held_out: true");
  const summary: RunSummary = { experimentId: experiment, steps: 0, outcomes: { pass: 0, fail: 0, short: 0 } };
  try {
    for (;;) {
      const next = await options.api.next(experiment);
      if (next.action === "done") break;
      if (next.action === "wait") {
        await sleep(options.waitMs ?? 5000);
        continue;
      }
      summary.steps += 1;
      await runStep(options, experiment, next, summary, log);
    }
  } catch (error) {
    if (!(error instanceof ConsoleError && error.code === "budget_spent")) throw error;
    summary.stoppedFor = "the experiment's budget is spent";
  }
  return summary;
}

async function runStep(options: RunOptions, experiment: string, step: Step, summary: RunSummary, log: (line: string) => void): Promise<void> {
  log(`step ${step.step}: change ${step.change_id}, ${step.task_ids.length} tasks x ${step.runs_per_task} runs${step.reason ? ` (${step.reason})` : ""}`);
  const testEnv = { ...options.server.env, BATON_DSN: options.dsn };
  // Baton is off for the check's own calls: they must not count as test traffic,
  // make a change look loaded, or become an issue a try targets (runner.test.ts: "runs each step's tasks").
  const callTool = options.callToolFor({ ...options.server, env: { ...testEnv, BATON_DISABLED: "1" } });
  const byId = new Map(options.tasks.map((t) => [t.id, t]));
  const sessions = step.task_ids.flatMap((id) => {
    const task = byId.get(id);
    if (!task) throw new Error(`the Console asked for task ${id}, which is not in the tasks file`);
    return Array.from({ length: step.runs_per_task }, (_, i) => ({ task, run: i + 1 }));
  });
  const post = async (rows: ResultRow[], detail?: string) => {
    const outcomes = await options.api.results(experiment, step.step, rows);
    for (const outcome of outcomes) {
      summary.outcomes[outcome.outcome] += 1;
      log(`  ${describe(outcome)}${detail ? `: ${detail}` : ""}`);
    }
  };

  let loadedChecked = false;
  for (const [index, { task, run }] of sessions.entries()) {
    const server: ServerStart = { ...options.server, env: { ...testEnv, BATON_CANDIDATE: step.change_id, BATON_TASK: task.id } };
    const agentRun = await options.agent.run(task.prompt, server);
    // Only a connected run that ended on its own has sent all its events
    // (runner.test.ts: "doesn't ask whether the change loaded after a run").
    if (!loadedChecked && (agentRun.stop === "ok" || agentRun.stop === "over_budget")) {
      loadedChecked = true;
      await agentRun.serverExited;
      if (!(await changeLoaded(options, experiment, step.step))) {
        log(`  change ${step.change_id} did not load: no events tagged with it. Marking this step's runs short, which ends the experiment.`);
        const notLoaded = { outcome: "short", reason: "not_loaded" } as const;
        const rest = sessions.slice(index + 1).map((s): ResultRow => ({ task_id: s.task.id, run: s.run, ...notLoaded }));
        await post([{ ...runRow(task.id, run, agentRun, options.agent), ...notLoaded }, ...rest]);
        return;
      }
    }
    const row = await resultRow(task, run, agentRun, callTool, options.agent);
    const detail = agentRun.detail ?? row.check?.error;
    // A broken setup would make every run short, at a cost (runner.test.ts: "stops the experiment when its first run").
    if (summary.steps === 1 && index === 0 && row.reason === "crashed") {
      await post([row], detail);
      const hint = agentRun.stop === "no_server" ? "check that [start] in baton-eval.toml starts the server" : "fix the cause above, or run again if it was passing";
      throw new Error(`the first run failed (${agentRun.detail}), so baton-eval stopped before spending more: ${hint}`);
    }
    await post([row], detail);
  }
}

function describe(outcome: RowOutcome): string {
  return `${outcome.task_id} #${outcome.run}: ${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ""}`;
}

/** Sets the outcome only when the runner knows it; the Console judges the rest from the reply and the check. */
async function resultRow(task: Task, run: number, agentRun: AgentRun, callTool: CallTool, agent: Agent): Promise<ResultRow> {
  const row = runRow(task.id, run, agentRun, agent);
  switch (agentRun.stop) {
    case "over_budget":
      return { ...row, outcome: "fail", reason: "dollar_cap" };
    case "no_server":
    case "error":
      return { ...row, outcome: "short", reason: "crashed" };
    case "ok": {
      const check = await runCheck(task.check, callTool);
      return check.error === undefined ? { ...row, check } : { ...row, outcome: "short", reason: "check_failed", check };
    }
  }
}

function runRow(taskId: string, run: number, agentRun: AgentRun, agent: Agent): ResultRow {
  return {
    task_id: taskId,
    run,
    reply: agentRun.reply,
    seconds: Math.round(agentRun.seconds * 10) / 10,
    agent: agent.name,
    model: agentRun.model ?? agent.model,
    cost_usd: agentRun.costUsd,
    turns: agentRun.turns,
  };
}

async function changeLoaded(options: RunOptions, experiment: string, step: number): Promise<boolean> {
  const polls = options.loadedPolls ?? { tries: 6, delayMs: 2500 };
  for (let attempt = 0; attempt < polls.tries; attempt++) {
    if (attempt > 0) await sleep(polls.delayMs);
    if ((await options.api.loaded(experiment, step)) > 0) return true;
  }
  return false;
}
