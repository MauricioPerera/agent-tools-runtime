const DEFAULT_URL = 'https://ardf.dev/mcp-server/http';
import { authStatus, getAccessToken } from './n8n-oauth.mjs';
import { closestMatches } from './fuzzy-match.mjs';

export { closestMatches };

async function readPayload(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch {
    const events = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
    for (const event of events.reverse()) {
      try { return JSON.parse(event); } catch { /* try the next SSE event */ }
    }
    return { raw: text };
  }
}

/** Single source of truth for the instance's base URL: N8N_INSTANCE_URL (e.g.
 * "https://ardf.dev"). Both this adapter (MCP) and the REST-based skills
 * (resolveInstanceUrl in skills/_shared.mjs) derive their respective endpoints
 * from it, so configuring one variable is enough for the whole plugin --
 * N8N_MCP_URL remains a supported override for the rare case where MCP and
 * REST are actually served from different hosts. */
function resolveMcpUrl() {
  if (process.env.N8N_MCP_URL) return process.env.N8N_MCP_URL;
  if (process.env.N8N_INSTANCE_URL) return `${process.env.N8N_INSTANCE_URL.replace(/\/+$/, '')}/mcp-server/http`;
  return DEFAULT_URL;
}

export class N8nMcpAdapter {
  constructor({ url = resolveMcpUrl(), token = process.env.N8N_MCP_TOKEN } = {}) {
    this.url = url;
    this.token = token;
    this.tokenInfo = null;
    this.requestId = 0;
  }

  async request(method, params = {}, notification = false) {
    this.tokenInfo ??= await getAccessToken({ explicitToken: this.token });
    const body = { jsonrpc: '2.0', ...(notification ? {} : { id: ++this.requestId }), method, params };
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${this.tokenInfo.accessToken}` },
      body: JSON.stringify(body),
    });
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(`n8n MCP HTTP ${response.status}`);
    if (payload?.error) throw new Error(`n8n MCP ${payload.error.code}: ${payload.error.message}`);
    return payload?.result ?? payload;
  }

  async initialize() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-tools-runtime-poc', version: '0.1.0' } });
    await this.request('notifications/initialized', {}, true);
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
    const tool = (listed.tools || []).find((candidate) => candidate.name === name);
    if (!tool) {
      const names = (listed.tools || []).map((t) => t.name);
      const suggestions = closestMatches(name, names).filter((m) => m.similarity >= 0.5);
      const hint = suggestions.length
        ? ` ¿Quisiste decir: ${suggestions.map((s) => s.name).join(', ')}?`
        : '';
      throw new Error(`Unknown n8n tool: ${name}.${hint}`);
    }
    return tool;
  }

  async call(name, input) {
    await this.initialize();
    return this.request('tools/call', { name, arguments: input });
  }

  async authStatus() {
    return authStatus();
  }

  /** Hook opcional que el loader de plugins llama tras discover() para adjuntar
   * contexto extra a la respuesta (ver runtime/mcp-server.mjs, handleDiscover).
   * Antes del refactor a plugins esto vivía hardcodeado en el handler genérico;
   * ahora es responsabilidad del plugin, porque "cuál es tu proyecto personal"
   * es un concepto de n8n, no algo que el runtime deba saber en general. */
  async discoverContext() {
    let personalProject = null;
    try {
      const raw = await this.call('search_projects', {});
      const text = raw?.content?.[0]?.text;
      const parsed = typeof text === 'string' ? JSON.parse(text) : raw;
      const list = parsed?.data || [];
      personalProject = list.find((p) => p.type === 'personal') || list[0] || null;
    } catch { /* best-effort: si falla, seguimos sin contexto de proyecto */ }
    return {
      personalProject,
      hint: 'Si el usuario no nombró un proyecto específico, omití projectId al crear workflows; create_data_table sí requiere el id del proyecto personal devuelto aquí.',
    };
  }
}
