# Figma Refactor - Repository Knowledge

## Project Overview
VS Code Extension for converting Figma-exported "machine-translated" React code into maintainable multi-page applications. Uses LangGraph state machine + DeepSeek V4 Flash as LLM backend.

## Architecture

```
extension.ts (VS Code UI layer)
  └─ WorkflowEngine (LangGraph adapter)
       └─ LangGraph StateGraph (state machine)
            ├─ Each Stage → Graph Node
            ├─ Conditional edges (retry/skip/abort/auto-heal)
            └─ Built-in checkpointing via Annotation state
       └─ DeepSeekClient (LLM caller)
            └─ OpenAI SDK → api.deepseek.com
```

### Key Files

| File | Purpose |
|------|---------|
| `src/extension.ts` | VS Code command registration (2 commands) |
| `src/workflow-engine.ts` | LangGraph adapter - keeps same extension.ts interface |
| `src/workflow-state.ts` | LangGraph Annotation.Root state definition |
| `src/langgraph-workflow.ts` | StateGraph with all stage nodes + routing |
| `src/llm/deepseek.ts` | DeepSeek V4 Flash client (OpenAI SDK) |
| `src/workflow-types.ts` | Shared type definitions |
| `src/prompts/` | 9 prompt builders (stage0~stage8 + base-prompt) |
| `src/ast-guard.ts` | Syntax checking (esbuild/tsc) |
| `src/html-baseline.ts` | HTML golden baseline extraction |
| `src/linkage-verifier.ts` | Cross-page linkage contract verification |

### Stages (in execution order)
1. `scaffold` - Project scaffolding (dirs, deps, router)
2. `baseline` - HTML structure baseline + linkage contracts (analysis only)
3. `audit` - Code audit (LLM)
4. `decompose` - Single-page to multi-page decomposition (LLM)
5. `verify-linkage` - Verify linkage contracts (analysis only)
6. `extract` - Component extraction (LLM)
7. `style` - Inline style to Tailwind (LLM)
8. `types` - TypeScript enhancement (LLM)
9. `a11y` - Accessibility (LLM)
10. `data` - Data layer separation (LLM)
11. `polish` - Final cleanup (LLM)

## Common Commands

- **Compile**: `npm run compile` (tsc -p ./)
- **Watch**: `npm run watch`
- **Type-check**: `npx tsc --noEmit`

## Configuration

DeepSeek API Key can be set via:
1. Environment variable: `DEEPSEEK_API_KEY`
2. VS Code setting: `figma-refactor.deepseekApiKey`

Model name configurable via: `figma-refactor.deepseekModel` (default: `deepseek-v4-flash`)

## LangGraph Workflow Design

### State Schema
Uses `Annotation.Root` with reducer functions for each field:
- Array fields: unique-append merge
- Object fields: shallow merge
- Simple fields: latest value wins

### Graph Structure
```
START → [first selected stage] → route → [next stage] → ... → finish → END
                                  ↕ (autoHeal on verify-linkage failure)
```

### Auto-heal
When `verify-linkage` detects broken contracts, the graph routes to `autoHeal` node which re-runs Stage 2 (decompose) with autoMode=true, up to `maxHealRetries` (default 3) times.

## Dependencies
- `@langchain/langgraph` - State machine
- `@langchain/core` - LangChain core types
- `openai` - OpenAI-compatible SDK for DeepSeek
