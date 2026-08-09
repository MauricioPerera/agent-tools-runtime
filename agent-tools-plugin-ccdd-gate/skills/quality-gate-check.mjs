// Skill determinista: junta measure_complexity + los checks AST puntuales
// (check_mutable_defaults/check_bare_except/check_none_cmp/check_purity) en
// una sola llamada con un veredicto combinado.
//
// Primer intento (ver historial git) usaba run_rules_gate, que lee un
// rules.yaml DEL DISCO -- pero probado en vivo (isolated + pool exec) se
// confirmo que resuelve esa ruta relativa al cwd del PROCESO PYTHON, no al
// project_root que recibe como argumento. El proceso python es un child
// long-lived que el adapter spawnea UNA vez (ver ensureStarted en
// adapter.mjs) con el cwd que haya heredado el proceso host -- no hay forma
// de fijarlo por-llamada desde un skill. Los checks puntuales, en cambio,
// reciben el codigo inline (source/fn_name) sin tocar el filesystem, asi que
// son la pieza correcta para componer este skill (cero dependencia de cwd).
export const meta = {
  description: 'Corre measure_complexity + los checks AST puntuales (mutable_defaults, bare_except, none_cmp, purity) sobre UNA función Python en una sola llamada, todo inline (sin tocar el filesystem) -- devuelve un veredicto combinado (PASS/FAIL) con las métricas de complejidad y las violaciones encontradas. Sin opinión de LLM encima: son los checks deterministas del backend tal cual. Nota: los checks puntuales son Python-only (AST nativo), a diferencia de measure_complexity que soporta otros lenguajes vía backend registrado.',
  args: 'code (string, requerido) -- debe incluir la definición completa de la función. fnName (opcional -- si no se pasa, se autodetecta la primera "def nombre(" del código). checks (array opcional de ["mutable_defaults","bare_except","none_cmp","purity"], default: los 4).',
};

const CHECK_TOOLS = {
  mutable_defaults: { tool: 'check_mutable_defaults', field: 'mutable_defaults' },
  bare_except: { tool: 'check_bare_except', field: 'bare_except_lines' },
  none_cmp: { tool: 'check_none_cmp', field: 'none_eq_lines' },
  purity: { tool: 'check_purity', field: 'impurities' },
};
const DEFAULT_CHECKS = Object.keys(CHECK_TOOLS);
const FN_NAME_PATTERN = /^\s*def\s+(\w+)\s*\(/m;

function extractContentJson(mcpResult) {
  const text = mcpResult?.content?.[0]?.text;
  if (typeof text !== 'string') return mcpResult;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function run(adapter, args) {
  const code = args?.code;
  if (!code || typeof code !== 'string') {
    return { isError: true, error: 'quality-gate-check requires: code (string, con una definición de función completa)' };
  }
  const fnName = args?.fnName || (code.match(FN_NAME_PATTERN) || [])[1];
  if (!fnName) {
    return { isError: true, error: 'quality-gate-check no pudo detectar el nombre de la función en "code" -- pasá fnName explícito.' };
  }
  const language = args?.language || 'python';
  const requestedChecks = Array.isArray(args?.checks) && args.checks.length ? args.checks : DEFAULT_CHECKS;
  const unknownChecks = requestedChecks.filter((c) => !CHECK_TOOLS[c]);
  if (unknownChecks.length) {
    return { isError: true, error: `checks desconocidos: ${unknownChecks.join(', ')} -- válidos: ${DEFAULT_CHECKS.join(', ')}` };
  }

  try {
    const [complexity, ...checkResults] = await Promise.all([
      adapter.call('measure_complexity', { code, language }).then(extractContentJson),
      ...requestedChecks.map((c) => adapter.call(CHECK_TOOLS[c].tool, { source: code, fn_name: fnName }).then(extractContentJson)),
    ]);

    const findings = complexity?.findings || [];
    const thresholdsExceeded = findings.filter((f) => f.exceeds_threshold);

    const violations = requestedChecks
      .map((c, i) => ({ check: c, hits: checkResults[i]?.[CHECK_TOOLS[c].field] || [] }))
      .filter((v) => v.hits.length > 0);

    const verdict = (violations.length === 0 && thresholdsExceeded.length === 0) ? 'PASS' : 'FAIL';

    return {
      isError: verdict !== 'PASS',
      verdict,
      fnName,
      complexity: findings,
      thresholdsExceeded,
      violations,
    };
  } catch (e) {
    return { isError: true, error: e.message };
  }
}
