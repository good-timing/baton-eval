import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { parsePath } from "./check.js";
import { MAX_CHARS, PROMPT_MAX_CHARS, type TaskRef } from "./console.js";
import { isObject, isStringList, overCodePoints } from "./util.js";

export interface Check {
  tool: string;
  args: Record<string, unknown>;
  /** A path into the check's result, such as `rows[0].label`, for the value the judge looks for. */
  answer?: string;
}

export interface Task {
  id: string;
  prompt: string;
  check: Check;
  /** Unset when the file doesn't say: the Console reads any `held_out`, even false, as the developer's pick. */
  held_out?: boolean;
  tools: string[];
}

const TASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function loadTasks(path: string, placeholders: Record<string, string>): Task[] {
  const tasks: Task[] = [];
  const seen = new Set<string>();
  for (const { raw, where } of readTaskLines(path)) {
    const task = parseTask(raw, where, placeholders);
    if (seen.has(task.id)) throw new Error(`${where}: task id ${task.id} appears twice`);
    seen.add(task.id);
    tasks.push(task);
  }
  if (tasks.length === 0) throw new Error(`${path} has no tasks`);
  return tasks;
}

function readTaskLines(path: string): { raw: unknown; where: string }[] {
  return fs
    .readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      const where = `${path}:${index + 1}`;
      try {
        return [{ raw: JSON.parse(line) as unknown, where }];
      } catch (error) {
        throw new Error(`${where}: not JSON (${(error as Error).message})`, { cause: error });
      }
    });
}

function parseTask(raw: unknown, where: string, placeholders: Record<string, string>): Task {
  if (!isObject(raw)) throw new Error(`${where}: a task is a JSON object`);
  const { id, prompt, check, held_out, tools } = raw;
  if (typeof id !== "string" || !TASK_ID.test(id)) {
    throw new Error(`${where}: id must be 1-128 of [A-Za-z0-9_.:-]`);
  }
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`${where}: prompt must be a non-empty string`);
  if (!isObject(check) || typeof check.tool !== "string") throw new Error(`${where}: check.tool must be a string`);
  const args = check.args ?? {};
  if (!isObject(args)) throw new Error(`${where}: check.args must be an object`);
  if (check.reply_contains !== undefined || check.reply_contains_any !== undefined) {
    throw new Error(`${where}: reply_contains and reply_contains_any are gone; name the value with check.answer, such as "rows[0].label"`);
  }
  const { answer } = check;
  if (answer !== undefined) {
    if (typeof answer !== "string") throw new Error(`${where}: check.answer must be a path such as "rows[0].label"`);
    try {
      parsePath(answer);
    } catch (error) {
      throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
    }
  }
  if (held_out !== undefined && typeof held_out !== "boolean") throw new Error(`${where}: held_out must be true or false`);
  if (tools !== undefined && !isStringList(tools)) {
    throw new Error(`${where}: tools must be a list of tool names`);
  }
  const fill = (value: string) => fillPlaceholders(value, placeholders, where);
  const filled = fill(prompt);
  if (overCodePoints(filled, PROMPT_MAX_CHARS)) throw new Error(`${where}: prompt is over ${PROMPT_MAX_CHARS} characters`);
  const filledArgs = fillDeep(args, fill) as Record<string, unknown>;
  const argsText = JSON.stringify(filledArgs);
  if (overCodePoints(argsText, MAX_CHARS)) throw new Error(`${where}: task ${id}'s check.args is over ${MAX_CHARS} characters as JSON`);
  return {
    id,
    prompt: filled,
    check: {
      tool: check.tool,
      args: filledArgs,
      ...(answer === undefined ? {} : { answer }),
    },
    ...(held_out === undefined ? {} : { held_out }),
    tools: tools ?? [check.tool],
  };
}

function fillPlaceholders(value: string, placeholders: Record<string, string>, where: string): string {
  return value.replace(PLACEHOLDER, (_, name: string) => {
    const filled = placeholders[name];
    if (filled === undefined) throw new Error(`${where}: {${name}} has no value under [placeholders] in baton-eval.toml`);
    return filled;
  });
}

function fillDeep(value: unknown, fill: (s: string) => string): unknown {
  if (typeof value === "string") return fill(value);
  if (Array.isArray(value)) return value.map((item) => fillDeep(item, fill));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, fill)]));
  return value;
}

/** Leaves out `held_out`, so writing the Console's pick back keeps the same hash and so the same pick (units.test.ts: "without changing the task set hash"). */
export function taskSetHash(tasks: Task[]): string {
  const canonical = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(canonicalTask);
  return "sha256:" + hash(canonical.join("\n"));
}

/** Each task's hash by id: what the Console's baseline ran, held_out aside. */
export function taskHashes(tasks: Task[]): Record<string, string> {
  return Object.fromEntries(tasks.map((task) => [task.id, hash(canonicalTask(task))]));
}

function canonicalTask({ id, prompt, check, tools }: Task): string {
  return canonicalJson({ id, prompt, check, tools });
}

export function taskRefs(tasks: Task[]): TaskRef[] {
  return tasks.map(({ id, prompt, held_out, tools }) => ({ id, prompt, ...(held_out === undefined ? {} : { held_out }), tools }));
}

/**
 * The tasks `init` marks held out: 1 in 5, at least 1, once there are 2 tasks. None when the file
 * is missing or already marks any, since that is the developer's pick.
 */
export function pickHeldOut(path: string): string[] {
  if (!fs.existsSync(path)) return [];
  const tasks = readTaskLines(path).map(({ raw, where }) => {
    if (!isObject(raw) || typeof raw.id !== "string") throw new Error(`${where}: not a task with an id`);
    return { id: raw.id, heldOut: raw.held_out };
  });
  if (tasks.length < 2 || tasks.some((task) => task.heldOut !== undefined)) return [];
  // By hash, not file order, so related tasks written together aren't all held out.
  const byHash = tasks.map(({ id }) => [hash(id), id] as const).sort(([a], [b]) => (a < b ? -1 : 1));
  return byHash.slice(0, Math.max(1, Math.floor(tasks.length / 5))).map(([, id]) => id);
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Rewrites each line with only `held_out` changed; placeholders and other values are kept, but not spacing. */
export function writeHeldOut(path: string, heldOut: string[]): void {
  const picked = new Set(heldOut);
  const lines = fs.readFileSync(path, "utf8").split("\n");
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    const raw = JSON.parse(line) as Record<string, unknown>;
    raw.held_out = picked.has(raw.id as string);
    return JSON.stringify(raw);
  });
  fs.writeFileSync(path, out.join("\n"));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
