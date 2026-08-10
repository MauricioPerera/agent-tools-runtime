// Generic stdio-transport MCP client -- the stdio analogue of
// generic-mcp.mjs (which only speaks MCP over HTTP). Spawns `command` as a
// long-lived child process and exchanges newline-delimited JSON-RPC over
// its stdin/stdout, per the MCP spec's stdio transport. Exists for MCP
// servers that only ship as a local subprocess (launched via `uvx`, `npx`,
// a venv's bin/, etc.) with no HTTP endpoint to point generic-mcp.mjs at --
// e.g. QwenLM/Qwen-MM-Plugins' capabilities, each a `uvx --from <pkg>
// <entrypoint>` stdio server.
//
// Same listTools/search/describe/call contract every plugin adapter
// implements, so this can be used two ways: directly as a plugin's own
// adapter (plugin.json's "adapter" pointing straight at this file, command/
// args read from env -- same pattern generic-mcp.mjs already supports), or
// wrapped by a plugin-specific adapter.mjs that hardcodes its command/args
// in the constructor (matching how every other plugin in this repo already
// wraps its service's specifics rather than leaving them to env vars).
//
// Unlike the HTTP-backed adapters, this one owns a real child process
// lifecycle: it can fail to spawn, crash mid-session, or hang on a request
// that never answers. All three are handled explicitly below rather than
// left to hang the caller.
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

export class StdioMcpAdapter {
  constructor({
    command = process.env.AGENT_STDIO_MCP_COMMAND,
    args = parseJsonEnv('AGENT_STDIO_MCP_ARGS') || [],
    env = parseJsonEnv('AGENT_STDIO_MCP_ENV'),
    cwd = process.env.AGENT_STDIO_MCP_CWD,
    timeoutMs = Number(process.env.AGENT_STDIO_MCP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.command = command;
    this.args = args;
    this.extraEnv = env;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;

    this.proc = null;
    this.starting = null;
    this.initialized = false;
    this.nextId = 0;
    this.pending = new Map(); // request id -> {resolve, reject, timer}
    this.buffer = '';
    this.stderrTail = [];
  }

  // Spawns the process on first use only, and again after a crash -- a call
  // right after this.proc was cleared by an 'exit' handler naturally
  // re-spawns rather than staying dead for the process's whole lifetime.
  // Concurrent callers share one in-flight spawn instead of racing to start
  // the process twice.
  async ensureStarted() {
    if (this.proc) return;
    if (!this.starting) {
      this.starting = this._spawn().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async _spawn() {
    if (!this.command) {
      throw new Error('stdio-mcp: no command configured (pass {command} to the constructor, or set AGENT_STDIO_MCP_COMMAND)');
    }
    const proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...(this.extraEnv || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    this.initialized = false;
    this.buffer = '';
    this.stderrTail = [];

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._onStdout(chunk));

    // Kept only to surface in an error message if the process dies --
    // never otherwise surfaced (an MCP server's own logging is its
    // business, not something this adapter forwards on success).
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });

    const failAllPending = (error) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
    };

    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.initialized = false;
      failAllPending(new Error(
        `stdio-mcp: "${this.command}" exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        + (this.stderrTail.length ? `\n${this.stderrTail.join('')}` : ''),
      ));
    });
    proc.on('error', (err) => {
      this.proc = null;
      this.initialized = false;
      failAllPending(new Error(`stdio-mcp: "${this.command}" failed: ${err.message}`));
    });

    // Wait for a real 'spawn' (or an 'error' for e.g. ENOENT) before
    // returning, so a command that can't even launch rejects the caller's
    // ensureStarted()/request() instead of surfacing only as a later,
    // unawaited 'error' event.
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        cleanup();
        reject(new Error(`stdio-mcp: "${this.command}" failed to start: ${err.message}`));
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        proc.off('error', onError);
        proc.off('spawn', onSpawn);
      };
      proc.once('error', onError);
      proc.once('spawn', onSpawn);
    });
  }

  // MCP's stdio transport is newline-delimited JSON: one complete message
  // per line. Buffers across chunk boundaries and only parses complete
  // lines. A line that isn't valid JSON (stray output on stdout from a
  // misbehaving server) is skipped, not fatal -- same "don't die on garbage
  // from the child" posture the exit/error handlers already take. A
  // message with no id is a notification FROM the server (e.g.
  // notifications/tools/list_changed) -- nothing here consumes those yet,
  // so it's dropped rather than left unhandled forever.
  _onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined || message.id === null) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    }
  }

  async request(method, params = {}, notification = false) {
    await this.ensureStarted();
    if (notification) {
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
      return undefined;
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`stdio-mcp: "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  async initialize() {
    if (this.initialized) return;
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agent-tools-runtime', version: '0.2.7' },
    });
    await this.request('notifications/initialized', {}, true);
    this.initialized = true;
  }

  async listTools() {
    await this.initialize();
    return this.request('tools/list');
  }

  async search(query, limit = 5) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error('A search query is required');
    const listed = await this.listTools();
    const max = Math.max(1, Math.min(Number(limit) || 5, 20));
    return {
      query,
      matches: (listed.tools || []).map((tool) => {
        const text = `${tool.name} ${tool.description || ''}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (text.includes(term) ? (tool.name.includes(term) ? 3 : 1) : 0), 0);
        return { tool, score };
      }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, max)
        .map(({ tool, score }) => ({ name: tool.name, description: tool.description || '', score })),
    };
  }

  async describe(name) {
    const listed = await this.listTools();
    const tool = (listed.tools || []).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    return tool;
  }

  async call(name, input) {
    await this.initialize();
    return this.request('tools/call', { name, arguments: input });
  }

  // Not part of the listTools/search/describe/call contract every other
  // adapter method implements -- an HTTP or one-shot-CLI adapter has no
  // long-lived child to clean up, so none of them need this. A caller that
  // wants to end the subprocess deliberately (tests; a runtime shutdown
  // hook, if one gets added later) can call this; nothing in this codebase
  // calls it automatically today.
  async close() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.initialized = false;
    proc.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
