// Cuarto plugin del sistema, y el primero contra una API propia self-hosted
// (no un MCP server como n8n/kite-lite, no un SaaS de terceros como GitHub):
// un CRUD REST minimo desplegado en el VPS del proyecto (server.mjs bajo
// /opt/agent-tools-tasks-api, expuesto via nginx en api.ardf.dev/tasks/),
// pensado para validar que el contrato de adapter tambien generaliza a
// infraestructura propia sin login/OAuth, solo una API key compartida.
const API_BASE = process.env.TASKS_API_BASE || 'https://api.ardf.dev/tasks';

const TOOLS = [
  {
    name: 'list_tasks',
    description: 'Lista tasks. Filtro opcional por texto libre en el titulo.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
  {
    name: 'get_task',
    description: 'Trae una task por id.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'create_task',
    description: 'Crea una task nueva. Muta estado, requiere confirm.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, done: { type: 'boolean' } }, required: ['title'] },
  },
  {
    name: 'update_task',
    description: 'Actualiza titulo y/o estado done de una task existente. Muta estado, requiere confirm.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, done: { type: 'boolean' } }, required: ['id'] },
  },
  {
    name: 'delete_task',
    description: 'Borra una task por id. Muta estado, requiere confirm.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
];

export class TasksAdapter {
  constructor({ apiKey = process.env.TASKS_API_KEY, baseUrl = API_BASE } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async request(method, path, body) {
    if (!this.apiKey) throw new Error('TASKS_API_KEY is not configured');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    if (!response.ok) throw new Error(`tasks API ${response.status}: ${payload?.error || text}`);
    return payload;
  }

  async listTools() { return { tools: TOOLS }; }

  async search(query, limit = 5) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error('A search query is required');
    const max = Math.max(1, Math.min(Number(limit) || 5, 20));
    return {
      query,
      matches: TOOLS.map((tool) => {
        const text = `${tool.name} ${tool.description}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (text.includes(term) ? (tool.name.includes(term) ? 3 : 1) : 0), 0);
        return { tool, score };
      }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, max)
        .map(({ tool, score }) => ({ name: tool.name, description: tool.description, score })),
    };
  }

  async describe(name) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tasks tool: ${name}`);
    return tool;
  }

  async call(name, args) {
    const a = args || {};
    if (name === 'list_tasks') {
      const qs = a.q ? `?q=${encodeURIComponent(a.q)}` : '';
      const data = await this.request('GET', `/tasks${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(data.tasks) }] };
    }
    if (name === 'get_task') {
      const data = await this.request('GET', `/tasks/${a.id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data.task) }] };
    }
    if (name === 'create_task') {
      const data = await this.request('POST', '/tasks', { title: a.title, done: a.done });
      return { content: [{ type: 'text', text: JSON.stringify(data.task) }] };
    }
    if (name === 'update_task') {
      const { id, ...rest } = a;
      const data = await this.request('PATCH', `/tasks/${id}`, rest);
      return { content: [{ type: 'text', text: JSON.stringify(data.task) }] };
    }
    if (name === 'delete_task') {
      const data = await this.request('DELETE', `/tasks/${a.id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data.deleted) }] };
    }
    throw new Error(`Unknown tasks tool: ${name}`);
  }
}
