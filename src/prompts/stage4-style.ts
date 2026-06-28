/**
 * Stage 4 Prompt — 样式提取
 *
 * 将内联 style={{}} 转换为 Tailwind CSS 类名 + 设计令牌。
 * 🛠️ 令牌收敛：颜色模糊匹配 + 间距/圆角平滑。
 */

import { BASE_SYSTEM_PROMPT } from './base-prompt';

export function buildStylePrompt(fileContents: string): string {
  return `
${BASE_SYSTEM_PROMPT}

【阶段目标：样式提取】
将内联 style={{}} 全部替换为 Tailwind CSS 类名，并提取设计令牌。

要求：
1. 识别所有内联 style={{...}} 对象，转换为 Tailwind 类
2. 提取重复的样式值作为设计令牌写入 src/styles/tokens.ts
3. 对于无法用 Tailwind 表达的复杂样式，提取为 CSS Modules (.module.css)
4. 删除所有内联 style={{...}}（保留动态样式除外，如基于 state 的样式）

# 🛠️ 设计令牌收敛规则（已在 Base Prompt 中定义）
本阶段必须严格执行：
- 颜色模糊匹配（#4f46e6 → indigo-600）
- 间距/圆角平滑取整（17px → p-4）
- 严禁生成任意值（禁止 bg-[#4f46e6]）

【源代码】
${fileContents}

【输出】
输出包含 Tailwind 化后的文件 + tokens.ts + 可选的 .module.css。
`;
}
