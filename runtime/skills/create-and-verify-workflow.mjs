// Skill de orquestacion (no de contenido): el LLM sigue escribiendo el codigo del
// workflow SDK -- esto es genuinamente generico, cualquier flujo -- pero la
// secuencia validate -> create -> publish -> execute se colapsa en UNA llamada
// por intento, en vez de que el modelo tenga que hacer esas 4 por separado y
// re-orquestar el ciclo el mismo cuando algo falla.
//
// La version anterior se quedaba en publish: si el codigo validaba y publicaba
// pero fallaba recien al EJECUTAR (ej. un parametro mal armado que solo se nota
// en runtime, no en validate_workflow), ese error solo aparecia en el JSON
// gigante de get_execution -- el modelo nunca lo leia y en vez de corregir el
// mismo workflow creaba uno nuevo de cero, repetidamente (visto en corridas
// reales: hasta 8 workflows distintos en una sola tarea). Ahora execute+verify
// tambien esta adentro, con el mismo formato estructurado que ya usa validate.

import { callTool, isFailure } from './_shared.mjs';

function findFailedNode(runData) {
  for (const [nodeName, runs] of Object.entries(runData || {})) {
    const failedRun = (runs || []).find((r) => r.executionStatus === 'error');
    if (failedRun) return { nodeName, message: failedRun.error?.message || 'unknown error' };
  }
  return null;
}

/** Orquesta la operacion pedida. n8nAdapter: instancia de N8nMcpAdapter ya conectada. */
export async function run(n8nAdapter, args) {
  const code = args?.code;
  const name = args?.name;
  const publish = args?.publish !== false; // default true
  const execute = args?.execute !== false && publish; // default true, no aplica si no se publica

  if (!code || !name) {
    return { isError: true, error: 'create-and-verify-workflow requires: code (SDK code), name' };
  }

  // 1. Validar primero, sin crear nada -- si falla, un solo objeto de vuelta con
  // los errores exactos, para que el LLM corrija el code y llame de nuevo. No
  // gasta un create_workflow_from_code en un intento que ya se sabe que va a fallar.
  const validation = await callTool(n8nAdapter, 'validate_workflow', { code });
  if (validation?.valid === false) {
    return { isError: true, stage: 'validate', valid: false, errors: validation?.errors || [validation?.error].filter(Boolean) };
  }

  // 2. Crear
  const createResult = await callTool(n8nAdapter, 'create_workflow_from_code', { code, confirm: true, name });
  if (isFailure(createResult)) {
    return { isError: true, stage: 'create', error: createResult?.error };
  }
  const workflowId = createResult?.workflowId || createResult?.id;

  if (!publish) {
    return { isError: false, stage: 'create', workflowId, published: false };
  }

  // 3. Publicar (solo si se pidio validacion+creacion exitosa)
  const publishResult = await callTool(n8nAdapter, 'publish_workflow', { workflowId });
  if (isFailure(publishResult)) {
    return { isError: true, stage: 'publish', workflowId, error: publishResult?.error };
  }

  if (!execute) {
    return { isError: false, stage: 'publish', workflowId, published: true };
  }

  // 4. Ejecutar y verificar -- si algo del workflow falla recien acá, devolver
  // el error del nodo puntual (no todo el JSON de la ejecución), para que el
  // LLM corrija justo eso en el mismo workflow en vez de empezar de cero.
  const exec = await callTool(n8nAdapter, 'execute_workflow', { workflowId, executionMode: 'manual' });
  if (isFailure(exec) || !exec?.executionId) {
    return { isError: true, stage: 'execute', workflowId, error: exec?.error || 'execute_workflow failed' };
  }
  const detail = await callTool(n8nAdapter, 'get_execution', {
    workflowId, executionId: String(exec.executionId), includeData: true,
  });
  const status = detail?.execution?.status;
  if (status !== 'success') {
    const runData = detail?.data?.resultData?.runData;
    const failedNode = findFailedNode(runData);
    return {
      isError: true, stage: 'execute', workflowId, executionId: exec.executionId,
      executionStatus: status ?? null,
      error: failedNode?.message || detail?.data?.resultData?.error?.message || 'la ejecución no terminó en success',
      failedNode: failedNode?.nodeName ?? null,
    };
  }

  return {
    isError: false, stage: 'execute', workflowId, executionId: exec.executionId,
    executionStatus: status, published: true,
  };
}
