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

/** REST-based skills (audit-workflows, delete-workflow, delete-workflows-bulk) don't go
 * through N8nMcpAdapter, so they never see N8N_MCP_URL/DEFAULT_URL automatically -- they
 * used to require an explicit `url` argument every call even though the instance is
 * already configured for the MCP side. Derives the REST base from N8N_MCP_URL (or the
 * same default the adapter uses) by stripping the known /mcp-server/http suffix; an
 * explicit `url` argument still wins, for the case where REST and MCP live on different
 * hosts. */
export function resolveInstanceUrl(explicitUrl) {
  if (explicitUrl) return explicitUrl.replace(/\/+$/, '');
  const mcpUrl = process.env.N8N_MCP_URL || N8N_MCP_URL_DEFAULT;
  const base = mcpUrl.endsWith(MCP_PATH_SUFFIX) ? mcpUrl.slice(0, -MCP_PATH_SUFFIX.length) : mcpUrl;
  return base.replace(/\/+$/, '');
}
