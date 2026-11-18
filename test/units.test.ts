import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseOutput, type ProcessOutput } from "../src/agent.js";
import { parsePath, runCheck, select } from "../src/check.js";
import { loadConfig, parseDsn, readDsn, saveDsn } from "../src/config.js";
import { launch } from "../src/server.js";
import { loadTasks, pickHeldOut, taskSetHash, writeHeldOut } from "../src/tasks.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-eval-unit-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const SEED = [
  { id: "top", prompt: "Most friction on {server} last week?", check: { tool: "top_friction_by_tool", args: { vendor_id: "{vendor_id}", window_days: 7 }, answer: "rows[0].label" }, held_out: false },
  { id: "gaps", prompt: "What to build next on {server}?", check: { tool: "top_gaps_clustered", args: { vendor_id: "{vendor_id}" } } },
];
const PLACEHOLDERS = { server: "Baton", vendor_id: "baton-mcp" };

function writeTasks(tasks: unknown[]): string {
  const file = path.join(dir, "tasks.jsonl");
  fs.writeFileSync(file, tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
  return file;
}

describe("tasks", () => {
  it("loads the seed format and fills placeholders in the prompt and the check's arguments", () => {
    const [top, gaps] = loadTasks(writeTasks(SEED), PLACEHOLDERS);
    expect(top).toMatchObject({ prompt: "Most friction on Baton last week?", held_out: false, tools: ["top_friction_by_tool"] });
    expect(top?.check.args).toEqual({ vendor_id: "baton-mcp", window_days: 7 });
    expect(top?.check.answer).toBe("rows[0].label");
    expect(gaps?.check).not.toHaveProperty("answer");
    expect(gaps).not.toHaveProperty("held_out");
  });

  it("names a placeholder with no value", () => {
    expect(() => loadTasks(writeTasks(SEED), { server: "Baton" })).toThrow("{vendor_id}");
  });

  it.each([
    [{ ...SEED[0], id: "has space" }, "id must be"],
    [{ ...SEED[0], check: { tool: "t", reply_contains: "rows[0].label" } }, "are gone"],
    [{ ...SEED[0], check: { tool: "t", reply_contains_any: "rows[:3].label" } }, "are gone"],
    [{ ...SEED[0], check: { tool: "t", answer: 0 } }, "check.answer must be"],
    [{ ...SEED[0], held_out: "yes" }, "held_out"],
    [{ ...SEED[0], check: { ...SEED[0]!.check, answer: "rows[0]label" } }, "cannot read the check path"],
    [{ ...SEED[0], prompt: "{server}" + "x".repeat(3996) }, "over 4000"],
    [{ ...SEED[0], check: { tool: "t", args: { q: "x".repeat(20_000) } } }, "top's check.args is over 20000"],
  ])("refuses a bad task", (bad, message) => {
    expect(() => loadTasks(writeTasks([bad]), PLACEHOLDERS)).toThrow(message);
  });

  it("refuses a repeated id", () => {
    expect(() => loadTasks(writeTasks([SEED[0], SEED[0]]), PLACEHOLDERS)).toThrow("twice");
  });

  it("writes the held-out pick back without changing the task set hash", () => {
    const file = writeTasks(SEED);
    const before = taskSetHash(loadTasks(file, PLACEHOLDERS));
    writeHeldOut(file, ["gaps"]);
    const after = loadTasks(file, PLACEHOLDERS);
    expect(after.map((t) => t.held_out)).toEqual([false, true]);
    expect(taskSetHash(after)).toBe(before);
    expect(fs.readFileSync(file, "utf8")).toContain("{vendor_id}");
  });

  it("takes a prompt of 4000 characters, counted as the Console counts them", () => {
    expect(loadTasks(writeTasks([{ ...SEED[0], prompt: "😀".repeat(4000) }]), PLACEHOLDERS)).toHaveLength(1);
  });

  it("picks 1 in 5 tasks to hold out, at least 1, only when the file marks none", () => {
    const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, prompt: "p", check: { tool: "x" } }));
    expect(pickHeldOut(writeTasks(tasks(1)))).toEqual([]);
    expect(pickHeldOut(writeTasks(tasks(2)))).toHaveLength(1);
    expect(pickHeldOut(writeTasks(tasks(14)))).toHaveLength(2);
    expect(pickHeldOut(writeTasks(tasks(14)))).toEqual(pickHeldOut(writeTasks(tasks(14))));
    expect(pickHeldOut(writeTasks([...tasks(9), { id: "x", prompt: "p", check: { tool: "x" }, held_out: false }]))).toEqual([]);
    expect(pickHeldOut(path.join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("changes the hash when a task's content changes, whatever the order", () => {
    const hash = taskSetHash(loadTasks(writeTasks(SEED), PLACEHOLDERS));
    expect(taskSetHash(loadTasks(writeTasks([SEED[1], SEED[0]]), PLACEHOLDERS))).toBe(hash);
    expect(taskSetHash(loadTasks(writeTasks([{ ...SEED[0], prompt: "other" }, SEED[1]]), PLACEHOLDERS))).not.toBe(hash);
  });
});

describe("check", () => {
  const data = { rows: [{ label: "Search Docs" }, { label: "run_query" }, { label: "" }, { label: "x" }] };

  it("reads one value or the first n", () => {
    expect(select(data, "rows[0].label")).toBe("Search Docs");
    expect(select(data, "rows[:3].label")).toEqual(["Search Docs", "run_query", ""]);
    expect(select({ rows: [{ label: "a" }, {}, { label: null }] }, "rows[:3].label")).toEqual(["a", null]);
    expect(select({ rows: "x" }, "rows[0].label")).toBeUndefined();
  });

  it.each(["rows[0]..label", "rows[0]label", ".rows", "rows[-1].label", "rows.[0]", "", "a[:2].b[:2].c"])("refuses the path %j", (bad) => {
    expect(() => parsePath(bad)).toThrow();
  });

  const call = (result: unknown) => async () => result;
  const check = { tool: "t", args: { a: 1 }, answer: "rows[0].label" };

  it("sends the call's result and the value at the answer path", async () => {
    expect(await runCheck(check, call(data))).toEqual({ ...check, result: data, picked: "Search Docs" });
    expect(await runCheck({ ...check, answer: "rows[:3].label" }, call(data))).toMatchObject({ picked: ["Search Docs", "run_query"] });
    expect(await runCheck({ tool: "t", args: {} }, call(data))).toEqual({ tool: "t", args: {}, result: data });
  });

  it("fails a check whose path found nothing, or only blank values", async () => {
    for (const label of [null, "", "  "]) {
      const result = { rows: [{ label }, { label: null }] };
      expect(await runCheck(check, call(result))).toEqual({ ...check, result, error: "rows[0].label found only blank values" });
      expect(await runCheck({ ...check, answer: "rows[:2].label" }, call(result))).toMatchObject({ error: "rows[:2].label found only blank values" });
    }
    for (const result of [{ rows: [] }, { rows: "x" }, {}]) {
      expect(await runCheck(check, call(result))).toEqual({ ...check, result, error: "rows[0].label found nothing in the result" });
    }
    expect(await runCheck({ ...check, answer: "rows[:3].label" }, call({ rows: [] }))).toHaveProperty("error");
    expect(await runCheck({ ...check, answer: "rows[:3].label" }, call({ rows: [{}] }))).toHaveProperty("error");
  });

  it("fails the check, without a result, when its call fails", async () => {
    const failing = async () => {
      throw new Error("down");
    };
    expect(await runCheck(check, failing)).toEqual({ ...check, error: "the check call failed: down" });
  });
});

describe("parseOutput", () => {
  const output = (file: string): ProcessOutput => {
    const events = fs.readFileSync(path.join(fixtures, file), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    return { init: events.find((e) => e.type === "system"), result: events.find((e) => e.type === "result"), stderrTail: "", code: 0, timedOut: false };
  };

  it("reads a real Claude Code run whose server connected", () => {
    expect(parseOutput(output("claude-connected.jsonl"), "probe", 2)).toMatchObject({ stop: "ok", reply: expect.stringContaining("Hi"), turns: 1, model: "claude-haiku-5-5" });
  });

  it("reports no server when the server failed, though Claude Code says success", () => {
    expect(parseOutput(output("claude-server-failed.jsonl"), "probe", 2)).toMatchObject({ stop: "no_server", detail: expect.stringContaining("did not connect") });
  });

  it("keeps the error text when Claude Code flags an error under a success subtype", () => {
    const run = output("claude-connected.jsonl");
    run.result = { ...run.result, is_error: true, result: "API Error: 529 overloaded" };
    expect(parseOutput(run, "probe", 1)).toMatchObject({ stop: "error", detail: expect.stringContaining("529 overloaded") });
  });

  it("reports an error when there is no result, a timeout, or the agent can't start", () => {
    const empty = { stderrTail: "", code: null, timedOut: false };
    expect(parseOutput({ ...empty, stderrTail: "Invalid API key\n", code: 1 }, "p", 1).detail).toContain("Invalid API key");
    expect(parseOutput({ ...empty, timedOut: true }, "p", 1).detail).toContain("time limit");
    expect(parseOutput({ ...output("claude-connected.jsonl"), timedOut: true }, "p", 1)).toMatchObject({ stop: "error", detail: expect.stringContaining("time limit") });
    expect(parseOutput({ ...empty, spawnError: "ENOENT" }, "p", 1).detail).toContain("ENOENT");
  });
});

describe("config and credentials", () => {
  const DSN = "https://baton_tk_abc123@ingest.example.com/ten_0123abcd/baton-mcp";

  it("saves the test DSN in a file only its owner can read, and reads it back", () => {
    const file = path.join(dir, "cfg", "credentials");
    saveDsn(parseDsn(DSN, "baton-mcp"), file);
    saveDsn(parseDsn(DSN.replace("baton-mcp", "other"), "other"), file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readDsn("baton-mcp", file)).toEqual({ raw: DSN, origin: "https://ingest.example.com", key: "baton_tk_abc123", server: "baton-mcp" });
    expect(readDsn("other", file).server).toBe("other");
  });

  it("tightens an existing credentials file to 600", () => {
    const file = path.join(dir, "credentials");
    fs.writeFileSync(file, "", { mode: 0o644 });
    saveDsn(parseDsn(DSN, "baton-mcp"), file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("won't replace a different saved DSN for the same server without --replace-dsn", () => {
    const file = path.join(dir, "credentials");
    saveDsn(parseDsn(DSN, "baton-mcp"), file);
    saveDsn(parseDsn(DSN, "baton-mcp"), file);
    const other = parseDsn(DSN.replace("ten_0123abcd", "ten_99999999"), "baton-mcp");
    expect(() => saveDsn(other, file)).toThrow("--replace-dsn");
    expect(readDsn("baton-mcp", file).raw).toBe(DSN);
    saveDsn(other, file, { replace: true });
    expect(readDsn("baton-mcp", file).raw).toBe(other.raw);
  });

  it.each([
    ['env = { "BATON_DSN" = "v" }', "sets BATON_DSN itself"],
    ['env = { "BAD-NAME" = "v" }', "not a variable name"],
    ['env = { "A" = "${HOME}" }', "${NAME}"],
    ['args = ["--dir=${HOME}"]', "${NAME}"],
    ['cwd = "${HOME}"', "${NAME}"],
  ])("refuses ${NAME} and runner settings in [start]: %s", (line, message) => {
    const file = path.join(dir, "baton-eval.toml");
    fs.writeFileSync(file, `server = "s"\ntasks = "t"\n[start]\ncommand = "x"\n${line}\n[agent]\nmodel = "m"\nmax_budget_usd = 1\n`);
    expect(() => loadConfig(file)).toThrow(message);
  });

  it("refuses a DSN for another server, or one without a key", () => {
    expect(() => parseDsn(DSN, "other")).toThrow("for server baton-mcp");
    expect(() => parseDsn("https://ingest.example.com/ten_0123abcd/baton-mcp", "baton-mcp")).toThrow("must look like");
  });

  it("loads baton-eval.toml with paths relative to it", () => {
    const file = path.join(dir, "baton-eval.toml");
    fs.writeFileSync(
      file,
      `server = "baton-mcp"\ntasks = "evals/tasks.jsonl"\n[start]\ncommand = "uv"\nargs = ["run", "baton-mcp"]\n[agent]\nmodel = "claude-sonnet-5-5"\nmax_budget_usd = 0.5\n[placeholders]\nserver = "Baton"\n`,
    );
    expect(loadConfig(file)).toEqual({
      server: "baton-mcp",
      tasks: path.join(dir, "evals/tasks.jsonl"),
      start: { command: "uv", args: ["run", "baton-mcp"], env: {}, cwd: dir },
      agent: { model: "claude-sonnet-5-5", maxBudgetUsd: 0.5 },
      placeholders: { server: "Baton" },
    });
  });

  it("requires a model, so every run uses the same one", () => {
    const file = path.join(dir, "baton-eval.toml");
    fs.writeFileSync(file, `server = "s"\ntasks = "t"\n[start]\ncommand = "x"\n[agent]\nmax_budget_usd = 1\n`);
    expect(() => loadConfig(file)).toThrow("agent.model");
  });
});

describe("launch", () => {
  it.each([true, false])("runs nothing when the server's directory is missing (shield: %s)", (shieldSignals) => {
    const marker = path.join(dir, "ran");
    const server = { name: "s", command: "touch", args: [marker], cwd: path.join(dir, "missing"), env: { BATON_DISABLED: "1" } };
    const { command, args, env } = launch(server, { shieldSignals });
    expect(spawnSync(command, args, { env }).status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([true, false])("exports the server's variables and runs any command path (shield: %s)", (shieldSignals) => {
    fs.mkdirSync(path.join(dir, "a=b"));
    fs.writeFileSync(path.join(dir, "a=b", "show"), '#!/bin/sh\nprintf "%s|%s" "$FOO" "$BATON_DSN"\n', { mode: 0o755 });
    const server = { name: "s", command: "./a=b/show", args: [], cwd: dir, env: { FOO: "x y=z $HOME", BATON_DSN: "secret" } };
    const { command, args, env } = launch(server, { shieldSignals });
    expect(args.join(" ")).not.toContain("secret");
    expect(spawnSync(command, args, { env, encoding: "utf8" }).stdout).toBe("x y=z $HOME|secret");
  });

  it("gives the server back the INT and TERM handling that sh ignores", () => {
    // Perl reports a signal ignored at startup; Node resets it, so the Node fixture can't show this.
    const show = 'print $SIG{INT} // "default", " ", $SIG{TERM} // "default"';
    const server = { name: "s", command: "perl", args: ["-e", show], cwd: dir, env: {} };
    const { command, args, env } = launch(server, { shieldSignals: true });
    expect(spawnSync(command, args, { env, encoding: "utf8" }).stdout).toBe("default default");
  });
});
