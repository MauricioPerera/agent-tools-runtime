// Pi extension for agent-tools-runtime (https://pi.dev).
//
// Unlike pi-mcp-adapter (the third-party MCP bridge for Pi), this does NOT
// go through MCP or its interactive /mcp setup onboarding at all -- that
// onboarding step has no documented headless equivalent, which is exactly
// what blocked a first attempt at wiring agent-tools-runtime into Pi via
// pi-mcp-adapter's .mcp.json (verified live: the model only ever saw
// built-in bash/read tools, never the adapter's mcp() proxy tool).
//
// pi.registerTool() runs at extension LOAD time, before any interactive
// gate -- so this talks to agent-tools-runtime's Streamable HTTP transport
// (runtime/mcp-http-server.mjs, `npm run mcp:http`) directly and registers
// each real facade tool as a native Pi tool. No subprocess management here:
// the HTTP server is assumed already running, same assumption eve's
// connections/agent-tools-runtime.ts makes.
//
// Install: copy this file to .pi/extensions/agent-tools-runtime.ts
// (project-local) or ~/.pi/agent/extensions/agent-tools-runtime.ts (global),
// or load ad hoc with `pi -e ./agent-tools-runtime.ts`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BASE_URL = process.env.AGENT_TOOLS_HTTP_URL || "http://127.0.0.1:8321/mcp";

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!res.ok) {
    throw new Error(
      `agent-tools-runtime HTTP ${res.status} -- is 'npm run mcp:http' running at ${BASE_URL}?`
    );
  }
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// Same three argument shapes every plugin's facade uses (see
// buildFacadeToolsForPlugin in runtime/mcp-server.mjs) -- hand-mirrored here
// in typebox instead of passing the raw MCP inputSchema through, so this
// doesn't depend on whether Pi's tool validator accepts bare JSON Schema.
const DISCOVER_PARAMS = Type.Object({
  query: Type.Optional(
    Type.String({ description: "Free-text search. Omit to list the most common tools." })
  ),
});
const CALL_PARAMS = Type.Object({
  toolName: Type.String({ description: "Exact tool name for this plugin." }),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Tool arguments as a JSON object." })
  ),
  confirm: Type.Optional(
    Type.Boolean({ description: "true to allow tools that mutate state." })
  ),
});
const RUN_SKILL_PARAMS = Type.Object({
  skill: Type.String({ description: "Exact skill name." }),
  arguments: Type.Record(Type.String(), Type.Unknown(), { description: "Skill arguments as a JSON object." }),
});
const EXEC_PARAMS = Type.Object({
  command: Type.String({ description: "Command to execute, e.g. 'load commands/generic-mcp.mjs'." }),
});
const EMPTY_PARAMS = Type.Object({});

function paramsFor(toolName: string) {
  if (toolName.endsWith("_discover")) return DISCOVER_PARAMS;
  if (toolName.endsWith("_call")) return CALL_PARAMS;
  if (toolName.endsWith("_run_skill")) return RUN_SKILL_PARAMS;
  if (toolName === "agent_tools_exec") return EXEC_PARAMS;
  return EMPTY_PARAMS;
}

export default async function (pi: ExtensionAPI) {
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "pi-agent-tools-runtime-extension", version: "0.1.0" },
  });

  const { tools } = (await rpc("tools/list")) as {
    tools: Array<{ name: string; description?: string }>;
  };

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description || tool.name,
      promptSnippet: (tool.description || tool.name).slice(0, 120),
      parameters: paramsFor(tool.name),
      async execute(_toolCallId, params) {
        const result = (await rpc("tools/call", {
          name: tool.name,
          arguments: params,
        })) as { content?: Array<{ type: string; text: string }> };
        return {
          content: result.content ?? [{ type: "text", text: JSON.stringify(result) }],
          details: {},
        };
      },
    });
  }
}
