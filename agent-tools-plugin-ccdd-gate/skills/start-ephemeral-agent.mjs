// Skill determinista: dispara run_ephemeral_agent SIN esperar la respuesta
// (puede tardar varios minutos -- hasta 3 iteraciones de un modelo chico
// escribiendo codigo contra el gate) y devuelve {jobId} al toque. Mismo
// patron que start_generate/start_chat de agent-tools-plugin-ollama.
// Consulta el resultado con la skill ephemeral-agent-status.
import { jobs, nextJobId } from './ephemeral-jobs-store.mjs';

export const meta = {
  description: 'Dispara run_ephemeral_agent SIN esperar (puede tardar varios minutos) y devuelve {jobId} al toque, sin bloquear la llamada. Consultá el resultado con la skill ephemeral-agent-status({jobId}).',
  args: 'task_path (string, requerido) -- ruta absoluta al .md del Task Contract, igual que run_ephemeral_agent. target y tests deben existir en disco antes de llamar.',
  related: [{ target: 'ccdd:ephemeral-agent-status', why: 'Consulta el estado/resultado del job que devuelve esta skill.' }],
};

function extractContentJson(mcpResult) {
  const text = mcpResult?.content?.[0]?.text;
  if (typeof text !== 'string') return mcpResult;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function run(adapter, args) {
  const taskPath = args?.task_path;
  if (!taskPath) return { isError: true, error: 'start-ephemeral-agent requires: task_path (string, ruta absoluta)' };

  const jobId = nextJobId();
  const job = { jobId, status: 'running', startedAt: Date.now(), finishedAt: null, result: null, error: null };
  jobs.set(jobId, job);

  adapter.call('run_ephemeral_agent', { task_path: taskPath })
    .then((raw) => { job.status = 'done'; job.finishedAt = Date.now(); job.result = extractContentJson(raw); })
    .catch((e) => { job.status = 'error'; job.finishedAt = Date.now(); job.error = e.message; });

  return { isError: false, jobId, status: 'running' };
}
