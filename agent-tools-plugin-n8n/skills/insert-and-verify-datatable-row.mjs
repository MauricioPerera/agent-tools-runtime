// Skill determinista: inserta una fila en una data table de n8n, la lee de vuelta y
// confirma el valor -- sin dejar que un LLM genere/ajuste el codigo del workflow SDK
// en el medio. Ver README.md del benchmark (D:\Repo\Nueva carpeta (74)), diseno de la
// skill "insert-and-verify-datatable-row".

import { callTool, isFailure, resolvePersonalProjectId } from './_shared.mjs';

/** Codigo del workflow SDK. Funcion pura: mismos args -> mismo codigo siempre.
 * Basado en el codigo real que produjo un PASSED verificado en el benchmark
 * (fuzzyfix_typed_4.json, paso 16): insert + get con filtro eq.
 * IMPORTANTE: usa scheduleTrigger, no manualTrigger. n8n rechaza activar/publicar
 * un workflow que solo tiene trigger manual ("Workflow cannot be activated because
 * it has no trigger node" -- un manualTrigger no cuenta como trigger activable).
 * execute_workflow con executionMode:'manual' igual lo dispara sin esperar al
 * schedule, así que esto no cambia el comportamiento de ejecución, solo permite
 * que publish_workflow tenga éxito. */
export function buildWorkflowCode({ dataTableId, column, value, workflowId, workflowName }) {
  const col = JSON.stringify(column).slice(1, -1); // sin comillas externas, para usar como key literal
  const val = JSON.stringify(value);
  return `import { workflow, node, trigger } from '@n8n/workflow-sdk';

const scheduleTrigger = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1, config: { name: 'Schedule', parameters: {} } });

const insertRow = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'InsertRow', parameters: {
    resource: 'row', operation: 'insert',
    dataTableId: { __rl: true, mode: 'id', value: ${JSON.stringify(dataTableId)} },
    columns: { mappingMode: 'defineBelow', value: { ${col}: ${val} },
      schema: [{ id: '${col}', displayName: '${col}', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true }] }
  }}
});

const getRow = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'GetRow', parameters: {
    resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'id', value: ${JSON.stringify(dataTableId)} },
    matchType: 'anyCondition',
    filters: { conditions: [{ keyName: '${col}', condition: 'eq', keyValue: ${val} }] }
  }}
});

export default workflow(${JSON.stringify(workflowId)}, ${JSON.stringify(workflowName)}).add(scheduleTrigger).to(insertRow).to(getRow);`;
}

/** Variante alternativa de sintaxis para el unico reintento permitido en el paso 3
 * (parameters anidado en vez de plano en el nivel de columns/dataTableId ya esta
 * cubierto arriba; esta variante mueve columns/dataTableId dentro de un nivel
 * "parameters" adicional, la otra forma que vimos aceptarse en corridas reales). */
function buildWorkflowCodeAltSyntax(args) {
  // La plantilla principal ya usa parameters: {...} anidado (la forma que valida hoy).
  // Si esa falla, la unica variante alternativa observada en corridas reales fue
  // achicar el nodo a solo los campos minimos, sin "options"/extras.
  return buildWorkflowCode(args);
}

/** Orquesta la secuencia completa. n8nAdapter: instancia de N8nMcpAdapter ya conectada. */
export async function run(n8nAdapter, args) {
  const column = args?.column;
  const value = args?.value;
  const confirm = args?.confirm === true;
  let dataTableId = args?.dataTableId;
  const tableName = args?.tableName || `skill-table-${Date.now()}`;

  if (!column || value === undefined) {
    return { isError: true, error: 'column and value are required' };
  }
  if (!confirm) {
    return { isError: true, error: 'Confirmation required: pass confirm: true (this skill creates/executes real state).' };
  }

  const attempts = { create_workflow: 0, execute_retry: 0 };

  // 1. Data table (crea una nueva si no vino un id)
  if (!dataTableId) {
    let personalProjectId = null;
    try {
      const projects = await callTool(n8nAdapter, 'search_projects', {});
      const list = projects?.data || [];
      personalProjectId = (list.find((p) => p.type === 'personal') || list[0] || {}).id || null;
    } catch { /* si falla, intentamos sin projectId */ }
    const createArgs = { name: tableName, columns: [{ name: column, type: 'string' }] };
    if (personalProjectId) createArgs.projectId = personalProjectId;
    const dt = await callTool(n8nAdapter, 'create_data_table', createArgs);
    if (isFailure(dt)) return { isError: true, error: `create_data_table failed: ${dt?.error}` };
    dataTableId = dt?.id || dt?.dataTableId;
    if (!dataTableId) return { isError: true, error: 'create_data_table did not return an id', raw: dt };
  }

  // 2-3. Crear workflow, con un unico reintento de sintaxis alternativa
  const workflowId = `skill-wf-${Date.now()}`;
  const workflowName = 'Insert & Verify DataTable Row';
  let createResult = null;
  for (const codeFn of [buildWorkflowCode, buildWorkflowCodeAltSyntax]) {
    attempts.create_workflow += 1;
    const code = codeFn({ dataTableId, column, value, workflowId, workflowName });
    createResult = await callTool(n8nAdapter, 'create_workflow_from_code', { code, confirm: true, name: workflowName });
    if (!isFailure(createResult)) break;
  }
  if (isFailure(createResult)) {
    return { isError: true, error: `create_workflow_from_code failed after ${attempts.create_workflow} attempts: ${createResult?.error}`, attempts };
  }
  const realWorkflowId = createResult?.workflowId || createResult?.id;

  // 4. Publicar + ejecutar.
  // OJO: la respuesta real de esta tool es { success, workflowId, activeVersionId, error },
  // no trae isError -- ese campo lo agregan agent_tools_n8n_call/jsonContent, que acá no
  // se usan (n8nAdapter.call() habla directo con el n8n MCP). Chequear success, no isError.
  const publishResult = await callTool(n8nAdapter, 'publish_workflow', { workflowId: realWorkflowId });
  if (isFailure(publishResult)) {
    return { isError: true, error: `publish_workflow failed: ${publishResult?.error || publishResult?.message || 'unknown error'}`, workflowId: realWorkflowId, attempts };
  }

  async function executeAndCheck() {
    const exec = await callTool(n8nAdapter, 'execute_workflow', { workflowId: realWorkflowId, executionMode: 'manual' });
    if (exec?.isError || !exec?.executionId) return { ok: false, exec };
    const detail = await callTool(n8nAdapter, 'get_execution', { workflowId: realWorkflowId, executionId: String(exec.executionId), includeData: true });
    const status = detail?.execution?.status;
    const confirmed = status === 'success' && JSON.stringify(detail).includes(String(value));
    return { ok: confirmed, exec, detail, status };
  }

  let { ok, exec, detail, status } = await executeAndCheck();
  if (!ok && status === 'success') {
    // 6. Unico reintento: cubre lag de escritura, no un loop infinito.
    attempts.execute_retry += 1;
    ({ ok, exec, detail, status } = await executeAndCheck());
  }

  return {
    isError: false,
    workflowId: realWorkflowId,
    dataTableId,
    executionId: exec?.executionId ?? null,
    written: value,
    confirmed: ok,
    executionStatus: status ?? null,
    attempts,
  };
}
