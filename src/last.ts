import * as fs from "node:fs";
import * as path from "node:path";
import { ConsoleError, type Status } from "./console.js";
import { isObject, isStringRecord, tryParseJson } from "./util.js";

/** The last experiment whose baseline `run --issue` reuses: a find, or a fix made on one. */
export interface LastRun {
  experiment_id: string;
  server: string;
  agent: string;
  tasks: Record<string, string>;
}

export function lastRunPath(configPath: string): string {
  return path.join(path.dirname(configPath), ".baton-eval", "last.json");
}

/**
 * Whether the next fix can reuse this experiment's runs: a find that found, or a fix made on reused runs whose try
 * was judged, so its baseline, added tasks included, all ran. The Console won't build on a --fresh fix.
 */
export function isReusable(status: Status, reused: boolean): boolean {
  return (status.kind === "find" && status.verdict === "found") || (status.kind === "fix" && reused && status.result != null);
}

/** The folder ignores itself, so git never shows it, wherever the config is (units.test.ts: "is ignored by git"). */
export function writeLastRun(file: string, last: LastRun): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n");
  fs.writeFileSync(file, JSON.stringify(last, null, 2) + "\n");
}

export function readLastRun(file: string): LastRun | undefined {
  if (!fs.existsSync(file)) return undefined;
  const raw = tryParseJson(fs.readFileSync(file, "utf8"));
  if (!isObject(raw) || typeof raw.experiment_id !== "string" || typeof raw.server !== "string" || typeof raw.agent !== "string" || !isStringRecord(raw.tasks)) return undefined;
  return raw as unknown as LastRun;
}

const ISSUE = /^[0-9a-f]{16}\.[0-9a-f]{16}$/;
/** The Console's refusals of a reuse that a fix with its own baseline gets past. */
const REUSE_REFUSED = new Set(["tasks_changed", "base_moved", "not_found_yet", "agents_changed", "unknown_experiment"]);
const FRESH_HINT = "pass --fresh to test the fix after running the tasks again, which costs more";

/** Test a fix for this issue, reusing the runs of experiment `from` when given. */
export type Fix = { issue: string; from?: string };

/** A find without `issue`; else a fix reusing the last run, or on its own with `fresh`, which costs more and so is never chosen for the user. */
export function planFix(issue: string | undefined, fresh: boolean, last: LastRun | undefined, now: Omit<LastRun, "experiment_id">): Fix | undefined {
  if (issue === undefined) {
    if (fresh) throw new Error("--fresh goes with --issue");
    return undefined;
  }
  if (!ISSUE.test(issue)) throw new Error("--issue must be an issue id from a find or the Console, like 0123456789abcdef.0123456789abcdef");
  if (fresh) return { issue };
  const problem = reuseProblem(last, now);
  if (problem || !last) throw new Error(`can't reuse the last run: ${problem}; ${FRESH_HINT}`);
  return { issue, from: last.experiment_id };
}

/** For an error from the /fix start: the Console's refusal of the reuse names --fresh. */
export function withFreshHint(error: unknown): unknown {
  return error instanceof ConsoleError && REUSE_REFUSED.has(error.code) ? new Error(`${error.message}; ${FRESH_HINT}`) : error;
}

/** Why the last run can't be reused for these tasks, or undefined when it can. Hashes also catch a changed check, which the Console never gets. */
export function reuseProblem(last: LastRun | undefined, now: Omit<LastRun, "experiment_id">): string | undefined {
  if (last === undefined) return "there is no finished run to reuse";
  if (last.server !== now.server) return `the last run was for server ${last.server}`;
  if (last.agent !== now.agent) return `the last run used ${last.agent}, and the config now runs ${now.agent}`;
  for (const [id, hash] of Object.entries(last.tasks)) {
    if (!(id in now.tasks)) return `task ${id} was removed since the last run`;
    if (now.tasks[id] !== hash) return `task ${id} changed since the last run`;
  }
  return undefined;
}
