// Skill determinista: borra una credencial de n8n via REST API
// (DELETE /api/v1/credentials/{id}). Mismo motivo que delete-workflow: no
// existe en el catalogo MCP (list_credentials es de solo lectura), asi que
// el borrado real solo es posible por la REST API.
// No pide confirm propio: este plugin corre con requireConfirm:false
// (ver plugin.json), la misma politica que el resto de sus tools mutantes.
import { resolveInstanceUrl } from './_shared.mjs';

export const meta = {
  description: 'Borra una credencial de n8n via REST (list_credentials del catálogo MCP es de solo lectura).',
  args: 'credentialId (requerido, ver list_credentials).',
};

export async function run(_adapter, args) {
  const url = resolveInstanceUrl(args?.url);
  const credentialId = args?.credentialId;

  if (!credentialId) return { isError: true, error: 'delete-credential requires: credentialId' };

  if (!process.env.N8N_API_KEY) {
    return { isError: true, error: 'delete-credential requiere N8N_API_KEY en el entorno del proceso del runtime (API key REST de n8n, distinta del token MCP).' };
  }

  const base = url.replace(/\/+$/, '');
  const endpoint = `${base}/api/v1/credentials/${encodeURIComponent(credentialId)}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'DELETE',
      headers: { accept: 'application/json', 'X-N8N-API-KEY': process.env.N8N_API_KEY },
    });
  } catch (e) {
    return { isError: true, error: `request failed: ${e.message}` };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // respuesta de DELETE puede venir sin body en algunas versiones de n8n
  }

  if (!response.ok) {
    return { isError: true, status: response.status, error: body?.message || `HTTP ${response.status}`, raw: body };
  }

  return { isError: false, credentialId, deleted: body };
}
