import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse, stringify } from "smol-toml";
import { isObject, isStringList, isStringRecord } from "./util.js";

export const CONFIG_FILE = "baton-eval.toml";

const SET_BY_RUNNER = new Set(["BATON_DSN", "BATON_CANDIDATE", "BATON_DISABLED"]);

interface Config {
  /** The server's slug: the last path segment of its DSN. */
  server: string;
  tasks: string;
  start: { command: string; args: string[]; env: Record<string, string>; cwd: string };
  agent: { model: string; maxBudgetUsd: number };
  placeholders: Record<string, string>;
  budgetSessions?: number | undefined;
}

interface Dsn {
  raw: string;
  origin: string;
  key: string;
  server: string;
}

export function loadConfig(file: string): Config {
  const dir = path.dirname(path.resolve(file));
  const raw = readToml(file);
  const where = (field: string) => `${file}: ${field}`;
  const server = raw.server;
  if (typeof server !== "string" || !server) throw new Error(where("server must name the server, as in its DSN"));
  const tasks = raw.tasks;
  if (typeof tasks !== "string") throw new Error(where("tasks must be the path to the tasks file"));
  const start = table(raw.start, where("[start]"));
  if (typeof start.command !== "string" || !start.command) throw new Error(where("start.command is required"));
  const args = start.args ?? [];
  if (!isStringList(args)) throw new Error(where("start.args must be a list of strings"));
  const env = start.env ?? {};
  if (!isStringRecord(env)) throw new Error(where("start.env must be a table of strings"));
  for (const key of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(where(`start.env: ${key} is not a variable name`));
    if (SET_BY_RUNNER.has(key)) throw new Error(where(`start.env: baton-eval sets ${key} itself; remove it`));
  }
  const cwd = start.cwd ?? ".";
  if (typeof cwd !== "string") throw new Error(where("start.cwd must be a path"));
  // Claude Code fills ${NAME} in the agent's server command and baton-eval's check does not (units.test.ts: "refuses ${").
  if ([start.command, cwd, ...args, ...Object.values(env)].some((value) => value.includes("${"))) {
    throw new Error(where("[start] can't use ${NAME}: the agent's server and the check's would get different values; write the value out"));
  }
  const agent = table(raw.agent, where("[agent]"));
  if (typeof agent.model !== "string" || !agent.model) throw new Error(where("agent.model is required, so every run uses the same model"));
  if (typeof agent.max_budget_usd !== "number" || !(agent.max_budget_usd > 0)) {
    throw new Error(where("agent.max_budget_usd must be a number above 0"));
  }
  const placeholders = raw.placeholders ?? {};
  if (!isStringRecord(placeholders)) throw new Error(where("[placeholders] must be a table of strings"));
  const budget = raw.budget_sessions;
  if (budget !== undefined && !(typeof budget === "number" && Number.isInteger(budget) && budget > 0)) {
    throw new Error(where("budget_sessions must be a whole number above 0"));
  }
  return {
    server,
    tasks: path.resolve(dir, tasks),
    start: {
      command: start.command,
      args,
      env,
      cwd: path.resolve(dir, cwd),
    },
    agent: { model: agent.model, maxBudgetUsd: agent.max_budget_usd },
    placeholders,
    budgetSessions: budget,
  };
}

export function renderConfig(input: { server: string; tasks: string; command: string; args: string[]; model: string; maxBudgetUsd: number }): string {
  return stringify({
    server: input.server,
    tasks: input.tasks,
    start: { command: input.command, args: input.args },
    agent: { model: input.model, max_budget_usd: input.maxBudgetUsd },
    placeholders: {},
  }) + "\n";
}

export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "baton-eval", "credentials");
}

export function readDsn(server: string, file = credentialsPath()): Dsn {
  if (!fs.existsSync(file)) throw new Error(`no test key: ${file} does not exist. Run baton-eval init first.`);
  const dsn = savedDsn(readToml(file), server);
  if (dsn === undefined) throw new Error(`no test key for ${server} in ${file}. Run baton-eval init for this server.`);
  return parseDsn(dsn, server);
}

function savedDsn(saved: Record<string, unknown>, server: string): string | undefined {
  const entry = saved[server];
  return isObject(entry) && typeof entry.dsn === "string" ? entry.dsn : undefined;
}

/**
 * Sets mode 600, on a new or existing file, before any secret is in it (units.test.ts: "only its owner can read", "tightens an existing").
 * Saved DSNs are keyed by server name alone, so replacing one needs `replace` (units.test.ts: "won't replace").
 */
export function saveDsn(dsn: Dsn, file = credentialsPath(), options: { replace?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(file) ? readToml(file) : {};
  const saved = savedDsn(existing, dsn.server);
  if (saved !== undefined && saved !== dsn.raw && !options.replace) {
    throw new Error(`a different test DSN for ${dsn.server} is already saved in ${file}, maybe for another workspace; pass --replace-dsn to replace it`);
  }
  existing[dsn.server] = { dsn: dsn.raw };
  const fd = fs.openSync(file, "w", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, stringify(existing) + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

export function parseDsn(raw: string, server: string): Dsn {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("the test DSN is not a URL; copy the whole value, which starts with https://");
  }
  const key = decodeURIComponent(url.username);
  const segments = url.pathname.split("/").filter(Boolean);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !key || url.password || segments.length !== 2) {
    throw new Error("the test DSN must look like https://<key>@<host>/<workspace>/<server>");
  }
  if (segments[1] !== server) {
    throw new Error(`the test DSN is for server ${segments[1]}, but baton-eval.toml names ${server}`);
  }
  return { raw: trimmed, origin: url.origin, key, server };
}

function readToml(file: string): Record<string, unknown> {
  return parse(fs.readFileSync(file, "utf8"));
}

function table(value: unknown, where: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${where} is missing or not a table`);
  return value;
}
