// A stdio MCP server for tests. Its answer names the change it was started under.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";

const server = new McpServer({ name: "fixture", version: "1" });
server.registerTool("top_friction", { description: "Tools ranked by friction." }, async () => {
  const rows = process.env.FIXTURE_EMPTY ? [] : [{ label: "search_docs" }, { label: "run_query" }];
  if (process.env.FIXTURE_LOG) {
    fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ candidate: process.env.BATON_CANDIDATE, disabled: process.env.BATON_DISABLED, api: process.env.BATON_API_BASE_URL, dsn: process.env.BATON_DSN, cwd: process.cwd() }) + "\n");
  }
  return { content: [{ type: "text", text: JSON.stringify({ rows }) }], structuredContent: { rows } };
});
await server.connect(new StdioServerTransport());
// Stands in for an SDK that sends its last events as the server shuts down; with Baton off it has none.
if (process.env.FIXTURE_EXIT_MARKER && !process.env.BATON_DISABLED) {
  process.stdin.on("end", () => setTimeout(() => {
    fs.appendFileSync(process.env.FIXTURE_EXIT_MARKER, `flushed ${process.env.BATON_CANDIDATE ?? "no-change"}\n`);
    process.exit(0);
  }, Number(process.env.FIXTURE_EXIT_DELAY_MS ?? 300)));
}
