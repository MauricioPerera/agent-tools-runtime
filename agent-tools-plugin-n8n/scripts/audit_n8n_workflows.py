#!/usr/bin/env python3
"""Read-only security and robustness audit for n8n workflows via the REST API.

No external dependencies. Never mutates workflows, credentials or executions.
Never prints the API key. Prefer passing it via the N8N_API_KEY environment
variable instead of --api-key to keep it out of shell history.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

TRIGGER_TYPES = {
    "n8n-nodes-base.webhook",
    "n8n-nodes-base.cron",
    "n8n-nodes-base.scheduleTrigger",
    "n8n-nodes-base.errorTrigger",
    "n8n-nodes-base.manualTrigger",
    "n8n-nodes-base.emailReadImap",
    "n8n-nodes-base.mqttTrigger",
}
HIGH_RISK_TYPES = {
    "n8n-nodes-base.executeCommand",
    "n8n-nodes-base.ssh",
    "n8n-nodes-base.code",
    "n8n-nodes-base.function",
    "n8n-nodes-base.functionItem",
}
EXTERNAL_CALL_TYPES = {
    "n8n-nodes-base.httpRequest",
    "n8n-nodes-base.graphql",
    "n8n-nodes-base.webhookResponse",
}
SECRET_KEY_PATTERN = re.compile(
    r"(apikey|api_key|token|password|passwd|secret|authorization|bearer)",
    re.IGNORECASE,
)
SECRET_VALUE_PATTERN = re.compile(
    r"^(sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+\S+|"
    r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})"
)
EXPRESSION_PREFIX = "={{"
USER_AGENT = "n8n-workflow-auditor/0.6.1 (+https://github.com/MauricioPerera/thehumanintheloop-marketplace-codex)"
AUDIT_CATEGORIES = {"credentials", "database", "nodes", "filesystem", "instance"}


def _request(base_url, path, api_key, method="GET", body=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "X-N8N-API-KEY": api_key,
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base_url.rstrip("/") + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise SystemExit(f"[FAILED] HTTP {exc.code} en {method} {path}: {exc.reason} — {detail}")
    except urllib.error.URLError as exc:
        raise SystemExit(f"[FAILED] No se pudo conectar a {base_url}: {exc.reason}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Respuesta HTTP 200 pero body no-JSON: tipico de un proxy/balanceador mal
        # configurado devolviendo una pagina de error con status 200, o una URL
        # base que no apunta al API de n8n. Sin este catch, json.loads() tira un
        # JSONDecodeError sin capturar y el script corta con un traceback crudo
        # en vez de un [FAILED] legible.
        preview = raw[:300].replace("\n", " ")
        raise SystemExit(f"[FAILED] Respuesta no-JSON de {method} {path} (revisa la URL de n8n y que no haya un proxy interceptando la request): {preview}")


def http_get(base_url, path, api_key):
    return _request(base_url, path, api_key, method="GET")


def run_native_audit(base_url, api_key, categories=None, days_abandoned=None):
    additional = {}
    if categories:
        unknown = set(categories) - AUDIT_CATEGORIES
        if unknown:
            raise SystemExit(f"[FAILED] Categorias de audit invalidas: {sorted(unknown)}. Validas: {sorted(AUDIT_CATEGORIES)}")
        additional["categories"] = categories
    if days_abandoned is not None:
        additional["daysAbandonedWorkflow"] = days_abandoned
    body = {"additionalOptions": additional} if additional else {}
    return _request(base_url, "/api/v1/audit", api_key, method="POST", body=body, timeout=60)


def list_workflows(base_url, api_key, only_active):
    workflows = []
    cursor = None
    while True:
        path = "/api/v1/workflows?limit=250"
        if only_active:
            path += "&active=true"
        if cursor:
            path += f"&cursor={cursor}"
        data = http_get(base_url, path, api_key)
        workflows.extend(data.get("data", []))
        cursor = data.get("nextCursor")
        if not cursor:
            break
    return workflows


def get_workflow(base_url, api_key, workflow_id):
    return http_get(base_url, f"/api/v1/workflows/{workflow_id}", api_key)


def list_credentials(base_url, api_key):
    credentials = []
    cursor = None
    while True:
        path = "/api/v1/credentials?limit=250"
        if cursor:
            path += f"&cursor={cursor}"
        data = http_get(base_url, path, api_key)
        credentials.extend(data.get("data", []))
        cursor = data.get("nextCursor")
        if not cursor:
            break
    return credentials


def summarize_credential(credential):
    shared = credential.get("shared") or []
    return {
        "id": credential.get("id"),
        "name": credential.get("name"),
        "type": credential.get("type"),
        "created_at": credential.get("createdAt"),
        "updated_at": credential.get("updatedAt"),
        "shared_with": [{"project": s.get("name"), "role": s.get("role")} for s in shared],
    }


def render_credentials_markdown(report):
    lines = [f"# Credenciales n8n — {report['n8n_url']}", ""]
    lines.append(f"Total: {report['total']}")
    if report["by_type"]:
        by_type = ", ".join(f"{t}: {n}" for t, n in sorted(report["by_type"].items(), key=lambda kv: -kv[1]))
        lines.append(f"Por tipo: {by_type}")
    lines.append("")
    lines.append("| Nombre | ID | Tipo | Creada | Compartida con |")
    lines.append("|---|---|---|---|---|")
    for cred in report["credentials"]:
        shared = "; ".join(f"{s['project']} ({s['role']})" for s in cred["shared_with"]) or "sin compartir"
        lines.append(f"| {cred['name']} | `{cred['id']}` | {cred['type']} | {cred['created_at']} | {shared} |")
    return "\n".join(lines)


EXECUTION_STATUSES = {"canceled", "crashed", "error", "new", "running", "success", "unknown", "waiting"}
ERROR_STATUSES = {"error", "crashed"}


def list_executions(base_url, api_key, status=None, workflow_id=None, max_executions=500):
    if status and status not in EXECUTION_STATUSES:
        raise SystemExit(f"[FAILED] Status invalido: {status!r}. Validos: {sorted(EXECUTION_STATUSES)}")
    executions = []
    cursor = None
    truncated = False
    while True:
        path = "/api/v1/executions?limit=250"
        if status:
            path += f"&status={status}"
        if workflow_id:
            path += f"&workflowId={workflow_id}"
        if cursor:
            path += f"&cursor={cursor}"
        data = http_get(base_url, path, api_key)
        executions.extend(data.get("data", []))
        cursor = data.get("nextCursor")
        if len(executions) >= max_executions:
            executions = executions[:max_executions]
            truncated = bool(cursor)
            break
        if not cursor:
            break
    return executions, truncated


def summarize_executions(executions):
    by_workflow = {}
    for execution in executions:
        workflow_id = execution.get("workflowId")
        entry = by_workflow.setdefault(workflow_id, {
            "workflow_id": workflow_id,
            "total": 0,
            "success": 0,
            "error": 0,
            "other": 0,
            "last_status": None,
            "last_started_at": None,
            "last_error_at": None,
        })
        entry["total"] += 1
        status = execution.get("status")
        started_at = execution.get("startedAt")
        if status == "success":
            entry["success"] += 1
        elif status in ERROR_STATUSES:
            entry["error"] += 1
            if started_at and (entry["last_error_at"] is None or started_at > entry["last_error_at"]):
                entry["last_error_at"] = started_at
        else:
            entry["other"] += 1
        if started_at and (entry["last_started_at"] is None or started_at > entry["last_started_at"]):
            entry["last_started_at"] = started_at
            entry["last_status"] = status
    for entry in by_workflow.values():
        entry["error_rate_pct"] = round(100 * entry["error"] / entry["total"], 1) if entry["total"] else 0.0
    return sorted(by_workflow.values(), key=lambda e: e["error"], reverse=True)


def render_executions_markdown(report):
    lines = [f"# Ejecuciones n8n — {report['n8n_url']}", ""]
    filters = report["filters"]
    filter_desc = ", ".join(f"{k}={v}" for k, v in filters.items() if v) or "ninguno"
    lines.append(f"Muestra: {report['sampled']} ejecuciones | filtros: {filter_desc}")
    if report["truncated"]:
        lines.append(f"**Truncado**: hay mas ejecuciones ademas de esta muestra de {report['sampled']}. Sube `--max-executions` para ampliar la ventana, o agrega `--status`/`--workflow-id` para acotar.")
    lines.append("")
    lines.append("| Workflow | ID | Total | OK | Error | Error % | Ultimo status | Ultimo error |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for entry in report["by_workflow"]:
        lines.append(
            f"| {entry.get('workflow_name', '?')} | `{entry['workflow_id']}` | {entry['total']} | {entry['success']} | "
            f"{entry['error']} | {entry['error_rate_pct']} | {entry['last_status']} | {entry['last_error_at'] or '-'} |"
        )
    return "\n".join(lines)


def scan_params_for_secrets(params, path="parameters"):
    findings = []
    if isinstance(params, dict):
        for key, value in params.items():
            key_path = f"{path}.{key}"
            if isinstance(value, (dict, list)):
                findings.extend(scan_params_for_secrets(value, key_path))
            elif isinstance(value, str):
                if value.startswith(EXPRESSION_PREFIX) or not value.strip():
                    continue
                key_hits_pattern = bool(SECRET_KEY_PATTERN.search(str(key)))
                value_hits_pattern = bool(SECRET_VALUE_PATTERN.match(value.strip()))
                if value_hits_pattern or (key_hits_pattern and len(value) >= 12):
                    findings.append(key_path)
    elif isinstance(params, list):
        for idx, item in enumerate(params):
            findings.extend(scan_params_for_secrets(item, f"{path}[{idx}]"))
    return findings


def check_webhook_auth(nodes):
    offenders = []
    for node in nodes:
        if node.get("type") == "n8n-nodes-base.webhook":
            auth = (node.get("parameters") or {}).get("authentication", "none")
            if auth in ("none", None):
                offenders.append(node.get("name", "?"))
    status = "FAILED" if offenders else "PASSED"
    return {
        "rule": "1. Webhooks sin autenticacion",
        "status": status,
        "evidence": offenders,
        "detail": "Nodos webhook con authentication=none" if offenders else "Todos los webhooks tienen autenticacion configurada",
    }


def check_hardcoded_secrets(nodes):
    offenders = {}
    for node in nodes:
        hits = scan_params_for_secrets(node.get("parameters") or {})
        if hits:
            offenders[node.get("name", "?")] = hits
    status = "FAILED" if offenders else "PASSED"
    return {
        "rule": "2. Credenciales hardcodeadas en parametros",
        "status": status,
        "evidence": offenders,
        "detail": "Valores literales con forma de secreto en parametros de nodo (no via credential manager)" if offenders else "Sin literales con forma de secreto detectados",
    }


def check_high_risk_nodes(nodes):
    offenders = [n.get("name", "?") for n in nodes if n.get("type") in HIGH_RISK_TYPES and not n.get("disabled")]
    status = "WARN" if offenders else "PASSED"
    return {
        "rule": "3. Nodos de alto riesgo (comandos, SSH, codigo)",
        "status": status,
        "evidence": offenders,
        "detail": "Requieren revision manual: ejecutan comandos, SSH o codigo arbitrario" if offenders else "Sin nodos de ejecucion de comandos/codigo activos",
    }


def check_error_workflow(workflow):
    error_wf = (workflow.get("settings") or {}).get("errorWorkflow")
    status = "PASSED" if error_wf else "FAILED"
    return {
        "rule": "4. Workflow de error configurado",
        "status": status,
        "evidence": error_wf,
        "detail": "settings.errorWorkflow definido" if error_wf else "Sin errorWorkflow: fallos silenciosos si nadie mira las ejecuciones",
    }


def check_retry_on_external_calls(nodes):
    offenders = []
    for node in nodes:
        if node.get("type") in EXTERNAL_CALL_TYPES and not node.get("disabled"):
            if not node.get("retryOnFail"):
                offenders.append(node.get("name", "?"))
    status = "FAILED" if offenders else "PASSED"
    return {
        "rule": "5. Reintentos en llamadas externas",
        "status": status,
        "evidence": offenders,
        "detail": "Nodos HTTP/GraphQL sin retryOnFail" if offenders else "Llamadas externas con retryOnFail configurado",
    }


def check_orphan_nodes(nodes, connections):
    connected = set()
    for source_name, outputs in (connections or {}).items():
        connected.add(source_name)
        for output_group in outputs.values():
            for branch in output_group:
                for target in branch:
                    connected.add(target.get("node"))
    offenders = [
        n.get("name", "?")
        for n in nodes
        if n.get("name") not in connected and n.get("type") not in TRIGGER_TYPES and not n.get("disabled")
    ]
    status = "FAILED" if offenders else "PASSED"
    return {
        "rule": "6. Nodos huerfanos o desconectados",
        "status": status,
        "evidence": offenders,
        "detail": "Nodos sin conexion de entrada ni salida, fuera de triggers" if offenders else "Todos los nodos no-trigger estan conectados",
    }


def check_reachable_trigger(nodes, active):
    if not active:
        return {
            "rule": "7. Workflow activo con trigger alcanzable",
            "status": "PASSED",
            "evidence": None,
            "detail": "Workflow inactivo, regla no aplica",
        }
    has_trigger = any(n.get("type") in TRIGGER_TYPES and not n.get("disabled") for n in nodes)
    status = "PASSED" if has_trigger else "FAILED"
    return {
        "rule": "7. Workflow activo con trigger alcanzable",
        "status": status,
        "evidence": has_trigger,
        "detail": "Al menos un trigger activo" if has_trigger else "Workflow marcado activo sin trigger utilizable",
    }


def audit_workflow(workflow):
    nodes = workflow.get("nodes") or []
    connections = workflow.get("connections") or {}
    checks = [
        check_webhook_auth(nodes),
        check_hardcoded_secrets(nodes),
        check_high_risk_nodes(nodes),
        check_error_workflow(workflow),
        check_retry_on_external_calls(nodes),
        check_orphan_nodes(nodes, connections),
        check_reachable_trigger(nodes, workflow.get("active", False)),
    ]
    return {
        "id": workflow.get("id"),
        "name": workflow.get("name"),
        "active": workflow.get("active", False),
        "checks": checks,
    }


def build_summary(workflows):
    active = sum(1 for wf in workflows if wf.get("active"))
    return {
        "total": len(workflows),
        "active": active,
        "inactive": len(workflows) - active,
    }


def render_native_audit_markdown(n8n_url, native_audit):
    lines = [f"# Auditoria nativa de n8n (POST /audit) — {n8n_url}", ""]
    if not native_audit:
        lines.append("Sin hallazgos: todas las categorias auditadas volvieron limpias.")
        return "\n".join(lines)
    for report_name, report in native_audit.items():
        sections = report.get("sections", [])
        lines.append(f"## {report_name}")
        lines.append("")
        if not sections:
            lines.append("Sin hallazgos.")
            lines.append("")
            continue
        for section in sections:
            locations = section.get("location", [])
            lines.append(f"### {section.get('title')} ({len(locations)} hallazgos)")
            if section.get("description"):
                lines.append(f"> {section['description']}")
            if section.get("recommendation"):
                lines.append(f"> Recomendacion: {section['recommendation']}")
            lines.append("")
            if locations:
                keys = sorted({k for loc in locations for k in loc.keys()})
                lines.append("| " + " | ".join(keys) + " |")
                lines.append("|" + "---|" * len(keys))
                for loc in locations:
                    lines.append("| " + " | ".join(str(loc.get(k, "")) for k in keys) + " |")
            lines.append("")
    return "\n".join(lines)


def render_markdown(report):
    lines = [f"# Auditoria n8n — {report['n8n_url']}", ""]
    summary = report["summary"]
    lines.append(f"Workflows totales: {summary['total']} | activos: {summary['active']} | inactivos: {summary['inactive']}")
    if report.get("export"):
        lines.append(f"Exportados a `{report['export']['dir']}`: {report['export']['files']} archivos.")
    lines.append("")
    if report.get("summary_only"):
        lines.append("| Workflow | ID | Estado | Nodos | Triggers |")
        lines.append("|---|---|---|---|---|")
        for wf in report["workflows"]:
            lines.append(f"| {wf['name']} | `{wf['id']}` | {'activo' if wf['active'] else 'inactivo'} | {wf['node_count']} | {', '.join(wf['trigger_types']) or 'ninguno'} |")
        return "\n".join(lines)
    for wf in report["workflows"]:
        lines.append(f"## {wf['name']} (`{wf['id']}`) — {'activo' if wf['active'] else 'inactivo'}")
        lines.append("")
        lines.append("| Regla | Estado | Detalle |")
        lines.append("|---|---|---|")
        for check in wf["checks"]:
            lines.append(f"| {check['rule']} | [{check['status']}] | {check['detail']} |")
        lines.append("")
    return "\n".join(lines)


def safe_filename(workflow_id, name):
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", (name or "workflow")).strip("-") or "workflow"
    return f"{slug}__{workflow_id}.json"


def export_workflows(workflows, export_dir):
    os.makedirs(export_dir, exist_ok=True)
    written = []
    for wf in workflows:
        path = os.path.join(export_dir, safe_filename(wf.get("id"), wf.get("name")))
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(wf, fh, indent=2, ensure_ascii=False)
        written.append(path)
    return written


def summarize_workflow(workflow):
    nodes = workflow.get("nodes") or []
    return {
        "id": workflow.get("id"),
        "name": workflow.get("name"),
        "active": workflow.get("active", False),
        "node_count": len(nodes),
        "trigger_types": sorted({n.get("type") for n in nodes if n.get("type") in TRIGGER_TYPES and not n.get("disabled")}),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="URL base de n8n, ej: https://n8n.midominio.com")
    parser.add_argument("--api-key", help="API key de n8n. Preferi la variable de entorno N8N_API_KEY.")
    parser.add_argument("--workflow-id", help="Auditar un unico workflow por id")
    parser.add_argument("--all", action="store_true", help="Incluir workflows inactivos (por defecto solo activos)")
    parser.add_argument("--summary", action="store_true", help="Solo inventario (id, nombre, activo, nodos, triggers), sin correr las 7 reglas")
    parser.add_argument("--export-dir", dest="export_dir", help="Descarga cada workflow (JSON completo, tal cual la API) a esta carpeta local")
    parser.add_argument("--native-audit", action="store_true", help="Pide el audit nativo de n8n (POST /audit) en vez de recorrer workflows")
    parser.add_argument("--audit-categories", dest="audit_categories", help=f"Categorias para --native-audit, separadas por coma. Validas: {', '.join(sorted(AUDIT_CATEGORIES))}")
    parser.add_argument("--days-abandoned", dest="days_abandoned", type=int, help="Dias sin ejecutar para considerar un workflow abandonado (solo --native-audit)")
    parser.add_argument("--executions", action="store_true", help="Analiza el historial de ejecuciones (/executions) en vez de auditar definiciones de workflow")
    parser.add_argument("--status", help=f"Filtra ejecuciones por status (solo --executions). Validos: {', '.join(sorted(EXECUTION_STATUSES))}")
    parser.add_argument("--max-executions", type=int, default=500, dest="max_executions", help="Tope de ejecuciones a traer (solo --executions, default 500). Instancias activas pueden tener millones de ejecuciones historicas; esto evita un crawl completo.")
    parser.add_argument("--credentials", action="store_true", help="Inventario de credenciales (metadata, nunca valores) via /credentials, en vez de auditar workflows")
    parser.add_argument("--json", dest="json_out", help="Ruta de salida JSON")
    parser.add_argument("--markdown", dest="md_out", help="Ruta de salida Markdown")
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("N8N_API_KEY")
    if not api_key:
        raise SystemExit("[FAILED] Falta API key: pasa --api-key o define N8N_API_KEY")

    if args.native_audit:
        categories = args.audit_categories.split(",") if args.audit_categories else None
        native_audit = run_native_audit(args.url, api_key, categories=categories, days_abandoned=args.days_abandoned)
        report = {"n8n_url": args.url, "native_audit": native_audit}
        if args.json_out:
            with open(args.json_out, "w", encoding="utf-8") as fh:
                json.dump(report, fh, indent=2, ensure_ascii=False)
        if args.md_out:
            with open(args.md_out, "w", encoding="utf-8") as fh:
                fh.write(render_native_audit_markdown(args.url, native_audit))
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0

    if args.executions:
        executions, truncated = list_executions(
            args.url, api_key, status=args.status, workflow_id=args.workflow_id, max_executions=args.max_executions,
        )
        by_workflow = summarize_executions(executions)
        if args.workflow_id:
            name_map = {args.workflow_id: get_workflow(args.url, api_key, args.workflow_id).get("name")}
        else:
            name_map = {wf["id"]: wf.get("name") for wf in list_workflows(args.url, api_key, only_active=False)}
        for entry in by_workflow:
            entry["workflow_name"] = name_map.get(entry["workflow_id"], "(desconocido)")
        report = {
            "n8n_url": args.url,
            "sampled": len(executions),
            "truncated": truncated,
            "filters": {"status": args.status, "workflow_id": args.workflow_id},
            "by_workflow": by_workflow,
        }
        if args.json_out:
            with open(args.json_out, "w", encoding="utf-8") as fh:
                json.dump(report, fh, indent=2, ensure_ascii=False)
        if args.md_out:
            with open(args.md_out, "w", encoding="utf-8") as fh:
                fh.write(render_executions_markdown(report))
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0

    if args.credentials:
        credentials = list_credentials(args.url, api_key)
        by_type = {}
        for cred in credentials:
            by_type[cred.get("type")] = by_type.get(cred.get("type"), 0) + 1
        report = {
            "n8n_url": args.url,
            "total": len(credentials),
            "by_type": by_type,
            "credentials": [summarize_credential(c) for c in credentials],
        }
        if args.json_out:
            with open(args.json_out, "w", encoding="utf-8") as fh:
                json.dump(report, fh, indent=2, ensure_ascii=False)
        if args.md_out:
            with open(args.md_out, "w", encoding="utf-8") as fh:
                fh.write(render_credentials_markdown(report))
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0

    if args.workflow_id:
        workflows = [get_workflow(args.url, api_key, args.workflow_id)]
    else:
        # La lista ya trae nodes/connections/settings completos: no hace falta
        # un GET adicional por workflow. En instancias con cientos de workflows,
        # ese N+1 es lo que antes causaba timeouts.
        workflows = list_workflows(args.url, api_key, only_active=not args.all)

    exported = export_workflows(workflows, args.export_dir) if args.export_dir else []

    report = {
        "n8n_url": args.url,
        "summary": build_summary(workflows),
        "summary_only": args.summary,
        "export": {"dir": args.export_dir, "files": len(exported)} if args.export_dir else None,
        "workflows": [summarize_workflow(wf) for wf in workflows] if args.summary else [audit_workflow(wf) for wf in workflows],
    }

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2, ensure_ascii=False)
    if args.md_out:
        with open(args.md_out, "w", encoding="utf-8") as fh:
            fh.write(render_markdown(report))

    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
