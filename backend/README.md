# Figma Refactor Backend

FastAPI server that provides a web API for running the LangGraph workflow pipeline.

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Start (API on :8000, frontend on root)
DEEPSEEK_API_KEY=sk-your-key python3 main.py
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stages` | List available pipeline stages |
| POST | `/api/runs` | Start a new workflow run |
| GET | `/api/runs` | List runs |
| GET | `/api/runs/{id}` | Get run status & results |
| GET | `/api/runs/{id}/files` | List generated files |
| GET | `/api/runs/{id}/file?path=...` | Get file content |
| GET | `/api/runs/{id}/logs` | Get run logs |

If `frontend/dist/` exists, it's served at `/`.
Run the React frontend in dev mode with `npm run dev` from `frontend/`.
