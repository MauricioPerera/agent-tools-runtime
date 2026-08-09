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

## Transportes: stdio (default) y Streamable HTTP

`runtime/mcp-server.mjs` habla MCP por stdio -- el caso de uso original y el que sigue sin cambios
(`npm run mcp`, o `bin/agent-tools-mcp.mjs` si el paquete está instalado). Pero algunos clientes MCP
no pueden spawnear un subproceso stdio: por ejemplo [eve](https://github.com/vercel/eve) (framework
de agentes de Vercel), cuyas `connections/*.ts` (`defineMcpClientConnection`) exigen una `url` que
hable Streamable HTTP o SSE, sin opción de `command`/`args`. Para esos casos existe
`runtime/mcp-http-server.mjs` (`npm run mcp:http`, o `bin/agent-tools-mcp-http.mjs`), el mismo
dispatcher (`createMessageHandler()` en `mcp-server.mjs`, extraído para no atarlo a ningún
transporte) expuesto sobre HTTP en vez de stdin/stdout.

```bash
export AGENT_TOOLS_HTTP_PORT=8321      # default si se omite
export AGENT_TOOLS_HTTP_HOST=127.0.0.1 # default -- solo localhost, ver nota de seguridad abajo
npm run mcp:http
```

Implementa la variante simple del spec ([2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http)):
una respuesta JSON por request (`Content-Type: application/json`), sin upgrade a SSE -- el catálogo
de mensajes de este runtime (`initialize`/`tools/list`/`tools/call`) es enteramente request/response,
sin mensajes server-initiated, así que streaming no aporta nada todavía. Session ID vía
`Mcp-Session-Id` (emitido en `initialize`, validado en requests siguientes, `404` si no se reconoce),
protección DNS-rebinding (rechaza `Origin` no-local con `403`), bind a `127.0.0.1` por default. Sin
batching de mensajes en esta versión -- ningún cliente probado lo necesitó.

### Cliente probado en vivo: eve (Vercel)

[eve](https://github.com/vercel/eve) es un framework de agentes "filesystem-first": herramientas,
conexiones y skills viven como archivos convencionales bajo `agent/`. Conectarlo a este runtime es
crear `agent/connections/agent-tools-runtime.ts`:

```ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "http://127.0.0.1:8321/mcp",
  description: "agent-tools-runtime: typed facades over Ollama, ccdd-gate, n8n, GitHub, PocketBase.",
});
```

**Gotcha real encontrado en vivo, no hipotético:** con un modelo fuera del catálogo de AI Gateway
(en la prueba, Ollama local vía `@ai-sdk/openai-compatible`), eve falla al arrancar con *"Cannot
compile agent compaction because the primary compaction trigger model ... does not have known AI
Gateway context window metadata"* -- necesita saber la ventana de contexto del modelo para su feature
de compaction, y un modelo custom no la trae. Se resuelve declarándola explícita en `agent.ts`:

```ts
export default defineAgent({
  model: ollama.chatModel("gpt-oss:20b-cloud"),
  modelContextWindowTokens: 131072,
});
```

**Dos corridas reales, mismo modelo (`gpt-oss:20b-cloud` vía Ollama local), mismo transporte HTTP:**

| | `ollama` (5 tools, 0 skills) | `n8n` (10 skills) |
|---|---|---|
| Tools usadas | `discover` + `call` | `run_skill` × 2 (`find-workflows`, después `audit-workflows`) |
| Decisión del modelo | directa | encadenó dos skills razonando qué le faltaba para responder "configuración riesgosa" sin que nadie se lo indicara |
| Resultado | tabla correcta de modelos disponibles | hallazgos reales (webhooks sin autenticación, workflows activos sin trigger) + recomendaciones, honesto sobre el corte de la muestra (356 workflows activos, mostró algunos y ofreció ampliar) |

En ambos casos el flujo fue el mismo y sin fricción: `connection_search` (mecanismo propio de eve
para descubrir tools de una conexión MCP por texto libre) encontró la conexión y las tools/skills
correctas, verificado en el trace crudo del stream de eventos, no solo en la respuesta final.

### Cliente probado en vivo: Pi (pi.dev) -- vía extensión propia, no MCP

[Pi](https://pi.dev) es un coding agent liviano construido sobre el Claude Agent SDK. No tiene soporte
MCP nativo -- depende de un paquete de terceros, [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter),
que expone un único tool `mcp()` proxy (para no gastar contexto con el catálogo completo de cada
server, mismo espíritu que la fachada `discover`/`call` de este runtime).

**Intento 1, con `pi-mcp-adapter`, fallido -- documentado para no repetir el mismo camino:**
instalé el adapter (`pi install npm:pi-mcp-adapter`) y probé tanto `.pi/mcp.json` como `.mcp.json`
(las dos ubicaciones que documenta el paquete) apuntando a este runtime. En ambos casos, verificado
en el trace crudo, el modelo **nunca vio el tool `mcp()`** -- solo tenía disponibles los tools nativos
de Pi (`bash`, `read`). La causa, confirmada en la documentación oficial de Pi
([`security.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)):
la activación real de un server pasa por `/mcp` o `/mcp setup`, explícitamente descriptos como
*"interactive panel and first-run onboarding surface"* -- sin equivalente de línea de comandos para
modo headless (`-p`). No es un bug de este runtime ni del adapter; es una limitación real de
`pi-mcp-adapter` para automatización sin TTY.

**Intento 2, extensión propia -- funciona.** Las extensiones de Pi (`pi.registerTool()`) se registran
al cargar la extensión, **antes** de cualquier gate interactivo -- esquivan el problema por completo.
[`integrations/pi-extension.ts`](integrations/pi-extension.ts) hace `tools/list` contra el transporte
HTTP de este runtime al arrancar y registra cada tool real como un tool nativo de Pi, reusando las
mismas tres formas de argumento fijas que ya define `mcp-server.mjs` (`discover`/`call`/`run_skill`)
en vez de reenviar el JSON Schema crudo, para no depender de si el validador de Pi acepta ese formato
sin la marca típebox.

```bash
cp integrations/pi-extension.ts .pi/extensions/agent-tools-runtime.ts   # o -e ./pi-extension.ts
npm run mcp:http   # el server HTTP tiene que estar corriendo
```

**Verificado en vivo**, mismo prompt/modelo que la prueba de n8n con eve (comparable directamente):
llamó `agent_tools_n8n_run_skill({skill:"find-workflows"})`, después `agent_tools_n8n_discover` y dos
`agent_tools_n8n_call({toolName:"get_workflow_details"})` para inspeccionar workflows puntuales --
encontró los mismos dos workflows con webhook sin autenticación que ya había encontrado eve, con los
IDs reales coincidiendo. Estrategia distinta a la de eve (inspección puntual en vez de la skill
`audit-workflows` completa), mismo resultado correcto.

**Mismo prompt, mismo proyecto, mismas tools registradas -- solo cambiando a un modelo chico
(`qwen2.5:1.5b`):** cero tool calls. Respuesta vaga y divagante ("invertir en recursos", "consultar a
alguien versátil") sin tocar ninguna tool real. Como la extensión ya estaba confirmada funcionando en
la corrida anterior con el mismo setup exacto, este resultado negativo queda aislado limpio como
límite de capacidad del modelo, no de la integración -- mismo patrón que el resto de esta sección de
discoverabilidad: modelos grandes usan esta capa sin fricción, modelos chicos ni la intentan.

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

Siete plugins reales, elegidos para cubrir formas de transporte distintas (no todos el mismo tipo de
integración) y medir si el contrato de adapter (`listTools`/`search`/`describe`/`call`) generaliza:

| Plugin | Prefix | Transporte | Qué valida |
|---|---|---|---|
| `agent-tools-plugin-n8n` | `n8n` | MCP sobre HTTP (proxy a un server MCP real de terceros) | El caso original — medido extensamente contra `gpt-oss:20b-cloud`/`120b-cloud` en un benchmark propio (no publicado) |
| `agent-tools-plugin-kite-lite` | `kite` | MCP sobre stdio (spawnea un proceso hijo que habla MCP) | Adapter como cliente MCP por stdio, no HTTP |
| `agent-tools-plugin-github` | `github` | REST (SaaS, token ya emitido) | Catálogo de tools inventado por el plugin sobre una REST API real |
| `agent-tools-plugin-tasks` | `tasks` | REST (self-hosted, API key) | Mismo caso que github pero sin OAuth ni proveedor externo |
| `agent-tools-plugin-gh-cli` | `ghcli` | CLI (`execFile` sobre un binario ya instalado) | Ni HTTP ni MCP — exit code + stdout/stderr como superficie de error. Mismo dominio que `github` a propósito, para aislar la variable de transporte |
| `agent-tools-plugin-pocketbase` | `pocketbase` | REST (self-hosted, auth dinámica) | Sin API key estática — el adapter hace login (`auth-with-password`) y cachea el token, primer caso de autenticación que el propio adapter tiene que gestionar en vez de solo adjuntar |
| `agent-tools-plugin-ccdd-gate` | `ccdd` | MCP sobre stdio (backend en dos partes: `python <script>`, no un binario único como kite-lite) | Mismo caso que kite-lite pero contra un backend real de terceros (ccdd-complexity, github.com/MauricioPerera/KDD) — 23 tools reales, sin catálogo inventado. Su skill `quality-gate-check` compone 5 llamadas AST inline en vez de `run_rules_gate`: ese tool resultó leer su `rules.yaml` relativo al cwd del proceso Python long-lived, no al `project_root` que recibe como argumento — no hay forma de satisfacerlo desde un tempdir por-llamada, encontrado probando el plugin en vivo |

El formato del manifest y el loader dinámico ya están probados con varios plugins reales cargando a la
vez sin tocar `mcp-server.mjs` — agregar uno nuevo es crear el directorio, no editar el runtime.

### Por qué construir un plugin (para quien expone la API/servicio)

Punto a aclarar primero porque es fácil malinterpretarlo: un plugin **no evita MCP**. Hacia el agente,
agent-tools-runtime sigue hablando MCP tal cual (stdio, JSON-RPC) — no hay protocolo alternativo ahí, y
los clientes que importan (Claude Desktop, Claude Code, cualquier agente) existen porque hablan MCP. Lo
que un plugin evita es **alojar y mantener vos ese proceso MCP-facing**: en vez de desplegar tu propio
server que hable MCP con el agente, tu plugin se monta sobre un runtime que el host ya tiene corriendo —
el proceso MCP lo aloja el host, no vos.

Con eso claro, las ventajas concretas de empaquetar como plugin en vez de (o adicionalmente a) desplegar
tu propio server MCP:

- **Cero infra propia**: el plugin es un paquete npm que envuelve la API que ya tenés (REST, CLI, lo que
  sea) — no hay proceso nuevo que alojar, escalar ni mantener en pie. Ver `github`/`tasks`/`pocketbase`
  en la tabla de arriba: ninguno de los tres tiene un MCP propio, y aun así son alcanzables por un agente
  sin que su proveedor haya construido un server MCP desde cero.
- **Heredás gratis** lo que ya construyó el runtime: confirm-gating en mutaciones, error-hints,
  discoverabilidad (`discover`/`meta`/`related`, ver sección siguiente) — construir eso dentro de un
  server MCP propio es trabajo tuyo; acá viene incluido.
- **Skills = tu receta determinista para tu dominio**, no que cada agente/modelo reconstruya la
  orquestación a mano cada vez — reduce la tasa de error específicamente para tus casos de uso (ver
  benchmark de skills vs. tools sueltas más abajo).
- **Credenciales quedan del lado del host** vía env vars (o auth dinámica, ver `pocketbase`) — no hace
  falta correr un broker de auth expuesto a internet.
- **Distribución por npm**, versionado semver estándar, sin story de deployment propio.

La contra honesta: un plugin solo sirve dentro de un host que tenga agent-tools-runtime cargado — no es
un MCP genérico que hable con cualquier cliente. Un server MCP propio tiene alcance universal, pero el
costo entero de infra y discoverabilidad es tuyo.

**Y no es una decisión excluyente.** `agent-tools-plugin-n8n` es el caso probado de combinar ambos: n8n
ya tiene su propio server MCP real, y el adapter de este plugin lo proxea tal cual para la mayoría de las
tools — pero cuando ese MCP no cubre algo bien (operaciones de Data Table, ciertos flujos de auditoría),
las skills del plugin lo tapan con llamadas deterministas propias, sin que el agente vea la costura. Si
ya tenés un MCP que no cubre el 100% de lo que tu API puede hacer, un plugin te deja combinar "lo que el
MCP ya expone" con "lo que le falta" detrás de una sola fachada, en vez de elegir entre uno de los dos.

## Arquitectura de discoverabilidad

Esto no es un sustituto de MCP — hacia el agente sigue hablando el protocolo tal cual, y varios adapters
lo hablan hacia adentro también (n8n, kite-lite). Lo que cambia es el supuesto que trae implícito el uso
típico de MCP: que exponer capacidad es declarar una lista plana y completa de tools, cargada entera en
cada turno. Acá la capacidad real vive detrás de un índice barato (`discover`/`call`/`run_skill`, 3 tools
fijas por plugin sin importar si el backend tiene 4 endpoints o 30), y se resuelve bajo demanda — mismo
principio que `ToolSearch` sobre esta propia sesión. Eso separa "cuánto cuesta tener la capacidad
conectada" de "cuánto cuesta que el agente la vea", pero ese ahorro tiene un precio: una capacidad que no
se declara de antemano solo se usa si alguien la busca. Lo de abajo es el mapa de esa contrapartida,
capa por capa, con qué tan probado está cada mecanismo.

| Capa | Qué resuelve | Mecanismo | Cuándo se paga el costo |
|---|---|---|---|
| Nombre de skill | Que existe una receta para la tarea | Listado estático en la descripción de `run_skill` | Siempre — barato, fijo, no depende de que el agente pregunte nada |
| Forma de una skill | Argumentos/modos que acepta (ej. `mode:"nativeAudit"`) | `meta` por skill, indexado por `discover({ query })` | Solo si hay `query` — el modo "listar sin filtro" queda igual de barato que antes |
| Otros plugins del mismo dominio (a ciegas) | Que existe una alternativa con capacidades distintas (ej. `github` vs `gh-cli`) | `agent_tools_help()` lista todos los plugins cargados; cada `discover` lo menciona en su propia descripción | Solo si el agente llama `help()` explícitamente |
| Otros plugins, dirigido (un salto) | Ídem, pero apuntando al vecino exacto en vez de a los 6 plugins mezclados | `meta.related` de una skill (`[{ target: "prefix:skill-name", why }]`), sumado al resultado de `discover({ query })` cuando esa skill matchea | Mismo costo que la fila 2 — solo con query, ya viene incluido en esa búsqueda |
| — (no es una capa, es el techo) | — | Acceso a shell directo al mismo backend que un plugin envuelve | Gratis para el agente, y le gana a todas las de arriba cuando existe |

**Nivel de confianza real en cada fila, no solo la intención de diseño:**

- **Nombre de skill (fila 1): confirmado con A/B en vivo, y el resultado depende del tamaño del
  modelo.** Mismo prompt, mismo código (una función Python con anidamiento excesivo, default mutable,
  `except:` desnudo y `== None`), contra la skill `quality-gate-check` de `agent-tools-plugin-ccdd-gate`,
  probado con cuatro modelos "grandes": `glm-5.2:cloud`, `kimi-k2.6:cloud`, `deepseek-v4-pro:cloud`,
  `nemotron-3-ultra:cloud`. Los cuatro encontraron y llamaron la skill correcta con los argumentos
  correctos al primer intento (verificado en el trace crudo del tool call, no solo leyendo la respuesta
  final). Dos de los cuatro (`deepseek-v4-pro`, `nemotron-3-ultra`) ni llegaron a llamar
  `discover`: fueron directo a `run_skill` con el nombre exacto, resuelto solo con el listado estático de
  la fila 1 — la capa más barata que existe. Los otros dos sí pasaron por `discover` primero (fila 2), un
  paso extra pero sin ningún error ni reintento. Contraste con los modelos chicos usados en pruebas
  anteriores de este mismo repo (`gpt-oss:20b-cloud`, `gemma4:cloud`): esos sí necesitaron el mecanismo de
  auto-corrección de `error-hints` para resolver la forma de una llamada mal anidada. Lectura: la fila 1
  sola ya alcanza para que un modelo grande use la skill correcta sin fricción; las filas de abajo
  (`meta`/`discover`, error-hints) importan más cuanto más chico es el modelo, no menos.
- **Forma de skill (fila 2): confirmado con A/B en vivo.** Mismo prompt, mismo modelo, antes/después del
  fix — sin él, tres llamadas seguidas a `mode:"nativeAudit"`/`"executions"`/`"credentials"` devolvían en
  silencio el mismo reporte genérico (el argumento quedaba mal anidado y el default absorbía el error);
  con él, un error explícito señala la forma correcta y el modelo se corrige en el primer reintento en
  vez de reconstruir todo a mano con tools sueltas.
- **Otros plugins, a ciegas (fila 3): probado, pero más débil de lo que parece.** Funciona *si* el agente
  llega a llamar `discover` con query o `help()` — nunca se aisló si el aviso de texto es la causa real de
  que un agente encuentre el plugin correcto, o si el modelo simplemente asocia el nombre por su cuenta. Y
  en una corrida real, el agente jamás llamó ni `discover` ni `help()`: fue directo a resolver la tarea por
  otro camino, así que el aviso nunca tuvo la oportunidad de leerse.
- **Otros plugins, dirigido (fila 4): un salto de grafo, no un motor de traversal.** `related` no reemplaza
  la búsqueda inicial (sigue haciendo falta encontrar el primer nodo con `discover`) — apunta al vecino
  exacto una vez que ya encontraste algo, en vez de forzar al agente a elegir entre los 6 plugins de
  `help()`. Se valida al arrancar (`validateRelatedLinks` en `mcp-server.mjs`): un `target` que no resuelve
  a una skill real de un plugin realmente cargado se loguea a stderr, no tumba nada — es metadata de
  discoverabilidad, no una dependencia funcional. Alcance a propósito: solo conecta skills entre sí, no
  tools crudas (el catálogo de una tool cruda a veces solo se conoce tras conectar en vivo, y esto corre
  antes de que nada se conecte). Mismo riesgo que `discoverHint` desde el día uno: un `related` sin
  mantener apunta a algo que ya no existe — la validación al arrancar avisa, pero no impide que quede
  desactualizado si nadie lee el log.
- **El techo: confirmado, no es hipotético.** Mismo modelo, misma tarea, mismo plugin: con shell
  disponible, ignoró todo el sistema de plugins y llamó al binario subyacente directo; sin shell
  disponible, usó el plugin y encontró la skill correcta sin que nadie la nombrara. Ninguna de las capas
  de arriba funciona como discoverabilidad real fuera de un entorno donde el agente no tiene una ruta más corta —
  no son una frontera de seguridad ni de control, son la ruta ganadora únicamente cuando es la única.

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
