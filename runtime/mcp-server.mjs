#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { handle } from './agent-tools-runtime.mjs';

const tools = [
  {
    name: 'agent_tools_help',
    description: 'Returns the compact protocol for discovering and executing commands in the persistent Agent Tools runtime.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agent_tools_exec',
    description: 'Executes one validated command in the persistent Agent Tools runtime. Load only the adapter required by the active skill.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'Command to execute, for example: load commands/generic-mcp.mjs' } }, required: ['command'], additionalProperties: false },
  },
];

const help = `Agent Tools runtime\n\n1. agent_tools_help()\n2. agent_tools_exec({ command })\n\nAvailable adapters (load only the one required):\n  commands/generic-mcp.mjs  -> AGENT_MCP_URL, optional AGENT_MCP_TOKEN\n  commands/n8n-mcp.mjs      -> N8N_MCP_URL, optional N8N_MCP_TOKEN/OAuth store\n  commands/rest-api.mjs     -> AGENT_API_BASE_URL, optional AGENT_API_TOKEN\n  commands/local-cli.mjs    -> AGENT_CLI_ALLOWLIST\n\nProgressive disclosure examples:\n  load commands/generic-mcp.mjs\n  mcp-search <query>\n  mcp-describe <tool>\n  mcp-call --confirm <tool> <json>\n  load commands/local-cli.mjs\n  cli-run --confirm <allowlisted-program> [args...]\n\nThe runtime keeps provider credentials on the host and exposes only structured command output.`;

function reply(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function processMessage(message) {
  if (message.method === 'initialize') return reply(message.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agent-tools-runtime', version: '0.8.0' } });
  if (message.method === 'notifications/initialized') return null;
  if (message.method === 'tools/list') return reply(message.id, { tools });
  if (message.method !== 'tools/call') return error(message.id, -32601, `Unsupported method: ${message.method}`);
  const name = message.params?.name;
  if (name === 'agent_tools_help') return reply(message.id, { content: [{ type: 'text', text: help }] });
  if (name !== 'agent_tools_exec') return error(message.id, -32602, `Unknown tool: ${name}`);
  const command = message.params?.arguments?.command;
  if (typeof command !== 'string' || !command.trim()) return error(message.id, -32602, 'command must be a non-empty string');
  const result = await handle({ action: 'exec', command });
  return reply(message.id, { isError: result.code !== 0, content: [{ type: 'text', text: JSON.stringify(result) }] });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  try {
    const result = await processMessage(JSON.parse(line));
    if (result) console.log(JSON.stringify(result));
  } catch (err) {
    console.log(JSON.stringify(error(null, -32603, err.message)));
  }
}
