"""
FastAPI Backend — LangGraph Workflow Manager

Provides a REST API to run the LangGraph pipeline from a web frontend.
Calls Node.js runner.mjs via subprocess for each workflow execution.
"""

import os
import json
import uuid
import asyncio
import subprocess
import shutil
from pathlib import Path
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel

# ── Config ───────────────────────────────────────────────────────
PROJECT_ROOT = Path(os.environ.get("PROJECT_ROOT", "/workspace/project/machinecode_toreact"))
RUNS_DIR = PROJECT_ROOT / ".runs"
FIXTURES_DIR = PROJECT_ROOT / "test-fixtures"
RUNNER_SCRIPT = PROJECT_ROOT / "backend" / "runner.mjs"
PREVIEW_BUILDER = PROJECT_ROOT / "backend" / "preview-builder.mjs"

RUNS_DIR.mkdir(exist_ok=True)

# ── App ──────────────────────────────────────────────────────────
app = FastAPI(
    title="Figma Refactor — LangGraph Workflow",
    version="0.2.0",
    description="Web UI for the Figma-to-React multi-page refactoring pipeline",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ───────────────────────────────────────────────────────

class PageInput(BaseModel):
    name: str
    htmlContent: str
    jsxContent: str
    linkageGroup: str = "default"

class WorkspaceRequest(BaseModel):
    pages: list[PageInput]

class RunRequest(BaseModel):
    selected_stages: list[str]
    api_key: Optional[str] = None
    workspace: Optional[str] = None

class RunStatus(BaseModel):
    id: str
    status: str  # pending | running | complete | error
    stages: list[dict]
    created_at: str
    workspace: str
    results: Optional[dict] = None
    logs: list[str] = []

# ── Stage Registry ───────────────────────────────────────────────

STAGES = [
    {"key": "baseline",   "label": "HTML 结构基线",  "analysis_only": True,  "description": "扫描 HTML 文件的 DOM 结构，提取交互元素"},
    {"key": "linkage",    "label": "联动契约",       "analysis_only": True,  "description": "建立跨页联动契约（导航、回调、参数）"},
    {"key": "audit",      "label": "代码审计",       "analysis_only": False, "description": "DeepSeek 审计代码质量、类型安全、运行时风险"},
    {"key": "decompose",  "label": "结构分解",       "analysis_only": False, "description": "单页 → React Router 多页结构分解（核心）"},
    {"key": "verify",     "label": "联动验证",       "analysis_only": True,  "description": "重构后验证所有联动契约是否仍被满足"},
]

STAGE_KEYS = [s["key"] for s in STAGES]
# Default order: baseline → linkage → audit → decompose → verify
DEFAULT_ORDER = ["baseline", "linkage", "audit", "decompose", "verify"]

# ── In-memory run state ──────────────────────────────────────────
_runs: dict[str, RunStatus] = {}

# ── API ───────────────────────────────────────────────────────────

@app.get("/api/stages")
def list_stages():
    """List all available pipeline stages."""
    return STAGES


@app.post("/api/workspaces", status_code=201)
def create_workspace(req: WorkspaceRequest):
    """Create a workspace from submitted page inputs (HTML + JSX + linkage groups)."""
    if not req.pages:
        raise HTTPException(400, "At least one page is required")

    ws_id = uuid.uuid4().hex[:12]
    ws_dir = RUNS_DIR / ws_id
    ws_dir.mkdir(parents=True)
    src_dir = ws_dir / "src"
    src_dir.mkdir(exist_ok=True)

    # Linkage group config
    linkage_config: dict[str, list[str]] = {}

    for i, page in enumerate(req.pages):
        # Validate
        name = page.name or f"page_{i+1}"
        safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
        if not safe_name:
            safe_name = f"page_{i+1}"

        # Save HTML
        html_path = ws_dir / f"{safe_name}.html"
        html_path.write_text(page.htmlContent, encoding="utf-8")

        # Save JSX
        jsx_path = src_dir / f"{safe_name}.jsx"
        jsx_path.write_text(page.jsxContent, encoding="utf-8")

        # Track linkage group
        group = page.linkageGroup or "default"
        if group not in linkage_config:
            linkage_config[group] = []
        linkage_config[group].append(safe_name)

    # Write linkage config
    linkage_file = ws_dir / ".figma-linkage.json"
    linkage_file.write_text(json.dumps(linkage_config, ensure_ascii=False, indent=2), encoding="utf-8")

    # Ensure package.json exists
    if not (ws_dir / "package.json").exists():
        (ws_dir / "package.json").write_text('{"name":"workflow-workspace","private":true}')

    return {"id": ws_id, "path": str(ws_dir), "pages": len(req.pages), "groups": list(linkage_config.keys())}


@app.get("/api/runs")
def list_runs():
    """List all runs."""
    return [
        {"id": rid, "status": r.status, "stages": r.stages,
         "created_at": r.created_at}
        for rid, r in sorted(_runs.items(), reverse=True)[:50]
    ]


@app.post("/api/runs", status_code=201)
async def create_run(req: RunRequest):
    """Start a new workflow run."""
    # Validate stages
    invalid = [s for s in req.selected_stages if s not in STAGE_KEYS]
    if invalid:
        raise HTTPException(400, f"Invalid stages: {invalid}")

    # Create run directory
    run_id = uuid.uuid4().hex[:12]
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True)

    # Prepare workspace
    if req.workspace:
        workspace = req.workspace
    else:
        workspace = str(run_dir / "workspace")
        ws_path = Path(workspace)
        ws_path.mkdir(parents=True, exist_ok=True)
        (ws_path / "src").mkdir(exist_ok=True)

        # Copy test fixtures as default input
        if FIXTURES_DIR.exists():
            for f in FIXTURES_DIR.glob("*.html"):
                shutil.copy(f, ws_path / f.name)
            for f in FIXTURES_DIR.glob("*.jsx"):
                shutil.copy(f, ws_path / "src" / f.name)
        (ws_path / "package.json").write_text('{"name":"workflow-run","private":true}')

    # Create run record
    now = datetime.utcnow().isoformat()
    run = RunStatus(
        id=run_id,
        status="running",
        stages=[{"key": k, "status": "pending"}
                for k in DEFAULT_ORDER if k in req.selected_stages],
        created_at=now,
        workspace=workspace,
        results=None,
        logs=[f"Run {run_id} started at {now}"],
    )
    _runs[run_id] = run

    # Schedule execution in background
    asyncio.create_task(_execute_run(run_id, req))

    return {"id": run_id, "status": "running"}


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    """Get run status and results."""
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return run.dict()


@app.get("/api/runs/{run_id}/files")
def list_files(run_id: str):
    """List generated files in the workspace."""
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")

    ws = Path(run.workspace)
    if not ws.exists():
        return {"files": []}

    files = []
    # Source files
    src_dir = ws / "src"
    if src_dir.exists():
        for f in sorted(src_dir.rglob("*")):
            if f.is_file() and f.name != "package.json":
                rel = f.relative_to(ws)
                files.append({
                    "path": str(rel),
                    "size": f.stat().st_size,
                    "lines": len(f.read_text().splitlines()) if f.suffix in
                             (".ts", ".tsx", ".jsx", ".js", ".json", ".html") else 0,
                    "type": "source",
                })

    # Generated artifacts
    stage_dir = ws / ".figma-stage"
    if stage_dir.exists():
        for f in sorted(stage_dir.rglob("*")):
            if f.is_file():
                rel = f.relative_to(ws)
                files.append({
                    "path": str(rel),
                    "size": f.stat().st_size,
                    "type": "artifact",
                })

    return {"files": files}


@app.get("/api/runs/{run_id}/file")
def get_file(run_id: str, path: str = Query(...)):
    """Get file content."""
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")

    file_path = Path(run.workspace) / path
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, f"File not found: {path}")

    return FileResponse(str(file_path))


@app.get("/api/runs/{run_id}/logs")
def get_logs(run_id: str):
    """Get run logs."""
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return {"logs": run.logs}


# ── Preview & Page Data Endpoints ─────────────────────────────

@app.get("/api/runs/{run_id}/pages")
def get_run_pages(run_id: str):
    """Get per-page data with preview info for a completed run."""
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")

    preview_dir = Path(run.workspace) / ".figma-stage" / "preview"
    pages_file = preview_dir / "pages.json"
    if not pages_file.exists():
        return {"pages": [], "note": "No preview data available (run may not have decompose stage or preview not built)"}

    return json.loads(pages_file.read_text())


@app.get("/api/runs/{run_id}/preview/{subpath:path}")
def serve_preview(run_id: str, subpath: str):
    """Serve preview files (HTML previews, the React app, etc.)"""
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")

    preview_dir = Path(run.workspace) / ".figma-stage" / "preview"
    if not preview_dir.exists():
        raise HTTPException(404, "No preview built")

    if not subpath or subpath == "":
        subpath = "app.html"

    file_path = preview_dir / subpath
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, f"Preview file not found: {subpath}")

    return FileResponse(str(file_path))


@app.get("/api/runs/{run_id}/linkage")
def get_linkage(run_id: str):
    """Get linkage relationship data between pages."""
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(404, "Run not found")

    ws = Path(run.workspace)

    # Linkage config
    linkage_file = ws / ".figma-linkage.json"
    linkage_config = {}
    if linkage_file.exists():
        linkage_config = json.loads(linkage_file.read_text())

    # Contracts
    contracts_file = ws / ".figma-stage" / "00-linkage" / "contracts-before.json"
    contracts = []
    if contracts_file.exists():
        contracts = json.loads(contracts_file.read_text())

    # Verification report
    verify_file = ws / ".figma-stage" / "00-linkage" / "verification-report.json"
    verification = {}
    if verify_file.exists():
        verification = json.loads(verify_file.read_text())

    # Build linkage graph
    groups = []
    for group_name, page_names in linkage_config.items():
        group_contracts = [c for c in contracts
                          if c.get("sourceComponent", "").lower() in
                          [n.lower() for n in page_names] or
                          c.get("targetComponent", "").lower() in
                          [n.lower() for n in page_names]]
        groups.append({
            "name": group_name,
            "pages": page_names,
            "contracts": [{
                "pattern": c.get("pattern", ""),
                "source": c.get("sourceComponent", ""),
                "target": c.get("targetComponent", ""),
                "snippet": (c.get("originalSnippet", "") or "")[:100],
            } for c in group_contracts],
        })

    return {
        "groups": groups,
        "contracts": contracts,
        "verification": verification,
    }


# ── Background Runner ────────────────────────────────────────────

async def _execute_run(run_id: str, req: RunRequest):
    """Execute the workflow in a background task."""
    run = _runs[run_id]

    try:
        # Prepare runner config
        config = {
            "workspace": run.workspace,
            "selectedKeys": req.selected_stages,
            "apiKey": req.api_key or os.environ.get("DEEPSEEK_API_KEY", ""),
            "autoMode": True,
        }

        # Update stage statuses
        for stage in run.stages:
            if stage["key"] in req.selected_stages:
                stage["status"] = "running"

        run.logs.append("Spawning Node.js runner...")

        # Spawn Node.js subprocess
        env = os.environ.copy()
        if req.api_key:
            env["DEEPSEEK_API_KEY"] = req.api_key
        env["PROJECT_ROOT"] = str(PROJECT_ROOT)

        proc = await asyncio.create_subprocess_exec(
            "node", str(RUNNER_SCRIPT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
            env=env,
        )

        # Send config
        stdout, stderr = await proc.communicate(
            json.dumps(config).encode()
        )

        # Parse NDJSON output
        stage_results = {}
        logs = []
        stderr_text = stderr.decode() if stderr else ""

        for line in stdout.decode().splitlines():
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
                if msg["type"] == "log":
                    run.logs.append(msg["message"])
                elif msg["type"] == "stage":
                    for stage in run.stages:
                        if stage["key"] == msg["key"]:
                            stage["status"] = msg["status"]
                            if msg["status"] == "ok":
                                stage["summary"] = msg.get("summary", "")
                            elif msg["status"] == "error":
                                stage["error"] = msg.get("error", "")
                elif msg["type"] == "results":
                    run.results = msg["results"]
            except json.JSONDecodeError:
                pass

        if stderr_text:
            run.logs.append(f"STDERR: {stderr_text[:500]}")

        if proc.returncode == 0:
            run.status = "complete"
            run.logs.append("✅ Workflow complete")
            # Build preview after successful run
            try:
                run.logs.append("Building preview...")
                preview_proc = await asyncio.create_subprocess_exec(
                    "node", str(PREVIEW_BUILDER), run.workspace,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                p_out, p_err = await preview_proc.communicate()
                if preview_proc.returncode == 0:
                    run.logs.append("✅ Preview built")
                else:
                    run.logs.append(f"⚠️ Preview build warning: {p_err.decode()[:200]}")
            except Exception as pe:
                run.logs.append(f"⚠️ Preview build error: {str(pe)[:100]}")
        else:
            run.status = "error"
            run.logs.append(f"❌ Process exited with code {proc.returncode}")

    except Exception as e:
        run.status = "error"
        run.logs.append(f"❌ Error: {str(e)}")


# ── Serve Frontend ───────────────────────────────────────────────

FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")


# ── Main ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
