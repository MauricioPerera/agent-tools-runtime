// Quinto plugin REST self-hosted (mismo caso que tasks/pocketbase: sin MCP
// nativo, catalogo de tools inventado por el plugin), y el mas simple de
// todos: Ollama no tiene auth por default. Alcance a proposito para esta
// primera version: solo lo que la API REST propia de Ollama expone
// directamente (listar/bajar modelos, generate/chat de una sola pasada).
// NO delega tareas con acceso a herramientas -- eso es un problema distinto
// (llamadas de varios minutos, requeriria semantica async que el runtime no
// tiene hoy, riesgo de recursion si el agente delegado reusa las mismas MCP
// tools) y se evaluo por separado antes de arrancar este plugin.
const API_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';

const TOOLS = [
  {
    name: 'list_models',
    description: 'Lista los modelos disponibles localmente (descargados o cloud-linked). Ver "capabilities" de cada uno (completion/tools/thinking/vision) antes de elegir uno para generate/chat.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_running_models',
    description: 'Lista los modelos actualmente cargados en memoria (procesos activos).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'generate',
    description: 'Completion de una sola pasada (prompt -> texto), sin historial de mensajes. stream:false siempre -- espera la respuesta completa. Muta cómputo real (tiempo/costo), requiere confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Nombre exacto tal como aparece en list_models (ej. "qwen2.5:0.5b").' },
        prompt: { type: 'string' },
        system: { type: 'string', description: 'System prompt opcional.' },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name: 'chat',
    description: 'Completion con historial de mensajes (role/content). stream:false siempre. Muta cómputo real (tiempo/costo), requiere confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: { role: { type: 'string' }, content: { type: 'string' } },
            required: ['role', 'content'],
          },
        },
      },
      required: ['model', 'messages'],
    },
  },
  {
    name: 'pull_model',
    description: 'Descarga un modelo al disco local. Puede tardar minutos (modelo grande = descarga grande). Muta estado (disco), requiere confirm.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
  },
];

function textContent(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export class OllamaAdapter {
  constructor({ baseUrl = API_BASE } = {}) {
    this.baseUrl = baseUrl;
  }

  async request(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    if (!response.ok) throw new Error(`ollama API ${response.status}: ${payload?.error || text}`);
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
    if (!tool) throw new Error(`Unknown ollama tool: ${name}`);
    return tool;
  }

  async call(name, args) {
    const a = args || {};
    if (name === 'list_models') {
      const data = await this.request('GET', '/api/tags');
      return textContent(data.models || []);
    }
    if (name === 'list_running_models') {
      const data = await this.request('GET', '/api/ps');
      return textContent(data.models || []);
    }
    if (name === 'generate') {
      const data = await this.request('POST', '/api/generate', {
        model: a.model, prompt: a.prompt, system: a.system, stream: false,
      });
      return textContent({
        model: data.model, response: data.response, done: data.done,
        total_duration_ms: data.total_duration ? Math.round(data.total_duration / 1e6) : undefined,
        eval_count: data.eval_count,
      });
    }
    if (name === 'chat') {
      const data = await this.request('POST', '/api/chat', {
        model: a.model, messages: a.messages, stream: false,
      });
      return textContent({
        model: data.model, message: data.message, done: data.done,
        total_duration_ms: data.total_duration ? Math.round(data.total_duration / 1e6) : undefined,
        eval_count: data.eval_count,
      });
    }
    if (name === 'pull_model') {
      const data = await this.request('POST', '/api/pull', { model: a.model, stream: false });
      return textContent(data);
    }
    throw new Error(`Unknown ollama tool: ${name}`);
  }
}
