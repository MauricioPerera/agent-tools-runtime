// Materializa un workflow de n8n (el JSON que devuelve get_workflow_details/REST
// /workflows/:id) como un concepto OKF (https://github.com/GoogleCloudPlatform/
// knowledge-catalog/blob/main/okf/SPEC.md): un .md con frontmatter YAML.
//
// Alcance chico a proposito: esto NO se expone todavia como resource MCP real
// (el runtime hoy solo declara capabilities:{tools:{}}, ver runtime/mcp-server.mjs)
// ni se probo contra un workflow real (el N8N_MCP_TOKEN de esta sesion quedo
// invalido tras el reset de la DB de n8n). Es la logica de generacion/validacion
// aislada, probada contra JSON de workflow mockeado.
//
// El parser/serializer de frontmatter de aca abajo NO es un YAML generico -- solo
// entiende el subconjunto exacto que este mismo modulo escribe (escalares, un
// nivel de anidamiento, arrays inline). No hay dependencia de YAML en el repo
// hoy y para este alcance no hace falta agregar una.

import { createHash } from 'node:crypto';

// Campos que definen el contenido real de un workflow -- deliberadamente excluye
// id/createdAt/updatedAt/versionId/meta (metadata de version/ejecucion, no de
// contenido), asi el sha solo cambia cuando cambia algo que de verdad importa.
const CONTENT_FIELDS = ['nodes', 'connections', 'settings', 'active'];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeWorkflowSha(workflow) {
  const content = {};
  for (const field of CONTENT_FIELDS) content[field] = workflow?.[field] ?? null;
  return createHash('sha256').update(canonicalJson(content)).digest('hex').slice(0, 12);
}

function yamlScalar(value) {
  if (typeof value !== 'string') return String(value);
  return /[:#\n]|^\s|\s$|^$/.test(value) ? JSON.stringify(value) : value;
}

function yamlLine(key, value, indent = '') {
  if (Array.isArray(value)) {
    return `${indent}${key}: [${value.map(yamlScalar).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const inner = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => yamlLine(k, v, `${indent}  `))
      .join('\n');
    return `${indent}${key}:\n${inner}`;
  }
  return `${indent}${key}: ${yamlScalar(value)}`;
}

export function buildFrontmatter(fields) {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => yamlLine(k, v));
  return `---\n${lines.join('\n')}\n---`;
}

export function workflowToOkfConcept(workflow, { generatedBy = 'agent-tools-plugin-n8n', now = new Date().toISOString(), staleDays = 7 } = {}) {
  if (!workflow || typeof workflow !== 'object' || !workflow.id) {
    throw new Error('workflowToOkfConcept requiere un workflow con "id"');
  }
  const sha = computeWorkflowSha(workflow);
  const staleAfter = new Date(new Date(now).getTime() + staleDays * 86400000).toISOString().slice(0, 10);
  const nodeCount = Array.isArray(workflow.nodes) ? workflow.nodes.length : 0;

  const frontmatter = buildFrontmatter({
    type: 'n8n Workflow',
    title: workflow.name || workflow.id,
    description: `Workflow de n8n con ${nodeCount} nodo(s), ${workflow.active ? 'activo' : 'inactivo'}`,
    resource: `n8n://workflow/${workflow.id}`,
    tags: ['n8n', workflow.active ? 'activo' : 'inactivo'],
    status: 'stable',
    generated: { by: generatedBy, at: now },
    content_sha: sha,
    stale_after: staleAfter,
    sources: {
      author: `n8n REST API /workflows/${workflow.id}`,
      last_modified: (workflow.updatedAt || now).slice(0, 10),
    },
  });

  const body = [
    '## Estado',
    '',
    `${workflow.active ? 'Activo' : 'Inactivo'}. ${nodeCount} nodo(s).`,
  ].join('\n');

  return `${frontmatter}\n\n${body}\n`;
}

function parseScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    return inner ? inner.split(',').map((s) => parseScalar(s.trim())) : [];
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return trimmed; }
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

export function parseOkfConcept(markdownText) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdownText);
  if (!match) throw new Error('okf: no se encontró frontmatter YAML delimitado por "---"');
  const [, frontmatterBlock, body] = match;

  const root = {};
  let currentParent = null;
  for (const line of frontmatterBlock.split('\n')) {
    if (!line.trim()) continue;
    const indented = /^  \S/.test(line);
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) throw new Error(`okf: línea de frontmatter sin ":" -- "${line}"`);
    const key = line.slice(0, colonIdx).replace(/^\s+/, '').trim();
    const valueRaw = line.slice(colonIdx + 1).trim();
    if (!indented) {
      if (valueRaw === '') { currentParent = {}; root[key] = currentParent; }
      else { currentParent = null; root[key] = parseScalar(valueRaw); }
    } else {
      if (!currentParent) throw new Error(`okf: valor anidado "${key}" sin encabezado padre`);
      currentParent[key] = parseScalar(valueRaw);
    }
  }
  return { frontmatter: root, body: body.trim() };
}

export function validateOkfConcept(markdownText) {
  let parsed;
  try { parsed = parseOkfConcept(markdownText); }
  catch (e) { return { valid: false, errors: [e.message] }; }

  const errors = [];
  const { frontmatter } = parsed;
  if (!frontmatter.type || !String(frontmatter.type).trim()) {
    errors.push('falta "type" (requerido por el spec de OKF)');
  }
  if (frontmatter.stale_after && Number.isNaN(new Date(frontmatter.stale_after).getTime())) {
    errors.push('"stale_after" no es una fecha válida');
  }
  return { valid: errors.length === 0, errors, frontmatter, body: parsed.body };
}

export function verifyWorkflowShaMatches(markdownText, workflow) {
  const { frontmatter } = parseOkfConcept(markdownText);
  const expected = computeWorkflowSha(workflow);
  const actual = frontmatter.content_sha;
  return { matches: actual === expected, expected, actual };
}
