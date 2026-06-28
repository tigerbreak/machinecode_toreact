/**
 * Stage 3 Prompt — 组件提取
 *
 * 从页面中识别重复 UI 模式，提取为可复用组件。
 * 🛠️ 骨架去重增强：DOM 结构相同但 style 不同的区块应合并。
 */

import { BASE_SYSTEM_PROMPT } from './base-prompt';

export function buildExtractPrompt(pageFiles: string): string {
  return `
${BASE_SYSTEM_PROMPT}

【阶段目标：组件提取】
分析以下页面文件中的重复 UI 模式，提取为共享组件。

# 🛠️ 骨架去重规则（DOM 结构匹配）
判断两个 UI 区块是否"骨架相同"的条件（满足任一即视为可合并）：

1. **标签结构相同**：div > img + div > h2 + p + button 的嵌套层级一致
2. **类名/样式模式相同**：都用了 flex、grid、grid-cols-*、gap-* 等布局类
3. **props 接口相同**：接受类似的回调或数据参数

例如以下两种卡片虽然颜色不同，但 DOM 结构完全一致，必须合并为同一个 Card 组件，
差异通过 variant/color 等 props 解耦，**严禁产出两个仅颜色不同的组件**（如 Card1, Card2）。

提取规则：
1. 识别重复出现的 UI 模式（≥2 次出现）
2. 每个提取的组件放在 src/components/<ComponentName>.tsx
3. 提取的组件必须：
   - 有完整的 TypeScript 接口定义 props
   - 使用 React.forwardRef（如果适合传递 ref）
   - 支持 className 覆盖（通过 clsx 合并）
   - 包含 displayName
   - 添加 JSDoc 注释说明用途
4. 更新原页面文件，使用新提取的组件替换内联代码

【页面文件】
${pageFiles}

【输出】
输出包含 components/*.tsx 和更新后的 pages/*.tsx。
`;
}
