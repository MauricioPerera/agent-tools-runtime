// Skill determinista: borra en lote ejecuciones que matchean un filtro, via
// la REST API de n8n (DELETE /api/v1/executions/{id}, un request por
// ejecución -- n8n no tiene bulk-delete nativo para esto tampoco, misma
// limitación que workflows).
//
// A diferencia de delete-workflows-bulk (donde "todos los inactivos" son a
// lo sumo unos cientos/miles), el historial de ejecuciones puede estar en el
// orden de millones -- esta instancia ya tiene IDs de ejecución en ~4.5M.
// Por eso esta skill:
//   1) Requiere al menos un filtro real (status y/o workflowId) -- igual
//      politica que delete-workflows-bulk, nunca "todo" por default.
//   2) SIEMPRE tiene un tope maxDelete (default 100, tope duro 2000) -- ni
//      siquiera con filtro se puede pedir un borrado sin límite en una sola
//      llamada. Para borrar más, se llama de nuevo.
import { resolveInstanceUrl, fetchExecutions } from './_shared.mjs';

const HARD_CEILING = 2000;

export const meta = {
  description: 'Borra en lote ejecuciones que matchean status y/o workflowId, hasta maxDelete (default 100, tope duro 2000 por llamada -- el historial puede tener millones de registros, nunca borra "todo" en una corrida).',
  args: 'status?:string y/o workflowId?:string (al menos uno requerido), maxDelete?:number (default 100, máximo 2000).',
};

export async function run(_adapter, args) {
  const url = resolveInstanceUrl(args?.url);
  const status = typeof args?.status === 'string' && args.status.trim() ? args.status.trim() : null;
  const workflowId = typeof args?.workflowId === 'string' && args.workflowId.trim() ? args.workflowId.trim() : null;

  if (!status && !workflowId) {
    return { isError: true, error: 'delete-executions-bulk requiere al menos un filtro: status y/o workflowId. Sin filtro no se borra nada.' };
  }

  let maxDelete = Number.isFinite(args?.maxDelete) ? Math.floor(args.maxDelete) : 100;
  if (maxDelete < 1) maxDelete = 1;
  if (maxDelete > HARD_CEILING) {
    return { isError: true, error: `maxDelete no puede superar ${HARD_CEILING} en una sola llamada. Pedí menos, o llamá de nuevo para seguir borrando.` };
  }

  if (!process.env.N8N_API_KEY) {
    return { isError: true, error: 'delete-executions-bulk requiere N8N_API_KEY en el entorno del proceso del runtime (API key REST de n8n, distinta del token MCP).' };
  }

  const base = url.replace(/\/+$/, '');
  const apiKey = process.env.N8N_API_KEY;

  let fetchResult;
  try {
    fetchResult = await fetchExecutions(base, apiKey, { status, workflowId, maxFetch: maxDelete });
  } catch (e) {
    return { isError: true, status: e.status, error: e.message, raw: e.raw };
  }
  const { executions, truncated } = fetchResult;

  const deleted = [];
  const failed = [];
  for (const exec of executions) {
    const delUrl = `${base}/api/v1/executions/${encodeURIComponent(exec.id)}`;
    try {
      const delResp = await fetch(delUrl, { method: 'DELETE', headers: { accept: 'application/json', 'X-N8N-API-KEY': apiKey } });
      if (delResp.ok) {
        deleted.push({ id: exec.id, workflowId: exec.workflowId, status: exec.status });
      } else {
        let errBody = null;
        try { errBody = await delResp.json(); } catch { /* sin body JSON */ }
        failed.push({ id: exec.id, status: delResp.status, error: errBody?.message || `HTTP ${delResp.status}` });
      }
    } catch (e) {
      failed.push({ id: exec.id, error: e.message });
    }
  }

  return {
    isError: executions.length > 0 && deleted.length === 0,
    matchedCount: executions.length,
    deletedCount: deleted.length,
    failedCount: failed.length,
    moreMayRemain: truncated || deleted.length === maxDelete,
    deleted,
    failed,
  };
}
