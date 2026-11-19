import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import type { Outcome, ResultRow, Status, TaskRef } from "../src/console.js";

export interface FakeStep {
  change_id: string;
  task_ids: string[];
  runs_per_task: number;
  tagged_events: number;
  /** Count the tagged events only once this file exists, as events arrive only once the server sends them. */
  taggedOnceExists?: string;
}

export interface FakeConsole {
  origin: string;
  key: string;
  started: { tasks: TaskRef[]; task_set_hash: string; agents?: string[]; issue?: string }[];
  /** Each /fix call: the find it reuses and its body. */
  fixed: { find: string; body: { issue: string; task_set_hash: string; tasks: TaskRef[]; agents: string[] } }[];
  /** Each row as sent, with the outcome the Console stored for it. */
  results: { step: number; outcome: Outcome; reason?: string | undefined; sent: ResultRow }[];
  posts: number;
  loadedCalls: number;
  close(): Promise<void>;
}

/** The Console's experiment API under /v0/experiments, as baton-eval calls it. */
export async function fakeConsole(options: {
  steps: FakeStep[];
  heldOut?: string[];
  waitsBeforeFirstStep?: number;
  budgetSessions?: number;
  /** Answer /next with this instead of the scripted steps. */
  nextAnswer?: unknown;
  /** Answer this many results posts with 503 judge_failed first. */
  judgeFailures?: number;
  /** Answer every results post with 503 no_judge. */
  noJudge?: boolean;
  /** Breaks the answer to a results post: one outcome missing, or one naming a run that wasn't sent. */
  badOutcomes?: "drop" | "misname";
  status?: Status;
  statusFails?: boolean;
  fixRefusal?: string;
  /** The judge's reason on each fail. */
  note?: string;
}): Promise<FakeConsole> {
  const key = "baton_tk_testkey0123456789";
  const state: FakeConsole = { origin: "", key, started: [], fixed: [], results: [], posts: 0, loadedCalls: 0, close: async () => {} };
  let stepIndex = 0;
  let waits = options.waitsBeforeFirstStep ?? 0;
  let judgeFailures = options.judgeFailures ?? 0;
  const budget = options.budgetSessions ?? 400;
  const started = { experiment_id: "exp_1", held_out: options.heldOut ?? [], budget_sessions: budget, url: "https://console.test/autopilot/exp_1" };

  const server = http.createServer((req, res) => {
    void text(req).then((body) => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const error = (status: number, code: string) => send(status, { error: { code, message: code } });
      if (req.headers.authorization !== `Bearer ${key}`) return error(403, "not_a_test_key");
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v0/experiments") {
        if (unstorable(JSON.parse(body))) return error(422, "unstorable_text");
        const parsed = JSON.parse(body) as FakeConsole["started"][number];
        state.started.push(parsed);
        return send(201, started);
      }
      const fix = /^\/v0\/experiments\/(exp_\w+)\/fix$/.exec(url);
      if (req.method === "POST" && fix) {
        if (options.fixRefusal) return error(409, options.fixRefusal);
        state.fixed.push({ find: fix[1]!, body: JSON.parse(body) as FakeConsole["fixed"][number]["body"] });
        return send(201, started);
      }
      if (req.method === "GET" && url.startsWith("/v0/experiments/exp_1?")) {
        // As the Console: a server that isn't the key's own has no experiments.
        if (new URLSearchParams(url.split("?")[1]).get("server") !== "fixture") return error(404, "unknown_experiment");
        if (options.statusFails) return error(500, "unavailable");
        return send(200, { experiment_id: "exp_1", ...(options.status ?? { kind: "find", state: "done", verdict: null, reason: null, issues: [] }) });
      }
      if (req.method === "GET" && url === "/v0/experiments/exp_1/next") {
        if (options.nextAnswer !== undefined) return send(200, options.nextAnswer);
        if (waits > 0) {
          waits -= 1;
          return send(200, { action: "wait" });
        }
        const step = options.steps[stepIndex];
        if (!step) return send(200, { action: "done" });
        return send(200, { action: "run", step: stepIndex + 1, reason: "test", change_id: step.change_id, task_ids: step.task_ids, runs_per_task: step.runs_per_task });
      }
      const match = /^\/v0\/experiments\/exp_1\/steps\/(\d+)\/(results|loaded)$/.exec(url);
      const step = match ? options.steps[Number(match[1]) - 1] : undefined;
      if (match && step && match[2] === "loaded" && req.method === "GET") {
        state.loadedCalls += 1;
        const arrived = step.taggedOnceExists === undefined || fs.existsSync(step.taggedOnceExists);
        return send(200, { tagged_events: arrived ? step.tagged_events : 0 });
      }
      if (match && step && match[2] === "results" && req.method === "POST") {
        state.posts += 1;
        if (options.noJudge) return error(503, "no_judge");
        // A not_loaded row ends the experiment.
        if (state.results.some((r) => r.reason === "not_loaded")) return error(409, "step_not_running");
        const rows = (JSON.parse(body) as { results: ResultRow[] }).results;
        const refused = rows.map(refusal).find((code) => code !== undefined);
        if (refused) return error(422, refused);
        if (rows.filter((r) => r.outcome === undefined).length > 20) return error(422, "too_many_to_judge");
        if (judgeFailures > 0 && rows.some((r) => r.outcome === undefined)) {
          judgeFailures -= 1;
          return error(503, "judge_failed");
        }
        const outcomes = [];
        for (const row of rows) {
          if (!step.task_ids.includes(row.task_id)) return error(422, "task_not_in_step");
          if (state.results.length >= budget) return error(409, "budget_spent");
          const stored = row.outcome === undefined ? { outcome: judge(row) } : { outcome: row.outcome, reason: row.reason };
          state.results.push({ ...stored, step: Number(match[1]), sent: row });
          outcomes.push({ task_id: row.task_id, run: row.run, ...stored, ...(stored.outcome === "fail" && options.note ? { note: options.note } : {}) });
        }
        if (state.results.filter((r) => r.step === Number(match[1])).length === step.task_ids.length * step.runs_per_task) {
          stepIndex += 1;
        }
        if (options.badOutcomes === "drop") outcomes.pop();
        if (options.badOutcomes === "misname" && outcomes[0]) outcomes[0] = { ...outcomes[0], run: 99 };
        return send(200, { added: rows.length, spent_sessions: state.results.length, outcomes });
      }
      return error(404, "not_found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

/** Stands in for the Console's judge: a pass when the reply names the picked value. */
function judge(row: ResultRow): Outcome {
  const picked = row.check?.picked;
  const values = (Array.isArray(picked) ? picked : [picked]).map(String);
  return values.some((value) => row.reply?.toLowerCase().includes(value.toLowerCase())) ? "pass" : "fail";
}

/** A real NUL or a lone surrogate anywhere, which Postgres can't store; the six characters \\u0000 are fine. */
function unstorable(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
  if (Array.isArray(value)) return value.some(unstorable);
  if (value !== null && typeof value === "object") return Object.entries(value).some(([k, v]) => unstorable(k) || unstorable(v));
  return false;
}

/** What the Console refuses in a row: its error code, or undefined. */
function refusal(row: ResultRow): string | undefined {
  if (row.outcome !== undefined && row.outcome !== "fail" && row.outcome !== "short") return "bad_outcome";
  if (row.outcome === undefined && (row.reply === undefined || row.check?.result === undefined)) return "missing_reply_or_check";
  const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
  const fields = [row.reply, row.check?.error, row.check?.args, row.check?.result, row.check?.picked].filter((v) => v !== undefined);
  if (fields.some((value) => Array.from(text(value)).length > 20_000)) return "too_long";
  if (unstorable(row)) return "unstorable_text";
  return undefined;
}
