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
| `generate` | Completion de una sola pasada (prompt → texto), sin historial. Espera la respuesta completa. | **Sí — requiere `confirm: true`** |
| `chat` | Completion con historial de mensajes (`role`/`content`). Espera la respuesta completa. | **Sí — requiere `confirm: true`** |
| `pull_model` | Descarga un modelo al disco — puede tardar minutos | **Sí — requiere `confirm: true`** |
| `start_generate` | Como `generate`, pero no espera: dispara el request y devuelve `{jobId}` al toque | **Sí — requiere `confirm: true`** |
| `start_chat` | Como `chat`, pero no espera: dispara el request y devuelve `{jobId}` al toque | **Sí — requiere `confirm: true`** |
| `job_status` | Estado de un job (`running`/`done`/`error`/`cancelled`) más `elapsedMs` y el resultado si ya terminó | No |
| `list_jobs` | Lista todos los jobs trackeados en esta sesión, más recientes primero | No |
| `cancel_job` | Aborta un job `running` (vía `AbortController`) | **Sí — requiere `confirm: true`** |

`generate`/`chat` siempre corren con `stream:false` (respuesta completa de una, no streaming) para
mantener el contrato simple de request/response del plugin.

### Visión: `images` en `generate`/`chat` (y sus versiones `start_*`)

`generate({ model, prompt, images? })` e `chat({ model, messages: [{role, content, images?}] })`
aceptan imágenes — `images` es un array de strings en **base64 puro** (sin el prefijo
`data:image/...;base64,`), una por elemento. En `generate` va a nivel del request; en `chat` va
por mensaje (así una conversación puede tener algunos mensajes con imagen y otros sin). Solo tiene
efecto real con un modelo que declare `"vision"` en su `capabilities` (`list_models` lo muestra) —
con un modelo sin esa capability, Ollama la ignora en silencio, no es un error.

Verificado en vivo contra `gemma4:cloud` (`capabilities: [completion, thinking, tools, vision]`):
una imagen sintética con un círculo rojo de borde negro y el texto "CAT" en azul, descrita
correctamente por el modelo — color, forma y texto, los tres acertados.

### Jobs asíncronos: `start_generate`/`start_chat` + `job_status`

Pensado para el caso donde un modelo puede tardar bastante en responder (un modelo cloud grande, o
uno con mucho razonamiento interno — ver el caso real de `prism-ml/bonsai-27b` quemando ~9 minutos y
3947 tokens de "pensamiento" en una pregunta trivial, documentado en el README raíz) y no querés que
la llamada quede bloqueada esperando. En vez de `generate`/`chat` (síncronos), usá
`start_generate`/`start_chat`: devuelven `{jobId}` de inmediato, sin esperar nada, y consultás el
resultado después con `job_status({jobId})` — que te dice si sigue `running` (viva, no colgada),
`done` (con el resultado) o `error`.

El tracking de jobs vive **en memoria del proceso runtime**, no en disco ni en Ollama — si el server
MCP se reinicia, se pierde la referencia al job (aunque el request en sí siga su curso del lado de
Ollama). No hay expiración/limpieza automática de jobs viejos en esta primera versión.

## Skills

Tres, todas envolviendo `chat` con un solo mensaje (prompt fijo por tarea + una imagen) — el
equivalente funcional a las capacidades `core` de
[QwenLM/Qwen-MM-Plugins](https://github.com/QwenLM/Qwen-MM-Plugins) (`vision_chat`/`ocr`/`grounding`),
pero armadas sobre Ollama en vez de la API DashScope de Qwen. Ninguna reemplaza esa API — es la
alternativa cuando el modelo que ya tenés corriendo (`gemma4:cloud` u otro con capability `"vision"`)
alcanza. Las tres exigen `confirm: true` (mismo motivo que `chat`/`generate`: cómputo real) y fallan
claro si el `image` o los demás argumentos requeridos faltan.

- **`vision_chat({ image, question, model?, confirm })`** — pregunta libre sobre una imagen: qué hay,
  describir, comparar, contar objetos. Devuelve `{ model, answer }`. Verificado en vivo contra
  `gemma4:cloud` con una imagen sintética (círculo rojo, borde negro, texto "CAT" en azul) — contestó
  color y texto correctos.
- **`ocr({ image, model?, confirm })`** — extrae todo el texto visible, verbatim (sin resumir ni
  corregir). Devuelve `{ model, text }` (`text: ""` si no hay texto, no el string literal que le pide
  al modelo internamente). Verificado en vivo: extrajo "CAT" solo, sin comentario extra, de la misma
  imagen de prueba; devolvió `""` limpio contra una imagen sin texto.
- **`grounding({ image, target, width, height, model?, confirm })`** — encuentra un objeto por
  descripción libre y devuelve su bounding box en píxeles. `width`/`height` (las dimensiones reales de
  la imagen) son **requeridos** — sin ellos el modelo no tiene escala contra la cual reportar
  coordenadas. Devuelve `{ found: true, box: {x_min, y_min, x_max, y_max} }` o `{ found: false }` si el
  objeto no aparece — no alucina coordenadas cuando no encuentra nada (verificado). `gemma4:cloud`
  tiende a envolver su respuesta en un fence ` ```json ` aunque el prompt le pida explícitamente que no
  lo haga; la skill lo pela antes de parsear, no confía en que el prompt alcance solo.

  Verificado en vivo dos veces antes de escribir la skill, no asumido: (1) imagen 200×200 con un solo
  círculo rojo — devolvió `{30,30,170,170}`, exacto contra el box real; (2) imagen 300×300 con un
  círculo rojo Y un cuadrado azul, pidiendo específicamente el azul — devolvió `{180,150,260,230}`,
  exacto también, y discriminó la forma correcta entre dos presentes en la imagen.

## Licencia

MIT.
