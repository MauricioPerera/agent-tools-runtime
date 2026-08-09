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
  servicio, con el `arguments` validado contra su schema antes de reenviar. Por defecto, las tools que
  mutan estado requieren `confirm: true` — un plugin puede optar por lo contrario con
  `requireConfirm: false` en su `plugin.json` (ver "Qué es un plugin"); hoy solo lo hace
  `agent-tools-plugin-n8n`, por decisión propia de ese plugin, no default del runtime.
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
- **`requireConfirm`** (opcional, default `true`): en `false`, ninguna tool del plugin exige
  `confirm: true`, ni siquiera las que mutan estado — el campo `confirm` sigue en el schema de `_call`
  por compatibilidad pero no tiene efecto. Es una decisión explícita del autor del plugin, no algo que
  el runtime active por su cuenta.

### Cómo se descubren los plugins

`discoverPlugins()` en `runtime/mcp-server.mjs` escanea, sin configuración adicional:

1. Directorios `agent-tools-plugin-*` al lado de `runtime/` (el caso de este repo — `agent-tools-plugin-n8n/`).
2. `node_modules/agent-tools-plugin-*` (si un plugin se instala como dependencia npm).
3. `$AGENT_TOOLS_PLUGINS_DIR/agent-tools-plugin-*` (una carpeta externa cualquiera, para sumar un plugin
   sin que viva ni en el repo ni en `node_modules`).

Agregar un plugin nuevo no requiere tocar `mcp-server.mjs`: alcanza con que el directorio exista en
alguna de esas tres ubicaciones con el `plugin.json` correcto. Un plugin que falla al cargar se loguea a
stderr y se saltea — no tumba a los demás.

### Skills descubribles: `meta` y `agent_tools_<prefix>_discover`

`agent_tools_<prefix>_run_skill`'s description ya lista los *nombres* de las skills de un plugin (barato,
siempre presente), pero eso no alcanza para que un agente sepa qué argumentos/modos acepta cada una sin
tener que fallar una llamada primero para leer el error. Una skill puede exportar, además de `run`:

```js
export const meta = {
  description: 'Una línea de qué hace, sin jerga interna.',
  args: 'mode?: "a"|"b"|"c" (default "a"). otroArg (requerido).',
};
```

Cuando `agent_tools_<prefix>_discover({ query })` se llama **con query**, busca en esos `meta` con el
mismo scoring por texto que ya usa para las tools crudas, y los devuelve mezclados
(`{ kind: "skill", name, description, args }`) — así un agente que pregunta "auditoría nativa" o "crear
workflow sin publicar" encuentra el modo/flag exacto que necesita en vez de reconstruirlo a mano con
tools sueltas. **Sin query** (modo "listar"), el comportamiento no cambia — sigue devolviendo solo tools
crudas, para no encarecer ese caso. Una skill sin `meta` sigue funcionando igual, solo que `discover` no
la va a encontrar por texto libre (su nombre sigue apareciendo en la descripción de `run_skill`).

`agent_tools_help()` también lista todos los plugins cargados (prefix + descripción de una línea) — útil
cuando hay más de un plugin para el mismo dominio (ver tabla de abajo, `github` vs `gh-cli`) y un agente
ya comprometido con uno no tendría forma de enterarse de que el otro existe. La descripción de cada
`discover` también menciona esto explícitamente, como recordatorio en el punto donde el agente ya está
parado.

### Estado real de esto hoy

Seis plugins reales, elegidos para cubrir formas de transporte distintas (no todos el mismo tipo de
integración) y medir si el contrato de adapter (`listTools`/`search`/`describe`/`call`) generaliza:

| Plugin | Prefix | Transporte | Qué valida |
|---|---|---|---|
| `agent-tools-plugin-n8n` | `n8n` | MCP sobre HTTP (proxy a un server MCP real de terceros) | El caso original — medido extensamente contra `gpt-oss:20b-cloud`/`120b-cloud` en un benchmark propio (no publicado) |
| `agent-tools-plugin-kite-lite` | `kite` | MCP sobre stdio (spawnea un proceso hijo que habla MCP) | Adapter como cliente MCP por stdio, no HTTP |
| `agent-tools-plugin-github` | `github` | REST (SaaS, token ya emitido) | Catálogo de tools inventado por el plugin sobre una REST API real |
| `agent-tools-plugin-tasks` | `tasks` | REST (self-hosted, API key) | Mismo caso que github pero sin OAuth ni proveedor externo |
| `agent-tools-plugin-gh-cli` | `ghcli` | CLI (`execFile` sobre un binario ya instalado) | Ni HTTP ni MCP — exit code + stdout/stderr como superficie de error. Mismo dominio que `github` a propósito, para aislar la variable de transporte |
| `agent-tools-plugin-pocketbase` | `pocketbase` | REST (self-hosted, auth dinámica) | Sin API key estática — el adapter hace login (`auth-with-password`) y cachea el token, primer caso de autenticación que el propio adapter tiene que gestionar en vez de solo adjuntar |

El formato del manifest y el loader dinámico ya están probados con varios plugins reales cargando a la
vez sin tocar `mcp-server.mjs` — agregar uno nuevo es crear el directorio, no editar el runtime.

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
recibir tokens como argumentos ni escribir secretos en archivos. Los CLIs se
ejecutan sin shell implícito.

Por defecto, las operaciones mutantes de cualquier plugin requieren
confirmación explícita (`confirm: true`). Un plugin puede desactivar esto
para sí mismo con `requireConfirm: false` en su `plugin.json` — es opt-out
por plugin, no un flag global del runtime. Hoy lo hace `agent-tools-plugin-n8n`
(ver su README): las llamadas a tools de n8n que mutan estado, incluyendo
`delete_workflow`, se ejecutan sin ningún freno del lado del runtime.

## Integraciones

El plugin para Claude Code y Codex se mantiene en el marketplace como una capa
de distribución. Este repositorio contiene el runtime canónico y no depende de
los manifests específicos de ningún cliente.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
