// Levenshtein + closestMatches, vendorizado local a este plugin. Antes se
// importaba desde el runtime ("../runtime/fuzzy-match.mjs") -- rompía en
// instalaciones reales via npm: este plugin vive en node_modules/agent-tools-plugin-n8n/,
// el runtime en node_modules/@rckflr/agent-tools-runtime/, dos árboles
// distintos de node_modules, así que una ruta relativa cross-package nunca
// resuelve ahí. Verificado en vivo, no asumido: "Cannot find module
// .../node_modules/runtime/fuzzy-match.mjs" al instalar limpio via npm.
// Mismo fix que ya se hizo para discoverPlugins() en el Hallazgo 15, pero acá
// la solución es no depender del import cross-package en absoluto (la
// función es chica y estable), no perseguir la resolución hacia arriba.

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

/** Nombres candidatos ordenados por similitud descendente (1 = idéntico, 0 = nada en común). */
export function closestMatches(input, candidates, limit = 3) {
  const scored = candidates.map((name) => {
    const dist = levenshtein(input, name);
    const maxLen = Math.max(input.length, name.length) || 1;
    return { name, similarity: 1 - dist / maxLen };
  });
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
