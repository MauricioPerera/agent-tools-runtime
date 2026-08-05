# Agent Tools Runtime

Runtime persistente basado en `just-bash` para que un agente descubra y cargue
progresivamente adaptadores MCP, REST y CLI local sin exponer todo el catálogo
de herramientas en cada conversación.

## Estado

Este repositorio es la evolución independiente de la POC publicada en
[TheHumanInTheLoop Marketplace](https://mauricioperera.github.io/thehumanintheloop-marketplace-codex/).
La API todavía está en `0.x`; cualquier cambio puede requerir migración.

## Capas

```text
MCP facade → persistent runtime → adapter → provider
```

Adaptadores incluidos:

- MCP genérico con sesiones y tokens host-side.
- n8n MCP con OAuth/token host-side.
- REST/API con rutas relativas y confirmación para mutaciones.
- CLI local con allowlist, `execFile`, timeout y confirmación.

## Desarrollo

Requisitos: Node.js `>=20.18.1`.

```powershell
npm install
npm test
npm run probe
npm run serve
```

La fachada MCP se inicia con:

```powershell
npm run mcp
```

## Instalación desde una release

El paquete está publicado en npm como
[`@rckflr/agent-tools-runtime`](https://www.npmjs.com/package/@rckflr/agent-tools-runtime):

```powershell
npm install @rckflr/agent-tools-runtime
```

Para iniciar la fachada MCP sin instalarla globalmente:

```powershell
npx --yes --package=@rckflr/agent-tools-runtime@0.1.3 --call agent-tools-mcp
```

Si ejecutas el comando desde el propio checkout `agent-tools-runtime`, usa el
prefijo del directorio padre para que npm no confunda el paquete local con el
paquete remoto:

```powershell
npx --prefix .. --yes --package=@rckflr/agent-tools-runtime@0.1.3 --call agent-tools-mcp
```

La release inicial también incluye un tarball instalable directamente desde
GitHub:

```powershell
npm install https://github.com/MauricioPerera/agent-tools-runtime/releases/download/v0.1.0/rckflr-agent-tools-runtime-0.1.0.tgz
```

Después de instalarlo, el ejecutable queda disponible como `agent-tools`.
El repositorio incluye un workflow de publicación. Para futuras versiones se
debe configurar el secret `NPM_TOKEN` en GitHub; después puede ejecutarse
manualmente o al publicar una release con tag `v*`.

El preflight puede comprobar un CLI sin ejecutarlo:

```powershell
$env:AGENT_TOOLS_COMMAND = "gh"
$env:AGENT_CLI_ALLOWLIST = "gh,docker,supabase"
npm run probe
```

## Diseño de seguridad

Las credenciales permanecen en el host. Las skills y los adapters no deben
recibir tokens como argumentos ni escribir secretos en archivos. Las
operaciones mutantes requieren confirmación explícita y los CLIs se ejecutan
sin shell implícito.

## Integraciones

El plugin para Claude Code y Codex se mantiene en el marketplace como una capa
de distribución. Este repositorio contiene el runtime canónico y no depende de
los manifests específicos de ningún cliente.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
