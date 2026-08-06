#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { handle } from './agent-tools-runtime.mjs';
import { N8nMcpAdapter, closestMatches } from '../adapters/n8n-mcp.mjs';

const FACADE_TOOL_NAMES = ['agent_tools_help', 'agent_tools_exec', 'agent_tools_n8n_discover', 'agent_tools_n8n_call'];
const FACADE_AUTOROUTE_THRESHOLD = 0.6;

const require = createRequire(import.meta.url);
const runtimeVersion = require('../package.json').version;

const n8nAdapter = new N8nMcpAdapter();

// Mismo criterio que commands/n8n-mcp.mjs: tools de solo lectura no requieren confirm.
const N8N_READONLY_TOOLS = new Set([
  'search_workflows', 'get_workflow_details', 'get_workflow_history', 'get_workflow_version',
  'search_executions', 'get_execution', 'search_nodes', 'get_node_types',
  'get_workflow_best_practices', 'explore_node_resources', 'validate_workflow',
  'validate_node_config', 'get_sdk_reference', 'list_credentials', 'list_tags',
  'search_projects', 'search_folders', 'search_data_tables',
]);

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
  {
    name: 'agent_tools_n8n_discover',
    description: 'Busca tools de n8n disponibles por texto libre (sin query, lista las más comunes). Siempre devuelve también el proyecto personal accesible (context.personalProject) para no tener que adivinar projectId.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Texto de búsqueda, por ejemplo "create workflow" o "data table"' } },
      additionalProperties: false,
    },
  },
  {
    name: 'agent_tools_n8n_call',
    description: 'Llama una tool de n8n con argumentos JSON estructurados (objeto nativo, sin comillas de shell). Valida los argumentos contra el schema de la tool antes de reenviar. Las tools que mutan estado requieren confirm:true.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'Nombre exacto de la tool de n8n, ej: create_data_table' },
        arguments: { type: 'object', description: 'Argumentos de la tool como objeto JSON' },
        confirm: { type: 'boolean', description: 'true para permitir tools que mutan estado' },
      },
      required: ['toolName'],
      additionalProperties: false,
    },
  },
];

const help = `Agent Tools runtime\n\n1. agent_tools_help()\n2. agent_tools_exec({ command })\n3. agent_tools_n8n_discover({ query? }) / agent_tools_n8n_call({ toolName, arguments, confirm? })\n\nAvailable adapters (load only the one required):\n  commands/generic-mcp.mjs  -> AGENT_MCP_URL, optional AGENT_MCP_TOKEN\n  commands/n8n-mcp.mjs      -> N8N_MCP_URL, optional N8N_MCP_TOKEN/OAuth store\n  commands/rest-api.mjs     -> AGENT_API_BASE_URL, optional AGENT_API_TOKEN\n  commands/local-cli.mjs    -> AGENT_CLI_ALLOWLIST\n\nProgressive disclosure examples:\n  load commands/generic-mcp.mjs\n  mcp-search <query>\n  mcp-describe <tool>\n  mcp-call --confirm <tool> <json>\n  load commands/local-cli.mjs\n  cli-run --confirm <allowlisted-program> [args...]\n\nFor n8n specifically, prefer the typed facade over text commands:\n  agent_tools_n8n_discover({ query: "create workflow" })\n  agent_tools_n8n_call({ toolName: "create_data_table", arguments: { name: "x", columns: [...] }, confirm: true })\n\nThe runtime keeps provider credentials on the host and exposes only structured command output.`;

function reply(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function jsonContent(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function extractContentJson(mcpResult) {
  const text = mcpResult?.content?.[0]?.text;
  if (typeof text !== 'string') return mcpResult;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** Validador mínimo de JSON Schema (sin dependencias): required + type de primer nivel. */
function validateArguments(schema, args) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  const provided = args && typeof args === 'object' ? args : {};
  for (const key of schema.required || []) {
    if (!(key in provided)) errors.push(`Missing required argument: ${key}`);
  }
  const props = schema.properties || {};
  for (const [key, value] of Object.entries(provided)) {
    const propSchema = props[key];
    if (!propSchema || !propSchema.type) continue;
    const expected = Array.isArray(propSchema.type) ? propSchema.type : [propSchema.type];
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const numericOk = actual === 'number' && expected.includes('integer');
    if (!expected.includes(actual) && !numericOk) {
      errors.push(`Argument '${key}' expected type ${expected.join('|')}, got ${actual}`);
    }
  }
  return errors;
}

async function handleN8nDiscover(args) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  let matches;
  try {
    if (query) {
      const searchResult = await n8nAdapter.search(query, 8);
      matches = searchResult.matches;
    } else {
      const listed = await n8nAdapter.listTools();
      matches = (listed.tools || []).slice(0, 15).map((t) => ({ name: t.name, description: t.description || '' }));
    }
  } catch (e) {
    return jsonContent({ isError: true, error: e.message });
  }

  let personalProject = null;
  try {
    const raw = await n8nAdapter.call('search_projects', {});
    const parsed = extractContentJson(raw);
    const list = parsed?.data || [];
    personalProject = list.find((p) => p.type === 'personal') || list[0] || null;
  } catch { /* best-effort: si falla, seguimos sin contexto de proyecto */ }

  return jsonContent({
    query: query || null,
    matches,
    context: {
      personalProject,
      hint: 'Si el usuario no nombró un proyecto específico, omití projectId al crear workflows; create_data_table sí requiere el id del proyecto personal devuelto aquí.',
    },
  });
}

async function handleN8nCall(args) {
  const toolName = args?.toolName;
  const toolArgs = args?.arguments && typeof args.arguments === 'object' ? args.arguments : {};
  const confirm = args?.confirm === true;

  if (!toolName) return jsonContent({ isError: true, error: 'toolName is required' });

  let tool;
  try {
    tool = await n8nAdapter.describe(toolName);
  } catch {
    return jsonContent({ isError: true, error: `Unknown n8n tool: ${toolName}` });
  }

  const schemaErrors = validateArguments(tool.inputSchema, toolArgs);
  if (schemaErrors.length) {
    return jsonContent({ isError: true, error: 'Argument validation failed', details: schemaErrors, schema: tool.inputSchema });
  }

  if (!N8N_READONLY_TOOLS.has(toolName) && !confirm) {
    return jsonContent({ isError: true, error: `Confirmation required for mutating n8n tool: ${toolName}. Pass confirm: true.` });
  }

  try {
    const result = await n8nAdapter.call(toolName, toolArgs);
    return jsonContent({ isError: false, result: extractContentJson(result) });
  } catch (e) {
    return jsonContent({ isError: true, error: e.message });
  }
}

async function processMessage(message) {
  if (message.method === 'initialize') return reply(message.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agent-tools-runtime', version: runtimeVersion } });
  if (message.method === 'notifications/initialized') return null;
  if (message.method === 'tools/list') return reply(message.id, { tools });
  if (message.method !== 'tools/call') return error(message.id, -32601, `Unsupported method: ${message.method}`);

  const name = message.params?.name;
  const args = message.params?.arguments || {};

  // Fuzzy-match del nombre de tool de la fachada (agent_tools_*): el conjunto de
  // candidatos es fijo y chico, así que auto-enrutar un typo es de bajo riesgo
  // (a diferencia del toolName interno de n8n, que puede disparar una acción real
  // y por eso solo sugiere, ver handleN8nCall/describe en n8n-mcp.mjs).
  let resolvedName = name;
  if (!FACADE_TOOL_NAMES.includes(name)) {
    // La forma de los argumentos es una señal más fuerte que la similitud de texto
    // para desambiguar discover vs call (ej. "agent_tools_n8n_search" con {query}
    // matchea por texto contra *_call, pero semánticamente es un discover).
    const shapeMatch = 'toolName' in args ? 'agent_tools_n8n_call'
      : ('query' in args && !('toolName' in args)) ? 'agent_tools_n8n_discover'
      : null;
    const [best] = closestMatches(name || '', FACADE_TOOL_NAMES, 1);
    const route = shapeMatch || (best && best.similarity >= FACADE_AUTOROUTE_THRESHOLD ? best.name : null);
    if (route) {
      console.error(`[fuzzy-route] '${name}' -> '${route}' (${shapeMatch ? 'por forma de argumentos' : `similitud ${best.similarity.toFixed(2)}`})`);
      resolvedName = route;
    }
  }

  if (resolvedName === 'agent_tools_help') return reply(message.id, { content: [{ type: 'text', text: help }] });

  // Defensa en profundidad: cualquier excepción no prevista en el dispatch de
  // tools/call responde con reply(message.id, ...) en vez de escapar hacia el
  // catch global, que respondería con id:null y cuelga al cliente MCP.
  try {
    if (resolvedName === 'agent_tools_n8n_discover') {
      const result = await handleN8nDiscover(args);
      return reply(message.id, result);
    }

    if (resolvedName === 'agent_tools_n8n_call') {
      const result = await handleN8nCall(args);
      const payload = JSON.parse(result.content[0].text);
      return reply(message.id, { isError: Boolean(payload.isError), ...result });
    }

    if (resolvedName !== 'agent_tools_exec') {
      const [best] = closestMatches(name || '', FACADE_TOOL_NAMES, 1);
      const hint = best ? ` ¿Quisiste decir: ${best.name}?` : '';
      return error(message.id, -32602, `Unknown tool: ${name}.${hint}`);
    }
    const command = args.command;
    if (typeof command !== 'string' || !command.trim()) return error(message.id, -32602, 'command must be a non-empty string');
    const loadMatch = command.match(/^load\s+([^\s]+)$/);
    const action = command === 'status'
      ? { action: 'status' }
      : command === 'list'
        ? { action: 'list' }
        : loadMatch
          ? { action: 'load', module: loadMatch[1] }
          : { action: 'exec', command };
    const result = await handle(action);
    return reply(message.id, { isError: result.code !== 0, content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (e) {
    return reply(message.id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ isError: true, error: e.message }) }] });
  }
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
