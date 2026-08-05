function baseUrl() {
  const value = process.env.AGENT_API_BASE_URL;
  if (!value) throw new Error('AGENT_API_BASE_URL is not configured');
  return new URL(value.endsWith('/') ? value : `${value}/`);
}
function resolvePath(path) {
  if (!path || path.startsWith('http://') || path.startsWith('https://') || path.includes('..')) throw new Error('API path must be relative and stay inside AGENT_API_BASE_URL');
  const url = new URL(path.replace(/^\//, ''), baseUrl());
  const root = baseUrl();
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw new Error('API path escaped the configured base URL');
  return url;
}

export class RestApiAdapter {
  constructor({ token = process.env.AGENT_API_TOKEN } = {}) { this.token = token; }

  async request(method, path, body = undefined, { confirm = false } = {}) {
    const verb = String(method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(verb) && !confirm) throw new Error(`Confirmation required for API method ${verb}`);
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) throw new Error(`Unsupported API method: ${verb}`);
    const headers = { Accept: 'application/json, text/plain' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(resolvePath(path), { method: verb, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(`API HTTP ${response.status}`);
    return { status: response.status, data };
  }
}
