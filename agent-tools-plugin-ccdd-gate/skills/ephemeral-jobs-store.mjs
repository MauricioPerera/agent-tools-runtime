// Estado compartido en memoria entre start-ephemeral-agent.mjs y
// ephemeral-agent-status.mjs -- NO es una skill en si (no esta listada en
// plugin.json), solo un modulo importado por las dos que si lo son. Mismo
// motivo que el jobs Map de agent-tools-plugin-ollama: run_ephemeral_agent
// puede tardar varios minutos (hasta 3 iteraciones de un modelo escribiendo
// codigo + gate), asi que separar "disparar" de "consultar" evita bloquear
// al agente que llama.
export const jobs = new Map();

let counter = 0;
export function nextJobId() {
  return `job_${Date.now()}_${++counter}`;
}
