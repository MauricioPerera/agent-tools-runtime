#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handle } from './agent-tools-runtime.mjs';
import { closestMatches } from './fuzzy-match.mjs';
import { hintFor } from './error-hints.mjs';

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

const AGENT_PLUGINS_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const EXT_NAMESPACE = 'dev.agent-tools-runtime';

/** Carga un plugin desde su directorio: lee plugin.json, instancia el adapter,
 * importa las skills. Un plugin = { name, prefix, adapter, readonlyTools, skills }.
 *
 * El manifest es un plugin.json conforme a la Agent Plugins Specification 1.0.0
 * (https://github.com/agentplugins/agent-plugins-spec) -- validado contra
 * plugin.schema.json, no solo con esta forma esperada de memoria. Ese spec
 * define plugin.json como metadata pura (name/version/author/...) más un
 * namespace `extensions` para datos específicos de cada runtime; lo que antes
 * vivía plano en la raíz del manifest (adapter, skills, readonlyTools) ahora
 * vive en `extensions["dev.agent-tools-runtime"]` -- el spec no le asigna
 * semántica al contenido de ese namespace, así que agent-tools-runtime es
 * libre de definir la suya ahí. Ver plugin.json de cualquier agent-tools-plugin-. */
async function loadPlugin(pluginDir) {
  const manifestPath = path.join(pluginDir, 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  if (manifest.$schema !== AGENT_PLUGINS_SCHEMA) {
    throw new Error(`plugin.json no declara $schema: "${AGENT_PLUGINS_SCHEMA}" (Agent Plugins Spec 1.0.0)`);
  }
  const ext = manifest.extensions?.[EXT_NAMESPACE];
  if (!ext) {
    throw new Error(`plugin.json no tiene extensions["${EXT_NAMESPACE}"] -- nada que agent-tools-runtime pueda cargar`);
  }

  const adapterModule = await import(pathToFileURL(path.join(pluginDir, ext.adapter)));
  const AdapterClass = adapterModule[ext.adapterExport];
  const adapter = new AdapterClass();

  const skills = {};
  for (const skillPath of ext.skills || []) {
    const skillName = path.basename(skillPath, '.mjs');
    skills[skillName] = await import(pathToFileURL(path.join(pluginDir, skillPath)));
  }

  return {
    name: manifest.name,
    description: manifest.description || '',
    prefix: ext.prefix,
    adapter,
    readonlyTools: new Set(ext.readonlyTools || []),
    // Default true (opt-out, not opt-in): a plugin.json that omits this field keeps
    // gating every non-readonly tool behind confirm:true, same as before this field
    // existed. Only a plugin.json that explicitly sets requireConfirm:false skips it
    // -- currently just agent-tools-plugin-n8n, by its own project's choice, not a
    // runtime-wide default.
    requireConfirm: ext.requireConfirm !== false,
    skills,
    discoverHint: ext.discoverHint || '',
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

/** Sube desde `startDir` por cada directorio padre hasta la raíz del filesystem,
 * juntando un candidato `<ancestro>/node_modules` en cada nivel -- misma lógica
 * que usa la resolución de módulos de Node para encontrar node_modules "hacia
 * arriba". Necesario porque cuando este paquete se instala como dependencia
 * (node_modules/@rckflr/agent-tools-runtime/runtime/mcp-server.mjs), su propio
 * node_modules/ anidado casi nunca existe -- npm hoistea los plugins al
 * node_modules/ del proyecto consumidor, uno o más niveles arriba. */
function ancestorNodeModulesDirs(startDir) {
  const dirs = [];
  let current = startDir;
  while (true) {
    dirs.push(path.join(current, 'node_modules'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/** Plugins disponibles, escaneados de verdad (no una lista hardcodeada):
 *   1. Directorios agent-tools-plugin-* al lado de runtime/ (el caso de este repo).
 *   2. node_modules/agent-tools-plugin-* en este paquete o en cualquier ancestro
 *      (el caso de instalar un plugin via npm, incluido cuando el runtime mismo
 *      vive dentro del node_modules/ de otro proyecto).
 *   3. $AGENT_TOOLS_PLUGINS_DIR/agent-tools-plugin-* (una carpeta externa cualquiera,
 *      para poder "soltar" un plugin sin que viva dentro del repo ni de node_modules).
 * Un plugin que falla al cargar se loguea a stderr y se saltea -- no tira abajo
 * el resto de los plugins que sí cargaron bien. */
async function discoverPlugins() {
  const repoRoot = path.join(__dirname, '..');
  const searchRoots = [
    repoRoot,
    ...ancestorNodeModulesDirs(repoRoot),
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
      // Encontrado en vivo: con dos plugins del mismo dominio cargados
      // (github REST y ghcli), un agente que ya había elegido este prefix
      // nunca se enteró de que el otro existía -- discover() es por-plugin,
      // no ve el resto de la flota. agent_tools_help() sí lista todos los
      // plugins cargados (ver buildHelp), pero nada empujaba a llamarlo antes
      // de comprometerse con el primer prefix que sonara obvio. Este aviso
      // vive acá, en la descripción de la tool donde el agente ya está parado
      // -- en vez de confiar en que descubra help() por su cuenta.
      description: `Busca tools de ${plugin.name} disponibles por texto libre (sin query, lista las más comunes). Si esto no cubre lo que necesitás, puede haber OTRO plugin cargado para el mismo dominio con otras capacidades -- llamá agent_tools_help() para ver la lista completa de plugins antes de asumir que este es el único. ${plugin.discoverHint}`,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Texto de búsqueda' } },
        additionalProperties: false,
      },
    },
    {
      name: `agent_tools_${p}_call`,
      description: plugin.requireConfirm
        ? `Llama una tool de ${plugin.name} con argumentos JSON estructurados. Valida los argumentos contra el schema de la tool antes de reenviar. Las tools que mutan estado requieren confirm:true.`
        : `Llama una tool de ${plugin.name} con argumentos JSON estructurados. Valida los argumentos contra el schema de la tool antes de reenviar. Este plugin no exige confirm:true para tools que mutan estado -- se ejecutan directamente, sin ese freno.`,
      inputSchema: {
        type: 'object',
        properties: {
          toolName: { type: 'string', description: `Nombre exacto de la tool de ${plugin.name}` },
          arguments: { type: 'object', description: 'Argumentos de la tool como objeto JSON' },
          confirm: plugin.requireConfirm
            ? { type: 'boolean', description: 'true para permitir tools que mutan estado' }
            : { type: 'boolean', description: 'Sin efecto en este plugin: las tools que mutan estado no requieren confirm.' },
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

/** Busca en los `meta` de las skills del plugin (name/description/args por
 * skill, ver `export const meta` en cada skills/*.mjs) con el mismo scoring
 * simple por term-match que usa adapter.search() para las tools crudas --
 * name match pesa mas que description/args match.
 *
 * Por que hace falta: el nombre de cada skill ya aparece siempre en la
 * description de agent_tools_<prefix>_run_skill (barato, always-on), pero sus
 * argumentos/modos NO -- meterlos ahi infla esa description por cada skill del
 * plugin en cada sesion, la usen o no. Encontrado en vivo: un agente real usó
 * audit-workflows una sola vez con el mode default y reconstruyo a mano (con
 * tools sueltas + scripts locales) exactamente lo que mode:"nativeAudit" /
 * "executions" / "credentials" ya le habrian dado en una llamada, porque no
 * tenia forma de enterarse de que esos modos existian sin leer el codigo
 * fuente. discover() ya es el mecanismo on-demand que un agente usa cuando
 * necesita buscar algo puntual -- sumar skills ahi (solo cuando hay query,
 * cero costo si no se pregunta) es la misma solucion que search_workflows /
 * find-workflows le da a las tools crudas, aplicada a las skills. */
function searchSkills(skills, query, limit) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return Object.entries(skills)
    .map(([name, mod]) => {
      const meta = mod.meta || {};
      const haystack = `${name} ${meta.description || ''} ${meta.args || ''}`.toLowerCase();
      const score = terms.reduce((sum, term) => {
        if (!haystack.includes(term)) return sum;
        return sum + (name.toLowerCase().includes(term) ? 3 : 1);
      }, 0);
      const entry = { kind: 'skill', name, description: meta.description || '', args: meta.args || '' };
      if (meta.related?.length) entry.related = meta.related;
      return { ...entry, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...rest }) => rest);
}

/** Un salto de grafo, no un motor de traversal: `meta.related` en una skill
 * (ver skills/*.mjs) puede listar `{ target: "prefix:skill-name", why }` --
 * otras skills (mismo plugin o de otro) que conviene mirar desde acá. El caso
 * real que motivó esto: agent-tools-plugin-github y agent-tools-plugin-gh-cli
 * cubren el mismo dominio (ambos tienen una skill `repo-overview`), pero
 * `agent_tools_help()` (que lista los 6 plugins juntos, sin decir cuál se
 * relaciona con cuál) resultó insuficiente para que un agente ya parado en
 * uno encontrara el otro sin que se lo nombraran explícito -- un `related`
 * apunta directo al vecino en vez de hacer que el agente adivine entre 6.
 *
 * Alcance a propósito: solo valida que el target sea una SKILL real de un
 * plugin cargado, no una tool cruda -- el catálogo de tools de un adapter a
 * veces solo se conoce tras conectar en vivo (n8n, pocketbase), y esto corre
 * al arranque, antes de que nada se conecte. Un target roto (plugin borrado,
 * typo, skill renombrada) no tumba el arranque -- se loguea a stderr, mismo
 * criterio que un plugin que falla al cargar, porque es metadata de
 * discoverabilidad, no una dependencia funcional. */
function validateRelatedLinks(plugins) {
  const byPrefix = new Map(plugins.map((p) => [p.prefix, p]));
  for (const plugin of plugins) {
    for (const [skillName, mod] of Object.entries(plugin.skills)) {
      for (const rel of mod.meta?.related || []) {
        const [targetPrefix, targetSkill] = String(rel.target || '').split(':');
        const targetPlugin = byPrefix.get(targetPrefix);
        if (!targetPlugin || !targetPlugin.skills[targetSkill]) {
          console.error(`[related] ${plugin.prefix}:${skillName} -> '${rel.target}' no resuelve (¿plugin/skill borrado o renombrado?)`);
        }
      }
    }
  }
}

async function handleDiscover(plugin, args) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  let matches;
  try {
    if (query) {
      const searchResult = await plugin.adapter.search(query, 8);
      const skillMatches = searchSkills(plugin.skills, query, 5);
      matches = [...skillMatches, ...searchResult.matches];
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

  if (!toolName) return jsonContent({ isError: true, code: 'MISSING_TOOL_NAME', error: 'toolName is required', hint: hintFor('MISSING_TOOL_NAME') });

  let tool;
  try {
    tool = await plugin.adapter.describe(toolName);
  } catch {
    return jsonContent({ isError: true, code: 'UNKNOWN_TOOL', error: `Unknown ${plugin.name} tool: ${toolName}`, hint: hintFor('UNKNOWN_TOOL') });
  }

  const schemaErrors = validateArguments(tool.inputSchema, toolArgs);
  if (schemaErrors.length) {
    return jsonContent({ isError: true, code: 'ARG_VALIDATION_FAILED', error: 'Argument validation failed', details: schemaErrors, schema: tool.inputSchema, hint: hintFor('ARG_VALIDATION_FAILED') });
  }

  if (plugin.requireConfirm && !plugin.readonlyTools.has(toolName) && !confirm) {
    return jsonContent({ isError: true, code: 'CONFIRM_REQUIRED', error: `Confirmation required for mutating ${plugin.name} tool: ${toolName}. Pass confirm: true.`, hint: hintFor('CONFIRM_REQUIRED') });
  }

  try {
    const result = await plugin.adapter.call(toolName, toolArgs);
    return jsonContent({ isError: false, result: extractContentJson(result) });
  } catch (e) {
    return jsonContent({ isError: true, error: e.message });
  }
}

async function handleRunSkill(plugin, args) {
  let skillName = args?.skill;
  let skillArgs = args?.arguments && typeof args.arguments === 'object' ? args.arguments : {};

  // Encontrado en vivo: un modelo llamó esta tool con TODO el payload
  // envuelto en un 'arguments' de más -- { arguments: { arguments: {...},
  // skill: "..." } } en vez de { skill: "...", arguments: {...} } al nivel
  // que espera esta tool. Resultado observado: "Unknown skill: undefined" en
  // 6 intentos seguidos con la misma forma mal anidada, antes de que el
  // modelo la corrigiera solo por prueba y error -- el mensaje de error no
  // daba ninguna pista de la causa real. Ninguna skill real usa un argumento
  // llamado "skill", así que si el nivel de arriba no trae skill pero sí hay
  // un args.arguments.skill (string), es inequívoco: se anidó un nivel de
  // más. Se desenvuelve automáticamente -- mismo criterio que el fuzzy-route
  // de nombres de tool más abajo (recuperar solo cuando no hay ambigüedad,
  // loguear para debug, no forzar al modelo a adivinar la forma a los
  // tumbos).
  if (!skillName && args?.arguments && typeof args.arguments === 'object' && typeof args.arguments.skill === 'string') {
    const { skill: innerSkill, arguments: innerArgs, ...rest } = args.arguments;
    console.error(`[run_skill] argumentos anidados de más -- desenvolviendo automáticamente ('${innerSkill}')`);
    skillName = innerSkill;
    skillArgs = innerArgs && typeof innerArgs === 'object' ? innerArgs : rest;
  }

  const skill = plugin.skills[skillName];
  if (!skill) {
    const names = Object.keys(plugin.skills);
    const skillsList = names.length ? ` Skills disponibles: ${names.join(', ')}.` : '';
    return jsonContent({ isError: true, code: 'UNKNOWN_SKILL', error: `Unknown skill: ${skillName}.${skillsList}`, hint: hintFor('UNKNOWN_SKILL') });
  }
  try {
    const result = await skill.run(plugin.adapter, skillArgs);
    return jsonContent(result);
  } catch (e) {
    return jsonContent({ isError: true, error: e.message });
  }
}

const HELP_HEADER = `Agent Tools runtime\n\n1. agent_tools_help()\n2. agent_tools_exec({ command })\n3. Por cada plugin cargado: agent_tools_<prefix>_discover({ query? }) / agent_tools_<prefix>_call({ toolName, arguments, confirm? }) / agent_tools_<prefix>_run_skill({ skill, arguments })\n\nAvailable adapters via text protocol (load only the one required):\n  commands/generic-mcp.mjs  -> AGENT_MCP_URL, optional AGENT_MCP_TOKEN\n  commands/n8n-mcp.mjs      -> N8N_MCP_URL, optional N8N_MCP_TOKEN/OAuth store\n  commands/rest-api.mjs     -> AGENT_API_BASE_URL, optional AGENT_API_TOKEN\n  commands/local-cli.mjs    -> AGENT_CLI_ALLOWLIST\n\nThe runtime keeps provider credentials on the host and exposes only structured command output.`;

// Encontrado en vivo: con dos plugins de dominio GitHub cargados a la vez
// (github vía REST, ghcli vía el binario gh), un agente que ya había elegido
// "github" para una tarea nunca se enteró de que "ghcli" existía y podía
// cubrir lo que al primero le faltaba (pr_list) -- discover() es por-plugin,
// no hay forma de ver el resto desde adentro de uno ya elegido. Listar acá
// TODOS los plugins cargados (prefix + una línea de qué es cada uno) es el
// único punto de entrada que sí ve la flota completa de una sola vez, antes
// de comprometerse a un prefix -- barato porque solo se paga si el agente
// llama agent_tools_help() explícitamente, no en cada discover().
function buildHelp(plugins) {
  const pluginLines = plugins.map((p) => `  ${p.prefix.padEnd(8)} (agent_tools_${p.prefix}_*) -- ${p.description || p.name}`).join('\n');
  const pluginsSection = plugins.length
    ? `\n\nPlugins cargados (elegí el prefix que corresponda ANTES de llamar discover -- puede haber más de uno para el mismo dominio, con capacidades distintas):\n${pluginLines}`
    : '';
  return `${HELP_HEADER}${pluginsSection}`;
}

function reply(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function main() {
  const plugins = await discoverPlugins();
  validateRelatedLinks(plugins);
  const help = buildHelp(plugins);
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
        const suggestion = best ? ` ¿Quisiste decir: ${best.name}?` : '';
        return error(message.id, -32602, `Unknown tool: ${name}.${suggestion} ${hintFor('UNKNOWN_FACADE_TOOL')}`);
      }
      const command = args.command;
      if (typeof command !== 'string' || !command.trim()) return error(message.id, -32602, `command must be a non-empty string. ${hintFor('EMPTY_COMMAND')}`);
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
