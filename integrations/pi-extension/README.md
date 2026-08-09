# agent-tools-runtime-pi-extension

A [Pi](https://pi.dev) package that connects [agent-tools-runtime](https://github.com/MauricioPerera/agent-tools-runtime)
to Pi natively, without going through MCP at all.

## Why this exists, not `pi-mcp-adapter`

Pi has no built-in MCP support -- the community bridge is
[`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter), which exposes MCP servers through
a single proxy tool. Tested live against this runtime: it never worked in headless (`-p`) mode. The
root cause is documented in Pi's own
[`security.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md):
activating an MCP server goes through `/mcp` or `/mcp setup`, both explicitly described as
*"interactive panel and first-run onboarding surface"* -- there is no CLI equivalent for automation.

Pi extensions sidestep that entirely: `pi.registerTool()` runs when the extension loads, before any
interactive gate. This package does `tools/list` against agent-tools-runtime's Streamable HTTP
transport at startup and registers each real facade tool as a native Pi tool -- reusing the three
fixed argument shapes `runtime/mcp-server.mjs` already defines (`discover`/`call`/`run_skill`),
hand-mirrored in `typebox` instead of forwarding raw JSON Schema.

Verified live end-to-end (see the root README's client-comparison section): correctly discovered and
called real plugin skills/tools, found the same real data eve (a client with native MCP support)
found for the same task.

## Install

```bash
pi install npm:agent-tools-runtime-pi-extension
```

Or try it once without installing:

```bash
pi -e npm:agent-tools-runtime-pi-extension
```

## Configure

agent-tools-runtime must be running with its Streamable HTTP transport:

```bash
npm run mcp:http   # inside the agent-tools-runtime repo, default port 8321
```

```bash
export AGENT_TOOLS_HTTP_URL="http://127.0.0.1:8321/mcp"   # default if omitted
```

## What it registers

Every facade tool agent-tools-runtime currently exposes -- `agent_tools_help`, `agent_tools_exec`,
and `agent_tools_<plugin>_discover` / `_call` / `_run_skill` for each loaded plugin -- fetched live at
extension load time, so the tool list always matches whatever plugins the runtime has loaded. No
manual sync required when a plugin is added or removed on the runtime side.

## Licencia

MIT.
