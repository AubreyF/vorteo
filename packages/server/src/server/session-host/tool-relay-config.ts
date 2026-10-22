import path from "node:path";

/**
 * The shape of the tool relay's provider-side config, shared by the host that writes it and the
 * worker that must recognise it. See tool-relay.ts for the relay itself; this module stays free
 * of the relay's runtime so the worker can load it cheaply.
 */

/** Sockets live under the session host's private directory, one per hosted session. */
export const TOOL_RELAY_DIRECTORY_NAME = "tools";
/** The bridge is shipped with the server package and copied beside the built scripts. */
export const TOOL_RELAY_BRIDGE_FILE_NAME = "mcp-stdio-socket-bridge-cli.mjs";

/** Whether a tool server config is the relay's form: the bridge pointed at a relay socket. */
export function isToolRelayServer(config: {
  type?: string;
  command?: string;
  args?: string[];
}): boolean {
  if (config.type !== "stdio" || !config.args || config.args.length < 3) return false;
  const [script, flag, socketPath] = config.args;
  return (
    path.basename(script ?? "") === TOOL_RELAY_BRIDGE_FILE_NAME &&
    flag === "--socket" &&
    typeof socketPath === "string" &&
    socketPath.endsWith(".sock") &&
    path.basename(path.dirname(socketPath)) === TOOL_RELAY_DIRECTORY_NAME
  );
}
