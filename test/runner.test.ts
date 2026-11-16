import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCode, finishLeftovers, killActiveRuns } from "../src/agent.js";
import { callToolOn } from "../src/check.js";
import { ConsoleApi } from "../src/console.js";
import { runExperiment, type RunOptions } from "../src/runner.js";
import type { Task } from "../src/tasks.js";
import { fakeConsole, type FakeConsole } from "./_console.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    prompt: "Which tool has the most friction?",
    check: { tool: "top_friction", args: {}, reply_contains: "rows[0].label" },
    tools: ["top_friction"],
    ...extra,
  };
}

let dir: string;
let consoleFake: FakeConsole | undefined;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-eval-test-"));
  fs.mkdirSync(path.join(dir, "serverdir"));
  process.env.FAKE_CLAUDE_CHILD = path.join(dir, "child.pid");
  process.env.FAKE_CLAUDE_STATE = path.join(dir, "runs");
});

afterEach(async () => {
  await consoleFake?.close();
  consoleFake = undefined;
  process.env = { ...savedEnv };
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(fake: FakeConsole, tasks: Task[], extra: Partial<RunOptions> = {}) {
  const lines: string[] = [];
  const summary = await runExperiment({
    api: new ConsoleApi(fake.origin, fake.key, { retryDelaysMs: [1, 1] }),
    agent: fakeAgent(),
    tasks,
    server: fixtureServer({ FIXTURE_LOG: path.join(dir, "server.log") }),
    dsn: `${fake.origin.replace("://", `://${fake.key}@`)}/ten_0123abcd/fixture`,
    callToolFor: callToolOn,
    log: (line) => lines.push(line),
    loadedPolls: { tries: 2, delayMs: 1 },
    waitMs: 1,
    ...extra,
  });
  return { summary, lines };
}

function fixtureServer(env: Record<string, string> = {}) {
  return { name: "fixture", command: process.execPath, args: [path.join(fixtures, "server.mjs")], cwd: path.join(dir, "serverdir"), env };
}

function fakeAgent(options: { timeoutMs?: number; exitGraceMs?: number } = {}) {
  return new ClaudeCode({ model: "test-model", maxBudgetUsd: 1, binary: path.join(fixtures, "fake-claude.mjs"), ...options });
}

async function childPid(): Promise<number> {
  const file = process.env.FAKE_CLAUDE_CHILD!;
  while (!fs.existsSync(file) || !fs.readFileSync(file, "utf8")) await sleep(50);
  return Number(fs.readFileSync(file, "utf8"));
}

type ServerCall = { candidate?: string; disabled?: string; api?: string; dsn: string; cwd: string };

function serverLog(): ServerCall[] {
  if (!fs.existsSync(path.join(dir, "server.log"))) return [];
  return fs
    .readFileSync(path.join(dir, "server.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ServerCall);
}

describe("runExperiment", () => {
  it("runs each step's tasks under its change and posts one row per run", async () => {
    consoleFake = await fakeConsole({
      steps: [
        { change_id: "chg_base", task_ids: ["a", "b"], runs_per_task: 2, tagged_events: 3 },
        { change_id: "chg_try1", task_ids: ["a"], runs_per_task: 1, tagged_events: 1 },
      ],
      waitsBeforeFirstStep: 1,
    });
    const { summary } = await run(consoleFake, [task("a"), task("b"), task("c", { held_out: true })]);

    expect(summary).toMatchObject({ experimentId: "exp_1", steps: 2, outcomes: { pass: 5, fail: 0, short: 0 } });
    expect(consoleFake.results.map((r) => [r.step, r.task_id, r.run, r.outcome])).toEqual([
      [1, "a", 1, "pass"],
      [1, "a", 2, "pass"],
      [1, "b", 1, "pass"],
      [1, "b", 2, "pass"],
      [2, "a", 1, "pass"],
    ]);
    expect(consoleFake.results[0]).toMatchObject({ agent: "claude-code", model: "test-model-1", cost_usd: 0.01, turns: 2 });
    expect(consoleFake.results[0]).not.toHaveProperty("session_id");

    const started = consoleFake.started[0]!;
    expect(started.tasks).toEqual([
      { id: "a", tools: ["top_friction"] },
      { id: "b", tools: ["top_friction"] },
      { id: "c", held_out: true, tools: ["top_friction"] },
    ]);
    expect(started.task_set_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(started.agents).toEqual(["claude-code:test-model"]);

    const calls = serverLog();
    const agentCalls = calls.filter((c) => c.candidate !== undefined);
    expect(agentCalls.map((c) => c.candidate)).toEqual(["chg_base", "chg_base", "chg_base", "chg_base", "chg_try1"]);
    const checkCalls = calls.filter((c) => c.candidate === undefined);
    expect(checkCalls).toHaveLength(5);
    expect(checkCalls.every((c) => c.disabled === "1")).toBe(true);
    expect(agentCalls.every((c) => c.disabled === undefined)).toBe(true);
    expect(calls.every((c) => c.dsn.includes(consoleFake!.key))).toBe(true);
    expect(new Set(calls.map((c) => fs.realpathSync(c.cwd)))).toEqual(new Set([fs.realpathSync(path.join(dir, "serverdir"))]));
  });

  it("marks every run of a step short when its change did not load, and stops running it", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a", "b"], runs_per_task: 2, tagged_events: 0 }],
    });
    const { summary, lines } = await run(consoleFake, [task("a"), task("b")]);

    expect(consoleFake.results.map((r) => r.outcome)).toEqual(["short", "short", "short", "short"]);
    expect(consoleFake.results[0]).toMatchObject({ cost_usd: 0.01, turns: 2 });
    expect(summary.outcomes.short).toBe(4);
    expect(consoleFake.loadedCalls).toBe(2);
    expect(serverLog()).toHaveLength(2);
    expect(lines.join("\n")).toContain("did not load");
  });

  it("never lets the SDK's settings in the shell reach the server, but passes the server's own", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 1, tagged_events: 1 }],
    });
    process.env.BATON_CANDIDATE = "chg_stale";
    process.env.BATON_DISABLED = "1";
    process.env.BATON_API_BASE_URL = "https://api.example";
    await run(consoleFake, [task("a")]);
    expect(serverLog().map((c) => [c.candidate, c.disabled, c.api])).toEqual([
      ["chg_base", undefined, "https://api.example"],
      [undefined, "1", "https://api.example"],
    ]);
  });

  it.each([
    ["crashed", "crash"],
    ["had no server", "noserver"],
    ["timed out", "hang-after-init"],
  ])("doesn't ask whether the change loaded after a run that %s, but does after the next one", async (_, mode) => {
    consoleFake = await fakeConsole({
      steps: [
        { change_id: "chg_base", task_ids: ["a"], runs_per_task: 1, tagged_events: 1 },
        { change_id: "chg_try1", task_ids: ["a"], runs_per_task: 2, tagged_events: 0 },
      ],
    });
    process.env.FAKE_CLAUDE_MODE = mode;
    process.env.FAKE_CLAUDE_ONLY_RUN = "2";
    await run(consoleFake, [task("a")], { agent: fakeAgent({ timeoutMs: 3000, exitGraceMs: 100 }), loadedPolls: { tries: 1, delayMs: 1 } });
    expect(consoleFake.loadedCalls).toBe(2);
    expect(consoleFake.results.filter((r) => r.step === 2).map((r) => r.outcome)).toEqual(["short", "short"]);
  });

  it.each([
    ["crashes", "crash"],
    ["has no server", "noserver"],
  ])("stops the experiment when its first run %s, before spending more", async (_, mode) => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 3, tagged_events: 1 }],
    });
    process.env.FAKE_CLAUDE_MODE = mode;
    await expect(run(consoleFake, [task("a")])).rejects.toThrow("the first run failed");
    expect(consoleFake.results.map((r) => r.outcome)).toEqual(["short"]);
    expect(fs.readFileSync(process.env.FAKE_CLAUDE_STATE!, "utf8")).toBe("1");
  });

  it("asks whether the change loaded only once the server has sent its last events", async () => {
    const marker = path.join(dir, "flushed");
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 1, tagged_events: 1, taggedOnceExists: marker }],
    });
    await run(consoleFake, [task("a")], {
      server: fixtureServer({ FIXTURE_EXIT_MARKER: marker, FIXTURE_EXIT_DELAY_MS: "1500" }),
      loadedPolls: { tries: 1, delayMs: 1 },
    });
    expect(consoleFake.results.map((r) => r.outcome)).toEqual(["pass"]);
  });

  it("asks whether the change loaded after a connected run that called no tool", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 2, tagged_events: 0 }],
    });
    process.env.FAKE_CLAUDE_MODE = "notool";
    await run(consoleFake, [task("a")]);
    expect(consoleFake.loadedCalls).toBeGreaterThan(0);
    expect(consoleFake.results.map((r) => r.outcome)).toEqual(["short", "short"]);
  });

  it("retries a results post the Console could not take", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 1, tagged_events: 1 }],
      unavailableResults: 2,
    });
    await run(consoleFake, [task("a")]);
    expect(consoleFake.results.map((r) => r.outcome)).toEqual(["pass"]);
  });

  it("stops with a clear error on a next step it doesn't know", async () => {
    consoleFake = await fakeConsole({ steps: [], nextAnswer: { action: "paused" } });
    await expect(run(consoleFake, [task("a")])).rejects.toThrow("not one baton-eval knows");
  });

  it("finishes when the agent exits but leaves a child holding its output open", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 1, tagged_events: 1 }],
    });
    process.env.FAKE_CLAUDE_MODE = "leave-child";
    await run(consoleFake, [task("a")], {
      agent: fakeAgent({ exitGraceMs: 200 }),
    });
    expect(consoleFake.results.map((r) => r.outcome)).toEqual(["pass"]);
    const pid = await childPid();
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it("lets the server finish shutting down after the agent exits", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 1, tagged_events: 1 }],
    });
    const marker = path.join(dir, "flushed");
    await run(consoleFake, [task("a")], {
      server: fixtureServer({ FIXTURE_EXIT_MARKER: marker }),
    });
    await finishLeftovers();
    expect(fs.readFileSync(marker, "utf8")).toContain("flushed chg_base");
  });

  it("doesn't call a finished run timed out while its server shuts down", async () => {
    process.env.FAKE_CLAUDE_MODE = "leave-child";
    const agent = fakeAgent({ timeoutMs: 2000, exitGraceMs: 3000 });
    const result = await agent.run("p", fixtureServer());
    expect(result.stop).toBe("ok");
    await finishLeftovers();
  }, 15_000);

  it("stops a server still in its grace period on request", async () => {
    process.env.FAKE_CLAUDE_MODE = "leave-child";
    const agent = fakeAgent({ exitGraceMs: 60_000 });
    const runPromise = agent.run("p", fixtureServer());
    const pid = await childPid();
    killActiveRuns();
    await runPromise;
    await finishLeftovers();
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it("stops a running agent and everything it started on request", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    const agent = fakeAgent();
    const running = agent.run("p", fixtureServer());
    const pid = await childPid();
    killActiveRuns();
    expect(await running).toMatchObject({ stop: "error" });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kills a stuck agent when time runs out", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    const agent = fakeAgent({ timeoutMs: 1500 });
    const started = Date.now();
    const result = await agent.run("p", fixtureServer());
    expect(result).toMatchObject({ stop: "error", detail: expect.stringContaining("time limit") });
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("scores a wrong reply as fail and the dollar cap as fail", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 1, tagged_events: 1 }],
    });
    process.env.FAKE_CLAUDE_MODE = "wrong";
    await run(consoleFake, [task("a")]);
    expect(consoleFake.results[0]?.outcome).toBe("fail");

    await consoleFake.close();
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 1, tagged_events: 1 }],
    });
    process.env.FAKE_CLAUDE_MODE = "budget";
    await run(consoleFake, [task("a")]);
    expect(consoleFake.results[0]).toMatchObject({ outcome: "fail", cost_usd: 1.02 });
  });

  it("scores a run short when the check finds nothing to look for", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 1, tagged_events: 1 }],
    });
    process.env.FIXTURE_EMPTY = "1";
    await run(consoleFake, [task("a")]);
    expect(consoleFake.results[0]?.outcome).toBe("short");
  });

  it("stops cleanly when the Console says the budget is spent", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 3, tagged_events: 1 }],
      budgetSessions: 2,
    });
    const { summary } = await run(consoleFake, [task("a")]);
    expect(consoleFake.results).toHaveLength(2);
    expect(summary.stoppedFor).toContain("budget");
  });

  it("hands back the Console's held-out pick only when the file marked none", async () => {
    consoleFake = await fakeConsole({ steps: [], heldOut: ["b"] });
    const picked: string[][] = [];
    await run(consoleFake, [task("a"), task("b")], { onHeldOutPicked: (ids) => picked.push(ids) });
    await run(consoleFake, [task("a"), task("b", { held_out: true })], { onHeldOutPicked: (ids) => picked.push(ids) });
    await run(consoleFake, [task("a", { held_out: false }), task("b")], { onHeldOutPicked: (ids) => picked.push(ids) });
    expect(picked).toEqual([["b"]]);
    expect(consoleFake.started[0]!.tasks.map((t) => t.held_out)).toEqual([undefined, undefined]);
  });

  it("warns when no task is held out", async () => {
    consoleFake = await fakeConsole({ steps: [] });
    const { lines } = await run(consoleFake, [task("a", { held_out: false })]);
    expect(lines.join("\n")).toContain("no task is held out");
  });

  it("refuses a step that names a task the file does not have", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["zzz"], runs_per_task: 1, tagged_events: 1 }],
    });
    await expect(run(consoleFake, [task("a")])).rejects.toThrow("task zzz");
  });

  it("starts Claude Code isolated: no settings, no built-in tools, only the server's tools allowed", async () => {
    consoleFake = await fakeConsole({
      steps: [{ change_id: "chg_base", task_ids: ["a"], runs_per_task: 1, tagged_events: 1 }],
    });
    process.env.FAKE_CLAUDE_ARGS = path.join(dir, "args.json");
    await run(consoleFake, [task("a", { prompt: "- Which tool has the most friction?" })]);
    const { args, cwd, prompt, mcpConfig, env } = JSON.parse(fs.readFileSync(path.join(dir, "args.json"), "utf8")) as {
      args: string[];
      cwd: string;
      prompt: string;
      mcpConfig: string;
      env: Record<string, string>;
    };
    expect(prompt).toBe("- Which tool has the most friction?");
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain("--strict-mcp-config");
    expect(after("--tools")).toBe("");
    expect(after("--setting-sources")).toBe("");
    expect(after("--allowedTools")).toBe("mcp__fixture__*");
    expect(after("--max-budget-usd")).toBe("1");
    expect(after("--model")).toBe("test-model");
    expect(args.join(" ")).not.toContain(consoleFake.key);
    expect(mcpConfig).not.toContain(consoleFake.key);
    expect(env.BATON_DSN).toContain(consoleFake.key);
    expect(env).not.toHaveProperty("FIXTURE_LOG");
    expect(env).not.toHaveProperty("BATON_CANDIDATE");
    expect(serverLog()[0]?.candidate).toBe("chg_base");
    expect(cwd).not.toBe(process.cwd());
  });
});
