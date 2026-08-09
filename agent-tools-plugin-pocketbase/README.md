# agent-tools-plugin-pocketbase

Plugin de [agent-tools-runtime](https://github.com/MauricioPerera/agent-tools-runtime) para
[PocketBase](https://pocketbase.io) — backend self-hosted (Go) con REST API sobre colecciones/records.
Primer plugin del sistema con **autenticación dinámica**: a diferencia de github/tasks/n8n (token o API
key ya emitidos), PocketBase no tiene API key estática para superusers — el adapter hace login
(`auth-with-password` contra `_superusers`) en la primera llamada y cachea el token en memoria.

## Instalación

```bash
npm install agent-tools-plugin-pocketbase
```

Se instala al lado de `@rckflr/agent-tools-runtime`. Si `discoverPlugins()` escanea
`node_modules/agent-tools-plugin-*`, el plugin se detecta solo — no hace falta tocar código del runtime.

## Configuración

```bash
export POCKETBASE_URL="http://127.0.0.1:8090"   # default si se omite
export POCKETBASE_EMAIL="superuser@tudominio.com"
export POCKETBASE_PASSWORD="..."
```

## Tools expuestas

Con `prefix: "pocketbase"`, el runtime genera:

- `agent_tools_pocketbase_discover({ query? })`
- `agent_tools_pocketbase_call({ toolName, arguments, confirm? })`
- `agent_tools_pocketbase_run_skill({ skill, arguments })`

Catálogo de `toolName` disponibles vía `_call`:

| Tool | Descripción | Muta estado |
|---|---|---|
| `list_collections` | Lista colecciones (nombre, tipo, campos) | No |
| `list_records` | Lista records de una colección, paginado (default 100/página) | No |
| `get_record` | Trae un record por id | No |
| `create_record` | Crea un record nuevo | **Sí — requiere `confirm: true`** |
| `update_record` | Actualiza (parcial) un record existente | **Sí — requiere `confirm: true`** |
| `delete_record` | Borra un record por id | **Sí — requiere `confirm: true`** |

`list_records` **no trae todo automáticamente** — pagina de a `perPage` (default 100, tope real de
PocketBase 500); para catálogos más grandes hay que iterar `page` explícito.

## Skills

- **`insert-and-verify-record({ collection, data })`** — crea un record y lo confirma leyéndolo de
  vuelta. Determinista, mismo patrón que `insert-and-verify-task` (plugin `tasks`) e
  `insert-and-verify-datatable-row` (plugin `n8n`).

## Licencia

MIT.
