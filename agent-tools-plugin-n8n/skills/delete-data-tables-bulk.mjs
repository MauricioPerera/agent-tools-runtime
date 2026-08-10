// Skill determinista: borra en lote data tables que matchean un filtro.
// No existe delete_data_table en el catálogo MCP de n8n (search_data_tables,
// create_data_table, rename_data_table, add/delete/rename_data_table_column,
// add_data_table_rows -- ninguna borra la tabla entera). Igual que
// delete-workflow(-bulk), la única vía real es la REST API con N8N_API_KEY.
//
// Intenta primero DELETE /api/v1/data-tables/{id} (posible endpoint público,
// no confirmado antes de esta skill). Si esa ruta no existe en esta instancia
// (404/405), cae al camino documentado en data-table-crud.mjs: un workflow de
// un solo nodo Data Table (resource:table, operation:delete -- confirmado via
// find-node-types/get_node_types, discriminadores reales del nodo), publicado
// y ejecutado, y después borrado (vía DELETE REST directa) para no dejar
// workflows basura atrás -- la misma categoría de residuo que esta limpieza
// busca eliminar.
//
// Requiere al menos un filtro (namePattern), misma política que
// delete-workflows-bulk: sin filtro no borra nada.
import { resolveInstanceUrl, fetchAllWorkflows, callTool, isFailure } from './_shared.mjs';

export const meta = {
  description: 'Borra en lote data tables cuyo nombre matchea namePattern. Prueba REST directo primero, cae a un workflow Data Table/delete por tabla si el endpoint REST no existe en la instancia. Requiere namePattern -- nunca borra "todas" por default.',
  args: 'namePattern:string (requerido, substring case-insensitive).',
};

async function tryRestDelete(base, apiKey, dataTableId) {
  const endpoint = `${base}/api/v1/data-tables/${encodeURIComponent(dataTableId)}`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'DELETE',
      headers: { accept: 'application/json', 'X-N8N-API-KEY': apiKey },
    });
  } catch (e) {
    return { ok: false, restAvailable: null, error: `request failed: ${e.message}` };
  }
  if (response.status === 404 || response.status === 405) {
    return { ok: false, restAvailable: false };
  }
  let body = null;
  try { body = await response.json(); } catch { /* body vacío en algunas versiones */ }
  if (!response.ok) {
    return { ok: false, restAvailable: true, status: response.status, error: body?.message || `HTTP ${response.status}` };
  }
  return { ok: true, restAvailable: true };
}

function buildDeleteWorkflowCode({ dataTableId, workflowId, workflowName }) {
  return `import { workflow, node, trigger } from '@n8n/workflow-sdk';

const scheduleTrigger = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1, config: { name: 'Schedule', parameters: {} } });

const deleteTable = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'DeleteTable', parameters: {
    resource: 'table', operation: 'delete',
    dataTableId: { __rl: true, mode: 'id', value: ${JSON.stringify(dataTableId)} }
  }}
});

export default workflow(${JSON.stringify(workflowId)}, ${JSON.stringify(workflowName)}).add(scheduleTrigger).to(deleteTable);`;
}

async function tryWorkflowDelete(n8nAdapter, base, apiKey, dataTableId) {
  const workflowId = `dt-delete-wf-${Date.now()}-${dataTableId}`;
  const workflowName = `DT Delete ${dataTableId}`;
  const code = buildDeleteWorkflowCode({ dataTableId, workflowId, workflowName });

  const createResult = await callTool(n8nAdapter, 'create_workflow_from_code', { code, confirm: true, name: workflowName });
  if (isFailure(createResult)) return { ok: false, error: `create_workflow_from_code failed: ${createResult?.error}` };
  const realWorkflowId = createResult?.workflowId || createResult?.id;

  const publishResult = await callTool(n8nAdapter, 'publish_workflow', { workflowId: realWorkflowId });
  if (isFailure(publishResult)) return { ok: false, error: `publish_workflow failed: ${publishResult?.error}`, workflowId: realWorkflowId };

  const exec = await callTool(n8nAdapter, 'execute_workflow', { workflowId: realWorkflowId, executionMode: 'manual' });
  const execOk = !isFailure(exec) && exec?.executionId;

  // Cleanup: borrar el workflow throwaway pase lo que pase, via REST directa
  // (mismo endpoint que delete-workflow.mjs) -- no queremos que esta limpieza
  // de data tables deje workflows basura atrás.
  try {
    await fetch(`${base}/api/v1/workflows/${encodeURIComponent(realWorkflowId)}`, {
      method: 'DELETE',
      headers: { accept: 'application/json', 'X-N8N-API-KEY': apiKey },
    });
  } catch { /* best-effort cleanup, no bloquea el resultado */ }

  if (!execOk) return { ok: false, error: 'execute_workflow failed', workflowId: realWorkflowId };
  return { ok: true };
}

export async function run(n8nAdapter, args) {
  const url = resolveInstanceUrl(args?.url);
  const namePattern = typeof args?.namePattern === 'string' && args.namePattern.trim() ? args.namePattern.trim() : null;
  if (!namePattern) {
    return { isError: true, error: 'delete-data-tables-bulk requiere namePattern (substring, case-insensitive). Sin filtro no se borra nada.' };
  }
  if (!process.env.N8N_API_KEY) {
    return { isError: true, error: 'delete-data-tables-bulk requiere N8N_API_KEY en el entorno del proceso del runtime (API key REST de n8n, distinta del token MCP).' };
  }

  const base = url.replace(/\/+$/, '');
  const apiKey = process.env.N8N_API_KEY;

  const listResult = await callTool(n8nAdapter, 'search_data_tables', {});
  if (isFailure(listResult)) return { isError: true, error: `search_data_tables failed: ${listResult?.error}` };
  const all = listResult?.data || [];

  const needle = namePattern.toLowerCase();
  const matched = all.filter((dt) => (dt.name || '').toLowerCase().includes(needle));

  const deleted = [];
  const failed = [];
  let restAvailable = null; // null = aún no probado, true/false una vez que se sepa

  for (const dt of matched) {
    let result;
    if (restAvailable !== false) {
      result = await tryRestDelete(base, apiKey, dt.id);
      if (restAvailable === null && result.restAvailable !== undefined) restAvailable = result.restAvailable;
    }
    if (!result || (!result.ok && restAvailable === false)) {
      result = await tryWorkflowDelete(n8nAdapter, base, apiKey, dt.id);
    }
    if (result.ok) {
      deleted.push({ id: dt.id, name: dt.name });
    } else {
      failed.push({ id: dt.id, name: dt.name, error: result.error || `HTTP ${result.status}` });
    }
  }

  return {
    isError: matched.length > 0 && deleted.length === 0,
    totalDataTables: all.length,
    matchedCount: matched.length,
    deletedCount: deleted.length,
    failedCount: failed.length,
    deletionMethod: restAvailable ? 'rest' : 'workflow',
    deleted,
    failed,
  };
}
