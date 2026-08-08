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

**Este plugin corre con `requireConfirm: false`** (`plugin.json`, campo leído por el runtime desde
`>=0.2.2`): a diferencia de los demás plugins de agent-tools-runtime, `agent_tools_n8n_call` ejecuta
tools que mutan estado (`delete_workflow`, `create_workflow_from_code`, `publish_workflow`, etc.) sin
exigir `confirm: true` — el argumento sigue existiendo en el schema por compatibilidad, pero no tiene
efecto acá. No hay freno del lado del runtime contra una mutación o un delete accidental; queda en quien
llama a la tool.

## Skills

Las primeras tres, medidas en un benchmark real (ver [detalle](https://github.com/MauricioPerera/agent-tools-runtime)):

- **`insert-and-verify-datatable-row({ column, value, dataTableId?, tableName?, confirm })`** —
  determinista, no genera código: crea la data table si hace falta, crea y publica un workflow con una
  plantilla ya probada, lo ejecuta y confirma el valor leído. La más medida y confiable de las tres.
- **`data-table-crud({ operation: "create"|"insert"|"read", ... })`** — determinista. `create` e
  `insert` son llamadas directas a n8n (sin workflow); `read` arma un workflow mínimo porque n8n no
  expone una tool directa de lectura de filas.
- **`create-and-verify-workflow({ code, name, publish?, execute? })`** — la única genuinamente
  genérica: vos generás el código del `@n8n/workflow-sdk`, la skill valida/crea/publica/ejecuta en una
  sola llamada por intento, con errores estructurados por etapa.
- **`audit-workflows({ url, mode?, all?, workflowId?, exportDir?, auditCategories?, daysAbandoned?, status?, maxExecutions?, page?, pageSize? })`** —
  auditoría de seguridad/robustez de solo lectura, vía la REST API de n8n (no el MCP). Envuelve
  [`audit_n8n_workflows.py`](scripts/audit_n8n_workflows.py) (vendorizado desde
  [`n8n-workflow-auditor`](https://github.com/MauricioPerera/thehumanintheloop-marketplace-codex/tree/main/plugins/n8n-workflow-auditor),
  mismo autor, MIT) a través del adapter `local-cli` del runtime — no reescribe la lógica en JS. `mode`:
  `audit` (default, 7 reglas por workflow: webhooks sin auth, credenciales hardcodeadas, nodos de alto
  riesgo, error workflow, reintentos, nodos huérfanos, trigger alcanzable), `summary` (inventario),
  `export` (backup a `exportDir`), `nativeAudit` (envuelve `POST /api/v1/audit` de n8n), `executions`
  (tasa de error real por workflow), `credentials` (inventario de metadata, nunca valores).

  El script trae siempre el resultado completo (en una instancia con cientos de workflows eso es
  decenas de KB en un solo array); la skill lo pagina después, sobre el JSON ya completo, sin tocar el
  script. Aplica a los modos que devuelven una lista grande — `audit`/`summary` (`workflows`),
  `executions` (`by_workflow`), `credentials` (`credentials`) — no a `export`/`nativeAudit`. `page`
  (default `1`) y `pageSize` (default `50`, tope `200`) son opcionales; la respuesta agrega un campo
  `pagination: { page, pageSize, totalItems, totalPages }`. Pedir una página fuera de rango la ajusta a
  la última disponible en vez de devolver vacío por error.

  Requiere en el entorno del proceso del runtime (no se puede pasar por argumento de la skill):
  ```bash
  export N8N_API_KEY="<api key REST de n8n, Settings → n8n API — distinta del token MCP>"
  # opcional: export N8N_AUDIT_PYTHON_BIN="/ruta/a/python3"  # default: python3 en PATH
  ```

## Licencia

MIT. `scripts/audit_n8n_workflows.py` vendorizado desde
[`thehumanintheloop-marketplace-codex`](https://github.com/MauricioPerera/thehumanintheloop-marketplace-codex),
también MIT, mismo autor.
