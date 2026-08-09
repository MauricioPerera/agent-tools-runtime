// Adapter real de GitHub (REST API v3), no un mock. Segundo plugin del sistema
// (el primero es agent-tools-plugin-n8n) -- pensado para validar que el
// contrato de adapter generaliza a un servicio que no es un MCP server, es una
// REST API cualquiera con su propio catalogo de endpoints.
const API_BASE = 'https://api.github.com';

// Catalogo fijo de "tools": GitHub no tiene un tools/list como un MCP server,
// asi que el catalogo lo define el plugin. Cada entrada mapea a un endpoint
// real de la REST API v3.
const TOOLS = [
  {
    name: 'search_repositories',
    description: 'Busca repositorios de GitHub por texto libre.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
  },
  {
    name: 'get_repository',
    description: 'Trae metadata de un repositorio (stars, forks, descripcion, default branch, etc).',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'list_issues',
    description: 'Lista issues de un repositorio.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'get_latest_commit',
    description: 'Trae el ultimo commit de una rama de un repositorio.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Crea un issue nuevo en un repositorio. Muta estado, requiere confirm.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
];

export class GitHubAdapter {
  constructor({ token = process.env.GITHUB_TOKEN } = {}) {
    this.token = token;
  }

  async request(method, path, body) {
    if (!this.token) throw new Error('GITHUB_TOKEN is not configured');
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${payload?.message || text}`);
    return payload;
  }

  /** list_issues pedia per_page=20 fijo, sin loop ni cursor -- cualquier repo
   * con mas de 20 issues en el estado pedido devolvia un conteo/lista
   * silenciosamente incompleta (mismo patron que el bug real de paginacion
   * de search_workflows/audit-workflows en el plugin de n8n). Pagina de a 100
   * (el maximo de la REST API v3) y sigue hasta que una pagina vuelve con
   * menos de 100 items -- misma heuristica que fetchAllWorkflows en
   * agent-tools-plugin-n8n/skills/_shared.mjs, sin tope artificial: "listar
   * issues" tiene que significar todos, no una muestra. */
  async fetchAllIssues(owner, repo, state) {
    const perPage = 100;
    let page = 1;
    let all = [];
    while (true) {
      const data = await this.request('GET', `/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}&page=${page}`);
      all = all.concat(data);
      if (data.length < perPage) break;
      page += 1;
    }
    return all;
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
    if (!tool) throw new Error(`Unknown GitHub tool: ${name}`);
    return tool;
  }

  async call(name, args) {
    const a = args || {};
    if (name === 'search_repositories') {
      const data = await this.request('GET', `/search/repositories?q=${encodeURIComponent(a.query)}&per_page=${a.limit || 5}`);
      return { content: [{ type: 'text', text: JSON.stringify({ total_count: data.total_count, items: (data.items || []).map((r) => ({ full_name: r.full_name, description: r.description, stars: r.stargazers_count, url: r.html_url })) }) }] };
    }
    if (name === 'get_repository') {
      const r = await this.request('GET', `/repos/${a.owner}/${a.repo}`);
      return { content: [{ type: 'text', text: JSON.stringify({ full_name: r.full_name, description: r.description, stars: r.stargazers_count, forks: r.forks_count, open_issues: r.open_issues_count, default_branch: r.default_branch, url: r.html_url, updated_at: r.updated_at }) }] };
    }
    if (name === 'list_issues') {
      const state = a.state || 'open';
      const all = await this.fetchAllIssues(a.owner, a.repo, state);
      return { content: [{ type: 'text', text: JSON.stringify(all.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url }))) }] };
    }
    if (name === 'get_latest_commit') {
      const branch = a.branch ? `?sha=${a.branch}` : '';
      const data = await this.request('GET', `/repos/${a.owner}/${a.repo}/commits${branch}`);
      const c = data[0];
      return { content: [{ type: 'text', text: JSON.stringify({ sha: c.sha, message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date, url: c.html_url }) }] };
    }
    if (name === 'create_issue') {
      const r = await this.request('POST', `/repos/${a.owner}/${a.repo}/issues`, { title: a.title, body: a.body || '' });
      return { content: [{ type: 'text', text: JSON.stringify({ number: r.number, url: r.html_url }) }] };
    }
    throw new Error(`Unknown GitHub tool: ${name}`);
  }
}
