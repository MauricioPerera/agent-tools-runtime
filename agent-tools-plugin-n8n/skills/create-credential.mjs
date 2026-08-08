// Skill determinista: crea una credencial en n8n via REST API
// (POST /api/v1/credentials). No existe una tool de credenciales en el
// catalogo MCP de n8n (list_credentials es de solo lectura) -- crear una es
// otra operacion REST-only, mismo patron que delete-workflow(-bulk).
//
// No obtiene secretos por su cuenta: el humano se los tiene que dar en `data`
// (ej. un accessToken de Slack ya generado en la config de la app, o un
// clientId/clientSecret de OAuth). Para tipos OAuth2 reales, conseguir el
// token todavia requiere el consentimiento por navegador -- eso lo sigue
// haciendo el humano una vez; esta skill solo registra los datos que ya
// existen, no reemplaza ese paso.
//
// Antes de crear, trae el schema real del tipo (GET /credentials/schema/{type})
// y valida que `data` tenga los campos requeridos -- para dar un error
// especifico ("falta accessToken") en vez del generico que devuelve n8n.
import { resolveInstanceUrl } from './_shared.mjs';

export async function run(_adapter, args) {
  const url = resolveInstanceUrl(args?.url);
  const name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : null;
  const type = typeof args?.type === 'string' && args.type.trim() ? args.type.trim() : null;
  const data = args?.data && typeof args.data === 'object' ? args.data : null;

  if (!type) return { isError: true, error: 'create-credential requires: type (ej. "slackApi", "httpHeaderAuth" -- el nombre interno del tipo de credencial de n8n)' };

  if (!process.env.N8N_API_KEY) {
    return { isError: true, error: 'create-credential requiere N8N_API_KEY en el entorno del proceso del runtime (API key REST de n8n, distinta del token MCP).' };
  }

  const base = url.replace(/\/+$/, '');
  const headers = { accept: 'application/json', 'Content-Type': 'application/json', 'X-N8N-API-KEY': process.env.N8N_API_KEY };

  // Modo consulta: sin `data`, no crea nada -- solo trae el schema real del
  // tipo, para que el agente sepa que pedirle al humano antes de intentar
  // crear. GET /credentials/schema/{type} existe y esta vivo (probado en
  // vivo contra slackApi/slackOAuth2Api).
  if (!name && !data) {
    let schemaResp;
    try {
      schemaResp = await fetch(`${base}/api/v1/credentials/schema/${encodeURIComponent(type)}`, { headers });
    } catch (e) {
      return { isError: true, error: `schema request failed: ${e.message}` };
    }
    let schemaBody = null;
    try { schemaBody = await schemaResp.json(); } catch { /* sin body JSON */ }
    if (!schemaResp.ok) {
      return { isError: true, status: schemaResp.status, error: schemaBody?.message || `HTTP ${schemaResp.status}`, raw: schemaBody };
    }
    return { isError: false, mode: 'schema', type, schema: schemaBody };
  }

  if (!name) return { isError: true, error: 'create-credential requires: name (para crear -- si solo querés ver el schema del tipo, omití name y data)' };
  if (!data) return { isError: true, error: 'create-credential requires: data (objeto con los campos del tipo de credencial -- llamá primero con solo type para ver el schema)' };

  // 1. Traer el schema real del tipo para validar campos requeridos antes de crear.
  let schema = null;
  try {
    const schemaResp = await fetch(`${base}/api/v1/credentials/schema/${encodeURIComponent(type)}`, { headers });
    if (schemaResp.ok) schema = await schemaResp.json();
  } catch { /* si falla el fetch del schema, seguimos igual -- no es bloqueante */ }

  if (schema?.required?.length) {
    const missing = schema.required.filter((field) => !(field in data));
    if (missing.length) {
      return { isError: true, error: `Faltan campos requeridos para el tipo "${type}": ${missing.join(', ')}. Campos disponibles según el schema: ${Object.keys(schema.properties || {}).join(', ') || '(schema sin properties)'}.`, schema };
    }
  }

  // 2. Crear
  let response;
  try {
    response = await fetch(`${base}/api/v1/credentials`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, type, data }),
    });
  } catch (e) {
    return { isError: true, error: `request failed: ${e.message}` };
  }

  let body = null;
  try { body = await response.json(); } catch { /* respuesta sin body JSON */ }

  if (!response.ok) {
    return { isError: true, status: response.status, error: body?.message || `HTTP ${response.status}`, raw: body };
  }

  return { isError: false, credentialId: body?.id, name: body?.name, type: body?.type };
}
