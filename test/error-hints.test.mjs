import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HINTS, FALLBACK_HINT, hintFor } from '../runtime/error-hints.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_SOURCE = readFile(path.join(__dirname, '../runtime/mcp-server.mjs'), 'utf8');

// Cobertura en las DOS direcciones, extraída del código fuente en vez de
// mantenida a mano -- mismo criterio que rule-hints.py del repo hermano KDD
// (DO: "extraer los codigos del fuente de los validadores en el test, no de
// una lista mantenida a mano: la lista se desincroniza, el fuente no").
test('every HINTS key is actually referenced by hintFor(...) in mcp-server.mjs', async () => {
  const source = await MCP_SERVER_SOURCE;
  const referenced = new Set([...source.matchAll(/hintFor\('([A-Z_]+)'\)/g)].map((m) => m[1]));
  for (const code of Object.keys(HINTS)) {
    assert.ok(referenced.has(code), `HINTS['${code}'] no se usa en mcp-server.mjs -- receta de un codigo que ya no existe`);
  }
});

test('every hintFor(...) call in mcp-server.mjs resolves to a real HINTS entry, not the fallback', async () => {
  const source = await MCP_SERVER_SOURCE;
  const referenced = new Set([...source.matchAll(/hintFor\('([A-Z_]+)'\)/g)].map((m) => m[1]));
  for (const code of referenced) {
    assert.ok(code in HINTS, `mcp-server.mjs llama hintFor('${code}') pero no hay receta -- cae al fallback en silencio`);
  }
});

test('hintFor is total: any string returns a non-empty hint, unknown codes fall back', () => {
  assert.equal(hintFor('THIS_CODE_DOES_NOT_EXIST'), FALLBACK_HINT);
  assert.equal(hintFor(''), FALLBACK_HINT);
  for (const code of Object.keys(HINTS)) {
    const hint = hintFor(code);
    assert.ok(hint.length > 0);
    assert.notEqual(hint, FALLBACK_HINT, `HINTS['${code}'] no debería resolver al fallback`);
  }
});
