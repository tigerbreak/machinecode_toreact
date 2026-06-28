#!/usr/bin/env bash
# Start the Figma Refactor Web UI
# Usage: ./scripts/start-webui.sh [port]

set -e
cd "$(dirname "$0")/.."

PORT="${1:-8000}"
API_KEY="${DEEPSEEK_API_KEY:-}"

if [ -z "$API_KEY" ]; then
  echo "⚠️  DEEPSEEK_API_KEY not set. LLM stages (audit, decompose) will fail."
  echo "   Set it with: export DEEPSEEK_API_KEY=sk-..."
  echo ""
fi

# Build frontend if not already built
if [ ! -d "frontend/dist" ]; then
  echo "📦 Building frontend..."
  cd frontend && npm install && npx vite build && cd ..
fi

echo "🚀 Starting server on port $PORT..."
echo "   API:    http://localhost:$PORT/api/stages"
echo "   UI:     http://localhost:$PORT/"
echo ""
DEEPSEEK_API_KEY="$API_KEY" python3 -m uvicorn backend.main:app --host 0.0.0.0 --port "$PORT"
