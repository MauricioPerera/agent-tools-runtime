# agent-tools-plugin-n8n

Plugin de [agent-tools-runtime](https://github.com/MauricioPerera/agent-tools-runtime) para
[n8n](https://n8n.io). El primero y más medido de los tres plugins del proyecto — extensamente
benchmarkeado contra `gpt-oss:20b-cloud` y `gpt-oss:120b-cloud`.

## Instalación

```bash
npm install agent-tools-plugin-n8n
```

## Configuración

Una sola variable de URL para todo el plugin, más las credenciales:

```bash
export N8N_INSTANCE_URL="https://tu-instancia.n8n"   # una sola vez, cubre MCP y REST
export N8N_MCP_TOKEN="<tu token MCP>"
export N8N_API_KEY="<tu api key REST, Settings → n8n API>"  # solo si usás audit-workflows/delete-workflow(-bulk)

# O un token store persistente en disco (ver n8n-oauth.mjs), si preferís
# no pasar N8N_MCP_TOKEN por variable de entorno cada vez.
```

`N8N_INSTANCE_URL` es la única variable de URL que hace falta configurar: tanto el adapter MCP
(`agent_tools_n8n_discover`/`_call`) como las tres skills que hablan la REST API directo
(`audit-workflows`, `delete-workflow`, `delete-workflows-bulk` — ver la sección de Skills) la
derivan de ahí, completando cada una el path que necesita (`/mcp-server/http` para el MCP, la raíz
para la REST API). Ninguna llamada necesita que le pases `url` a mano.

`N8N_MCP_URL` (formato completo, con `/mcp-server/http`) sigue existiendo como override — solo
hace falta si tu MCP y tu REST API viven en hosts distintos, o para configs de antes de que
existiera `N8N_INSTANCE_URL`. Si no tenés ese caso puntual, no la definas: alcanza con
`N8N_INSTANCE_URL`.

## Tools expuestas

Con `prefix: "n8n"`, el runtime genera:

- `agent_tools_n8n_discover({ query? })`
- `agent_tools_n8n_call({ toolName, arguments, confirm? })`
- `agent_tools_n8n_run_skill({ skill, arguments })`

`_call` da acceso a las tools del MCP de n8n (creación/lectura de workflows, data tables, ejecuciones,
etc.) — el catálogo lo define n8n, este plugin solo lo reenvía tipado.

**Este plugin corre con `requireConfirm: false`** (`plugin.json`, campo leído por el runtime desde
`>=0.2.2`): a diferencia de los demás plugins de agent-tools-runtime, `agent_tools_n8n_call` ejecuta
tools que mutan estado (`create_workflow_from_code`, `update_workflow`, `archive_workflow`,
`publish_workflow`, etc.) sin exigir `confirm: true` — el argumento sigue existiendo en el schema por
compatibilidad, pero no tiene efecto acá. No hay freno del lado del runtime contra una mutación
accidental; queda en quien llama a la tool.

**Nota sobre borrado real de workflows**: el catálogo MCP de n8n no tiene un `delete_workflow` — lo más
parecido es `archive_workflow`, que archiva, no borra. Un borrado permanente solo existe en la REST API
de n8n (`DELETE /api/v1/workflows/{id}`), fuera del MCP; por eso es una skill aparte
(`delete-workflow`, ver abajo), no una tool de `_call`.

**`url` es opcional en `audit-workflows`, `delete-workflow` y `delete-workflows-bulk`**: estas tres
hablan la REST API directo (no el MCP), así que no heredan `N8N_MCP_URL` del adapter automáticamente.
Orden de resolución si no se pasa `url` en la llamada: `N8N_INSTANCE_URL` (si está seteada, gana) →
si no, se deriva de `N8N_MCP_URL` (o su default) sacándole el sufijo `/mcp-server/http`. No hace
falta pasar `url` en ninguna llamada salvo un caso puntual: REST y MCP en hosts distintos sin haber
seteado `N8N_INSTANCE_URL`.

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
- **`audit-workflows({ url?, mode?, all?, workflowId?, exportDir?, auditCategories?, daysAbandoned?, status?, maxExecutions?, page?, pageSize? })`** —
  auditoría de seguridad/robustez de solo lectura, vía la REST API de n8n (no el MCP). Envuelve
  [`audit_n8n_workflows.py`](scripts/audit_n8n_workflows.py) (vendorizado desde
  [`n8n-workflow-auditor`](https://github.com/MauricioPerera/thehumanintheloop-marketplace-codex/tree/main/plugins/n8n-workflow-auditor),
  mismo autor, MIT) a través del adapter `local-cli` del runtime — no reescribe la lógica en JS. `mode`:
  `audit` (default, 7 reglas por workflow: webhooks sin auth, credenciales hardcodeadas, nodos de alto
  riesgo, error workflow, reintentos, nodos huérfanos, trigger alcanzable), `summary` (inventario),
  `export` (backup a `exportDir`), `nativeAudit` (envuelve `POST /api/v1/audit` de n8n), `executions`
  (tasa de error real por workflow), `credentials` (inventario de metadata, nunca valores).

  `all` por default es `true` (catálogo completo, activos + inactivos) — el script solo trae
  workflows activos si no se le pasa `--all`, así que un `inactive: 0` sin este default reflejaba
  que nunca miró los inactivos, no que no existieran. Pasá `all: false` explícito solo si de verdad
  querés la vista recortada a activos.

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
- **`delete-workflow({ url?, workflowId })`** o **`delete-workflow({ url?, namePattern })`** —
  borrado real y permanente de un workflow, vía `DELETE /api/v1/workflows/{id}` de la REST API de
  n8n (no el MCP — ver la nota de arriba sobre por qué no es una tool de `_call`). `namePattern`
  (mismo argumento que `find-workflows`/`delete-workflows-bulk`) resuelve a un `workflowId` via
  substring match case-insensitive: error si matchea 0 workflows, o si matchea más de 1 (devuelve la
  lista de matches en vez de adivinar cuál — para eso está `delete-workflows-bulk`). No acepta
  `workflowId` y `namePattern` a la vez. Requiere `N8N_API_KEY` en el entorno del proceso del
  runtime, igual que `audit-workflows`. Sin confirmación propia — coherente con
  `requireConfirm: false` del resto del plugin: si se llama, borra. Devuelve
  `{ isError: false, workflowId, deleted: <workflow borrado> }` en éxito, o
  `{ isError: true, status, error }` si n8n rechaza el pedido (ej. id inexistente → 404).
- **`delete-workflows-bulk({ url?, active?, namePattern? })`** — borra en lote los workflows que
  matchean el filtro. `active` (boolean) filtra por estado activo/inactivo; `namePattern` (string) hace
  substring match case-insensitive contra el nombre; se puede pasar uno, el otro, o ambos (AND). **Exige
  al menos uno de los dos** — sin filtro, error, no borra nada (no hay "borrar todo" implícito). Pagina
  la lista completa antes de filtrar (`GET /api/v1/workflows` de n8n pagina de a 100 — un
  `delete-workflow` uno-por-uno sobre solo la primera página se queda corto en cualquier instancia con
  más de 100 workflows). Sin API de bulk-delete en n8n: por dentro sigue siendo un `DELETE` por
  workflow. Devuelve `{ isError, totalWorkflows, matchedCount, deletedCount, failedCount, deleted: [...],
  failed: [...] }` — `isError` solo es `true` si hubo matches y **ninguno** se pudo borrar; fallas
  parciales quedan en `failed` sin marcar la llamada entera como error. Requiere `N8N_API_KEY`, sin
  confirmación propia, misma política que `delete-workflow`.
- **`find-workflows({ url?, active?, namePattern?, page?, pageSize? })`** — de solo lectura,
  equivalente a `delete-workflows-bulk` pero sin el paso de borrado: mismo filtro (`active`/
  `namePattern`, ambos opcionales acá — sin ninguno devuelve el catálogo completo), misma paginación
  REST completa por dentro (comparten `fetchAllWorkflows` en `_shared.mjs`). Devuelve
  `{ isError: false, totalWorkflows, matchedCount, workflows: [{id, name, active, createdAt,
  updatedAt}, ...], pagination: {page, pageSize, totalItems, totalPages} }`. Existe porque la tool
  MCP `search_workflows` de n8n **no es confiable para esto**: su schema real es solo
  `limit`/`projectId`/`query`/`sortBy`/`tags` (tope `limit=200`), sin cursor ni filtro por `active` —
  pedirle distintas páginas con parámetros que no existen (`offset`, `skip`) devuelve siempre el
  mismo lote sin avisar del error. Usá `find-workflows` para cualquier "buscar/contar/listar
  workflows [in]activos", y `search_workflows` solo para lo que sí soporta (buscar por nombre/tag
  dentro de los primeros 200).
- **`find-node-types({ queries: string[] })`** o **`find-node-types({ nodeIds: [{nodeId, resource?,
  operation?, mode?, version?}, ...] })`** — junta `search_nodes`/`get_node_types` (las dos tools MCP
  para identificar y tipar nodos antes de escribir código con `create-and-verify-workflow`) bajo una
  skill con su propia validación, en vez del error genérico de `_call` cuando falta un argumento o
  el shape no es el esperado. `queries` busca nodos por nombre/servicio (equivalente a
  `search_nodes`, ya devuelve la guía de qué llamar después); `nodeIds` trae la definición
  TypeScript exacta de nodos ya identificados (equivalente a `get_node_types`, valida que cada
  entrada tenga `nodeId` antes de llamar). No acepta ambos a la vez — es un paso, no encadena
  automáticamente de `queries` a `nodeIds`: la salida de `search_nodes` es texto libre pensado para
  que lo lea un LLM (discriminadores anidados en prosa, no JSON estructurado), parsearlo a ciegas
  para "elegir el mejor match" arriesgaría construir un `nodeId` equivocado en silencio.
- **`create-credential({ type, name?, data? })`** — crea una credencial en n8n vía
  `POST /api/v1/credentials` (no existe en el catálogo MCP — `list_credentials` es de solo lectura).
  Sin `name`/`data`, solo trae el schema real del tipo (`GET /credentials/schema/{type}`) para saber
  qué campos pide, sin crear nada. Con los tres, valida contra ese mismo schema que `data` tenga los
  campos requeridos antes de llamar (error específico — "falta accessToken" — en vez del genérico de
  n8n) y crea la credencial. **No obtiene secretos por su cuenta**: para tipos con token estático
  (ej. `slackApi`, que solo pide `accessToken`) alcanza con que el humano haya generado ese token una
  vez en la app de origen; para tipos OAuth2 reales (ej. `slackOAuth2Api`), conseguir el token todavía
  exige el consentimiento por navegador — eso lo sigue haciendo un humano, esta skill solo registra
  los datos ya obtenidos. Devuelve `{ isError: false, credentialId, name, type }` en éxito, o
  `{ isError: false, mode: "schema", type, schema }` en el modo de solo consulta. Requiere
  `N8N_API_KEY`, misma política que las demás skills REST de este plugin.
- **`delete-credential({ url?, credentialId })`** — borrado real de una credencial, vía
  `DELETE /api/v1/credentials/{id}` de la REST API (mismo motivo que `delete-workflow`: no existe en
  el catálogo MCP). `credentialId` sale de `list_credentials`. Devuelve
  `{ isError: false, credentialId, deleted }` en éxito. Requiere `N8N_API_KEY`, sin confirmación
  propia — misma política `requireConfirm: false` que el resto del plugin.

## Licencia

MIT. `scripts/audit_n8n_workflows.py` vendorizado desde
[`thehumanintheloop-marketplace-codex`](https://github.com/MauricioPerera/thehumanintheloop-marketplace-codex),
también MIT, mismo autor.
