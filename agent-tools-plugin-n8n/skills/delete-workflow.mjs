// Skill determinista: borra un workflow por id via la REST API de n8n
// (DELETE /api/v1/workflows/{id}). No existe un delete_workflow en el
// catalogo MCP de n8n (solo archive_workflow, que archiva, no borra) -- esta
// skill es la unica via del plugin para un borrado real, igual que
// audit-workflows usa la REST API (N8N_API_KEY) en vez del MCP para lo suyo.
// No pide confirm propio: este plugin corre con requireConfirm:false
// (ver plugin.json), la misma politica que el resto de sus tools mutantes.
import { resolveInstanceUrl } from './_shared.mjs';

export async function run(_adapter, args) {
  const url = resolveInstanceUrl(args?.url);
  const workflowId = args?.workflowId;

  if (!workflowId) return { isError: true, error: 'delete-workflow requires: workflowId' };

  if (!process.env.N8N_API_KEY) {
    return { isError: true, error: 'delete-workflow requiere N8N_API_KEY en el entorno del proceso del runtime (API key REST de n8n, distinta del token MCP -- se genera en Settings > n8n API).' };
  }

  const endpoint = `${url.replace(/\/+$/, '')}/api/v1/workflows/${encodeURIComponent(workflowId)}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'DELETE',
      headers: { accept: 'application/json', 'X-N8N-API-KEY': process.env.N8N_API_KEY },
    });
  } catch (e) {
    return { isError: true, error: `request failed: ${e.message}` };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // n8n's DELETE response body may be empty on some versions; not itself a failure.
  }

  if (!response.ok) {
    return { isError: true, status: response.status, error: body?.message || `HTTP ${response.status}`, raw: body };
  }

  return { isError: false, workflowId, deleted: body };
}
