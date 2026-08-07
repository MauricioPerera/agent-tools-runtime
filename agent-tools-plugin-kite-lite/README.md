# agent-tools-plugin-kite-lite

Plugin de [agent-tools-runtime](https://github.com/MauricioPerera/agent-tools-runtime) para
[kite-lite](https://github.com/MauricioPerera/kite-lite), un motor web ligero en Rust orientado a agentes.

A diferencia de otros plugins que envuelven una REST API con un catálogo de tools inventado por el propio
plugin, kite-lite **ya habla MCP real** (JSON-RPC 2.0 sobre stdio). Este plugin es un cliente MCP que
spawnea el binario como proceso hijo y reenvía `tools/list`/`tools/call` tal cual — no reinventa el
catálogo.

## Requisitos

Necesitás el binario `kite-lite` compilado y accesible:

```bash
git clone https://github.com/MauricioPerera/kite-lite.git
cd kite-lite
cargo build --release
```

## Instalación

```bash
npm install agent-tools-plugin-kite-lite
```

## Configuración

```bash
export KITE_LITE_BIN="/ruta/a/kite-lite/target/release/kite-lite"
# o dejalo en PATH como "kite-lite" y no hace falta la variable
```

## Tools expuestas

Con `prefix: "kite"`, el runtime genera:

- `agent_tools_kite_discover({ query? })`
- `agent_tools_kite_call({ toolName, arguments, confirm? })`
- `agent_tools_kite_run_skill({ skill, arguments })`

Catálogo de `toolName` disponibles vía `_call` (definido por el propio MCP de kite-lite, no por este
plugin):

| Tool | Descripción | Muta la sesión |
|---|---|---|
| `fetch_page` | Trae una URL y devuelve título/texto/links, sin afectar la sesión persistente | No |
| `render_screenshot` | Trae una URL y la renderiza a PNG o SVG | No |
| `eval_js` | Evalúa una expresión JS contra un snapshot de solo lectura del documento | No |
| `browser_get_dom` | HTML de la sesión actual (o de un selector) | No |
| `browser_screenshot` | Renderiza la sesión actual a PNG o SVG | No |
| `browser_navigate` | Navega la sesión persistente a una URL | **Sí** |
| `browser_click` | Clickea el primer elemento que matchea un selector | **Sí** |
| `browser_type` | Escribe texto en el input/textarea enfocado | **Sí** |
| `browser_call_tool` | Llama una tool WebMCP declarada en la página actual | **Sí** |

## Skills

- **`page-overview({ url, screenshot?, format? })`** — navega la sesión persistente a `url` y (salvo que
  `screenshot: false`) la screenshotea, en una sola llamada.

## Licencia

MIT.
