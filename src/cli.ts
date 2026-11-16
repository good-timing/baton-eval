import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { ClaudeCode, finishLeftovers, killActiveRuns } from "./agent.js";
import { callToolOn } from "./check.js";
import { CONFIG_FILE, loadConfig, parseDsn, readDsn, renderConfig, saveDsn, credentialsPath } from "./config.js";
import { ConsoleApi } from "./console.js";
import { runExperiment } from "./runner.js";
import { loadTasks, writeHeldOut } from "./tasks.js";

const USAGE = `Usage:
  baton-eval init --server <slug> --tasks <file> --model <model> [--max-budget-usd <n>] [--force] [--replace-dsn] -- <command> [args...]
      Writes ${CONFIG_FILE} (safe to commit) and saves the server's test DSN to
      ${credentialsPath()} (mode 600). The DSN is read from BATON_EVAL_DSN or stdin,
      never from the command line.
  baton-eval run [--config <file>]
      Starts an experiment with the Console and runs the steps it hands out.`;

function log(line: string): void {
  process.stderr.write(line + "\n");
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    // The DSN holds the secret key, so it isn't echoed.
    process.stderr.write("Paste the server's test DSN, then press Enter: ");
    const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
    const rl = readline.createInterface({ input: process.stdin, output: silent, terminal: true });
    try {
      return (await rl.question("")).trim();
    } finally {
      rl.close();
      process.stderr.write("\n");
    }
  }
  return (await text(process.stdin)).trim();
}

async function init(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      tasks: { type: "string" },
      model: { type: "string" },
      "max-budget-usd": { type: "string", default: "1" },
      force: { type: "boolean", default: false },
      "replace-dsn": { type: "boolean", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (!values.server || !values.tasks || !values.model || !command) throw new Error(USAGE);
  const maxBudgetUsd = Number(values["max-budget-usd"]);
  if (!(maxBudgetUsd > 0)) throw new Error("--max-budget-usd must be a number above 0");
  if (fs.existsSync(CONFIG_FILE) && !values.force) {
    throw new Error(`${CONFIG_FILE} already exists; pass --force to replace it`);
  }
  const raw = process.env.BATON_EVAL_DSN || (await readStdin());
  if (!raw) throw new Error("no test DSN given: set BATON_EVAL_DSN or pipe it on stdin");
  const dsn = parseDsn(raw, values.server);
  saveDsn(dsn, credentialsPath(), { replace: values["replace-dsn"] });
  fs.writeFileSync(
    CONFIG_FILE,
    renderConfig({ server: values.server, tasks: values.tasks, command, args, model: values.model, maxBudgetUsd }),
  );
  log(`wrote ${CONFIG_FILE}; saved the test DSN for ${values.server} to ${credentialsPath()}`);
  log(`fill [placeholders] in ${CONFIG_FILE} if the tasks use any, then run: npx baton-eval run`);
}

async function run(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { config: { type: "string", default: CONFIG_FILE } } });
  const config = loadConfig(values.config);
  const dsn = readDsn(config.server);
  const tasks = loadTasks(config.tasks, config.placeholders);
  const agent = new ClaudeCode({
    model: config.agent.model,
    maxBudgetUsd: config.agent.maxBudgetUsd,
    binary: process.env.BATON_EVAL_CLAUDE || undefined,
  });
  // The agent runs in its own process group, so Ctrl-C or a closed terminal would not reach it.
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => {
      killActiveRuns();
      log(`baton-eval: stopped by ${signal}`);
      process.exit(code);
    });
  }
  const summary = await runExperiment({
    api: new ConsoleApi(dsn.origin, dsn.key),
    agent,
    tasks,
    server: { name: config.server, ...config.start },
    dsn: dsn.raw,
    callToolFor: callToolOn,
    budgetSessions: config.budgetSessions,
    onHeldOutPicked: (ids) => {
      const file = path.relative(".", config.tasks);
      try {
        writeHeldOut(config.tasks, ids);
        log(`no task was marked held_out, so the Console picked ${ids.join(", ")}; wrote that to ${file} for you to review`);
      } catch (error) {
        // The experiment has already started, so the pick is logged instead.
        log(`the Console picked ${ids.join(", ")} as held out, but writing that to ${file} failed: ${(error as Error).message}`);
      }
    },
    log,
  }).finally(finishLeftovers);
  const { pass, fail, short } = summary.outcomes;
  log(`experiment ${summary.experimentId}: ${summary.steps} steps, ${pass} pass, ${fail} fail, ${short} short${summary.stoppedFor ? `; stopped: ${summary.stoppedFor}` : ""}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "init") return init(rest);
  if (command === "run") return run(rest);
  log(USAGE);
  process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 2;
}

main().catch((error: unknown) => {
  log(`baton-eval: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
