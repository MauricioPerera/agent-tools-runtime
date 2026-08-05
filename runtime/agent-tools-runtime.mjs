#!/usr/bin/env node

import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const require = createRequire(import.meta.url);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commands = new Map();
const availableAdapters = [
  { name: 'generic-mcp', module: 'commands/generic-mcp.mjs', env: ['AGENT_MCP_URL', 'AGENT_MCP_TOKEN'] },
  { name: 'n8n-mcp', module: 'commands/n8n-mcp.mjs', env: ['N8N_MCP_URL', 'N8N_MCP_TOKEN'] },
  { name: 'rest-api', module: 'commands/rest-api.mjs', env: ['AGENT_API_BASE_URL', 'AGENT_API_TOKEN'] },
  { name: 'local-cli', module: 'commands/local-cli.mjs', env: ['AGENT_CLI_ALLOWLIST'] },
];
let bash = null;
let bashImportError = null;
let justBashModule = null;

function resolveJustBash() {
  try {
    return require.resolve('just-bash');
  } catch {
    return null;
  }
}

async function getBash() {
  if (bash) return bash;
  if (!resolveJustBash()) {
    bashImportError = 'Missing dependency: just-bash';
    return null;
  }
  try {
    justBashModule = await import(pathToFileURL(resolveJustBash()).href);
    bash = new justBashModule.Bash({ executionLimitProfile: 'hardened' });
    return bash;
  } catch (error) {
    bashImportError = error.message;
    return null;
  }
}

function response(code, data = null, error = null) {
  return { code, data, error, meta: { runtime: 'agent-tools-runtime-poc', persistent: true } };
}

async function status() {
  const dependency = Boolean(resolveJustBash());
  return response(dependency ? 0 : 2, {
    status: dependency ? 'READY' : 'IMPLEMENTABLE',
    justBash: { available: dependency, initialized: Boolean(bash) },
    commands: [...commands.keys()],
    availableAdapters,
    next: dependency ? 'Use load and exec.' : 'Install just-bash with npm install just-bash, then restart the runtime.',
  }, dependency ? null : bashImportError || 'just-bash is not available');
}

async function load(modulePath) {
  const absolute = resolve(runtimeRoot, modulePath);
  const relativePath = relative(runtimeRoot, absolute);
  if (!relativePath || relativePath.startsWith('..') || relativePath.includes(':')) {
    return response(3, null, 'Module path must remain inside the plugin runtime root');
  }
  const instance = await getBash();
  if (!instance) return response(2, null, bashImportError || 'just-bash is not available');
  try {
    const module = await import(pathToFileURL(absolute).href);
    if (typeof module.register !== 'function') return response(1, null, `Module must export register(): ${modulePath}`);
    await module.register({ bash: instance, commands, defineCommand: justBashModule.defineCommand });
    return response(0, { loaded: modulePath, commands: [...commands.keys()] });
  } catch (error) {
    return response(1, null, `Cannot load ${modulePath}: ${error.message}`);
  }
}

async function exec(command) {
  const instance = await getBash();
  if (!instance) return response(2, null, bashImportError || 'just-bash is not available');
  const result = await instance.exec(command);
  return response(result.exitCode, result);
}

export async function handle(request) {
  if (!request || typeof request !== 'object') return response(1, null, 'Request must be a JSON object');
  if (request.action === 'status') return status();
  if (request.action === 'list') return response(0, { commands: [...commands.keys()] });
  if (request.action === 'load') return load(request.module);
  if (request.action === 'exec') return exec(request.command);
  return response(1, null, `Unknown action: ${request.action}`);
}

export async function main() {
  const [action, argument] = process.argv.slice(2);
  if (action === 'serve') {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { console.log(JSON.stringify(await handle(JSON.parse(line)))); }
      catch (error) { console.log(JSON.stringify(response(1, null, error.message))); }
    }
    return;
  }
  const request = action === 'load' ? { action, module: argument }
    : action === 'exec' ? { action, command: process.argv.slice(3).join(' ') }
      : { action };
  console.log(JSON.stringify(await handle(request), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
