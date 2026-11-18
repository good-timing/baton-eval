export interface ServerStart {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Claude Code ignores `cwd` in an MCP config, so both the agent and the check start the server through sh. */
export function launch(server: ServerStart, options: { shieldSignals?: boolean } = {}): { command: string; args: string[]; env: Record<string, string> } {
  // Claude Code signals the server's pid as it exits, which loses the SDK's last events; sh keeps that pid and
  // the server, with its signals reset, exits when stdin closes (runner.test.ts: "lets the server finish"; units.test.ts: "gives the server back").
  // Only the secret DSN goes in the environment; sh exports the rest from its arguments, so it reaches the server
  // and not Claude Code (runner.test.ts: "starts Claude Code isolated"; units.test.ts: "exports the server's").
  const exports = 'while [ "$1" != -- ]; do export "$1"; shift; done; shift;';
  const script = options.shieldSignals
    ? `trap "" INT TERM; cd "$0" || exit; (${exports} trap - INT TERM; exec "$@"); exit $?`
    : `cd "$0" || exit; ${exports} exec "$@"`;
  const { BATON_DSN, ...vars } = server.env;
  const assignments = Object.entries(vars).map(([key, value]) => `${key}=${value}`);
  return {
    command: "/bin/sh",
    args: ["-c", script, server.cwd, ...assignments, "--", server.command, ...server.args],
    // The SDK's settings in the developer's shell must not reach the server (runner.test.ts: "never lets the SDK's settings").
    env: { ...withoutSdkSettings(process.env), ...(BATON_DSN === undefined ? {} : { BATON_DSN }) },
  };
}

/** The Baton SDK's own variables; a server's other BATON_ variables pass through. */
const SDK_SETTINGS = new Set(["BATON_CANDIDATE", "BATON_TASK", "BATON_DISABLED", "BATON_DSN", "BATON_TENANT_ID", "BATON_VENDOR_ID", "BATON_CONSENT_TOKEN"]);

function withoutSdkSettings(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SDK_SETTINGS.has(key))) as Record<string, string>;
}
