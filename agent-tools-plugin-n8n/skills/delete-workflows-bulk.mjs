// Skill determinista: borra en lote workflows que matchean un filtro, via la
// REST API de n8n (mismo mecanismo que delete-workflow.mjs, un DELETE por
// workflow -- no existe un bulk-delete nativo en la API de n8n). Pagina la
// lista completa primero (GET /api/v1/workflows pagina de a 100; una version
// anterior de este mismo borrado -- un script de PowerShell del usuario --
// solo leia la primera pagina y se perdia el resto en una instancia con
// cientos de workflows).
//
// Requiere al menos un filtro (active y/o namePattern): sin ninguno, no borra
// nada y devuelve error -- no por una politica de confirmacion (este plugin
// corre con requireConfirm:false a proposito, ver plugin.json), sino porque
// una llamada sin criterio no dice a que workflows aplica y "todos" no deberia
// ser el default implicito de un bulk-delete.
import { resolveInstanceUrl, fetchAllWorkflows } from './_shared.mjs';

export async function run(_adapter, args) {
  const url = resolveInstanceUrl(args?.url);

  if (!process.env.N8N_API_KEY) {
    return { isError: true, error: 'delete-workflows-bulk requiere N8N_API_KEY en el entorno del proceso del runtime (API key REST de n8n, distinta del token MCP).' };
  }

  const hasActiveFilter = typeof args?.active === 'boolean';
  const namePattern = typeof args?.namePattern === 'string' && args.namePattern.trim() ? args.namePattern.trim() : null;
  if (!hasActiveFilter && !namePattern) {
    return { isError: true, error: 'delete-workflows-bulk requiere al menos un filtro: active (boolean) o namePattern (substring, case-insensitive). Sin filtro no se borra nada.' };
  }

  const base = url.replace(/\/+$/, '');
  const headers = { accept: 'application/json', 'X-N8N-API-KEY': process.env.N8N_API_KEY };

  // 1. Traer todos los workflows, siguiendo la paginacion por cursor.
  let all;
  try {
    all = await fetchAllWorkflows(base, process.env.N8N_API_KEY);
  } catch (e) {
    return { isError: true, status: e.status, error: e.message, raw: e.raw };
  }

  // 2. Filtrar
  let matched = all;
  if (hasActiveFilter) matched = matched.filter((wf) => wf.active === args.active);
  if (namePattern) {
    const needle = namePattern.toLowerCase();
    matched = matched.filter((wf) => (wf.name || '').toLowerCase().includes(needle));
  }

  // 3. Borrar cada match, uno por uno (la API de n8n no tiene bulk-delete)
  const deleted = [];
  const failed = [];
  for (const wf of matched) {
    const delUrl = `${base}/api/v1/workflows/${encodeURIComponent(wf.id)}`;
    try {
      const delResp = await fetch(delUrl, { method: 'DELETE', headers });
      if (delResp.ok) {
        deleted.push({ id: wf.id, name: wf.name });
      } else {
        let errBody = null;
        try { errBody = await delResp.json(); } catch { /* sin body JSON */ }
        failed.push({ id: wf.id, name: wf.name, status: delResp.status, error: errBody?.message || `HTTP ${delResp.status}` });
      }
    } catch (e) {
      failed.push({ id: wf.id, name: wf.name, error: e.message });
    }
  }

  return {
    isError: matched.length > 0 && deleted.length === 0,
    totalWorkflows: all.length,
    matchedCount: matched.length,
    deletedCount: deleted.length,
    failedCount: failed.length,
    deleted,
    failed,
  };
}
