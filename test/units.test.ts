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
import { ConsoleError, type Status } from "../src/console.js";
import { isReusable, planFix, readLastRun, reuseProblem, withFreshHint, writeLastRun } from "../src/last.js";
import { reportLines } from "../src/report.js";
import { loadTasks, pickHeldOut, taskHashes, taskSetHash, writeHeldOut, type Task } from "../src/tasks.js";

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

describe("reportLines", () => {
  it("reads the Console's real answers", () => {
    const examples = JSON.parse(fs.readFileSync(path.join(fixtures, "status-examples.json"), "utf8")) as Record<string, Status & { experiment_id: string }>;
    const lines = Object.fromEntries(Object.entries(examples).map(([name, status]) => [name, reportLines(status.experiment_id, status)]));
    const token = "c1d549648c43f3fe.29a1af58c1382740";
    expect(lines).toEqual({
      find_found: [
        "experiment exp_pw43kzipgl: found 1 issue",
        `issue 1. ${token} text tool=lookup prod_sessions=0 tasks=b below_bar=no page=${examples.find_found!.issues![0]!.url}: Invalid field_paths: expected a list of strings, got a string`,
      ],
      fix_running_before_baseline: [`experiment exp_iyfkmwuxe5: fix ${token}: no verdict`],
      fix_helped: [`experiment exp_iyfkmwuxe5: fix ${token}: helped; targets 0/10 -> 10/10; guard held; held-out held`],
      fix_no_better: [`experiment exp_sd2urvms7y: fix ${token}: no_better; targets 0/10 -> 0/10; guard none; held-out none`],
      fix_ended: [`experiment exp_irjctmzmwd: fix ${token}: ended (no_task_hits)`],
      find_ended: ["experiment exp_hdwfneiewz: find ended (find_failed)"],
      helped_on_errors: [`experiment exp_twvbbz54it: fix ${token}: helped; targets 10/10 -> 10/10; error 10/10 -> 0/10; guard held; held-out held`],
      waiting_for_calls: [`experiment exp_tsvqczdd3d: fix ${token}: no verdict`],
      errors_null_after_deadline: [`experiment exp_tsvqczdd3d: fix ${token}: no_better; targets 10/10 -> 10/10; guard none; held-out none`],
    });
  });

  const issue = { issue: "a".repeat(16) + "." + "b".repeat(16), tool: "friction_on", error: "invalid day format\nat line 3", fix: "text", prod_sessions: 12, tasks: ["day", "day2"], below_bar: false, url: "https://c/i" };
  const find = (extra: Partial<Status>): Status => ({ kind: "find", state: "done", verdict: "found", reason: null, ...extra });

  it("lists a find's issues, one line each, the error last on one line", () => {
    const quiet = { ...issue, issue: "c".repeat(16) + "." + "d".repeat(16), error: "timeout: 30s", fix: "code", prod_sessions: 0, tasks: [], below_bar: true, url: null };
    expect(reportLines("exp_1", find({ issues: [issue, quiet] }))).toEqual([
      "experiment exp_1: found 2 issues",
      `issue 1. ${issue.issue} text tool=friction_on prod_sessions=12 tasks=day,day2 below_bar=no page=https://c/i: invalid day format`,
      `issue 2. ${quiet.issue} code tool=friction_on prod_sessions=0 tasks=- below_bar=yes page=-: timeout: 30s`,
    ]);
    expect(reportLines("exp_1", find({ issues: [] }))).toEqual(["experiment exp_1: found no issues"]);
    expect(reportLines("exp_1", find({ issues: [{ ...issue, error: "\u001e\n Traceback: bad day\nline 2" }] }))[1]).toMatch(/: Traceback: bad day$/);
    const odd = { ...issue, tool: "my tool\u2028x", tasks: ["day one", "day2"], url: "https://c/a b" };
    expect(reportLines("exp_1", find({ issues: [odd] }))[1]).toContain(" tool=my_tool prod_sessions=12 tasks=day_one,day2 below_bar=no page=https://c/a_b: ");
    expect(reportLines("exp_1", find({ verdict: "ended", reason: "not_loaded" }))).toEqual(["experiment exp_1: find ended (not_loaded)"]);
    expect(reportLines("exp_1", find({ verdict: null }))).toEqual(["experiment exp_1: find ended (done)"]);
    expect(reportLines("exp_1", find({ verdict: "ended", reason: "budget\nissue 1. x" }))).toEqual(["experiment exp_1: find ended (budget)"]);
  });

  it("gives a fix's verdict, with its numbers once judged", () => {
    const fix = (extra: Partial<Status>): Status => ({ kind: "fix", state: "done", verdict: "helped", reason: null, issue: issue.issue, ...extra });
    const result: NonNullable<Status["result"]> = { targets: { before: [3, 10], after: [10, 10] }, guard: { held: true }, held_out: null };
    expect(reportLines("exp_2", fix({ result }))).toEqual([`experiment exp_2: fix ${issue.issue}: helped; targets 3/10 -> 10/10; guard held; held-out none`]);
    const worse = { ...result, guard: { held: false }, held_out: { held: false } };
    expect(reportLines("exp_2", fix({ verdict: "worse", result: worse }))[0]).toMatch(/: worse; targets 3\/10 -> 10\/10; guard dropped; held-out didn't hold$/);
    expect(reportLines("exp_2", fix({ verdict: "ended", reason: "no_task_hits", result: null }))).toEqual([`experiment exp_2: fix ${issue.issue}: ended (no_task_hits)`]);
    const gone = { ...result, targets: { before: [20, 20] as [number, number], after: [20, 20] as [number, number] }, errors: { before: [13, 20] as [number, number], after: [0, 20] as [number, number] } };
    expect(reportLines("exp_2", fix({ result: gone }))).toEqual([`experiment exp_2: fix ${issue.issue}: helped; targets 20/20 -> 20/20; error 13/20 -> 0/20; guard held; held-out none`]);
    expect(reportLines("exp_2", fix({ result: { ...gone, errors: null } }))[0]).toContain("targets 20/20 -> 20/20; guard held");
    expect(reportLines("exp_2", fix({ issue: "a b", verdict: "no better", reason: "x\ny", result: null }))).toEqual(["experiment exp_2: fix a_b: no_better (x)"]);
  });
});

describe("the last run", () => {
  const issue = "0".repeat(16) + "." + "f".repeat(16);
  const t = (id: string, extra: Partial<Task> = {}): Task => ({ id, prompt: "p", check: { tool: "x", args: {} }, tools: ["x"], ...extra });
  const now = (tasks: Task[]) => ({ server: "s", agent: "claude-code:m", tasks: taskHashes(tasks) });
  const last = { experiment_id: "exp_0", ...now([t("a"), t("b")]) };

  it("is reused when tasks were only added, or only held_out changed", () => {
    expect(planFix(issue, false, last, now([t("a"), t("b", { held_out: true }), t("new")]))).toEqual({ issue, from: "exp_0" });
    expect(planFix(undefined, false, last, now([t("a")]))).toBeUndefined();
  });

  it("isn't reused, and names --fresh, when a task changed or went, the agent or server changed, or there is none", () => {
    const cases: [typeof last | undefined, ReturnType<typeof now>, string][] = [
      [undefined, now([t("a")]), "no finished run"],
      [last, now([t("a", { check: { tool: "x", args: { n: 1 } } }), t("b")]), "task a changed"],
      [last, now([t("a", { tools: ["x", "y"] }), t("b")]), "task a changed"],
      [last, now([t("a")]), "task b was removed"],
      [last, { ...now([t("a"), t("b")]), agent: "claude-code:other" }, "now runs claude-code:other"],
      [last, { ...now([t("a"), t("b")]), server: "s2" }, "for server s"],
    ];
    for (const [found, current, why] of cases) {
      expect(reuseProblem(found, current)).toContain(why);
      expect(() => planFix(issue, false, found, current)).toThrow(/--fresh/);
      expect(planFix(issue, true, found, current)).toEqual({ issue });
    }
  });

  it("refuses a bad issue id, and --fresh without --issue, before anything starts", () => {
    expect(() => planFix("abc", false, last, now([t("a")]))).toThrow("--issue must be");
    expect(() => planFix(undefined, true, last, now([t("a")]))).toThrow("--fresh goes with --issue");
  });

  it("adds --fresh to the Console's refusals of a reuse only", () => {
    const refused = new ConsoleError("tasks_changed", "POST /v0/experiments/exp_0/fix: 409 tasks_changed");
    expect(String(withFreshHint(refused))).toContain("pass --fresh");
    const other = new ConsoleError("fix_on_trial", "POST /v0/experiments/exp_0/fix: 409 fix_on_trial");
    expect(withFreshHint(other)).toBe(other);
  });

  it("is kept only after a find that found, or a judged fix made on reused runs", () => {
    const examples = JSON.parse(fs.readFileSync(path.join(fixtures, "status-examples.json"), "utf8")) as Record<string, Status>;
    const reusable = Object.entries(examples).filter(([, status]) => isReusable(status, true)).map(([name]) => name);
    expect(reusable).toEqual(["find_found", "fix_helped", "fix_no_better", "helped_on_errors", "errors_null_after_deadline"]);
    expect(isReusable(examples.fix_helped!, false)).toBe(false);
  });

  it("is kept in a file, and a broken file counts as none", () => {
    const file = path.join(dir, ".baton-eval", "last.json");
    writeLastRun(file, last);
    expect(readLastRun(file)).toEqual(last);
    fs.writeFileSync(file, "{");
    expect(readLastRun(file)).toBeUndefined();
  });

  it("is ignored by git: its folder ignores itself", () => {
    writeLastRun(path.join(dir, ".baton-eval", "last.json"), last);
    expect(fs.readFileSync(path.join(dir, ".baton-eval", ".gitignore"), "utf8")).toBe("*\n");
  });
});
