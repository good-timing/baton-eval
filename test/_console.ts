import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import type { ResultRow, TaskRef } from "../src/console.js";

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
  started: { tasks: TaskRef[]; task_set_hash: string; agents?: string[] }[];
  results: (ResultRow & { step: number })[];
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
  /** Answer this many results posts with 503 first. */
  unavailableResults?: number;
}): Promise<FakeConsole> {
  const key = "baton_tk_testkey0123456789";
  const state: FakeConsole = { origin: "", key, started: [], results: [], loadedCalls: 0, close: async () => {} };
  let stepIndex = 0;
  let waits = options.waitsBeforeFirstStep ?? 0;
  let unavailable = options.unavailableResults ?? 0;
  const budget = options.budgetSessions ?? 400;

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
        const parsed = JSON.parse(body) as FakeConsole["started"][number];
        state.started.push(parsed);
        return send(201, { experiment_id: "exp_1", held_out: options.heldOut ?? [], budget_sessions: budget });
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
        if (unavailable > 0) {
          unavailable -= 1;
          return error(503, "unavailable");
        }
        const rows = (JSON.parse(body) as { results: ResultRow[] }).results;
        for (const row of rows) {
          if (!step.task_ids.includes(row.task_id)) return error(422, "task_not_in_step");
          if (state.results.length >= budget) return error(409, "budget_spent");
          state.results.push({ ...row, step: Number(match[1]) });
        }
        if (state.results.filter((r) => r.step === Number(match[1])).length === step.task_ids.length * step.runs_per_task) {
          stepIndex += 1;
        }
        return send(200, { added: rows.length, spent_sessions: state.results.length });
      }
      return error(404, "not_found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}
