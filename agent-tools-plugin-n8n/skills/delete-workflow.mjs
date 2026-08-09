// Skill determinista: borra un workflow por id via la REST API de n8n
// (DELETE /api/v1/workflows/{id}). No existe un delete_workflow en el
// catalogo MCP de n8n (solo archive_workflow, que archiva, no borra) -- esta
// skill es la unica via del plugin para un borrado real, igual que
// audit-workflows usa la REST API (N8N_API_KEY) en vez del MCP para lo suyo.
// No pide confirm propio: este plugin corre con requireConfirm:false
// (ver plugin.json), la misma politica que el resto de sus tools mutantes.
//
// Acepta namePattern ademas de workflowId (mismo argumento que find-workflows
// y delete-workflows-bulk) -- encontrado en vivo: un modelo que ya venia de
// usar esas dos con namePattern asumio que delete-workflow funcionaba igual,
// y fallo con "requires: workflowId" antes de autocorregirse solo. Resuelve
// namePattern a exactamente un workflowId via fetchAllWorkflows (mismo helper
// que delete-workflows-bulk); error si matchea 0 o mas de 1, para no borrar
// el workflow equivocado por un nombre ambiguo.
import { resolveInstanceUrl, fetchAllWorkflows } from './_shared.mjs';

export const meta = {
  description: 'Borra UN workflow real por id (o por namePattern si matchea exactamente uno). No existe delete_workflow en el catálogo MCP (solo archive_workflow, que archiva).',
  args: 'workflowId O namePattern (uno de los dos, no ambos).',
};

export async function run(_adapter, args) {
  const url = resolveInstanceUrl(args?.url);
  let workflowId = args?.workflowId;
  const namePattern = typeof args?.namePattern === 'string' && args.namePattern.trim() ? args.namePattern.trim() : null;

  if (!workflowId && !namePattern) return { isError: true, error: 'delete-workflow requires: workflowId o namePattern' };
  if (workflowId && namePattern) return { isError: true, error: 'delete-workflow acepta workflowId O namePattern, no ambos.' };

  if (!process.env.N8N_API_KEY) {
    return { isError: true, error: 'delete-workflow requiere N8N_API_KEY en el entorno del proceso del runtime (API key REST de n8n, distinta del token MCP -- se genera en Settings > n8n API).' };
  }

  const base = url.replace(/\/+$/, '');

  if (namePattern) {
    let all;
    try {
      all = await fetchAllWorkflows(base, process.env.N8N_API_KEY);
    } catch (e) {
      return { isError: true, status: e.status, error: e.message, raw: e.raw };
    }
    const needle = namePattern.toLowerCase();
    const matches = all.filter((wf) => (wf.name || '').toLowerCase().includes(needle));
    if (matches.length === 0) {
      return { isError: true, error: `namePattern "${namePattern}" no matcheó ningún workflow.` };
    }
    if (matches.length > 1) {
      return {
        isError: true,
        error: `namePattern "${namePattern}" matcheó ${matches.length} workflows -- pasá workflowId directo para elegir uno, o usá delete-workflows-bulk si de verdad querés borrarlos todos.`,
        matches: matches.map((wf) => ({ id: wf.id, name: wf.name })),
      };
    }
    workflowId = matches[0].id;
  }

  const endpoint = `${base}/api/v1/workflows/${encodeURIComponent(workflowId)}`;

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
