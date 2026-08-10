import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GenericMcpAdapter } from '../adapters/generic-mcp.mjs';
import { RestApiAdapter } from '../adapters/rest-api.mjs';
import { LocalCliAdapter } from '../adapters/local-cli.mjs';
import { StdioMcpAdapter } from '../adapters/stdio-mcp.mjs';

function startMockMcp() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    requests.push({ message, session: req.headers['mcp-session-id'] || null });
    if (message.method !== 'initialize' && req.headers['mcp-session-id'] !== 'test-session') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Mcp-Session-Id required' } }));
      return;
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'read_doc', description: 'Read documentation', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', ...(message.method === 'initialize' ? { 'Mcp-Session-Id': 'test-session' } : {}) });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result })}\n\n`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

test('generic MCP supports public session-based servers without a token', async (t) => {
  const mock = await startMockMcp();
  t.after(() => mock.server.close());
  const adapter = new GenericMcpAdapter({ url: mock.url });
  const found = await adapter.search('documentation');
  assert.equal(found.matches[0].name, 'read_doc');
  const described = await adapter.describe('read_doc');
  assert.deepEqual(described.inputSchema, { type: 'object' });
  assert.equal(mock.requests.filter(({ message }) => message.method === 'initialize').length, 1);
  assert.equal(mock.requests[1].session, 'test-session');
});

test('runtime loads a command, executes it, and rejects path traversal', async (t) => {
  const child = spawn(process.execPath, ['runtime/agent-tools-runtime.mjs', 'serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const lines = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => lines.push(...chunk.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)));
  const send = (request) => child.stdin.write(`${JSON.stringify(request)}\n`);
  const waitFor = async (count) => {
    for (let i = 0; i < 50 && lines.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    return lines[count - 1];
  };
  send({ action: 'load', module: 'commands/runtime-demo.mjs' });
  assert.equal((await waitFor(1)).code, 0);
  send({ action: 'exec', command: 'runtime-echo hello' });
  assert.match((await waitFor(2)).data.stdout, /hello/);
  send({ action: 'load', module: '../outside.mjs' });
  assert.equal((await waitFor(3)).code, 3);
});

test('REST adapter allows reads and gates mutations', async (t) => {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const adapter = new RestApiAdapter({});
  process.env.AGENT_API_BASE_URL = `http://127.0.0.1:${server.address().port}/api/`;
  t.after(() => delete process.env.AGENT_API_BASE_URL);
  const read = await adapter.request('GET', '/health');
  assert.equal(read.data.method, 'GET');
  await assert.rejects(() => adapter.request('POST', '/workflows', { name: 'demo' }), /Confirmation required/);
  const write = await adapter.request('POST', '/workflows', { name: 'demo' }, { confirm: true });
  assert.deepEqual(write.data.body, { name: 'demo' });
});

test('local CLI adapter requires an allowlist and explicit confirmation', async (t) => {
  const previous = process.env.AGENT_CLI_ALLOWLIST;
  process.env.AGENT_CLI_ALLOWLIST = process.execPath;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_CLI_ALLOWLIST;
    else process.env.AGENT_CLI_ALLOWLIST = previous;
  });
  const adapter = new LocalCliAdapter();
  await assert.rejects(
    () => adapter.run(process.execPath, ['-e', 'console.log("cli-ok")']),
    /Confirmation required/,
  );
  const result = await adapter.run(process.execPath, ['-e', 'console.log("cli-ok")'], { confirm: true });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /cli-ok/);
  const failed = await adapter.run(process.execPath, ['-e', 'process.exit(7)'], { confirm: true });
  assert.equal(failed.exitCode, 7);
});

const stdioFixture = fileURLToPath(new URL('./stdio-mcp-fixture.mjs', import.meta.url));

test('stdio MCP adapter spawns a real process and speaks newline-delimited JSON-RPC', async (t) => {
  const adapter = new StdioMcpAdapter({ command: process.execPath, args: [stdioFixture] });
  t.after(() => adapter.close());
  const found = await adapter.search('echo');
  assert.equal(found.matches[0].name, 'echo');
  const described = await adapter.describe('echo');
  assert.deepEqual(described.inputSchema, { type: 'object', properties: { text: { type: 'string' } } });
  const called = await adapter.call('echo', { text: 'hi' });
  assert.deepEqual(JSON.parse(called.content[0].text), { text: 'hi' });
});

test('stdio MCP adapter rejects a call to an unknown command', async () => {
  const adapter = new StdioMcpAdapter({ command: 'this-command-does-not-exist-anywhere' });
  await assert.rejects(() => adapter.listTools(), /stdio-mcp:/);
});

test('stdio MCP adapter surfaces a process crash to any pending request', async () => {
  const adapter = new StdioMcpAdapter({ command: process.execPath, args: [stdioFixture, 'crash'] });
  await assert.rejects(() => adapter.listTools(), /exited/);
});

test('stdio MCP adapter times out a request that never gets a response', async (t) => {
  const adapter = new StdioMcpAdapter({ command: process.execPath, args: [stdioFixture, 'slow'], timeoutMs: 200 });
  t.after(() => adapter.close());
  await assert.rejects(() => adapter.call('echo', {}), /timed out after 200ms/);
});

test('stdio MCP adapter respawns after the process dies instead of staying dead', async (t) => {
  const adapter = new StdioMcpAdapter({ command: process.execPath, args: [stdioFixture] });
  t.after(() => adapter.close());
  await adapter.listTools(); // starts the process
  adapter.proc.kill(); // simulate an external crash, not one this adapter caused
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the 'exit' handler run
  assert.equal(adapter.proc, null);
  // ensureStarted() must spawn a fresh process here, not reuse the dead one.
  const found = await adapter.search('echo');
  assert.equal(found.matches[0].name, 'echo');
});

test('runtime probe reports requested CLI availability without executing it', () => {
  const script = fileURLToPath(new URL('../scripts/runtime_probe.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_TOOLS_COMMAND: process.execPath, AGENT_CLI_ALLOWLIST: process.execPath },
  });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.requestedCommand.name, process.execPath);
  assert.equal(report.checks.requestedCommand.available, true);
  assert.equal(report.checks.requestedCommand.allowlisted, true);
  assert.equal(report.checks.requestedCommand.executed, false);
});

test('runtime status exposes adapter catalog without loading adapters', () => {
  const result = spawnSync(process.execPath, ['runtime/agent-tools-runtime.mjs', 'status'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const status = JSON.parse(result.stdout);
  assert.deepEqual(status.data.commands, []);
  assert.deepEqual(status.data.availableAdapters.map(({ name }) => name), ['generic-mcp', 'n8n-mcp', 'rest-api', 'local-cli', 'stdio-mcp']);
});

test('MCP facade exposes generic tools plus the typed facade generated from the n8n plugin', async (t) => {
  const child = spawn(process.execPath, ['runtime/mcp-server.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const responses = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => responses.push(...chunk.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (count) => {
    for (let i = 0; i < 50 && responses.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    return responses[count - 1];
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal((await waitFor(1)).result.serverInfo.name, 'agent-tools-runtime');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  // No es un assert de igualdad exacta: hay 2 plugins reales en el repo
  // (agent-tools-plugin-n8n, agent-tools-plugin-github) y discoverPlugins() los
  // escanea a los dos -- una lista fija se rompería cada vez que se agregue un
  // plugin nuevo. Se valida que los tools base y los de CADA plugin conocido
  // estén presentes (subset), no el conjunto completo ni el orden.
  const toolNames = (await waitFor(2)).result.tools.map((tool) => tool.name);
  for (const expected of [
    'agent_tools_help', 'agent_tools_exec',
    'agent_tools_n8n_discover', 'agent_tools_n8n_call', 'agent_tools_n8n_run_skill',
    'agent_tools_github_discover', 'agent_tools_github_call', 'agent_tools_github_run_skill',
  ]) {
    assert.ok(toolNames.includes(expected), `esperaba '${expected}' en tools/list, no estaba: ${toolNames.join(', ')}`);
  }
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_tools_help', arguments: {} } });
  const help = (await waitFor(3)).result.content[0].text;
  assert.match(help, /commands\/generic-mcp\.mjs/);
  assert.match(help, /commands\/local-cli\.mjs/);
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent_tools_exec', arguments: { command: 'status' } } });
  const status = JSON.parse((await waitFor(4)).result.content[0].text);
  assert.equal(status.code, 0);
  assert.equal(status.data.status, 'READY');
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent_tools_n8n_call', arguments: {} } });
  const invalidCall = await waitFor(5);
  assert.equal(invalidCall.result.isError, true);
  assert.match(invalidCall.result.content[0].text, /toolName is required/);
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'agent_tools_n8n_run_skill', arguments: { skill: 'does-not-exist', arguments: {} } } });
  const invalidSkill = await waitFor(6);
  assert.equal(invalidSkill.result.isError, true);
  assert.match(invalidSkill.result.content[0].text, /Unknown skill: does-not-exist/);
  assert.match(invalidSkill.result.content[0].text, /insert-and-verify-datatable-row/);
  // Segundo plugin (agent-tools-plugin-github): mismo contrato, otro servicio --
  // valida que el gate de confirm no es algo especial del plugin de n8n.
  send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'agent_tools_github_call', arguments: { toolName: 'create_issue', arguments: { owner: 'x', repo: 'y', title: 'z' } } } });
  const unconfirmedMutation = await waitFor(7);
  assert.equal(unconfirmedMutation.result.isError, true);
  assert.match(unconfirmedMutation.result.content[0].text, /Confirmation required for mutating github tool: create_issue/);
});

test('standalone package starts the MCP facade from its runtime entrypoint', async () => {
  const result = spawnSync(process.execPath, ['runtime/mcp-server.mjs'], {
    input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).result.serverInfo.name, 'agent-tools-runtime');
});
