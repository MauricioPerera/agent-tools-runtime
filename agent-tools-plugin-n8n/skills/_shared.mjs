// Helpers compartidos entre skills. Extraido despues de encontrar el mismo bug
// (isFailure no detectaba errores de MCP devueltos como texto plano, no JSON)
// duplicado en insert-and-verify-datatable-row.mjs y data-table-crud.mjs.

export function extractContentJson(mcpResult) {
  const text = mcpResult?.content?.[0]?.text;
  if (typeof text !== 'string') return mcpResult;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function callTool(n8nAdapter, name, args) {
  const raw = await n8nAdapter.call(name, args);
  return extractContentJson(raw);
}

/** Las respuestas crudas del n8n MCP no son consistentes en como marcan error:
 * unas traen isError, otras success:false, otras solo un campo error suelto, y
 * otras ni siquiera son JSON valido -- el "tool call error" del protocolo MCP
 * llega como content[0].text en texto plano (ej. "MCP error -32602: Input
 * validation error..."), que extractContentJson no puede parsear y devuelve como
 * { raw: <texto> }. Ese shape también cuenta como fallo: ninguna respuesta
 * exitosa de estas tools es texto plano, siempre es JSON con datos reales. */
export function isFailure(result) {
  if (!result) return true;
  if (result.isError) return true;
  if (result.success === false) return true;
  if (typeof result.raw === 'string') return true;
  if (result.error && !(result.id || result.workflowId || result.dataTableId)) return true;
  return false;
}

export async function resolvePersonalProjectId(n8nAdapter) {
  try {
    const projects = await callTool(n8nAdapter, 'search_projects', {});
    const list = projects?.data || [];
    return (list.find((p) => p.type === 'personal') || list[0] || {}).id || null;
  } catch { return null; }
}

const N8N_MCP_URL_DEFAULT = 'https://ardf.dev/mcp-server/http';
const MCP_PATH_SUFFIX = '/mcp-server/http';

/** N8N_INSTANCE_URL is the single recommended variable for the whole plugin: set it once
 * (e.g. "https://ardf.dev") and both this REST base and the adapter's MCP endpoint
 * (adapter.mjs's resolveMcpUrl(), which appends /mcp-server/http) derive from it -- no
 * separate REST vs MCP configuration needed. Resolution order:
 *   1. an explicit `url` argument on the call (per-call override)
 *   2. N8N_INSTANCE_URL (the recommended single source of truth)
 *   3. N8N_MCP_URL (or the adapter's own default) with the known /mcp-server/http
 *      suffix stripped -- kept only as a fallback for setups from before
 *      N8N_INSTANCE_URL existed, or where REST and MCP genuinely live on different hosts */
export function resolveInstanceUrl(explicitUrl) {
  if (explicitUrl) return explicitUrl.replace(/\/+$/, '');
  if (process.env.N8N_INSTANCE_URL) return process.env.N8N_INSTANCE_URL.replace(/\/+$/, '');
  const mcpUrl = process.env.N8N_MCP_URL || N8N_MCP_URL_DEFAULT;
  const base = mcpUrl.endsWith(MCP_PATH_SUFFIX) ? mcpUrl.slice(0, -MCP_PATH_SUFFIX.length) : mcpUrl;
  return base.replace(/\/+$/, '');
}

/** n8n's own MCP tool (search_workflows) caps at limit<=200 with no cursor/offset --
 * calling it repeatedly with different `skip`/`offset` values does nothing, because
 * those parameters don't exist on that tool at all (verified: its real schema is only
 * limit/projectId/query/sortBy/tags). The REST API's GET /workflows, by contrast, has
 * real cursor pagination (nextCursor). This is the one place that walks it fully --
 * used by both delete-workflows-bulk and find-workflows, so "get every workflow, no
 * silent cap" only has to be implemented and tested once. */
export async function fetchAllWorkflows(url, apiKey) {
  const headers = { accept: 'application/json', 'X-N8N-API-KEY': apiKey };
  let all = [];
  let cursor = null;
  do {
    const listUrl = `${url}/api/v1/workflows?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const resp = await fetch(listUrl, { headers });
    let body = null;
    try { body = await resp.json(); } catch { /* respuesta no-JSON, body queda null */ }
    if (!resp.ok) {
      const error = new Error(body?.message || `HTTP ${resp.status}`);
      error.status = resp.status;
      error.raw = body;
      throw error;
    }
    all = all.concat(body?.data || []);
    cursor = body?.nextCursor || null;
  } while (cursor);
  return all;
}

/** Igual patron que fetchAllWorkflows (REST /api/v1/executions, cursor real,
 * a diferencia de search_executions via MCP que tope en limit<=200 sin
 * paginacion que funcione). A diferencia de workflows -- que en una instancia
 * real son a lo sumo miles -- las ejecuciones pueden estar en el orden de
 * millones (IDs de ejecucion ya en ~4.5M en esta instancia), asi que esta
 * funcion SIEMPRE tiene un tope (maxFetch, default 500) para no traer todo
 * el historial a memoria por accidente; quien la llama decide si necesita
 * mas, nunca "todo" por default. */
export async function fetchExecutions(url, apiKey, { status, workflowId, maxFetch = 500 } = {}) {
  const headers = { accept: 'application/json', 'X-N8N-API-KEY': apiKey };
  let all = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({ limit: '100' });
    if (status) params.set('status', status);
    if (workflowId) params.set('workflowId', workflowId);
    if (cursor) params.set('cursor', cursor);
    const resp = await fetch(`${url}/api/v1/executions?${params.toString()}`, { headers });
    let body = null;
    try { body = await resp.json(); } catch { /* respuesta no-JSON, body queda null */ }
    if (!resp.ok) {
      const error = new Error(body?.message || `HTTP ${resp.status}`);
      error.status = resp.status;
      error.raw = body;
      throw error;
    }
    all = all.concat(body?.data || []);
    cursor = body?.nextCursor || null;
  } while (cursor && all.length < maxFetch);
  return { executions: all.slice(0, maxFetch), truncated: all.length >= maxFetch && !!cursor };
}
