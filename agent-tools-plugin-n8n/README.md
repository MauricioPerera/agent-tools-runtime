# agent-tools-plugin-n8n

Plugin de [agent-tools-runtime](https://github.com/MauricioPerera/agent-tools-runtime) para
[n8n](https://n8n.io). El primero y más medido de los tres plugins del proyecto — extensamente
benchmarkeado contra `gpt-oss:20b-cloud` y `gpt-oss:120b-cloud`.

## Instalación

```bash
npm install agent-tools-plugin-n8n
```

## Configuración

Dos formas de autenticarse contra tu instancia de n8n:

```bash
# Token directo
export N8N_MCP_TOKEN="<tu token>"
export N8N_MCP_URL="https://tu-instancia.n8n/mcp-server/http"  # opcional, default ardf.dev

# O un token store persistente en disco (ver n8n-oauth.mjs), si preferís
# no pasar el token por variable de entorno cada vez.
```

## Tools expuestas

Con `prefix: "n8n"`, el runtime genera:

- `agent_tools_n8n_discover({ query? })`
- `agent_tools_n8n_call({ toolName, arguments, confirm? })`
- `agent_tools_n8n_run_skill({ skill, arguments })`

`_call` da acceso a las tools del MCP de n8n (creación/lectura de workflows, data tables, ejecuciones,
etc.) — el catálogo lo define n8n, este plugin solo lo reenvía tipado.

## Skills

Las tres, medidas en un benchmark real (ver [detalle](https://github.com/MauricioPerera/agent-tools-runtime)):

- **`insert-and-verify-datatable-row({ column, value, dataTableId?, tableName?, confirm })`** —
  determinista, no genera código: crea la data table si hace falta, crea y publica un workflow con una
  plantilla ya probada, lo ejecuta y confirma el valor leído. La más medida y confiable de las tres.
- **`data-table-crud({ operation: "create"|"insert"|"read", ... })`** — determinista. `create` e
  `insert` son llamadas directas a n8n (sin workflow); `read` arma un workflow mínimo porque n8n no
  expone una tool directa de lectura de filas.
- **`create-and-verify-workflow({ code, name, publish?, execute? })`** — la única genuinamente
  genérica: vos generás el código del `@n8n/workflow-sdk`, la skill valida/crea/publica/ejecuta en una
  sola llamada por intento, con errores estructurados por etapa.

## Licencia

MIT.
