/**
 * Stage 6 Prompt — 可访问性增强
 *
 * 语义化 HTML 标签 + ARIA 属性 + 键盘导航。
 */

import { BASE_SYSTEM_PROMPT } from './base-prompt';

export function buildA11yPrompt(fileContents: string): string {
  return `
${BASE_SYSTEM_PROMPT}

【阶段目标：可访问性增强】
增强以下 React 组件的可访问性 (WCAG 2.1 AA)。

具体规则：
1. div 替换为语义化标签: <nav>, <main>, <header>, <section>, <article>, <aside>, <footer>
2. 所有图片 (<img> 或背景图) 添加 alt 文本
3. 可交互元素添加适当的 ARIA 属性:
   - button: aria-label（如果无文字）
   - tab 模式: role="tablist", role="tab", aria-selected
   - 弹窗: role="dialog", aria-modal, aria-labelledby
   - 错误提示: role="alert", aria-live="polite"
4. 表单字段添加关联 label 或 aria-label
5. 键盘导航:
   - 自定义按钮/链接支持 Enter 和 Space
   - 焦点管理: tabIndex, onKeyDown
6. 颜色对比度: 确保文本/背景对比度 ≥ 4.5:1（用设计令牌检查）
7. 添加 aria-hidden 到装饰性元素
8. 添加 aria-current="page" 到当前导航项

【源代码】
${fileContents}

【输出】
输出语义化 + ARIA 增强后的所有文件。
`;
}
