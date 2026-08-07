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
