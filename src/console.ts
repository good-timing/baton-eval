/** The Console's runner API: every wire shape baton-eval depends on lives here. */
import { setTimeout as sleep } from "node:timers/promises";
import { isObject, isStringList, tryParseJson } from "./util.js";

export type Outcome = "pass" | "fail" | "short";

export interface TaskRef {
  id: string;
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
  outcome: Outcome;
  cost_usd?: number | undefined;
  seconds?: number | undefined;
  turns?: number | undefined;
  agent?: string | undefined;
  model?: string | undefined;
}

export class ConsoleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const RESULTS_PER_CALL = 1000;

const TIMEOUT_MS = 30_000;

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

  /** Safe to repeat: the Console adds a row it already holds as 0. */
  async results(experiment: string, step: number, rows: ResultRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += RESULTS_PER_CALL) {
      await this.call("POST", `${this.stepPath(experiment, step)}/results`, { results: rows.slice(i, i + RESULTS_PER_CALL) });
    }
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

  private async call(method: string, path: string, body?: unknown, retry = true): Promise<unknown> {
    const delays = retry ? this.retryDelaysMs : [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, path, body);
      } catch (error) {
        const transient = !(error instanceof ConsoleError) || error.code === "unavailable";
        const delay = delays[attempt];
        if (!transient || delay === undefined) throw error;
        await sleep(delay);
      }
    }
  }

  private async once(method: string, path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(this.origin + path, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    const parsed = tryParseJson(text);
    if (response.ok) return parsed;
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : {};
    const code = response.status >= 500 || response.status === 429 ? "unavailable" : typeof error.code === "string" ? error.code : "http_error";
    const message = typeof error.message === "string" ? error.message : text.slice(0, 200);
    throw new ConsoleError(code, `${method} ${path}: ${response.status} ${code} ${message}`.trim());
  }
}
