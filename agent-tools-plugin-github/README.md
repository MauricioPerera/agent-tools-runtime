# agent-tools-plugin-github

Plugin de [agent-tools-runtime](https://github.com/MauricioPerera/agent-tools-runtime) para GitHub (REST
API v3, no un MCP server envuelto — este plugin define su propio catálogo de tools).

## Instalación

```bash
npm install agent-tools-plugin-github
```

Se instala al lado de `@rckflr/agent-tools-runtime`. Si `discoverPlugins()` escanea
`node_modules/agent-tools-plugin-*`, el plugin se detecta solo — no hace falta tocar código del runtime.

## Configuración

```bash
export GITHUB_TOKEN="<tu personal access token, scope 'repo' como mínimo>"
```

## Tools expuestas

Con `prefix: "github"`, el runtime genera:

- `agent_tools_github_discover({ query? })`
- `agent_tools_github_call({ toolName, arguments, confirm? })`
- `agent_tools_github_run_skill({ skill, arguments })`

Catálogo de `toolName` disponibles vía `_call`:

| Tool | Descripción | Muta estado |
|---|---|---|
| `search_repositories` | Busca repos por texto libre | No |
| `get_repository` | Metadata de un repo (`owner`, `repo`) | No |
| `list_issues` | Lista issues de un repo | No |
| `get_latest_commit` | Último commit de una rama | No |
| `create_issue` | Crea un issue nuevo | **Sí — requiere `confirm: true`** |

## Skills

- **`repo-overview({ owner, repo })`** — junta `get_repository` + `list_issues` (abiertos) +
  `get_latest_commit` en una sola llamada. Determinista, no genera código ni depende de que el LLM
  orqueste las 3 llamadas por separado.

## Licencia

MIT.
