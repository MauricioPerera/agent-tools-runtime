// Skill determinista: consulta el estado de un job lanzado con
// start-ephemeral-agent. No llama al adapter -- lee del Map compartido en
// memoria (ver ephemeral-jobs-store.mjs).
import { jobs } from './ephemeral-jobs-store.mjs';

export const meta = {
  description: 'Estado de un job lanzado con start-ephemeral-agent: "running" (todavía trabajando, no está muerto), "done" (con el status PASS/FAIL/iterations de run_ephemeral_agent) o "error" (con el mensaje). Incluye elapsedMs. El tracking vive en memoria del proceso runtime -- se pierde si el server MCP se reinicia.',
  args: 'jobId (string, requerido).',
  related: [{ target: 'ccdd:start-ephemeral-agent', why: 'Lanza el job cuyo jobId consulta esta skill.' }],
};

export async function run(adapter, args) {
  const jobId = args?.jobId;
  const job = jobId && jobs.get(jobId);
  if (!job) return { isError: true, error: `Unknown jobId: ${jobId}` };
  const elapsedMs = (job.finishedAt || Date.now()) - job.startedAt;
  return { isError: job.status === 'error', jobId: job.jobId, status: job.status, elapsedMs, result: job.result, error: job.error };
}
