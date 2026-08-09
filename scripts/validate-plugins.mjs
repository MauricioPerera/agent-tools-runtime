#!/usr/bin/env node
// Gate de CI para el catálogo de plugins -- mismo movimiento que validate-okf.py
// del repo hermano KDD (github.com/MauricioPerera/KDD): un `meta.related` roto
// (plugin/skill borrado o renombrado) antes solo se veía si alguien miraba
// stderr al arrancar el server a mano. Esto lo convierte en un chequeo que
// rompe el build -- ver .github/workflows/ci.yml.
//
// Reusa discoverPlugins/validateRelatedLinks de mcp-server.mjs tal cual (cero
// reimplementación, cero drift entre lo que corre el server real y lo que
// valida este script).
import { discoverPlugins, validateRelatedLinks } from '../runtime/mcp-server.mjs';

const plugins = await discoverPlugins();
const problems = validateRelatedLinks(plugins);

console.log(`Plugins cargados: ${plugins.length}`);
for (const plugin of plugins) {
  const skillCount = Object.keys(plugin.skills).length;
  console.log(`  ${plugin.prefix} (${plugin.name}) -- ${skillCount} skill${skillCount === 1 ? '' : 's'}`);
}

if (problems.length) {
  console.error(`\n${problems.length} problema(s) de meta.related:`);
  for (const problem of problems) console.error(`  [related] ${problem}`);
  process.exit(1);
}

console.log('\nTodos los meta.related resuelven correctamente.');
