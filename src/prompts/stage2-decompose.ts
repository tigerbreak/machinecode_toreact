/**
 * Stage 2 Prompt — 结构分解（单页 → 多页）
 *
 * 将条件渲染 (useState boolean) 拆分为 React Router 多页结构。
 * 🛠️ 状态增强：跨页 useState 纠缠修复。
 * 🏛️ HTML 保真：保持黄金基准结构。
 * 🔗 联动保真：保证所有页面间导航和参数传递。
 */

import { BASE_SYSTEM_PROMPT } from './base-prompt';

export function buildDecomposePrompt(
  auditJson: string,
  sourceCode: string,
  htmlBaseline?: string,
  linkageConstraints?: string,
): string {
  return `
${BASE_SYSTEM_PROMPT}

${htmlBaseline || ''}

${linkageConstraints || ''}

【阶段目标：结构分解】
将单页条件渲染 (useState boolean) 拆分为 React Router 多页结构。

转换规则：
1. 识别 {showX && ...} 条件块 → 提取为独立页面组件
2. useState 导航状态 → React Router useNavigate()
3. 每个页面组件使用默认导出
4. 路由使用 React.lazy + Suspense

# 🛠️ 状态提升与拆分规则（跨页状态纠缠修复）
必须审计顶层的所有 useState，按以下三种策略分别处理：

1. **简单控制流**（tabs、当前选中的 id、modal 开关等）：
   - 转换为 useSearchParams() 或动态路由参数（如 /detail/:id）
   - 删除原有的 useState，不允许在全局残留

2. **跨页面共享数据**（userInfo、globalSettings、auth 状态等）：
   - 提升为 React Context（创建 src/context/<Name>Context.tsx）
   - Provider 放在 Layout 组件中
   - 各页面通过 useContext 消费

3. **页面私有状态**（仅被一个页面使用的 state）：
   - 直接下推到该页面组件内部
   - 不影响其他页面

# 🏛️ HTML 保真约束
你必须确保：
- 所有交互元素（按钮、输入框、分页控件、表格）在重构后全部保留
- DOM 层级结构（div → table → thead/tbody 等）不得合并或扁平化
- 所有可见文本内容（按钮文字、表头、占位符）不得更改
- 分页控件、筛选栏、表格列数必须与 HTML 基准完全一致

# 🔗 跨页联动约束
你必须确保：
- 页面 A → 页面 B 的导航使用 React Router，不能使用 console.log 或 useState 切换
- 跨页参数使用路由参数（/detail/:id）而非 props 透传
- onBack 回调使用 navigate(-1) 或路由返回
- router.tsx 中必须包含所有页面的路由配置

审计结果：${auditJson}

源代码：${sourceCode}

【输出】
输出包含 pages/*.tsx、context/*.tsx、router.tsx 文件。
`;
}
