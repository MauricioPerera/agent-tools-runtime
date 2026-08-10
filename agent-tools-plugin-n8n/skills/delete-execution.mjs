// Skill determinista: borra UNA ejecución por id via la REST API de n8n
// (DELETE /api/v1/executions/{id}). No existe delete_execution en el
// catálogo MCP de n8n (solo get_execution/search_executions, ambas de
// lectura) -- misma categoría de hueco que delete-workflow, resuelta igual.
import { resolveInstanceUrl } from './_shared.mjs';

export const meta = {
  description: 'Borra UNA ejecución real por id. No existe delete_execution en el catálogo MCP (solo get_execution/search_executions, de lectura).',
  args: 'executionId (requerido).',
};

export async function run(_adapter, args) {
  const url = resolveInstanceUrl(args?.url);
  const executionId = args?.executionId;
  if (!executionId) return { isError: true, error: 'delete-execution requires: executionId' };

  if (!process.env.N8N_API_KEY) {
    return { isError: true, error: 'delete-execution requiere N8N_API_KEY en el entorno del proceso del runtime (API key REST de n8n, distinta del token MCP).' };
  }

  const base = url.replace(/\/+$/, '');
  const endpoint = `${base}/api/v1/executions/${encodeURIComponent(executionId)}`;

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
  try { body = await response.json(); } catch { /* body vacío en algunas versiones */ }

  if (!response.ok) {
    return { isError: true, status: response.status, error: body?.message || `HTTP ${response.status}`, raw: body };
  }

  return { isError: false, executionId, deleted: body };
}
