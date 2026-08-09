// Skill determinista para identificar y tipar nodos de n8n antes de escribir
// codigo del workflow SDK -- junta las dos llamadas que el modelo tenia que
// encadenar el solo (search_nodes -> get_node_types) bajo una sola skill con
// su propia validacion de argumentos, en vez de dejar que el error generico
// de "Argument validation failed" del facade explique a medias que forma
// exacta se esperaba (visto en corridas reales: "Missing required argument:
// queries", "Missing required argument: nodes", un nodeId inventado que dio
// "not found, use search_node").
//
// No encadena automaticamente de queries a nodeIds: el texto que devuelve
// search_nodes es prosa libre pensada para que la lea un LLM (discriminadores
// resource/operation anidados en texto, no JSON estructurado) -- parsearlo a
// ciegas para elegir "el mejor match" arriesgaria construir un nodeId
// equivocado en silencio, peor que el proceso de 2 pasos actual. En vez de
// eso, esta skill cubre ambos pasos con su propia validacion clara:
//   - queries: string[] -> reenvia a search_nodes tal cual (ya devuelve una
//     guia explicita de que nodeId/discriminadores usar despues)
//   - nodeIds: array de { nodeId, resource?, operation?, mode?, version? } ->
//     reenvia a get_node_types, validando el shape antes de llamar
// No usa isFailure()/callTool() de _shared.mjs: ese helper trata cualquier
// content[0].text que no parsea como JSON como una falla (pensado para tools
// como create_workflow_from_code, cuyo unico texto plano posible es un error
// de protocolo MCP). search_nodes y get_node_types son distintos: su
// respuesta EXITOSA es prosa/TypeScript en texto plano, no JSON -- con
// isFailure() un resultado real y correcto se reportaba como error (bug real
// encontrado en vivo probando esto: search_nodes("slack") devolvia la lista
// completa y correcta de nodos, pero isFailure() decia isError:true solo
// porque el payload no era JSON). El campo isError de verdad esta en el
// nivel superior de la respuesta MCP (CallToolResult.isError), no en si
// content[0].text parsea como JSON -- se chequea eso directamente aca.
//
// Ese campo isError tampoco alcanza solo: probado en vivo, get_node_types con
// un nodeId invalido NO pone isError:true -- devuelve un "# Errors\n\nNode
// type '...' not found..." como si fuera contenido exitoso mas. Se detecta
// ese heading especifico ademas del isError real; ninguna respuesta legitima
// de search_nodes/get_node_types empieza asi.
export const meta = {
  description: 'Busca tipos de nodo de n8n por nombre/servicio, o trae su definición TypeScript exacta -- equivalente a search_nodes/get_node_types con validación de argumentos más clara.',
  args: 'queries:string[] (para buscar) O nodeIds:[{nodeId,resource?,operation?,mode?,version?}] (para tipar) -- no ambos en la misma llamada.',
};

function looksLikeErrorText(text) {
  return /^\s*#\s*Errors\b/i.test(text || '');
}

async function callN8nTool(n8nAdapter, name, toolArgs) {
  const raw = await n8nAdapter.call(name, toolArgs);
  const text = raw?.content?.[0]?.text;
  const asString = typeof text === 'string' ? text : JSON.stringify(raw);
  return { isError: raw?.isError === true || looksLikeErrorText(asString), text: asString };
}

export async function run(n8nAdapter, args) {
  const queries = Array.isArray(args?.queries) ? args.queries.filter((q) => typeof q === 'string' && q.trim()) : null;
  const nodeIds = Array.isArray(args?.nodeIds) ? args.nodeIds : null;

  if (!queries && !nodeIds) {
    return {
      isError: true,
      error: 'find-node-types requires: queries (string[], para buscar nodos por nombre/servicio) o nodeIds (array de {nodeId, resource?, operation?, mode?, version?}, para traer la definición exacta de nodos ya identificados).',
    };
  }
  if (queries && nodeIds) {
    return { isError: true, error: 'find-node-types acepta queries O nodeIds, no ambos en la misma llamada -- primero buscá con queries, después traé el tipo exacto con nodeIds.' };
  }

  if (queries) {
    if (!queries.length) return { isError: true, error: 'queries no puede ser un array vacío.' };
    const { isError, text } = await callN8nTool(n8nAdapter, 'search_nodes', { queries });
    if (isError) return { isError: true, stage: 'search', error: text };
    return { isError: false, stage: 'search', result: text };
  }

  for (const [i, entry] of nodeIds.entries()) {
    if (!entry || typeof entry.nodeId !== 'string' || !entry.nodeId.trim()) {
      return { isError: true, error: `nodeIds[${i}] requiere un campo "nodeId" (string) -- ej. "n8n-nodes-base.gmail". Conseguilo primero con find-node-types({ queries: [...] }).` };
    }
  }
  const { isError, text } = await callN8nTool(n8nAdapter, 'get_node_types', { nodeIds });
  if (isError) return { isError: true, stage: 'types', error: text };
  return { isError: false, stage: 'types', result: text };
}
