// Minimal real stdio MCP server, spawned by test/runtime.test.mjs's
// StdioMcpAdapter tests -- same "spawn the real thing, don't mock it"
// discipline the REST/CLI adapter tests already use (a real
// http.createServer, a real child process). Reads newline-delimited
// JSON-RPC from stdin, writes newline-delimited JSON-RPC to stdout.
//
// process.argv[2] selects a behavior:
//   (none)  -- normal server: initialize, tools/list (one "echo" tool),
//              tools/call (echoes its arguments back as text content).
//   "crash" -- exits immediately after starting, to test the adapter's
//              "process died" path.
//   "slow"  -- never responds to tools/call, to test the adapter's
//              request-timeout path.
import readline from 'node:readline';

const mode = process.argv[2] || 'normal';

if (mode === 'crash') {
  process.exit(7);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'notifications/initialized') return; // no response to a notification

  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '0.0.1' } } });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echoes its input back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
    return;
  }
  if (message.method === 'tools/call') {
    if (mode === 'slow') return; // deliberately never respond
    if (message.params?.name !== 'echo') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown tool: ${message.params?.name}` } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(message.params.arguments ?? {}) }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method: ${message.method}` } });
});
