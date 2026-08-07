#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handle } from './agent-tools-runtime.mjs';
import { closestMatches } from './fuzzy-match.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FACADE_AUTOROUTE_THRESHOLD = 0.6;

const require = createRequire(import.meta.url);
const runtimeVersion = require('../package.json').version;

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

/** Carga un plugin desde su directorio: lee plugin.json, instancia el adapter,
 * importa las skills. Un plugin = { name, prefix, adapter, readonlyTools, skills }. */
async function loadPlugin(pluginDir) {
  const manifestPath = path.join(pluginDir, 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const adapterModule = await import(pathToFileURL(path.join(pluginDir, manifest.adapter)));
  const AdapterClass = adapterModule[manifest.adapterExport];
  const adapter = new AdapterClass();

  const skills = {};
  for (const skillPath of manifest.skills || []) {
    const skillName = path.basename(skillPath, '.mjs');
    skills[skillName] = await import(pathToFileURL(path.join(pluginDir, skillPath)));
  }

  return {
    name: manifest.name,
    prefix: manifest.prefix,
    adapter,
    readonlyTools: new Set(manifest.readonlyTools || []),
    skills,
    discoverHint: manifest.discoverHint || '',
  };
}

const PLUGIN_DIR_PATTERN = /^agent-tools-plugin-/;

/** Subdirectorios inmediatos de `base` cuyo nombre matchea `agent-tools-plugin-*`
 * y que tienen un plugin.json. No recursivo: un plugin es siempre un directorio
 * de primer nivel dentro de `base`. */
async function findPluginDirsIn(base) {
  if (!base || !existsSync(base)) return [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PLUGIN_DIR_PATTERN.test(entry.name)) continue;
    const pluginDir = path.join(base, entry.name);
    if (existsSync(path.join(pluginDir, 'plugin.json'))) dirs.push(pluginDir);
  }
  return dirs;
}

/** Plugins disponibles, escaneados de verdad (no una lista hardcodeada):
 *   1. Directorios agent-tools-plugin-* al lado de runtime/ (el caso de este repo).
 *   2. node_modules/agent-tools-plugin-* (el caso de instalar un plugin via npm).
 *   3. $AGENT_TOOLS_PLUGINS_DIR/agent-tools-plugin-* (una carpeta externa cualquiera,
 *      para poder "soltar" un plugin sin que viva dentro del repo ni de node_modules).
 * Un plugin que falla al cargar se loguea a stderr y se saltea -- no tira abajo
 * el resto de los plugins que sí cargaron bien. */
async function discoverPlugins() {
  const repoRoot = path.join(__dirname, '..');
  const searchRoots = [
    repoRoot,
    path.join(repoRoot, 'node_modules'),
    process.env.AGENT_TOOLS_PLUGINS_DIR,
  ].filter(Boolean);

  const pluginDirs = new Set();
  for (const root of searchRoots) {
    for (const dir of await findPluginDirsIn(root)) pluginDirs.add(dir);
  }

  const plugins = [];
  for (const pluginDir of pluginDirs) {
    try {
      plugins.push(await loadPlugin(pluginDir));
    } catch (e) {
      console.error(`[plugin] no se pudo cargar '${pluginDir}': ${e.message}`);
    }
  }
  return plugins;
}

function buildFacadeToolsForPlugin(plugin) {
  const p = plugin.prefix;
  const skillNames = Object.keys(plugin.skills);
  const skillsDoc = skillNames
    .map((name) => `${name} (agent_tools_${p}_run_skill)`)
    .join(', ');
  return [
    {
      name: `agent_tools_${p}_discover`,
      description: `Busca tools de ${plugin.name} disponibles por texto libre (sin query, lista las más comunes). ${plugin.discoverHint}`,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Texto de búsqueda' } },
        additionalProperties: false,
      },
    },
    {
      name: `agent_tools_${p}_call`,
      description: `Llama una tool de ${plugin.name} con argumentos JSON estructurados. Valida los argumentos contra el schema de la tool antes de reenviar. Las tools que mutan estado requieren confirm:true.`,
      inputSchema: {
        type: 'object',
        properties: {
          toolName: { type: 'string', description: `Nombre exacto de la tool de ${plugin.name}` },
          arguments: { type: 'object', description: 'Argumentos de la tool como objeto JSON' },
          confirm: { type: 'boolean', description: 'true para permitir tools que mutan estado' },
        },
        required: ['toolName'],
        additionalProperties: false,
      },
    },
    ...(skillNames.length ? [{
      name: `agent_tools_${p}_run_skill`,
      description: `Ejecuta una receta del lado del server para una tarea completa de ${plugin.name}. Preferir sobre agent_tools_${p}_call cuando exista una skill para la tarea. Skills disponibles: ${skillsDoc}.`,
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Nombre exacto de la skill' },
          arguments: { type: 'object', description: 'Argumentos de la skill' },
        },
        required: ['skill', 'arguments'],
        additionalProperties: false,
      },
    }] : []),
  ];
}

async function handleDiscover(plugin, args) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  let matches;
  try {
    if (query) {
      const searchResult = await plugin.adapter.search(query, 8);
      matches = searchResult.matches;
    } else {
      const listed = await plugin.adapter.listTools();
      matches = (listed.tools || []).slice(0, 15).map((t) => ({ name: t.name, description: t.description || '' }));
    }
  } catch (e) {
    return jsonContent({ isError: true, error: e.message });
  }
  const context = plugin.adapter.discoverContext ? await plugin.adapter.discoverContext() : undefined;
  return jsonContent({ query: query || null, matches, ...(context ? { context } : {}) });
}

async function handleCall(plugin, args) {
  const toolName = args?.toolName;
  const toolArgs = args?.arguments && typeof args.arguments === 'object' ? args.arguments : {};
  const confirm = args?.confirm === true;

  if (!toolName) return jsonContent({ isError: true, error: 'toolName is required' });

  let tool;
  try {
    tool = await plugin.adapter.describe(toolName);
  } catch {
    return jsonContent({ isError: true, error: `Unknown ${plugin.name} tool: ${toolName}` });
  }

  const schemaErrors = validateArguments(tool.inputSchema, toolArgs);
  if (schemaErrors.length) {
    return jsonContent({ isError: true, error: 'Argument validation failed', details: schemaErrors, schema: tool.inputSchema });
  }

  if (!plugin.readonlyTools.has(toolName) && !confirm) {
    return jsonContent({ isError: true, error: `Confirmation required for mutating ${plugin.name} tool: ${toolName}. Pass confirm: true.` });
  }

  try {
    const result = await plugin.adapter.call(toolName, toolArgs);
    return jsonContent({ isError: false, result: extractContentJson(result) });
  } catch (e) {
    return jsonContent({ isError: true, error: e.message });
  }
}

async function handleRunSkill(plugin, args) {
  const skillName = args?.skill;
  const skillArgs = args?.arguments && typeof args.arguments === 'object' ? args.arguments : {};
  const skill = plugin.skills[skillName];
  if (!skill) {
    const names = Object.keys(plugin.skills);
    const hint = names.length ? ` Skills disponibles: ${names.join(', ')}.` : '';
    return jsonContent({ isError: true, error: `Unknown skill: ${skillName}.${hint}` });
  }
  try {
    const result = await skill.run(plugin.adapter, skillArgs);
    return jsonContent(result);
  } catch (e) {
    return jsonContent({ isError: true, error: e.message });
  }
}

const help = `Agent Tools runtime\n\n1. agent_tools_help()\n2. agent_tools_exec({ command })\n3. Por cada plugin cargado: agent_tools_<prefix>_discover({ query? }) / agent_tools_<prefix>_call({ toolName, arguments, confirm? }) / agent_tools_<prefix>_run_skill({ skill, arguments })\n\nAvailable adapters via text protocol (load only the one required):\n  commands/generic-mcp.mjs  -> AGENT_MCP_URL, optional AGENT_MCP_TOKEN\n  commands/n8n-mcp.mjs      -> N8N_MCP_URL, optional N8N_MCP_TOKEN/OAuth store\n  commands/rest-api.mjs     -> AGENT_API_BASE_URL, optional AGENT_API_TOKEN\n  commands/local-cli.mjs    -> AGENT_CLI_ALLOWLIST\n\nThe runtime keeps provider credentials on the host and exposes only structured command output.`;

function reply(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function main() {
  const plugins = await discoverPlugins();
  // toolName -> { plugin, kind: 'discover'|'call'|'run_skill' }
  const routes = new Map();
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

  for (const plugin of plugins) {
    for (const toolDef of buildFacadeToolsForPlugin(plugin)) {
      tools.push(toolDef);
      const kind = toolDef.name.endsWith('_discover') ? 'discover'
        : toolDef.name.endsWith('_call') ? 'call' : 'run_skill';
      routes.set(toolDef.name, { plugin, kind });
    }
  }

  const facadeToolNames = tools.map((t) => t.name);

  async function processMessage(message) {
    if (message.method === 'initialize') return reply(message.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agent-tools-runtime', version: runtimeVersion } });
    if (message.method === 'notifications/initialized') return null;
    if (message.method === 'tools/list') return reply(message.id, { tools });
    if (message.method !== 'tools/call') return error(message.id, -32601, `Unsupported method: ${message.method}`);

    const name = message.params?.name;
    const args = message.params?.arguments || {};

    // Fuzzy-match del nombre de tool de la fachada: el conjunto de candidatos es
    // fijo y chico por sesión, así que auto-enrutar un typo es de bajo riesgo (a
    // diferencia del toolName interno de cada plugin, que puede disparar una
    // acción real y por eso solo sugiere, ver handleCall/adapter.describe).
    let resolvedName = name;
    if (!facadeToolNames.includes(name)) {
      const shapeMatch = 'skill' in args
        ? facadeToolNames.find((n) => n.endsWith('_run_skill'))
        : 'toolName' in args
          ? facadeToolNames.find((n) => n.endsWith('_call'))
          : ('query' in args && !('toolName' in args))
            ? facadeToolNames.find((n) => n.endsWith('_discover'))
            : null;
      const [best] = closestMatches(name || '', facadeToolNames, 1);
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
      const route = routes.get(resolvedName);
      if (route) {
        const handler = route.kind === 'discover' ? handleDiscover
          : route.kind === 'call' ? handleCall : handleRunSkill;
        const result = await handler(route.plugin, args);
        const payload = JSON.parse(result.content[0].text);
        return reply(message.id, { isError: Boolean(payload.isError), ...result });
      }

      if (resolvedName !== 'agent_tools_exec') {
        const [best] = closestMatches(name || '', facadeToolNames, 1);
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
}

main();
