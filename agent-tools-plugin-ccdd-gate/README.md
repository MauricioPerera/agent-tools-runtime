# agent-tools-plugin-ccdd-gate

Plugin de [agent-tools-runtime](https://github.com/MauricioPerera/agent-tools-runtime) para
[ccdd-gate](https://github.com/MauricioPerera/KDD) (metodo CCDD, parte del repo KDD): un servidor MCP
de gates deterministas (AST, sin LLM salvo `run_ephemeral_agent`) para escribir codigo Python bajo
contratos de tarea congelados.

Mismo caso que `agent-tools-plugin-kite-lite`: el backend YA habla MCP real (JSON-RPC 2.0 sobre
stdio), asi que este adapter es un **cliente MCP por stdio** -- reenvia `tools/list`/`tools/call` tal
cual, sin inventar un catalogo propio (a diferencia de `github`/`tasks`, que envuelven REST APIs sin
MCP nativo). Cero reimplementacion, cero drift respecto al server real.

Unica diferencia de forma respecto a kite-lite: el backend se invoca en **dos partes**
(`python <script>`), no un binario unico con subcomando.

## Instalacion

```bash
npm install agent-tools-plugin-ccdd-gate
```

Se instala al lado de `@rckflr/agent-tools-runtime`. Si `discoverPlugins()` escanea
`node_modules/agent-tools-plugin-*`, el plugin se detecta solo.

## Configuracion

```bash
export CCDD_GATE_PYTHON="python"                                          # default si se omite
export CCDD_GATE_SCRIPT="D:/repos/ccddgate/ccdd-gate/runners/complexity_mcp.py"  # obligatorio
```

`run_ephemeral_agent` (delega la implementacion a un modelo pequeno local) ademas necesita
`CCDD_EXECUTOR_API`/`CCDD_EXECUTOR_MODEL` en el entorno del proceso Python -- el resto del catalogo
(analisis AST puro sobre codigo ya escrito) no depende de ningun LLM.

## Tools expuestas

Con `prefix: "ccdd"`, el runtime genera:

- `agent_tools_ccdd_discover({ query? })`
- `agent_tools_ccdd_call({ toolName, arguments, confirm? })`
- `agent_tools_ccdd_run_skill({ skill, arguments })` (sin skills todavia -- ver abajo)

El catalogo real de `toolName` lo define el server ccdd-complexity, no este plugin (se descubre via
`agent_tools_ccdd_discover()`). A la fecha, 23 tools agrupables en:

**Solo-lectura (analisis AST, sin mutar nada):** `measure_complexity`, `check_signature`,
`check_purity`, `check_asserts`, `check_bare_except`, `check_mutable_defaults`, `check_none_cmp`,
`scan_guardrails`, `scan_dependencies`, `lint_task_contract`, `complexity_rubric`, `eval_rubric`,
`audit_annotations`, `audit_composition`, `audit_orphan_targets`.

**Requieren `confirm: true`** (corren subprocesos, tests, o delegan a un agente ejecutor):
`run_rules_gate`, `run_linter_gate`, `run_integration_gate`, `run_eval_gate`, `mutation_audit`,
`judge_audit`, `run_ephemeral_agent`, `request_human_attestation`.

## Skills

- **`quality-gate-check({ code, language?, checks? })`** -- corre `measure_complexity` +
  `run_rules_gate` sobre un snippet en una sola llamada. Fricción real encontrada probando el plugin
  en vivo (pool exec, prompt abierto): `run_rules_gate` lee un `rules.yaml` y el archivo target DEL
  DISCO -- no acepta código ni reglas inline -- así que sin este skill el caller tiene que escribir el
  snippet a un archivo temporal, escribir el `rules.yaml` a mano, y recién ahí llamar el gate. El
  skill gestiona un tempdir efímero (se borra al terminar) y devuelve un veredicto combinado
  (`PASS`/`FAIL`/`INVALID`) con las métricas de complejidad y las violaciones de política, sin opinión
  de LLM encima -- son los dos gates deterministas del backend tal cual.

## Licencia

MIT.
