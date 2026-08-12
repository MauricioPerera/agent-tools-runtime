import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWorkflowSha,
  workflowToOkfConcept,
  parseOkfConcept,
  validateOkfConcept,
  verifyWorkflowShaMatches,
} from './okf.mjs';

function mockWorkflow(overrides = {}) {
  return {
    id: '8f3a1c2',
    name: 'Panorama diario de ventas',
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-08-10T12:00:00.000Z',
    nodes: [{ id: 'n1', type: 'n8n-nodes-base.scheduleTrigger' }, { id: 'n2', type: 'n8n-nodes-base.postgres' }],
    connections: { n1: { main: [[{ node: 'n2', type: 'main', index: 0 }]] } },
    settings: { timezone: 'America/Argentina/Buenos_Aires' },
    ...overrides,
  };
}

test('computeWorkflowSha is stable across key reordering', () => {
  const a = mockWorkflow();
  const b = { ...mockWorkflow(), connections: { n1: mockWorkflow().connections.n1 } };
  // reordenar las claves del objeto no debe cambiar el sha
  const reordered = Object.fromEntries(Object.entries(b).reverse());
  assert.equal(computeWorkflowSha(a), computeWorkflowSha(reordered));
});

test('computeWorkflowSha ignores volatile fields (updatedAt, id do not leak into content hash indirectly)', () => {
  const a = mockWorkflow();
  const b = mockWorkflow({ updatedAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(computeWorkflowSha(a), computeWorkflowSha(b));
});

test('computeWorkflowSha changes when nodes change', () => {
  const a = mockWorkflow();
  const b = mockWorkflow({ nodes: [...mockWorkflow().nodes, { id: 'n3', type: 'n8n-nodes-base.slack' }] });
  assert.notEqual(computeWorkflowSha(a), computeWorkflowSha(b));
});

test('computeWorkflowSha changes when active flips', () => {
  const a = mockWorkflow({ active: true });
  const b = mockWorkflow({ active: false });
  assert.notEqual(computeWorkflowSha(a), computeWorkflowSha(b));
});

test('workflowToOkfConcept produces parseable frontmatter with the required OKF fields', () => {
  const md = workflowToOkfConcept(mockWorkflow(), { now: '2026-08-11T09:00:00.000Z' });
  const { frontmatter, body } = parseOkfConcept(md);
  assert.equal(frontmatter.type, 'n8n Workflow');
  assert.equal(frontmatter.title, 'Panorama diario de ventas');
  assert.equal(frontmatter.resource, 'n8n://workflow/8f3a1c2');
  assert.deepEqual(frontmatter.tags, ['n8n', 'activo']);
  assert.equal(frontmatter.generated.by, 'agent-tools-plugin-n8n');
  assert.equal(frontmatter.generated.at, '2026-08-11T09:00:00.000Z');
  assert.equal(frontmatter.content_sha, computeWorkflowSha(mockWorkflow()));
  assert.equal(frontmatter.stale_after, '2026-08-18');
  assert.equal(frontmatter.sources.last_modified, '2026-08-10');
  assert.match(body, /Activo\. 2 nodo\(s\)\./);
});

test('workflowToOkfConcept requires an id', () => {
  assert.throws(() => workflowToOkfConcept({ name: 'sin id' }), /requiere un workflow con "id"/);
});

test('validateOkfConcept accepts a well-formed concept', () => {
  const md = workflowToOkfConcept(mockWorkflow());
  const result = validateOkfConcept(md);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateOkfConcept rejects a concept with no type (OKF spec minimum)', () => {
  const md = '---\ntitle: sin type\n---\n\nbody';
  const result = validateOkfConcept(md);
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /falta "type"/);
});

test('validateOkfConcept rejects malformed frontmatter (no closing ---)', () => {
  const result = validateOkfConcept('---\ntype: x\n\nbody sin cierre');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /no se encontró frontmatter/);
});

test('validateOkfConcept rejects an invalid stale_after date', () => {
  const md = '---\ntype: n8n Workflow\nstale_after: no-es-fecha\n---\n\nbody';
  const result = validateOkfConcept(md);
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /stale_after/);
});

test('verifyWorkflowShaMatches: true when the workflow has not changed', () => {
  const workflow = mockWorkflow();
  const md = workflowToOkfConcept(workflow);
  const result = verifyWorkflowShaMatches(md, workflow);
  assert.equal(result.matches, true);
});

test('verifyWorkflowShaMatches: false when the workflow drifted after the concept was generated', () => {
  const original = mockWorkflow();
  const md = workflowToOkfConcept(original);
  const changed = mockWorkflow({ nodes: [...original.nodes, { id: 'n3', type: 'n8n-nodes-base.slack' }] });
  const result = verifyWorkflowShaMatches(md, changed);
  assert.equal(result.matches, false);
  assert.notEqual(result.expected, result.actual);
});

test('verifyWorkflowShaMatches: false when someone hand-edited the content_sha field (tampering/drift in the manifest)', () => {
  const workflow = mockWorkflow();
  const md = workflowToOkfConcept(workflow).replace(/content_sha: \S+/, 'content_sha: deadbeef0000');
  const result = verifyWorkflowShaMatches(md, workflow);
  assert.equal(result.matches, false);
  assert.equal(result.actual, 'deadbeef0000');
});
