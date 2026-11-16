#!/usr/bin/env node
// Stands in for `claude -p ... --output-format stream-json`: starts the MCP server
// from --mcp-config like Claude Code does, calls top_friction, and answers per FAKE_CLAUDE_MODE.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
// FAKE_CLAUDE_ONLY_RUN=n applies the mode to the nth run only, counted in FAKE_CLAUDE_STATE.
const runNumber = Number(fs.existsSync(process.env.FAKE_CLAUDE_STATE) ? fs.readFileSync(process.env.FAKE_CLAUDE_STATE, "utf8") : 0) + 1;
fs.writeFileSync(process.env.FAKE_CLAUDE_STATE, String(runNumber));
const onlyRun = process.env.FAKE_CLAUDE_ONLY_RUN;
const mode = onlyRun && Number(onlyRun) !== runNumber ? "pass" : (process.env.FAKE_CLAUDE_MODE ?? "pass");
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const prompt = fs.readFileSync(0, "utf8");
const mcpConfig = fs.readFileSync(flag("--mcp-config"), "utf8");
if (process.env.FAKE_CLAUDE_ARGS) fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({ args, prompt, cwd: process.cwd(), mcpConfig, env: process.env }));
if (mode === "hang" || mode === "leave-child") {
  // A child that holds stdout and stderr open, as a stuck MCP server would.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  if (process.env.FAKE_CLAUDE_CHILD) fs.writeFileSync(process.env.FAKE_CLAUDE_CHILD, String(child.pid));
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
}
if (mode === "crash") {
  process.stderr.write("boom: not logged in\n");
  process.exit(1);
}
const config = JSON.parse(mcpConfig);
const [name, spec] = Object.entries(config.mcpServers)[0];
let reply = "";
let status = "connected";
let transport;
const client = new Client({ name: "fake-claude", version: "0" });
try {
  transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: process.env, stderr: "ignore" });
  await client.connect(transport);
} catch {
  status = "failed";
}
if (status === "connected" && mode !== "notool") {
  try {
    const result = await client.callTool({ name: "top_friction", arguments: {} });
    reply = `The tool with the most friction is ${result.structuredContent?.rows?.[0]?.label ?? "unknown"}.`;
  } catch {
    reply = "The tool call failed.";
  }
}
if (mode === "noserver") status = "failed";
out({ type: "system", subtype: "init", model: "test-model-1", mcp_servers: [{ name, status }] });
if (mode === "hang-after-init") await new Promise(() => {});
if (mode === "budget") {
  out({ type: "result", subtype: "error_max_budget_usd", is_error: true, num_turns: 3, total_cost_usd: 1.02 });
} else {
  out({ type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.01, result: mode === "wrong" || mode === "notool" ? "I could not tell." : reply });
}
// Like Claude Code, signal the server on the way out; its stdin closes when this exits.
try {
  if (transport?.pid) {
    process.kill(transport.pid, "SIGINT");
    process.kill(transport.pid, "SIGTERM");
  }
} catch {
  // The server already exited.
}
process.exit(0);
