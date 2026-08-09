// Adapter para ccdd-gate (D:/repos/ccddgate, github.com/MauricioPerera/KDD), el
// servidor MCP de gates deterministas (AST) del metodo CCDD. Mismo caso que
// kite-lite: el backend YA habla MCP real (JSON-RPC 2.0 sobre stdio) -- asi
// que este adapter tambien es un CLIENTE MCP por stdio, no un catalogo
// inventado. Unica diferencia real de forma respecto a KiteLiteAdapter: el
// backend se invoca en DOS partes (`python <scriptPath>`), no un binario
// unico con subcomando (`kite-lite mcp`).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class CcddGateAdapter {
  constructor({
    command = process.env.CCDD_GATE_PYTHON || 'python',
    scriptPath = process.env.CCDD_GATE_SCRIPT,
  } = {}) {
    if (!scriptPath) throw new Error('CcddGateAdapter requires scriptPath (o env CCDD_GATE_SCRIPT): ruta a complexity_mcp.py');
    this.command = command;
    this.scriptPath = scriptPath;
    this.child = null;
    this.rl = null;
    this.requestId = 0;
    this.pending = new Map();
    this.initialized = null;
  }

  ensureStarted() {
    if (this.child) return;
    this.child = spawn(this.command, [this.scriptPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`ccdd-gate MCP ${msg.error.code}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    });
    this.child.on('exit', (code) => {
      for (const waiter of this.pending.values()) waiter.reject(new Error(`ccdd-gate process exited (code ${code})`));
      this.pending.clear();
      this.child = null;
    });
    // Mismo bug real que documenta KiteLiteAdapter: sin este handler, un
    // spawn fallido (python mal configurado, ENOENT, scriptPath invalido)
    // crashea todo mcp-server.mjs, no solo este plugin.
    this.child.on('error', (err) => {
      for (const waiter of this.pending.values()) waiter.reject(new Error(`ccdd-gate process failed to start: ${err.message}`));
      this.pending.clear();
      this.child = null;
    });
  }

  request(method, params = {}) {
    this.ensureStarted();
    const id = ++this.requestId;
    const body = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(body)}\n`);
    });
  }

  async initialize() {
    if (this.initialized) return this.initialized;
    this.initialized = this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-tools-plugin-ccdd-gate', version: '0.1.0' } });
    await this.initialized;
    return this.initialized;
  }

  async listTools() {
    await this.initialize();
    return this.request('tools/list');
  }

  async search(query, limit = 5) {
    const listed = await this.listTools();
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error('A search query is required');
    const max = Math.max(1, Math.min(Number(limit) || 5, 20));
    return { query, matches: (listed.tools || []).map((tool) => {
      const text = `${tool.name} ${tool.description || ''}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (text.includes(term) ? (tool.name.includes(term) ? 3 : 1) : 0), 0);
      return { tool, score };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, max).map(({ tool, score }) => ({ name: tool.name, description: tool.description || '', score })) };
  }

  async describe(name) {
    const listed = await this.listTools();
    const tool = (listed.tools || []).find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown ccdd-gate tool: ${name}`);
    return tool;
  }

  async call(name, args) {
    await this.initialize();
    const result = await this.request('tools/call', { name, arguments: args || {} });
    return result;
  }
}
