// Skill determinista: create/insert/read sobre data tables de n8n.
// create e insert son tools directas de n8n (sin workflow, sin codigo generado).
// read no tiene tool directa en el n8n MCP -- se resuelve con un workflow minimo
// de un solo nodo Get, igual patron que insert-and-verify-datatable-row.mjs.

import { callTool, isFailure, resolvePersonalProjectId } from './_shared.mjs';

async function opCreate(n8nAdapter, args) {
  const { name, columns } = args;
  if (!name || !Array.isArray(columns) || !columns.length) {
    return { isError: true, error: 'create requires: name, columns: [{name, type}]' };
  }
  const projectId = args.projectId || await resolvePersonalProjectId(n8nAdapter);
  const createArgs = { name, columns };
  if (projectId) createArgs.projectId = projectId;
  const dt = await callTool(n8nAdapter, 'create_data_table', createArgs);
  if (isFailure(dt)) return { isError: true, error: `create_data_table failed: ${dt?.error}` };
  const dataTableId = dt?.id || dt?.dataTableId;
  if (!dataTableId) return { isError: true, error: 'create_data_table did not return an id', raw: dt };
  return { isError: false, dataTableId };
}

async function opInsert(n8nAdapter, args) {
  const { dataTableId, rows } = args;
  if (!dataTableId || !Array.isArray(rows) || !rows.length) {
    return { isError: true, error: 'insert requires: dataTableId, rows: [{column: value, ...}]' };
  }
  const projectId = args.projectId || await resolvePersonalProjectId(n8nAdapter);
  const insertArgs = { dataTableId, rows };
  if (projectId) insertArgs.projectId = projectId;
  const result = await callTool(n8nAdapter, 'add_data_table_rows', insertArgs);
  if (isFailure(result)) return { isError: true, error: `add_data_table_rows failed: ${result?.error}` };
  return { isError: false, dataTableId, inserted: rows.length, raw: result };
}

function buildReadWorkflowCode({ dataTableId, filters, workflowId, workflowName }) {
  const conditions = (filters || []).map(
    (f) => `{ keyName: ${JSON.stringify(f.column)}, condition: 'eq', keyValue: ${JSON.stringify(f.value)} }`
  ).join(', ');
  const filtersBlock = conditions
    ? `matchType: 'anyCondition', filters: { conditions: [${conditions}] },`
    : '';
  return `import { workflow, node, trigger } from '@n8n/workflow-sdk';

const scheduleTrigger = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1, config: { name: 'Schedule', parameters: {} } });

const getRows = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'GetRows', parameters: {
    resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'id', value: ${JSON.stringify(dataTableId)} },
    ${filtersBlock}
    returnAll: true
  }}
});

export default workflow(${JSON.stringify(workflowId)}, ${JSON.stringify(workflowName)}).add(scheduleTrigger).to(getRows);`;
}

async function opRead(n8nAdapter, args) {
  const { dataTableId, filters } = args;
  if (!dataTableId) return { isError: true, error: 'read requires: dataTableId' };

  const workflowId = `crud-read-wf-${Date.now()}`;
  const workflowName = 'Read DataTable Rows';
  const code = buildReadWorkflowCode({ dataTableId, filters, workflowId, workflowName });
  const createResult = await callTool(n8nAdapter, 'create_workflow_from_code', { code, confirm: true, name: workflowName });
  if (isFailure(createResult)) return { isError: true, error: `create_workflow_from_code failed: ${createResult?.error}` };
  const realWorkflowId = createResult?.workflowId || createResult?.id;

  const publishResult = await callTool(n8nAdapter, 'publish_workflow', { workflowId: realWorkflowId });
  if (isFailure(publishResult)) return { isError: true, error: `publish_workflow failed: ${publishResult?.error}`, workflowId: realWorkflowId };

  const exec = await callTool(n8nAdapter, 'execute_workflow', { workflowId: realWorkflowId, executionMode: 'manual' });
  if (isFailure(exec) || !exec?.executionId) return { isError: true, error: 'execute_workflow failed', workflowId: realWorkflowId };

  const detail = await callTool(n8nAdapter, 'get_execution', { workflowId: realWorkflowId, executionId: String(exec.executionId), includeData: true });
  const status = detail?.execution?.status;
  const runData = detail?.data?.resultData?.runData || {};
  const nodeOutput = runData?.GetRows?.[0]?.data?.main?.[0] || [];
  const rows = nodeOutput.map((item) => item.json);

  return {
    isError: status !== 'success',
    workflowId: realWorkflowId,
    dataTableId,
    executionId: exec.executionId,
    executionStatus: status ?? null,
    rows,
  };
}

/** Orquesta la operacion pedida. n8nAdapter: instancia de N8nMcpAdapter ya conectada. */
export async function run(n8nAdapter, args) {
  const operation = args?.operation;
  if (operation === 'create') return opCreate(n8nAdapter, args);
  if (operation === 'insert') return opInsert(n8nAdapter, args);
  if (operation === 'read') return opRead(n8nAdapter, args);
  return { isError: true, error: `Unknown operation: ${operation}. Use one of: create, insert, read.` };
}
