import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export function tokenStorePath() {
  const base = process.env.APPDATA || join(homedir(), '.config');
  return join(base, 'n8n-mcp-cli', 'tokens.json');
}
export async function loadTokenStore(path = tokenStorePath()) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read n8n OAuth token store: ${error.message}`);
  }
}

async function saveTokenStore(value, path) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function getAccessToken({ explicitToken = process.env.N8N_MCP_TOKEN, storePath } = {}) {
  if (explicitToken) return { accessToken: explicitToken, source: 'environment', expiresAt: null };
  const path = storePath || tokenStorePath();
  const store = await loadTokenStore(path);
  if (!store?.accessToken) throw new Error('n8n OAuth is not configured; run `n8n-mcp-cli auth login` first');
  if (store.expiresAt && Date.now() < store.expiresAt - 30_000) return { accessToken: store.accessToken, source: 'oauth-store', expiresAt: store.expiresAt };
  if (!store.refreshToken || !store.tokenEndpoint) throw new Error('n8n access token expired and no refresh token is available; run `n8n-mcp-cli auth login` again');
  const response = await fetch(store.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: store.refreshToken, client_id: store.clientId, ...(store.resource ? { resource: store.resource } : {}) }),
  });
  const tokens = await response.json();
  if (!response.ok || !tokens.access_token) throw new Error(`n8n OAuth refresh failed: ${tokens.error_description || tokens.error || response.statusText}`);
  const refreshed = { ...store, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || store.refreshToken, expiresAt: Date.now() + ((tokens.expires_in || 3600) * 1000) };
  await saveTokenStore(refreshed, path);
  return { accessToken: refreshed.accessToken, source: 'oauth-refresh', expiresAt: refreshed.expiresAt };
}

export async function authStatus(options = {}) {
  if (process.env.N8N_MCP_TOKEN) return { configured: true, source: 'environment', expiresAt: null, refreshable: false };
  const store = await loadTokenStore(options.storePath);
  if (!store?.accessToken) return { configured: false, source: null, expiresAt: null, refreshable: false };
  return { configured: true, source: 'oauth-store', expiresAt: store.expiresAt || null, refreshable: Boolean(store.refreshToken && store.tokenEndpoint), expired: Boolean(store.expiresAt && Date.now() >= store.expiresAt) };
}
