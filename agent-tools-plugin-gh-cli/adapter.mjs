// Adapter para el GitHub CLI (`gh`), no la REST API directa (eso ya lo cubre
// agent-tools-plugin-github). Quinto plugin del sistema y el primero de
// transporte CLI: en vez de MCP sobre HTTP (n8n), MCP sobre stdio (kite-lite)
// o REST con catálogo inventado (github, tasks), éste habla con un binario ya
// instalado via execFile + parseo de stdout/exit code -- valida que el
// contrato de adapter (listTools/search/describe/call) también generaliza a
// "shellear un CLI" como cuarta forma de transporte.
//
// Autenticación: a diferencia de los otros adapters, `gh` NO recibe un token
// por variable de entorno de este proceso -- usa la sesión local de
// `gh auth login` (keyring del SO). Si esa sesión no existe o venció, cada
// llamada falla con el stderr real de gh (ej. "To use GitHub CLI in a
// GitHub Actions workflow, set the GH_TOKEN..."), no con un error genérico
// nuestro -- se propaga tal cual para no esconder la causa real.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GH_BIN = process.env.GH_CLI_BIN || 'gh';

// gh CLI ya pagina internamente hasta lo que le pidas por --limit (no
// hardcodea un tope de a 30 por request como hace su propio default) -- pero
// SIN --limit explícito, gh usa 30, que reproduciría el mismo bug de
// paginación que encontramos y arreglamos hoy en agent-tools-plugin-github
// (REST, per_page=20 fijo). Default generoso acá en vez de heredar el de gh.
const DEFAULT_LIST_LIMIT = 200;

const TOOLS = [
  {
    name: 'repo_view',
    description: 'Trae metadata de un repositorio (stars, forks, descripción, default branch, etc) via `gh repo view`.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'issue_list',
    description: 'Lista issues de un repositorio via `gh issue list` (pagina internamente hasta `limit`, default 200).',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' }, limit: { type: 'integer' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'pr_list',
    description: 'Lista pull requests de un repositorio via `gh pr list` (pagina internamente hasta `limit`, default 200).',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' }, limit: { type: 'integer' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'issue_create',
    description: 'Crea un issue nuevo via `gh issue create`. Muta estado, requiere confirm.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
];

async function runGh(args) {
  try {
    const { stdout } = await execFileAsync(GH_BIN, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    // execFile rechaza con { message, stderr, code } en fallos -- el stderr
    // real de gh (auth vencida, repo inexistente, rate limit, etc.) es mucho
    // más útil que e.message solo (a veces genérico, "Command failed").
    const detail = e.stderr?.trim() || e.message;
    throw new Error(`gh CLI failed (${args.join(' ')}): ${detail}`);
  }
}

export class GhCliAdapter {
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
    if (!tool) throw new Error(`Unknown gh CLI tool: ${name}`);
    return tool;
  }

  async call(name, args) {
    const a = args || {};
    if (name === 'repo_view') {
      const stdout = await runGh(['repo', 'view', `${a.owner}/${a.repo}`, '--json', 'name,description,stargazerCount,forkCount,url,defaultBranchRef,updatedAt']);
      const r = JSON.parse(stdout);
      return { content: [{ type: 'text', text: JSON.stringify({ full_name: r.name, description: r.description, stars: r.stargazerCount, forks: r.forkCount, default_branch: r.defaultBranchRef?.name, url: r.url, updated_at: r.updatedAt }) }] };
    }
    if (name === 'issue_list') {
      const state = a.state || 'open';
      const limit = a.limit || DEFAULT_LIST_LIMIT;
      const stdout = await runGh(['issue', 'list', '--repo', `${a.owner}/${a.repo}`, '--state', state, '--limit', String(limit), '--json', 'number,title,state,url']);
      const items = JSON.parse(stdout);
      return { content: [{ type: 'text', text: JSON.stringify(items.map((i) => ({ number: i.number, title: i.title, state: i.state.toLowerCase(), url: i.url }))) }] };
    }
    if (name === 'pr_list') {
      const state = a.state || 'open';
      const limit = a.limit || DEFAULT_LIST_LIMIT;
      const stdout = await runGh(['pr', 'list', '--repo', `${a.owner}/${a.repo}`, '--state', state, '--limit', String(limit), '--json', 'number,title,state,url']);
      const items = JSON.parse(stdout);
      return { content: [{ type: 'text', text: JSON.stringify(items.map((i) => ({ number: i.number, title: i.title, state: i.state.toLowerCase(), url: i.url }))) }] };
    }
    if (name === 'issue_create') {
      const stdout = await runGh(['issue', 'create', '--repo', `${a.owner}/${a.repo}`, '--title', a.title, '--body', a.body || '']);
      // `gh issue create` imprime la URL del issue creado como última línea de stdout.
      const url = stdout.trim().split('\n').pop();
      const numberMatch = url?.match(/\/issues\/(\d+)/);
      return { content: [{ type: 'text', text: JSON.stringify({ number: numberMatch ? Number(numberMatch[1]) : null, url: url || null }) }] };
    }
    throw new Error(`Unknown gh CLI tool: ${name}`);
  }
}
