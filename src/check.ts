import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { launch, type ServerStart } from "./server.js";
import type { Check } from "./tasks.js";
import { isObject, tryParseJson } from "./util.js";

export type CallTool = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** Starts its own copy of the server and returns the tool's result as data. */
export function callToolOn(server: ServerStart): CallTool {
  return async (tool, args) => {
    const transport = new StdioClientTransport({ ...launch(server), stderr: "ignore" });
    const client = new Client({ name: "baton-eval", version: "0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: tool, arguments: args });
      if (result.isError) throw new Error(`${tool} returned an error: ${textOf(result.content).slice(0, 200)}`);
      if (result.structuredContent !== undefined) return result.structuredContent;
      const data = tryParseJson(textOf(result.content));
      if (data === undefined) throw new Error(`${tool} returned no structured content and its text is not JSON`);
      return data;
    } finally {
      await client.close();
    }
  };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((c) => (isObject(c) && c.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("\n");
}

export interface CheckReport extends Check {
  result?: unknown;
  picked?: unknown;
  /** Why the check failed: the call errored, or `answer` found nothing or only blank values in its result. */
  error?: string;
}

/** Makes the check's call and picks the value at `answer`, for the Console's judge. */
export async function runCheck(check: Check, callTool: CallTool): Promise<CheckReport> {
  let result: unknown;
  try {
    result = await callTool(check.tool, check.args);
  } catch (error) {
    return { ...check, error: `the check call failed: ${(error as Error).message}` };
  }
  if (check.answer === undefined) return { ...check, result };
  const found = select(result, check.answer);
  if (found === undefined || (Array.isArray(found) && found.length === 0)) return { ...check, result, error: `${check.answer} found nothing in the result` };
  // A blank value can't grade a reply, so the judge never gets one (units.test.ts: "blank values").
  const picked = Array.isArray(found) ? found.filter((value) => !isBlank(value)) : found;
  if (isBlank(picked) || (Array.isArray(picked) && picked.length === 0)) return { ...check, result, error: `${check.answer} found only blank values` };
  return { ...check, result, picked };
}

function isBlank(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.trim() === "");
}

type Token = { key: string } | { index: number } | { first: number };

const TOKEN = /^(?:\.?([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]|\[:(\d+)\])/;

/** Parses `rows[0].label` or `rows[:3].label`; throws on anything else. */
export function parsePath(expression: string): Token[] {
  const tokens: Token[] = [];
  let rest = expression;
  while (rest) {
    const match = TOKEN.exec(rest);
    const [whole = "", key, index, first] = match ?? [];
    const dotted = whole.startsWith(".");
    if (!match || (key !== undefined && dotted !== tokens.length > 0)) throw new Error(`cannot read the check path ${expression}`);
    tokens.push(key !== undefined ? { key } : index !== undefined ? { index: Number(index) } : { first: Number(first) });
    rest = rest.slice(whole.length);
  }
  if (tokens.length === 0) throw new Error("the check path is empty");
  if (tokens.filter((t) => "first" in t).length > 1) throw new Error(`the check path ${expression} can take only one [:n]`);
  return tokens;
}

export function select(data: unknown, expression: string): unknown {
  return walk(data, parsePath(expression));
}

function walk(value: unknown, tokens: Token[]): unknown {
  const [token, ...rest] = tokens;
  if (!token) return value;
  if ("key" in token) {
    const next = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[token.key] : undefined;
    return walk(next, rest);
  }
  if (!Array.isArray(value)) return undefined;
  if ("index" in token) return walk(value[token.index], rest);
  // A row missing the value is left out, so `[:n]` finds nothing only when no row has it.
  return value.slice(0, token.first).flatMap((item) => {
    const found = walk(item, rest);
    return found === undefined ? [] : [found];
  });
}
