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

/** Detecta expr('literal') sin '{{ }}' adentro -- visto en corridas reales
 * (cvwpilot_v5b_typed_1.json y _5.json): el modelo escribe expr('"texto"') para
 * un valor fijo, sin necesidad de expr() en absoluto (existe justo para envolver
 * '{{ ... }}', una expresión dinámica). n8n no lo rechaza -- es sintaxis válida
 * del SDK -- pero termina guardando un valor asimétrico/inesperado (una comilla
 * suelta), distinto al que el modelo pretendía escribir. No se puede detectar
 * mirando solo el resultado de validate_workflow (pasa esa validación), así que
 * se chequea acá, antes de gastar create+publish+execute en un intento que va a
 * escribir el valor mal. */
function findMisusedExpr(code) {
  const matches = [...(code || '').matchAll(/expr\(\s*(?:'([^']*)'|"([^"]*)")\s*\)/g)];
  for (const m of matches) {
    const content = m[1] ?? m[2] ?? '';
    if (!content.includes('{{')) return content;
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

  // 0. Chequeo previo, gratis (sin llamar a n8n): expr() mal usado sin '{{ }}'.
  // No es un error de sintaxis (validate_workflow lo deja pasar), es un error
  // semántico que solo se nota releyendo la ejecución -- se ataja acá para no
  // gastar el ciclo completo create+publish+execute en un intento que iba a
  // escribir el valor mal.
  const misusedExpr = findMisusedExpr(code);
  if (misusedExpr !== null) {
    return {
      isError: true, stage: 'validate', valid: false,
      errors: [
        `expr(${JSON.stringify(misusedExpr)}) no contiene '{{ }}' -- expr() es para expresiones dinámicas ` +
        `('={{ $json.campo }}'), no para valores fijos. Si ${JSON.stringify(misusedExpr)} es un valor fijo, ` +
        `pasalo directo como string sin expr() (ej. columns: { value: { col: ${JSON.stringify(misusedExpr)} } }). ` +
        `Si necesitás una expresión dinámica real, escribila con '{{ }}' adentro.`,
      ],
    };
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
