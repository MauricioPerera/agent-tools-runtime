// Adapter para PocketBase (https://pocketbase.io), un backend self-hosted
// (Go, REST + realtime + auth propios). Sexto plugin del sistema y el
// primero con autenticación DINÁMICA: a diferencia de github/tasks/n8n
// (token o API key ya emitidos, se pasan tal cual), PocketBase no tiene un
// concepto de API key estática para superusers -- hay que hacer login
// (auth-with-password contra la colección _superusers) para conseguir un
// token, igual que un usuario real. Valida que el contrato de adapter
// también generaliza a "necesito autenticarme yo mismo antes de poder
// llamar nada", no solo "adjuntar una credencial que ya tengo".
const PB_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';
const PB_EMAIL = process.env.POCKETBASE_EMAIL;
const PB_PASSWORD = process.env.POCKETBASE_PASSWORD;

// PocketBase pagina de a `perPage` (su propio default es 30; tope real de la
// plataforma es 500) -- default más generoso acá para no reproducir el mismo
// bug de paginación oculta que encontramos hoy en agent-tools-plugin-github
// (REST v3, per_page=20 fijo sin loop). No trae "todo" automáticamente como
// fetchAllWorkflows en el plugin de n8n -- para catálogos de más de 100
// records hace falta iterar `page` explícito.
const DEFAULT_PER_PAGE = 100;

const TOOLS = [
  {
    name: 'list_collections',
    description: 'Lista las colecciones disponibles (nombre, tipo, schema de campos).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_records',
    description: `Lista records de una colección, paginado (default ${DEFAULT_PER_PAGE} por página, no trae todo automáticamente).`,
    inputSchema: { type: 'object', properties: { collection: { type: 'string' }, filter: { type: 'string' }, sort: { type: 'string' }, page: { type: 'integer' }, perPage: { type: 'integer' } }, required: ['collection'] },
  },
  {
    name: 'get_record',
    description: 'Trae un record por id.',
    inputSchema: { type: 'object', properties: { collection: { type: 'string' }, id: { type: 'string' } }, required: ['collection', 'id'] },
  },
  {
    name: 'create_record',
    description: 'Crea un record nuevo en una colección. Muta estado, requiere confirm.',
    inputSchema: { type: 'object', properties: { collection: { type: 'string' }, data: { type: 'object' } }, required: ['collection', 'data'] },
  },
  {
    name: 'update_record',
    description: 'Actualiza (parcial) un record existente. Muta estado, requiere confirm.',
    inputSchema: { type: 'object', properties: { collection: { type: 'string' }, id: { type: 'string' }, data: { type: 'object' } }, required: ['collection', 'id', 'data'] },
  },
  {
    name: 'delete_record',
    description: 'Borra un record por id. Muta estado, requiere confirm.',
    inputSchema: { type: 'object', properties: { collection: { type: 'string' }, id: { type: 'string' } }, required: ['collection', 'id'] },
  },
];

export class PocketBaseAdapter {
  constructor({ url = PB_URL, email = PB_EMAIL, password = PB_PASSWORD } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.email = email;
    this.password = password;
    this.tokenPromise = null;
  }

  // Login perezoso, una sola vez por proceso -- llamadas concurrentes antes
  // de que resuelva la primera comparten la misma promesa en vez de disparar
  // logins duplicados (mismo patrón que getAccessToken en el adapter de n8n,
  // ahí por OAuth cacheado; acá por login con password).
  async getToken() {
    if (!this.email || !this.password) {
      throw new Error('POCKETBASE_EMAIL y POCKETBASE_PASSWORD son requeridos (login de superuser, no hay API key estática en PocketBase)');
    }
    this.tokenPromise ??= (async () => {
      const response = await fetch(`${this.url}/api/collections/_superusers/auth-with-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: this.email, password: this.password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.tokenPromise = null; // no cachear un login fallido -- el próximo intento reintenta
        throw new Error(`PocketBase auth failed (${response.status}): ${body?.message || 'unknown error'}`);
      }
      return body.token;
    })();
    return this.tokenPromise;
  }

  async request(method, path, body) {
    const token = await this.getToken();
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    if (!response.ok) throw new Error(`PocketBase API ${response.status}: ${payload?.message || text}`);
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
    if (!tool) throw new Error(`Unknown PocketBase tool: ${name}`);
    return tool;
  }

  async call(name, args) {
    const a = args || {};
    if (name === 'list_collections') {
      const data = await this.request('GET', '/api/collections');
      return { content: [{ type: 'text', text: JSON.stringify((data.items || []).map((c) => ({ id: c.id, name: c.name, type: c.type, fields: (c.fields || []).map((f) => f.name) }))) }] };
    }
    if (name === 'list_records') {
      const page = a.page || 1;
      const perPage = a.perPage || DEFAULT_PER_PAGE;
      const qs = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (a.filter) qs.set('filter', a.filter);
      if (a.sort) qs.set('sort', a.sort);
      const data = await this.request('GET', `/api/collections/${encodeURIComponent(a.collection)}/records?${qs.toString()}`);
      return { content: [{ type: 'text', text: JSON.stringify({ items: data.items, page: data.page, perPage: data.perPage, totalItems: data.totalItems, totalPages: data.totalPages }) }] };
    }
    if (name === 'get_record') {
      const data = await this.request('GET', `/api/collections/${encodeURIComponent(a.collection)}/records/${encodeURIComponent(a.id)}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    if (name === 'create_record') {
      const data = await this.request('POST', `/api/collections/${encodeURIComponent(a.collection)}/records`, a.data || {});
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    if (name === 'update_record') {
      const data = await this.request('PATCH', `/api/collections/${encodeURIComponent(a.collection)}/records/${encodeURIComponent(a.id)}`, a.data || {});
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    if (name === 'delete_record') {
      await this.request('DELETE', `/api/collections/${encodeURIComponent(a.collection)}/records/${encodeURIComponent(a.id)}`);
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, collection: a.collection, id: a.id }) }] };
    }
    throw new Error(`Unknown PocketBase tool: ${name}`);
  }
}
