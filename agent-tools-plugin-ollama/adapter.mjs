// Quinto plugin REST self-hosted (mismo caso que tasks/pocketbase: sin MCP
// nativo, catalogo de tools inventado por el plugin), y el mas simple de
// todos: Ollama no tiene auth por default. Alcance a proposito para esta
// primera version: solo lo que la API REST propia de Ollama expone
// directamente (listar/bajar modelos, generate/chat de una sola pasada).
// NO delega tareas con acceso a herramientas -- eso es un problema distinto
// (llamadas de varios minutos, requeriria semantica async que el runtime no
// tiene hoy, riesgo de recursion si el agente delegado reusa las mismas MCP
// tools) y se evaluo por separado antes de arrancar este plugin.
//
// Ollama Cloud (https://docs.ollama.com/cloud) expone los mismos endpoints
// (/api/tags, /api/chat, /api/generate) con el mismo shape de
// request/response -- solo cambia el host (https://ollama.com en vez de
// localhost) y que exige `Authorization: Bearer <key>`. Verificado en vivo
// contra la API real. Precedencia de resolucion de baseUrl:
//   1. OLLAMA_URL explicito -- siempre gana, sea cual sea OLLAMA_API_KEY.
//   2. OLLAMA_API_KEY sin OLLAMA_URL -- default a Ollama Cloud, para poder
//      usar el plugin sin depender de tener Ollama instalado localmente.
//   3. Ninguno de los dos -- default de siempre, localhost.
const DEFAULT_LOCAL_URL = 'http://localhost:11434';
const DEFAULT_CLOUD_URL = 'https://ollama.com';

function resolveBaseUrl({ baseUrl, apiKey }) {
  if (baseUrl) return baseUrl;
  if (process.env.OLLAMA_URL) return process.env.OLLAMA_URL;
  if (apiKey || process.env.OLLAMA_API_KEY) return DEFAULT_CLOUD_URL;
  return DEFAULT_LOCAL_URL;
}

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
    description: 'Completion de una sola pasada (prompt -> texto), sin historial de mensajes. stream:false siempre -- espera la respuesta completa. `images` (opcional) manda imágenes junto al prompt -- requiere un modelo con capability "vision" (ver list_models), si no Ollama la ignora en silencio. Muta cómputo real (tiempo/costo), requiere confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Nombre exacto tal como aparece en list_models (ej. "qwen2.5:0.5b"). Para imágenes, necesita capability "vision".' },
        prompt: { type: 'string' },
        system: { type: 'string', description: 'System prompt opcional.' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Opcional. Imágenes en base64 puro (sin el prefijo "data:image/...;base64,"), una por elemento. Solo tiene efecto con un modelo capability "vision".',
        },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name: 'chat',
    description: 'Completion con historial de mensajes (role/content, `images` opcional por mensaje). stream:false siempre. `images` en un mensaje requiere un modelo con capability "vision" (ver list_models), si no Ollama lo ignora en silencio. Muta cómputo real (tiempo/costo), requiere confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Para mandar imágenes, necesita capability "vision".' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              content: { type: 'string' },
              images: {
                type: 'array',
                items: { type: 'string' },
                description: 'Opcional. Imágenes en base64 puro (sin el prefijo "data:image/...;base64,") adjuntas a ESTE mensaje.',
              },
            },
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
  {
    name: 'start_generate',
    description: 'Igual que generate (incluido `images` opcional), pero NO espera la respuesta: dispara el request y devuelve {jobId} al toque. Usalo cuando el modelo puede tardar (cloud grande, modelos que razonan mucho) y no querés bloquear la llamada. Consultá el resultado con job_status({jobId}). Muta cómputo real, requiere confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        prompt: { type: 'string' },
        system: { type: 'string' },
        images: { type: 'array', items: { type: 'string' }, description: 'Opcional, mismo formato que generate.' },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name: 'start_chat',
    description: 'Igual que chat (incluido `images` opcional por mensaje), pero NO espera la respuesta: dispara el request y devuelve {jobId} al toque. Consultá el resultado con job_status({jobId}). Muta cómputo real, requiere confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              content: { type: 'string' },
              images: { type: 'array', items: { type: 'string' }, description: 'Opcional, mismo formato que chat.' },
            },
            required: ['role', 'content'],
          },
        },
      },
      required: ['model', 'messages'],
    },
  },
  {
    name: 'job_status',
    description: 'Estado de un job lanzado con start_generate/start_chat: "running" (todavía generando, no está muerto), "done" (con el resultado) o "error" (con el mensaje). Incluye elapsedMs para saber cuánto lleva corriendo. El tracking vive en memoria del proceso runtime -- se pierde si el server MCP se reinicia (el request en sí sigue su curso del lado de Ollama, pero se pierde la referencia).',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
  {
    name: 'list_jobs',
    description: 'Lista todos los jobs trackeados en esta sesión (running/done/error), más recientes primero.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_job',
    description: 'Aborta un job "running" (via AbortController sobre el fetch). No hace nada si ya terminó. Requiere confirm.',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
];

function textContent(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function formatGenerate(data) {
  return {
    model: data.model, response: data.response, done: data.done,
    total_duration_ms: data.total_duration ? Math.round(data.total_duration / 1e6) : undefined,
    eval_count: data.eval_count,
  };
}

function formatChat(data) {
  return {
    model: data.model, message: data.message, done: data.done,
    total_duration_ms: data.total_duration ? Math.round(data.total_duration / 1e6) : undefined,
    eval_count: data.eval_count,
  };
}

let jobCounter = 0;

export class OllamaAdapter {
  constructor({ baseUrl, apiKey = process.env.OLLAMA_API_KEY } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = resolveBaseUrl({ baseUrl, apiKey });
    // Tracking en memoria de esta instancia -- se pierde si el proceso
    // runtime se reinicia (documentado en la description de job_status).
    this.jobs = new Map();
  }

  async request(method, path, body, { signal } = {}) {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    if (!response.ok) throw new Error(`ollama API ${response.status}: ${payload?.error || text}`);
    return payload;
  }

  // Dispara `path`/`body` SIN esperarlo, guarda el job en this.jobs, y
  // devuelve el jobId al toque. `format` mapea la respuesta cruda de Ollama
  // al mismo shape que devuelve la tool sincrona equivalente (generate/chat).
  startJob(path, body, format) {
    const jobId = `job_${Date.now()}_${++jobCounter}`;
    const controller = new AbortController();
    const job = { jobId, status: 'running', startedAt: Date.now(), finishedAt: null, result: null, error: null, controller };
    this.jobs.set(jobId, job);
    this.request('POST', path, body, { signal: controller.signal })
      .then((data) => { job.status = 'done'; job.finishedAt = Date.now(); job.result = format(data); })
      .catch((e) => { job.status = e.name === 'AbortError' ? 'cancelled' : 'error'; job.finishedAt = Date.now(); job.error = e.message; });
    return jobId;
  }

  jobView(job) {
    const elapsedMs = (job.finishedAt || Date.now()) - job.startedAt;
    return { jobId: job.jobId, status: job.status, elapsedMs, result: job.result, error: job.error };
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
        model: a.model, prompt: a.prompt, system: a.system, images: a.images, stream: false,
      });
      return textContent(formatGenerate(data));
    }
    if (name === 'chat') {
      const data = await this.request('POST', '/api/chat', {
        model: a.model, messages: a.messages, stream: false,
      });
      return textContent(formatChat(data));
    }
    if (name === 'pull_model') {
      const data = await this.request('POST', '/api/pull', { model: a.model, stream: false });
      return textContent(data);
    }
    if (name === 'start_generate') {
      const jobId = this.startJob('/api/generate', { model: a.model, prompt: a.prompt, system: a.system, images: a.images, stream: false }, formatGenerate);
      return textContent({ jobId, status: 'running' });
    }
    if (name === 'start_chat') {
      const jobId = this.startJob('/api/chat', { model: a.model, messages: a.messages, stream: false }, formatChat);
      return textContent({ jobId, status: 'running' });
    }
    if (name === 'job_status') {
      const job = this.jobs.get(a.jobId);
      if (!job) throw new Error(`Unknown jobId: ${a.jobId}`);
      return textContent(this.jobView(job));
    }
    if (name === 'list_jobs') {
      const jobs = [...this.jobs.values()].sort((x, y) => y.startedAt - x.startedAt).map((j) => this.jobView(j));
      return textContent(jobs);
    }
    if (name === 'cancel_job') {
      const job = this.jobs.get(a.jobId);
      if (!job) throw new Error(`Unknown jobId: ${a.jobId}`);
      if (job.status === 'running') job.controller.abort();
      return textContent(this.jobView(job));
    }
    throw new Error(`Unknown ollama tool: ${name}`);
  }
}
