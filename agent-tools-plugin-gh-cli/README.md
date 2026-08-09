# agent-tools-plugin-gh-cli

Plugin de [agent-tools-runtime](https://github.com/MauricioPerera/agent-tools-runtime) para el
**GitHub CLI (`gh`)** — no la REST API directa (eso lo cubre
[agent-tools-plugin-github](../agent-tools-plugin-github)). Primer plugin del sistema de transporte
CLI: en vez de hablar HTTP/MCP, shellea un binario ya instalado (`execFile`, sin shell) y parsea su
stdout/exit code.

Mismo dominio que `agent-tools-plugin-github` a propósito — dos transportes distintos sobre el mismo
dominio (GitHub) para poder comparar comportamiento aislando esa única variable.

## Instalación

```bash
npm install agent-tools-plugin-gh-cli
```

Se instala al lado de `@rckflr/agent-tools-runtime`. Si `discoverPlugins()` escanea
`node_modules/agent-tools-plugin-*`, el plugin se detecta solo — no hace falta tocar código del runtime.

## Configuración

Requiere el binario `gh` instalado y **autenticado en este host**:

```bash
gh auth login
gh auth status   # verificar
```

A diferencia de los demás plugins, la autenticación **no** se pasa por variable de entorno de este
proceso — vive en la sesión local de `gh` (keyring del SO). Si `gh auth status` falla acá, ninguna tool
de este plugin va a funcionar sin importar qué argumentos le pases.

Override opcional del binario (por ejemplo, para apuntar a una instalación no estándar):

```bash
export GH_CLI_BIN="/ruta/a/gh"
```

## Tools expuestas

Con `prefix: "ghcli"`, el runtime genera:

- `agent_tools_ghcli_discover({ query? })`
- `agent_tools_ghcli_call({ toolName, arguments, confirm? })`
- `agent_tools_ghcli_run_skill({ skill, arguments })`

Catálogo de `toolName` disponibles vía `_call`:

| Tool | Descripción | Muta estado |
|---|---|---|
| `repo_view` | Metadata de un repo (`owner`, `repo`) vía `gh repo view` | No |
| `issue_list` | Lista issues (`owner`, `repo`, `state?`, `limit?`) vía `gh issue list` | No |
| `pr_list` | Lista pull requests (`owner`, `repo`, `state?`, `limit?`) vía `gh pr list` | No |
| `issue_create` | Crea un issue nuevo | **Sí — requiere `confirm: true`** |

`issue_list`/`pr_list` pasan `--limit` explícito (default 200) a `gh` — sin eso, `gh` usa su propio
default de 30, que reproduciría el mismo bug de paginación oculta que se encontró y arregló en
`agent-tools-plugin-github` (REST, `per_page=20` fijo sin loop).

## Skills

- **`repo-overview({ owner, repo })`** — junta `repo_view` + `issue_list` (abiertos) + `pr_list`
  (abiertos) en una sola llamada. Determinista, no genera código ni depende de que el LLM orqueste las
  3 llamadas por separado.

## Licencia

MIT.
