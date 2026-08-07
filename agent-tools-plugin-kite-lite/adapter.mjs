// Adapter para kite-lite (https://github.com/MauricioPerera/kite-lite), un
// motor web ligero en Rust orientado a agentes. A diferencia de los otros dos
// plugins (n8n envuelve un MCP HTTP; github envuelve una REST API con un
// catálogo de tools inventado por el plugin), kite-lite YA habla MCP real
// (JSON-RPC 2.0 sobre stdio, mismo protocolo que agent-tools-runtime usa
// hacia afuera) -- así que este adapter es un CLIENTE MCP por stdio: spawnea
// `kite-lite mcp` como proceso hijo y reenvía tools/list y tools/call tal
// cual. Valida que el contrato de adapter también generaliza a "envolver
// otro proceso que ya habla MCP", el tercer caso posible (HTTP MCP / REST
// propia / stdio MCP).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class KiteLiteAdapter {
  constructor({ command = process.env.KITE_LITE_BIN || 'kite-lite' } = {}) {
    this.command = command;
    this.child = null;
    this.rl = null;
    this.requestId = 0;
    this.pending = new Map();
    this.initialized = null;
  }

  ensureStarted() {
    if (this.child) return;
    this.child = spawn(this.command, ['mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`kite-lite MCP ${msg.error.code}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    });
    this.child.on('exit', (code) => {
      for (const waiter of this.pending.values()) waiter.reject(new Error(`kite-lite process exited (code ${code})`));
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
    this.initialized = this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-tools-plugin-kite-lite', version: '0.1.0' } });
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
    if (!tool) throw new Error(`Unknown kite-lite tool: ${name}`);
    return tool;
  }

  async call(name, args) {
    await this.initialize();
    const result = await this.request('tools/call', { name, arguments: args || {} });
    // El server de kite-lite ya devuelve { content: [...], isError } -- mismo
    // shape MCP estándar que espera extractContentJson() del runtime.
    return result;
  }
}
