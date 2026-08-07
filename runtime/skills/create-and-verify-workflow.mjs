// Skill de orquestacion (no de contenido): el LLM sigue escribiendo el codigo del
// workflow SDK -- esto es genuinamente generico, cualquier flujo -- pero la
// secuencia validate -> create -> publish se colapsa en UNA llamada por intento,
// en vez de que el modelo tenga que hacer esas 3 llamadas por separado y
// re-orquestar el ciclo el mismo cuando algo falla.

import { callTool, isFailure } from './_shared.mjs';

/** Orquesta la operacion pedida. n8nAdapter: instancia de N8nMcpAdapter ya conectada. */
export async function run(n8nAdapter, args) {
  const code = args?.code;
  const name = args?.name;
  const publish = args?.publish !== false; // default true

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

  return { isError: false, stage: 'publish', workflowId, published: true };
}
