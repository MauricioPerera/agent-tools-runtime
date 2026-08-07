# Agent Tools Runtime

Runtime persistente basado en `just-bash` para que un agente descubra y cargue
progresivamente adaptadores MCP, REST y CLI local sin exponer todo el catálogo
de herramientas en cada conversación.

## Estado

Este repositorio es la evolución independiente de la POC publicada en
[TheHumanInTheLoop Marketplace](https://mauricioperera.github.io/thehumanintheloop-marketplace-codex/).
La API todavía está en `0.x`; cualquier cambio puede requerir migración.

## Capas

```text
MCP facade → persistent runtime → adapter → provider
```

Adaptadores incluidos:

- MCP genérico con sesiones y tokens host-side.
- n8n MCP con OAuth/token host-side.
- REST/API con rutas relativas y confirmación para mutaciones.
- CLI local con allowlist, `execFile`, timeout y confirmación.

## Fachada tipada y sistema de plugins

Además de la capa de texto (`agent_tools_exec` + `commands/`), `runtime/mcp-server.mjs` expone una
**fachada tipada por plugin**: argumentos JSON nativos (objeto real vía tool-calling, sin comillas de
shell) en vez de comandos de texto parseados a mano. Cada plugin instalado agrega 2-3 tools a la sesión
MCP, generadas automáticamente a partir de su manifest:

- `agent_tools_<prefix>_discover({ query? })` — busca tools del servicio por texto libre.
- `agent_tools_<prefix>_call({ toolName, arguments, confirm? })` — llama una tool individual del
  servicio, con el `arguments` validado contra su schema antes de reenviar. Las tools que mutan estado
  requieren `confirm: true`.
- `agent_tools_<prefix>_run_skill({ skill, arguments })` — si el plugin trae skills, ejecuta una receta
  del lado del server para una tarea completa en una sola llamada, en vez de que el agente tenga que
  orquestar varias tool-calls.

### Qué es un plugin

Un plugin es un directorio cuyo nombre empieza con `agent-tools-plugin-` y contiene un `plugin.json`:

```json
{
  "name": "n8n",
  "prefix": "n8n",
  "adapter": "./adapter.mjs",
  "adapterExport": "N8nMcpAdapter",
  "readonlyTools": ["search_workflows", "get_execution", "..."],
  "skills": ["./skills/insert-and-verify-datatable-row.mjs", "..."],
  "discoverHint": "texto opcional que se agrega a la descripción de discover"
}
```

- **`adapter`** apunta a un módulo que exporta una clase con el contrato:
  ```js
  class Adapter {
    async listTools()            // -> { tools: [{name, description, inputSchema}] }
    async search(query, limit)   // -> { query, matches: [{name, description, score}] }
    async describe(name)         // -> tool completo, o throw si no existe
    async call(name, args)       // -> resultado crudo del MCP/API subyacente
    async discoverContext()      // opcional: contexto extra para adjuntar a la respuesta de discover
                                  // (ver agent-tools-plugin-n8n/adapter.mjs: adjunta el proyecto personal)
  }
  ```
- **`skills`** son módulos que exportan `async function run(adapter, args)`, y usan el `adapter` del
  propio plugin para orquestar una secuencia de llamadas. Ver `agent-tools-plugin-n8n/skills/` para tres
  ejemplos reales, incluyendo el patrón recomendado: si algo puede quedar 100% determinista (sin que un
  LLM tenga que generar código en el momento), hacerlo así — es la diferencia entre una skill que falla
  ~1 de cada 10 veces y una que no falla nunca (medido en el benchmark del repo hermano, ver abajo).
- **`readonlyTools`** son las tools del servicio que no requieren `confirm: true` en `_call`.

### Cómo se descubren los plugins

`discoverPlugins()` en `runtime/mcp-server.mjs` escanea, sin configuración adicional:

1. Directorios `agent-tools-plugin-*` al lado de `runtime/` (el caso de este repo — `agent-tools-plugin-n8n/`).
2. `node_modules/agent-tools-plugin-*` (si un plugin se instala como dependencia npm).
3. `$AGENT_TOOLS_PLUGINS_DIR/agent-tools-plugin-*` (una carpeta externa cualquiera, para sumar un plugin
   sin que viva ni en el repo ni en `node_modules`).

Agregar un plugin nuevo no requiere tocar `mcp-server.mjs`: alcanza con que el directorio exista en
alguna de esas tres ubicaciones con el `plugin.json` correcto. Un plugin que falla al cargar se loguea a
stderr y se saltea — no tumba a los demás.

### Estado real de esto hoy

Hay un solo plugin en producción (`agent-tools-plugin-n8n/`), medido extensamente contra `gpt-oss:20b-cloud`
y `gpt-oss:120b-cloud` en un benchmark propio (no publicado todavía) que compara esta fachada contra el
MCP directo de n8n en tokens, pasos y tasa de éxito verificada de forma independiente. El formato del
manifest y el loader dinámico están probados con un segundo plugin de prueba (descartado tras el test), no
todavía con un segundo plugin real de otro servicio — si escribís uno, es un buen momento para abrir un PR.

## Desarrollo

Requisitos: Node.js `>=20.18.1`.

```powershell
npm install
npm test
npm run probe
npm run serve
```

La fachada MCP se inicia con:

```powershell
npm run mcp
```

## Instalación desde una release

El paquete está publicado en npm como
[`@rckflr/agent-tools-runtime`](https://www.npmjs.com/package/@rckflr/agent-tools-runtime):

```powershell
npm install @rckflr/agent-tools-runtime
```

Para iniciar la fachada MCP sin instalarla globalmente:

```powershell
npx --yes --package=@rckflr/agent-tools-runtime@0.1.3 --call agent-tools-mcp
```

Si ejecutas el comando desde el propio checkout `agent-tools-runtime`, usa el
prefijo del directorio padre para que npm no confunda el paquete local con el
paquete remoto:

```powershell
npx --prefix .. --yes --package=@rckflr/agent-tools-runtime@0.1.3 --call agent-tools-mcp
```

La release inicial también incluye un tarball instalable directamente desde
GitHub:

```powershell
npm install https://github.com/MauricioPerera/agent-tools-runtime/releases/download/v0.1.0/rckflr-agent-tools-runtime-0.1.0.tgz
```

Después de instalarlo, el ejecutable queda disponible como `agent-tools`.
El repositorio incluye un workflow de publicación. Para futuras versiones se
debe configurar el secret `NPM_TOKEN` en GitHub; después puede ejecutarse
manualmente o al publicar una release con tag `v*`.

El preflight puede comprobar un CLI sin ejecutarlo:

```powershell
$env:AGENT_TOOLS_COMMAND = "gh"
$env:AGENT_CLI_ALLOWLIST = "gh,docker,supabase"
npm run probe
```

## Diseño de seguridad

Las credenciales permanecen en el host. Las skills y los adapters no deben
recibir tokens como argumentos ni escribir secretos en archivos. Las
operaciones mutantes requieren confirmación explícita y los CLIs se ejecutan
sin shell implícito.

## Integraciones

El plugin para Claude Code y Codex se mantiene en el marketplace como una capa
de distribución. Este repositorio contiene el runtime canónico y no depende de
los manifests específicos de ningún cliente.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
