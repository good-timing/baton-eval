import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { parsePath } from "./check.js";
import type { TaskRef } from "./console.js";
import { isObject, isStringList } from "./util.js";

export type Check = { tool: string; args: Record<string, unknown> } & (
  | { reply_contains: string; reply_contains_any?: never }
  | { reply_contains_any: string; reply_contains?: never }
);

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
  const lines = fs.readFileSync(path, "utf8").split("\n");
  const tasks: Task[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const where = `${path}:${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new Error(`${where}: not JSON (${(error as Error).message})`, { cause: error });
    }
    const task = parseTask(raw, where, placeholders);
    if (seen.has(task.id)) throw new Error(`${where}: task id ${task.id} appears twice`);
    seen.add(task.id);
    tasks.push(task);
  });
  if (tasks.length === 0) throw new Error(`${path} has no tasks`);
  return tasks;
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
  const keys = (["reply_contains", "reply_contains_any"] as const).filter((key) => check[key] !== undefined);
  const expression = keys.length === 1 ? check[keys[0]!] : undefined;
  if (typeof expression !== "string") {
    throw new Error(`${where}: check needs exactly one of reply_contains or reply_contains_any, as a string`);
  }
  const value = keys[0] === "reply_contains" ? { reply_contains: expression } : { reply_contains_any: expression };
  try {
    parsePath(expression);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
  }
  if (held_out !== undefined && typeof held_out !== "boolean") throw new Error(`${where}: held_out must be true or false`);
  if (tools !== undefined && !isStringList(tools)) {
    throw new Error(`${where}: tools must be a list of tool names`);
  }
  const fill = (value: string) => fillPlaceholders(value, placeholders, where);
  return {
    id,
    prompt: fill(prompt),
    check: {
      tool: check.tool,
      args: fillDeep(args, fill) as Record<string, unknown>,
      ...value,
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
  const canonical = [...tasks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, prompt, check, tools }) => canonicalJson({ id, prompt, check, tools }));
  return "sha256:" + createHash("sha256").update(canonical.join("\n")).digest("hex");
}

export function taskRefs(tasks: Task[]): TaskRef[] {
  return tasks.map(({ id, held_out, tools }) => ({ id, ...(held_out === undefined ? {} : { held_out }), tools }));
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
