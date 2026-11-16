import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseOutput, type ProcessOutput } from "../src/agent.js";
import { judge, parsePath, select } from "../src/check.js";
import { loadConfig, parseDsn, readDsn, saveDsn } from "../src/config.js";
import { launch } from "../src/server.js";
import { loadTasks, taskSetHash, writeHeldOut } from "../src/tasks.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-eval-unit-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const SEED = [
  { id: "top", prompt: "Most friction on {server} last week?", check: { tool: "top_friction_by_tool", args: { vendor_id: "{vendor_id}", window_days: 7 }, reply_contains: "rows[0].label" }, held_out: false },
  { id: "gaps", prompt: "What to build next on {server}?", check: { tool: "top_gaps_clustered", args: { vendor_id: "{vendor_id}" }, reply_contains_any: "rows[:3].label" } },
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
    expect(gaps?.check.reply_contains_any).toBe("rows[:3].label");
    expect(gaps).not.toHaveProperty("held_out");
  });

  it("names a placeholder with no value", () => {
    expect(() => loadTasks(writeTasks(SEED), { server: "Baton" })).toThrow("{vendor_id}");
  });

  it.each([
    [{ ...SEED[0], id: "has space" }, "id must be"],
    [{ ...SEED[0], check: { tool: "t", args: {} } }, "exactly one of"],
    [{ ...SEED[0], check: { tool: "t", reply_contains: null, reply_contains_any: "rows[:3].label" } }, "exactly one of"],
    [{ ...SEED[0], check: { tool: "t", reply_contains: 0 } }, "exactly one of"],
    [{ ...SEED[0], held_out: "yes" }, "held_out"],
    [{ ...SEED[0], check: { ...SEED[0]!.check, reply_contains: "rows[0]label" } }, "cannot read the check path"],
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
    expect(select({ rows: "x" }, "rows[0].label")).toBeUndefined();
  });

  it.each(["rows[0]..label", "rows[0]label", ".rows", "rows[-1].label", "rows.[0]", "", "a[:2].b[:2].c"])("refuses the path %j", (bad) => {
    expect(() => parsePath(bad)).toThrow();
  });

  const call = (result: unknown) => async () => result;

  it("passes when the reply holds the value, ignoring case and spacing", async () => {
    const check = { tool: "t", args: {}, reply_contains: "rows[0].label" };
    expect(await judge(check, "It is search  docs.", call(data))).toEqual({ outcome: "pass" });
    expect(await judge(check, "No idea.", call(data))).toEqual({ outcome: "fail" });
  });

  it("matches whole words only", async () => {
    const label = { tool: "t", args: {}, reply_contains: "rows[0].label" };
    expect(await judge(label, "I'm running it", call({ rows: [{ label: "run" }] }))).toEqual({ outcome: "fail" });
    expect(await judge(label, "Use `run`.", call({ rows: [{ label: "run" }] }))).toEqual({ outcome: "pass" });
    expect(await judge(label, "Use search_docs_v2", call({ rows: [{ label: "search_docs" }] }))).toEqual({ outcome: "fail" });
  });

  it.each([5, 0.5, true, false, "5", "1,500", "2026-11-16"])("is short for the value %j, which has no letter to look for", async (value) => {
    const check = { tool: "t", args: {}, reply_contains: "x" };
    expect((await judge(check, String(value), call({ x: value }))).outcome).toBe("short");
  });

  it.each([
    ["v2", "use v2.", "pass"],
    ["v2", "use v20.", "fail"],
    ["search_docs", "search_docs, then run_query", "pass"],
    ["search_docs", "the search_docs-related errors", "pass"],
    ["क", "कि", "fail"],
  ])("matches the text %j in %j: %s", async (value, reply, outcome) => {
    const check = { tool: "t", args: {}, reply_contains: "x" };
    expect(await judge(check, reply, call({ x: value }))).toEqual({ outcome });
  });

  it("reads keys with dashes", async () => {
    const check = { tool: "t", args: {}, reply_contains: "rows[0].is-open" };
    expect(await judge(check, "It is search_docs.", call({ rows: [{ "is-open": "search_docs" }] }))).toEqual({ outcome: "pass" });
  });

  it("passes reply_contains_any on any of the values, and is short if one has no letter", async () => {
    const check = { tool: "t", args: {}, reply_contains_any: "rows[:3].label" };
    expect(await judge(check, "mostly RUN_QUERY", call(data))).toEqual({ outcome: "pass" });
    expect(await judge(check, "It’s new", call({ rows: [{ label: "it's new" }] }))).toEqual({ outcome: "pass" });
    expect((await judge(check, "the top one is 404", call({ rows: [{ label: "404" }, { label: "timeout" }] }))).outcome).toBe("short");
  });

  it("is short, never a pass, when there is nothing to look for or the call fails", async () => {
    const check = { tool: "t", args: {}, reply_contains: "rows[0].label" };
    expect((await judge(check, "anything", call({ rows: [] }))).outcome).toBe("short");
    expect((await judge(check, "anything", call({ rows: [{ label: "  " }] }))).outcome).toBe("short");
    const any = { tool: "t", args: {}, reply_contains_any: "rows[:3].label" };
    expect((await judge(any, "anything", call({ rows: [] }))).outcome).toBe("short");
    const failing = async () => {
      throw new Error("down");
    };
    expect(await judge(check, "anything", failing)).toMatchObject({ outcome: "short", reason: expect.stringContaining("down") });
    expect((await judge({ tool: "t", args: {}, reply_contains: "rows[0]..x" }, "anything", call(data))).outcome).toBe("short");
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
