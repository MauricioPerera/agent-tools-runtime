// Skill determinista, de solo lectura: busca workflows por filtro (active,
// namePattern), paginando la lista completa via REST -- misma logica exacta
// que usa delete-workflows-bulk.mjs para encontrar sus matches (comparten
// fetchAllWorkflows en _shared.mjs), pero esta nunca borra nada.
//
// Existe porque search_workflows (la tool MCP de n8n) no es confiable para
// esto: su schema real solo tiene limit/projectId/query/sortBy/tags, sin
// cursor ni filtro por active -- limit tope 200, sin forma de pedir la
// pagina siguiente. Verificado en vivo: pedirle distintos "skip"/"offset"
// (parametros que no existen en su schema) siempre devuelve el mismo lote.
// find-workflows es la alternativa confiable para "encontrar" antes de un
// eventual delete-workflows-bulk, sin que quien llama tenga que reimplementar
// paginacion ni adivinar parametros que no existen.
import { resolveInstanceUrl, fetchAllWorkflows } from './_shared.mjs';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export async function run(_adapter, args) {
  const url = resolveInstanceUrl(args?.url);

  if (!process.env.N8N_API_KEY) {
    return { isError: true, error: 'find-workflows requiere N8N_API_KEY en el entorno del proceso del runtime (API key REST de n8n, distinta del token MCP).' };
  }

  const hasActiveFilter = typeof args?.active === 'boolean';
  const namePattern = typeof args?.namePattern === 'string' && args.namePattern.trim() ? args.namePattern.trim() : null;

  const base = url.replace(/\/+$/, '');

  let all;
  try {
    all = await fetchAllWorkflows(base, process.env.N8N_API_KEY);
  } catch (e) {
    return { isError: true, status: e.status, error: e.message, raw: e.raw };
  }

  let matched = all;
  if (hasActiveFilter) matched = matched.filter((wf) => wf.active === args.active);
  if (namePattern) {
    const needle = namePattern.toLowerCase();
    matched = matched.filter((wf) => (wf.name || '').toLowerCase().includes(needle));
  }

  const pageSize = Math.min(Math.max(1, Number(args?.pageSize) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const totalMatched = matched.length;
  const totalPages = Math.max(1, Math.ceil(totalMatched / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(Number(args?.page)) || 1), totalPages);
  const start = (page - 1) * pageSize;

  return {
    isError: false,
    totalWorkflows: all.length,
    matchedCount: totalMatched,
    workflows: matched.slice(start, start + pageSize).map((wf) => ({ id: wf.id, name: wf.name, active: wf.active, createdAt: wf.createdAt, updatedAt: wf.updatedAt })),
    pagination: { page, pageSize, totalItems: totalMatched, totalPages },
  };
}
