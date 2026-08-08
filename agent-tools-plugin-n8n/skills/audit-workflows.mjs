// Skill determinista: envuelve el script de n8n-workflow-auditor (vendorizado
// en scripts/audit_n8n_workflows.py, MIT, mismo autor) ejecutandolo como
// proceso hijo -- no reescribe la logica del audit en JS, solo le da una
// fachada tipada al comando. El adapter de este plugin (N8nMcpAdapter, habla
// MCP HTTP con n8n) no se usa aca: el script pega directo a la REST API de
// n8n con su propia API key, un mundo de autenticacion distinto del token MCP.
//
// No reusa LocalCliAdapter del runtime (adapters/local-cli.mjs): un primer
// intento importandolo por nombre de paquete ("@rckflr/agent-tools-runtime/...")
// rompia el descubrimiento in-repo, donde este plugin vive como directorio
// hermano de runtime/ (no instalado via npm, sin node_modules de por medio) --
// Node no puede resolver un paquete que no esta en ningun node_modules
// ancestro. Verificado en vivo, no asumido: el runtime logueaba "no se pudo
// cargar 'agent-tools-plugin-n8n'" y la skill ni aparecia. Mismo patron que
// el adapter de kite-lite (binario fijo via env var, sin depender de nada
// fuera de node: built-ins) -- funciona igual in-repo o instalado via npm.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'audit_n8n_workflows.py');
const PYTHON_BIN = process.env.N8N_AUDIT_PYTHON_BIN || 'python3';

const VALID_MODES = new Set(['audit', 'summary', 'export', 'nativeAudit', 'executions', 'credentials']);

export async function run(_adapter, args) {
  const url = args?.url;
  if (!url) return { isError: true, error: 'audit-workflows requires: url (URL base de tu instancia de n8n)' };

  if (!process.env.N8N_API_KEY) {
    return { isError: true, error: 'audit-workflows requiere N8N_API_KEY en el entorno del proceso del runtime (API key REST de n8n, distinta del token MCP -- se genera en Settings > n8n API).' };
  }

  const mode = args?.mode || 'audit';
  if (!VALID_MODES.has(mode)) {
    return { isError: true, error: `mode inválido: '${mode}'. Válidos: ${[...VALID_MODES].join(', ')}` };
  }

  const cliArgs = [SCRIPT_PATH, '--url', url];
  if (args?.all) cliArgs.push('--all');
  if (args?.workflowId) cliArgs.push('--workflow-id', String(args.workflowId));

  if (mode === 'summary') {
    cliArgs.push('--summary');
  } else if (mode === 'export') {
    if (!args?.exportDir) return { isError: true, error: "mode 'export' requiere: exportDir" };
    cliArgs.push('--export-dir', args.exportDir);
  } else if (mode === 'nativeAudit') {
    cliArgs.push('--native-audit');
    if (args?.auditCategories) cliArgs.push('--audit-categories', args.auditCategories);
    if (args?.daysAbandoned != null) cliArgs.push('--days-abandoned', String(args.daysAbandoned));
  } else if (mode === 'executions') {
    cliArgs.push('--executions');
    if (args?.status) cliArgs.push('--status', args.status);
    if (args?.maxExecutions != null) cliArgs.push('--max-executions', String(args.maxExecutions));
  } else if (mode === 'credentials') {
    cliArgs.push('--credentials');
  }
  // mode === 'audit': sin flag extra, es el default del script (7 reglas por workflow).

  let stdout;
  try {
    const result = await execFileAsync(PYTHON_BIN, cliArgs, {
      shell: false,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
      env: process.env,
    });
    stdout = result.stdout;
  } catch (e) {
    return { isError: true, mode, error: e.stderr || e.message };
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { isError: true, mode, error: 'audit_n8n_workflows.py no devolvió JSON válido', raw: stdout.slice(0, 2000) };
  }
  return { isError: false, mode, report };
}
