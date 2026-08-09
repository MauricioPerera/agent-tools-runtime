#!/usr/bin/env node
// Transporte Streamable HTTP (MCP spec 2025-03-26) para el mismo dispatcher
// que usa el server stdio -- ver createMessageHandler() en mcp-server.mjs,
// que no sabe nada de transporte. Motivado por clientes MCP que solo hablan
// HTTP/SSE (no pueden spawnear un subproceso stdio), ej. eve
// (github.com/vercel/eve): sus `connections/*.ts` exigen `url` con
// Streamable HTTP o SSE, no soportan `command`/`args`.
//
// Variante simple del spec: cada request produce UNA respuesta JSON
// (`Content-Type: application/json`), sin upgrade a SSE -- el catalogo de
// mensajes que maneja este runtime hoy (initialize, tools/list, tools/call)
// es enteramente request/response, sin notificaciones server-initiated, asi
// que el modo SSE (pensado para streaming y push del server) no aporta nada
// todavia. El spec permite esto explicitamente: "the server MUST either
// return text/event-stream... or application/json... The client MUST
// support both."
//
// No implementa batching de mensajes (array de requests en un solo POST) --
// ningun cliente real probado en este repo lo necesita hoy; se puede sumar
// si aparece un caso real.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createMessageHandler } from './mcp-server.mjs';

const HOST = process.env.AGENT_TOOLS_HTTP_HOST || '127.0.0.1';
const PORT = Number(process.env.AGENT_TOOLS_HTTP_PORT) || 8321;
const PATH = '/mcp';

function isLocalOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}

async function main() {
  const { processMessage } = await createMessageHandler();
  const sessions = new Set();

  const server = createServer(async (req, res) => {
    if (req.url !== PATH) {
      res.writeHead(404).end();
      return;
    }

    // Proteccion DNS-rebinding que exige el spec: un Origin de browser
    // presente y no-local se rechaza. Un cliente server-to-server (como el
    // backend de eve) tipicamente no manda Origin -- eso se permite.
    const origin = req.headers.origin;
    if (origin && !isLocalOrigin(origin)) {
      res.writeHead(403).end('Origin not allowed');
      return;
    }

    if (req.method === 'GET') {
      // No ofrecemos un stream SSE standalone en esta version -- 405 es la
      // respuesta spec-compliant para "no server-to-client push aqui".
      res.writeHead(405, { Allow: 'POST, DELETE' }).end();
      return;
    }

    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId && sessions.has(sessionId)) {
        sessions.delete(sessionId);
        res.writeHead(204).end();
      } else {
        res.writeHead(404).end();
      }
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' }).end();
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(404).end();
      return;
    }

    let message;
    try {
      message = JSON.parse(await readBody(req));
    } catch (e) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${e.message}` } });
      return;
    }

    let result;
    try {
      result = await processMessage(message);
    } catch (e) {
      sendJson(res, 500, { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: e.message } });
      return;
    }

    // notifications/initialized (y cualquier notification/response de
    // entrada) no generan respuesta -- processMessage devuelve null, el
    // spec pide 202 sin body para ese caso.
    if (!result) {
      res.writeHead(202).end();
      return;
    }

    const headers = {};
    if (message.method === 'initialize') {
      const newSessionId = randomUUID();
      sessions.add(newSessionId);
      headers['Mcp-Session-Id'] = newSessionId;
    }
    sendJson(res, 200, result, headers);
  });

  server.listen(PORT, HOST, () => {
    console.error(`agent-tools-runtime MCP (Streamable HTTP) listening on http://${HOST}:${PORT}${PATH}`);
  });
}

main();
