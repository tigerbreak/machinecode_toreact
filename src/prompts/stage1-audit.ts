/**
 * Stage 1 Prompt — 代码审计
 *
 * 扫描 Figma 代码，生成组件树、路由映射、问题清单。
 */

import { BASE_SYSTEM_PROMPT } from './base-prompt';

export function buildAuditPrompt(fileContents: string): string {
  return `
${BASE_SYSTEM_PROMPT}

【阶段目标：代码审计】
扫描以下 Figma 导出代码，生成完整的审计报告 JSON。

【审计报告格式】
写入 .figma-stage/01-audit/audit.json，格式如下：
{
  "componentTree": { "name": "App", "children": [...] },
  "routeMap": [
    { "path": "/", "component": "LandingPage", "label": "首页" },
    ...
  ],
  "issues": [
    { "severity": "error", "category": "structure", "message": "...", "file": "App.tsx", "line": 45, "suggestion": "..." }
  ],
  "metrics": { "totalLines": 0, "inlineStyles": 0, "anyTypes": 0, "accessibilityDefects": 0 }
}

【代码】
${fileContents}

【输出】
输出包含审计报告 JSON 文件（path 为 .figma-stage/01-audit/audit.json）。
`;
}
