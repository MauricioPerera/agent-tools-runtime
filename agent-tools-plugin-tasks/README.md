# agent-tools-plugin-tasks

Plugin de [agent-tools-runtime](https://github.com/MauricioPerera/agent-tools-runtime) para una API
REST propia, self-hosted (no un MCP server envuelto, no un SaaS de terceros): un CRUD mínimo de
"tasks" desplegado en el VPS del proyecto, sin OAuth ni creación de cuentas — solo una API key.

## Instalación

```bash
npm install agent-tools-plugin-tasks
```

Se instala al lado de `@rckflr/agent-tools-runtime`. Si `discoverPlugins()` escanea
`node_modules/agent-tools-plugin-*`, el plugin se detecta solo — no hace falta tocar código del runtime.

## Configuración

```bash
export TASKS_API_KEY="<api key de tu instancia>"
export TASKS_API_BASE="https://tu-instancia/tasks"  # opcional, default https://api.ardf.dev/tasks
```

## Tools expuestas

Con `prefix: "tasks"`, el runtime genera:

- `agent_tools_tasks_discover({ query? })`
- `agent_tools_tasks_call({ toolName, arguments, confirm? })`
- `agent_tools_tasks_run_skill({ skill, arguments })`

Catálogo de `toolName` disponibles vía `_call`:

| Tool | Descripción | Muta estado |
|---|---|---|
| `list_tasks` | Lista tasks, filtro opcional por texto (`q`) | No |
| `get_task` | Trae una task por `id` | No |
| `create_task` | Crea una task (`title`, `done?`) | **Sí — requiere `confirm: true`** |
| `update_task` | Actualiza `title`/`done` de una task existente | **Sí — requiere `confirm: true`** |
| `delete_task` | Borra una task por `id` | **Sí — requiere `confirm: true`** |

## Skills

- **`insert-and-verify-task({ title, done? })`** — determinista, no genera código: crea la task y
  confirma leyéndola de vuelta (`created.id === read.id`, `title`/`done` coinciden). Mismo patrón que
  `insert-and-verify-datatable-row` del plugin de n8n, pero sin capa de workflow de por medio.

## Licencia

MIT.
