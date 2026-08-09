# agent-tools-plugin-ollama

Plugin de [agent-tools-runtime](https://github.com/MauricioPerera/agent-tools-runtime) para
[Ollama](https://ollama.com) — server local de modelos con una REST API propia. Quinto plugin
REST self-hosted del sistema (mismo caso que `tasks`/`pocketbase`: sin MCP nativo, catálogo de
tools inventado por el plugin) y el más simple de todos: Ollama no tiene auth por default.

## Alcance de esta primera versión

Este plugin envuelve **solo la API propia de Ollama** (listar/bajar modelos, completions de una
sola pasada). **No delega tareas con acceso a herramientas** — evaluado por separado antes de
arrancar este plugin: eso es un problema distinto (llamadas de varios minutos, necesitaría
semántica async que el runtime no tiene hoy, riesgo de recursión si el agente delegado reusa las
mismas MCP tools). Este plugin es el primer paso simple; delegación real con tools queda para
evaluar más adelante si hace falta.

## Instalación

```bash
npm install agent-tools-plugin-ollama
```

Se instala al lado de `@rckflr/agent-tools-runtime`. Si `discoverPlugins()` escanea
`node_modules/agent-tools-plugin-*`, el plugin se detecta solo.

## Configuración

**Local (default):**

```bash
export OLLAMA_URL="http://localhost:11434"   # default si se omite
```

Sin auth — Ollama local no la requiere.

**Ollama Cloud** ([docs.ollama.com/cloud](https://docs.ollama.com/cloud)) — para no depender de tener
Ollama instalado localmente:

```bash
export OLLAMA_API_KEY="tu-api-key-de-ollama.com"
```

Si `OLLAMA_API_KEY` está seteada y `OLLAMA_URL` **no** lo está, el adapter apunta automáticamente a
`https://ollama.com` en vez de `localhost` y manda `Authorization: Bearer <key>` en cada request. Mismos
endpoints, mismo shape de request/response que local (verificado en vivo) — el catálogo de modelos
disponibles cambia (los de Ollama Cloud, no los que tengas descargados localmente).

`OLLAMA_URL` explícito siempre gana, tenga o no `OLLAMA_API_KEY` seteada — para casos como un proxy
propio delante de un server local con su propia auth.

## Tools expuestas

Con `prefix: "ollama"`, el runtime genera:

- `agent_tools_ollama_discover({ query? })`
- `agent_tools_ollama_call({ toolName, arguments, confirm? })`

Catálogo de `toolName` disponibles vía `_call`:

| Tool | Descripción | Muta estado/cómputo |
|---|---|---|
| `list_models` | Lista modelos disponibles localmente (descargados o cloud-linked), con `capabilities` | No |
| `list_running_models` | Lista modelos cargados en memoria ahora mismo | No |
| `generate` | Completion de una sola pasada (prompt → texto), sin historial | **Sí — requiere `confirm: true`** |
| `chat` | Completion con historial de mensajes (`role`/`content`) | **Sí — requiere `confirm: true`** |
| `pull_model` | Descarga un modelo al disco — puede tardar minutos | **Sí — requiere `confirm: true`** |

`generate`/`chat` siempre corren con `stream:false` (respuesta completa de una, no streaming) para
mantener el contrato simple de request/response del plugin.

## Skills

Ninguna todavía — arranca como facade REST puro sobre las 5 tools de arriba. Igual que los demás
plugins de este repo, una skill se agrega solo si el uso real muestra fricción concreta que valga
la pena colapsar en una sola llamada.

## Licencia

MIT.
