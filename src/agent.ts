import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { launch, type ServerStart } from "./server.js";
import { isObject, tryParseJson } from "./util.js";

/** How the agent stopped. The runner turns all but `ok` into fail or short; the Console judges an `ok` run whose check worked. */
type Stop = "ok" | "over_budget" | "no_server" | "error";

export interface AgentRun {
  stop: Stop;
  detail?: string | undefined;
  reply: string;
  seconds: number;
  costUsd?: number | undefined;
  turns?: number | undefined;
  /** The model the agent reports, which resolves an alias such as "haiku". */
  model?: string | undefined;
  /** Settles once the server has exited and so sent its last events, or was killed. */
  serverExited?: Promise<void> | undefined;
}

export interface Agent {
  readonly name: string;
  readonly model: string;
  run(prompt: string, server: ServerStart): Promise<AgentRun>;
}

interface ClaudeCodeOptions {
  model: string;
  maxBudgetUsd: number;
  binary?: string | undefined;
  timeoutMs?: number | undefined;
  exitGraceMs?: number | undefined;
}

/** Claude Code with no screen, no user settings, no built-in tools, and only the server under test. */
export class ClaudeCode implements Agent {
  readonly name = "claude-code";
  readonly model: string;

  constructor(private readonly options: ClaudeCodeOptions) {
    this.model = options.model;
  }

  async run(prompt: string, server: ServerStart): Promise<AgentRun> {
    // Tool names are mcp__<name>__<tool>, so the name must not hold other characters.
    const name = server.name.replace(/[^A-Za-z0-9_-]/g, "_");
    const { command, args: launchArgs, env } = launch(server, { shieldSignals: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-eval-"));
    try {
      const configPath = path.join(dir, "mcp.json");
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { [name]: { command, args: launchArgs } } }));
      const workdir = path.join(dir, "work");
      fs.mkdirSync(workdir);
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--mcp-config",
        configPath,
        "--allowedTools",
        `mcp__${name}__*`,
        "--tools",
        "",
        "--setting-sources",
        "",
        "--model",
        this.options.model,
        "--max-budget-usd",
        String(this.options.maxBudgetUsd),
        "--no-session-persistence",
        "--disable-slash-commands",
      ];
      const started = Date.now();
      // The prompt goes on stdin, where one starting with "-" can't be read as a flag.
      // The test DSN reaches the server through the environment, never a file or argv (runner.test.ts: "starts Claude Code isolated").
      const output = await runProcess(this.options.binary ?? "claude", args, prompt, {
        cwd: workdir,
        env,
        timeoutMs: this.options.timeoutMs ?? 10 * 60_000,
        exitGraceMs: this.options.exitGraceMs,
      });
      return { ...parseOutput(output, name, (Date.now() - started) / 1000), serverExited: output.serverExited };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

export interface ProcessOutput {
  init?: Record<string, unknown> | undefined;
  result?: Record<string, unknown> | undefined;
  stderrTail: string;
  code: number | null;
  timedOut: boolean;
  spawnError?: string | undefined;
  serverExited?: Promise<void> | undefined;
}

const STDERR_TAIL = 2000;
/** Time a server gets to send its last events after the agent exits. */
const EXIT_GRACE_MS = 10_000;

const running = new Set<() => void>();
const shuttingDown = new Set<Promise<void>>();

/** Kills every agent run in flight, and any server still in its grace period. */
export function killActiveRuns(): void {
  for (const kill of running) kill();
}

/** Waits for servers in their grace period to exit, killing any still there when it ends. */
export async function finishLeftovers(): Promise<void> {
  await Promise.all(shuttingDown);
}

function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Keeps only the init and result events, so a chatty run doesn't fill memory. */
function runProcess(
  binary: string,
  args: string[],
  input: string,
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; exitGraceMs?: number | undefined },
): Promise<ProcessOutput> {
  return new Promise((resolve) => {
    // Its own process group, so a timeout also kills the server and anything else it started.
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const output: ProcessOutput = { stderrTail: "", code: null, timedOut: false };
    let groupKilled = false;
    const killGroup = () => {
      if (groupKilled) return;
      const alive = groupAlive(child.pid);
      groupKilled = true;
      running.delete(killGroup);
      // Once the group is gone its id may be reused, so it is never signalled again.
      if (!alive) return;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    running.add(killGroup);
    const timer = setTimeout(() => {
      output.timedOut = true;
      killGroup();
    }, options.timeoutMs);
    // The server may still be sending its last events after the agent exits.
    // The group stays in `running` until then, so Ctrl-C still reaches it.
    const onExit = () => {
      clearTimeout(timer);
      const deadline = Date.now() + (options.exitGraceMs ?? EXIT_GRACE_MS);
      const done = (async () => {
        while (!groupKilled && groupAlive(child.pid) && Date.now() < deadline) await sleep(100);
        killGroup();
      })();
      output.serverExited = done;
      shuttingDown.add(done);
      void done.finally(() => shuttingDown.delete(done));
    };
    const settle = (extra: Partial<ProcessOutput>) => {
      clearTimeout(timer);
      resolve({ ...output, ...extra });
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = tryParseJson(line);
      if (!isObject(event)) return;
      if (event.type === "system" && event.subtype === "init") output.init = event;
      if (event.type === "result") output.result = event;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      output.stderrTail = (output.stderrTail + chunk).slice(-STDERR_TAIL);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", (error) => {
      killGroup();
      settle({ spawnError: error.message });
    });
    child.on("exit", onExit);
    child.on("close", (code) => settle({ code }));
  });
}

export function parseOutput(output: ProcessOutput, serverName: string, seconds: number): AgentRun {
  const base = { reply: "", seconds };
  if (output.spawnError) return { ...base, stop: "error", detail: `could not start the agent: ${output.spawnError}` };
  if (output.timedOut) return { ...base, stop: "error", detail: "the agent ran past its time limit" };
  const { init, result } = output;
  if (!result) {
    const detail = output.stderrTail.trim().split("\n").slice(-3).join(" ") || `exit code ${output.code}`;
    return { ...base, stop: "error", detail: `the agent gave no result: ${detail}` };
  }
  const run = {
    ...base,
    costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
    turns: typeof result.num_turns === "number" ? result.num_turns : undefined,
    model: typeof init?.model === "string" ? init.model : undefined,
  };
  const servers = Array.isArray(init?.mcp_servers) ? init.mcp_servers.filter(isObject) : [];
  const status = servers.find((s) => s.name === serverName)?.status;
  if (status !== "connected") {
    return { ...run, stop: "no_server", detail: `the server did not connect (status: ${typeof status === "string" ? status : "not reported"})` };
  }
  if (result.subtype === "error_max_budget_usd") return { ...run, stop: "over_budget" };
  if (result.is_error === true || typeof result.result !== "string") {
    const text = typeof result.result === "string" ? `: ${result.result.slice(0, 200)}` : "";
    return { ...run, stop: "error", detail: `the agent stopped with an error (${String(result.subtype)})${text}` };
  }
  return { ...run, stop: "ok", reply: result.result };
}
