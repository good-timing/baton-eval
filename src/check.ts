import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { launch, type ServerStart } from "./server.js";
import type { Check } from "./tasks.js";
import { isObject, tryParseJson } from "./util.js";

type Verdict = { outcome: "pass" | "fail" } | { outcome: "short"; reason: string };

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

export async function judge(check: Check, reply: string, callTool: CallTool): Promise<Verdict> {
  let data: unknown;
  const expression = check.reply_contains ?? check.reply_contains_any;
  try {
    data = await callTool(check.tool, check.args);
  } catch (error) {
    return { outcome: "short", reason: `the check call failed: ${(error as Error).message}` };
  }
  let value: unknown;
  try {
    value = select(data, expression);
  } catch (error) {
    return { outcome: "short", reason: (error as Error).message };
  }
  // No reply can name a blank or missing value, so it is dropped (units.test.ts: "is short, never a pass", "passes reply_contains_any").
  const values = (Array.isArray(value) ? value : [value])
    .map((v: unknown) => (typeof v === "string" ? normalize(v) : v))
    .filter((v) => v !== "" && v !== null && v !== undefined);
  if (values.length === 0) return { outcome: "short", reason: `${expression} gave nothing to look for` };
  // A number or a date can be worded many ways ("seven", "12.35"), so every value must be text with a letter
  // (units.test.ts: "which has no letter to look for").
  if (!values.every((v): v is string => typeof v === "string" && /\p{L}/u.test(v))) {
    return { outcome: "short", reason: `${expression} has a value that isn't text with a letter in it; only such text can be looked for` };
  }
  if (check.reply_contains !== undefined && values.length !== 1) {
    return { outcome: "short", reason: `reply_contains needs one value, and ${expression} gave ${values.length}` };
  }
  const haystack = normalize(reply);
  return { outcome: values.some((e) => mentionsWords(haystack, e)) ? "pass" : "fail" };
}

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase().replace(/\s+/g, " ").trim();
}

const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}_]";

/** Whole words only, so "run" doesn't match "running". */
function mentionsWords(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`, "u").test(haystack);
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
  return value.slice(0, token.first).map((item) => walk(item, rest));
}
