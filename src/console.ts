/** The Console's runner API: every wire shape baton-eval depends on lives here. */
import { setTimeout as sleep } from "node:timers/promises";
import type { CheckReport } from "./check.js";
import { cutToCodePoints, isObject, isStringList, tryParseJson, storable } from "./util.js";

export type Outcome = "pass" | "fail" | "short";

/** Why the runner set a row's outcome itself; other rows the Console judges. */
type Reason = "crashed" | "not_loaded" | "check_failed" | "dollar_cap";

export interface TaskRef {
  id: string;
  prompt: string;
  held_out?: boolean;
  tools: string[];
}

interface Started {
  experiment_id: string;
  held_out: string[];
  budget_sessions: number;
}

export interface Step {
  action: "run";
  step: number;
  change_id: string;
  task_ids: string[];
  runs_per_task: number;
  reason?: string | undefined;
}

type Next = Step | { action: "wait" } | { action: "done" };

export interface ResultRow {
  task_id: string;
  run: number;
  outcome?: "fail" | "short";
  reason?: Reason;
  reply?: string;
  check?: CheckReport;
  cost_usd?: number | undefined;
  seconds?: number | undefined;
  turns?: number | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  truncated?: true;
}

export interface RowOutcome {
  task_id: string;
  run: number;
  outcome: Outcome;
  reason?: string;
}

export class ConsoleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

/** The Console judges every row without an outcome before it answers a post, so it takes only a few of those. */
const JUDGED_PER_CALL = 20;
const RESULTS_PER_CALL = 1000;
const RESULTS_TIMEOUT_MS = 120_000;
const TIMEOUT_MS = 30_000;
/** The Console refuses longer text, counted in code points per field. */
export const MAX_CHARS = 20_000;
export const PROMPT_MAX_CHARS = 4000;

interface ConsoleOptions {
  /** Delays between tries for calls that are safe to repeat. */
  retryDelaysMs?: number[];
}

export class ConsoleApi {
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly origin: string,
    private readonly key: string,
    options: ConsoleOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? [1000, 4000, 15_000];
  }

  /** Never retried: a retry after a lost answer would start a second experiment. */
  async start(body: { tasks: TaskRef[]; task_set_hash: string; agents: string[]; budget_sessions?: number | undefined }): Promise<Started> {
    const started = await this.call("POST", "/v0/experiments", body, false);
    if (!isObject(started) || typeof started.experiment_id !== "string" || !isStringList(started.held_out) || typeof started.budget_sessions !== "number") {
      throw new ConsoleError("bad_answer", `POST /v0/experiments: unexpected answer ${JSON.stringify(started)}`);
    }
    return started as unknown as Started;
  }

  async next(experiment: string): Promise<Next> {
    const next = await this.call("GET", `${this.experimentPath(experiment)}/next`);
    if (isObject(next) && (next.action === "wait" || next.action === "done")) return { action: next.action };
    if (
      isObject(next) &&
      next.action === "run" &&
      Number.isInteger(next.step) &&
      typeof next.change_id === "string" &&
      isStringList(next.task_ids) &&
      Number.isInteger(next.runs_per_task)
    ) {
      return next as unknown as Step;
    }
    throw new ConsoleError("bad_answer", `the Console's next step is not one baton-eval knows: ${JSON.stringify(next).slice(0, 300)}`);
  }

  /** Safe to repeat: the Console adds a row it already holds as 0. Returns each row's outcome. */
  async results(experiment: string, step: number, rows: ResultRow[]): Promise<RowOutcome[]> {
    const outcomes: RowOutcome[] = [];
    for (const chunk of chunks(rows)) {
      const results = chunk.map(fitForConsole);
      const body = await this.call("POST", `${this.stepPath(experiment, step)}/results`, { results }, true, RESULTS_TIMEOUT_MS);
      if (!isObject(body) || !Array.isArray(body.outcomes) || !body.outcomes.every(isRowOutcome) || !sameRuns(body.outcomes, chunk)) {
        throw new ConsoleError("bad_answer", `results: unexpected answer ${JSON.stringify(body).slice(0, 300)}`);
      }
      outcomes.push(...body.outcomes);
    }
    return outcomes;
  }

  async loaded(experiment: string, step: number): Promise<number> {
    const body = await this.call("GET", `${this.stepPath(experiment, step)}/loaded`);
    if (!isObject(body) || typeof body.tagged_events !== "number") {
      throw new ConsoleError("bad_answer", `loaded: unexpected answer ${JSON.stringify(body)}`);
    }
    return body.tagged_events;
  }

  private experimentPath(experiment: string): string {
    return `/v0/experiments/${encodeURIComponent(experiment)}`;
  }

  private stepPath(experiment: string, step: number): string {
    return `${this.experimentPath(experiment)}/steps/${step}`;
  }

  private async call(method: string, path: string, body?: unknown, retry = true, timeoutMs = TIMEOUT_MS): Promise<unknown> {
    const delays = retry ? this.retryDelaysMs : [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, path, body, timeoutMs);
      } catch (error) {
        const transient = !(error instanceof ConsoleError) || error.transient;
        const delay = delays[attempt];
        if (!transient || delay === undefined) throw error;
        await sleep(delay);
      }
    }
  }

  private async once(method: string, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(this.origin + path, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(storable(body)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const parsed = tryParseJson(text);
    if (response.ok) return parsed;
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : {};
    const unavailable = response.status >= 500 || response.status === 429;
    const code = typeof error.code === "string" ? error.code : unavailable ? "unavailable" : "http_error";
    // A Console with no judge set up says so with a 503, which a resend can't fix (runner.test.ts: "doesn't resend").
    const transient = unavailable && code !== "no_judge";
    const message = typeof error.message === "string" ? error.message : text.slice(0, 200);
    throw new ConsoleError(code, `${method} ${path}: ${response.status} ${code} ${message}`.trim(), transient);
  }
}

/** Rows the runner scored itself go in one post: a not_loaded row ends the experiment (runner.test.ts: "marks every run of a step not_loaded"). */
function chunks(rows: ResultRow[]): ResultRow[][] {
  const out: ResultRow[][] = [];
  let current: ResultRow[] = [];
  let judged = 0;
  for (const row of rows) {
    const toJudge = row.outcome === undefined ? 1 : 0;
    if (current.length === RESULTS_PER_CALL || judged + toJudge > JUDGED_PER_CALL) {
      out.push(current);
      current = [];
      judged = 0;
    }
    current.push(row);
    judged += toJudge;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function sameRuns(outcomes: RowOutcome[], rows: ResultRow[]): boolean {
  const key = (row: { task_id: string; run: number }) => `${row.run} ${row.task_id}`;
  const sent = new Set(rows.map(key));
  return outcomes.length === sent.size && outcomes.every((outcome) => sent.delete(key(outcome)));
}

function isRowOutcome(value: unknown): value is RowOutcome {
  return (
    isObject(value) &&
    typeof value.task_id === "string" &&
    Number.isInteger(value.run) &&
    (value.outcome === "pass" || value.outcome === "fail" || value.outcome === "short")
  );
}

/** Fits each field to the Console's limit, a string as itself and any other value as its JSON text (runner.test.ts: "fits a row"). */
function fitForConsole(row: ResultRow): ResultRow {
  let truncated = false;
  const fit = (value: unknown): unknown => {
    if (value === undefined) return value;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const cut = cutToCodePoints(text, MAX_CHARS);
    if (cut === text) return value;
    truncated = true;
    return cut;
  };
  const fitAll = (fields: object) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fit(value)]));
  const { check, ...rest } = row;
  const fitted = { ...fitAll(rest), ...(check === undefined ? {} : { check: fitAll(check) }) } as unknown as ResultRow;
  return truncated ? { ...fitted, truncated: true } : fitted;
}
