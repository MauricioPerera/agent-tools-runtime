async function readPayload(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch {
    for (const line of text.split(/\r?\n/).filter((value) => value.startsWith('data:')).reverse()) {
      try { return JSON.parse(line.slice(5).trim()); } catch { /* continue */ }
    }
    return { raw: text };
  }
}

export class GenericMcpAdapter {
  constructor({ url = process.env.AGENT_MCP_URL, token = process.env.AGENT_MCP_TOKEN } = {}) {
    this.url = url;
    this.token = token;
    this.requestId = 0;
    this.sessionId = null;
    this.initialized = false;
  }

  async request(method, params = {}, notification = false) {
    if (!this.url) throw new Error('AGENT_MCP_URL is not configured');
    const message = { jsonrpc: '2.0', ...(notification ? {} : { id: ++this.requestId }), method, params };
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });
    this.sessionId ||= response.headers.get('mcp-session-id');
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    if (payload?.error) throw new Error(`MCP ${payload.error.code}: ${payload.error.message}`);
    return payload?.result ?? payload;
  }

  async initialize() {
    if (this.initialized) return;
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-tools-runtime-poc', version: '0.2.0' } });
    await this.request('notifications/initialized', {}, true);
    this.initialized = true;
  }

  async listTools() { await this.initialize(); return this.request('tools/list'); }

  async search(query, limit = 5) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error('A search query is required');
    const listed = await this.listTools();
    const max = Math.max(1, Math.min(Number(limit) || 5, 20));
    return { query, matches: (listed.tools || []).map((tool) => {
      const text = `${tool.name} ${tool.description || ''}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (text.includes(term) ? (tool.name.includes(term) ? 3 : 1) : 0), 0);
      return { tool, score };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, max).map(({ tool, score }) => ({ name: tool.name, description: tool.description || '', score })) };
  }

  async describe(name) {
    const listed = await this.listTools();
    const tool = (listed.tools || []).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    return tool;
  }

  async call(name, input) { await this.initialize(); return this.request('tools/call', { name, arguments: input }); }
}
