// Levenshtein + closestMatches, genérico (sin dependencias, sin nada específico
// de ningún plugin). Movido acá desde adapters/n8n-mcp.mjs para que el loader de
// plugins y cualquier adapter lo puedan compartir sin duplicar la lógica.

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
