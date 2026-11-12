/**
 * The Jev MCP server: a stdio server with no dependencies, so the app keeps its zero runtime packages.
 * MCP over stdio is newline delimited JSON-RPC 2.0. Three methods matter: initialize, tools/list, tools/call.
 *
 * JEV_MCP_TOOLS picks which tools are exposed, comma separated. Default: all of them.
 * Register it with `claude mcp add jev -- node claude/mcp/server.ts`, or let `node claude/config.ts` write the config.
 */
import { isMain, report } from "../lib.ts";
import { NUDGE, TOOLS, type Tool } from "../tools.ts";

const PROTOCOL_VERSION = "2025-06-18";

export function selectTools(spec: string | undefined, all: Tool[] = TOOLS): Tool[] {
  const wanted = new Set((spec ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  return wanted.size ? all.filter((t) => wanted.has(t.name)) : all;
}

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
}

/** One request in, one response out. Notifications have no id and get no response. */
export async function handle(msg: RpcMessage, tools: Tool[]): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "jev", version: "1.0.0" },
        ...(tools.some((t) => t.name === "ask_jev") ? { instructions: NUDGE } : {}),
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return error(-32602, `Unknown tool: ${msg.params?.name}`);
      try {
        return reply(await tool.run(msg.params?.arguments ?? {}));
      } catch (err: any) {
        report("error", { hook: tool.name, message: err?.message ?? String(err) });
        return reply({ content: [{ type: "text", text: `${tool.name} error: ${err?.message ?? err}` }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

async function serve() {
  const tools = selectTools(process.env.JEV_MCP_TOOLS);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg, tools).then((res) => { if (res) process.stdout.write(JSON.stringify(res) + "\n"); });
    }
  }
}

if (isMain(import.meta.url)) await serve();
