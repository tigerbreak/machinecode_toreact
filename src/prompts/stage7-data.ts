/**
 * Stage 7 Prompt — 数据层分离
 *
 * 将硬编码数据、API 调用逻辑、格式化函数从组件中分离。
 */

import { BASE_SYSTEM_PROMPT } from './base-prompt';

export function buildDataSeparationPrompt(fileContents: string): string {
  return `
${BASE_SYSTEM_PROMPT}

【阶段目标：数据层分离】
将视图组件与数据逻辑分离。

要求：
1. 将组件中的硬编码数据提取到 src/data/ 目录
   - JSON 或 ts 文件，export const
2. 将异步数据获取逻辑提取为 hooks: src/hooks/use<Name>.ts
   - 使用 useReducer + useCallback 替代 useState 管理复杂状态
   - 处理 loading / error / empty / success 四种状态
   - 类型定义使用 AsyncState<T> discriminated union
3. 将数据转换/格式化逻辑提取为 utils: src/utils/<name>.ts
   - 纯函数，无副作用
   - 有完整的类型定义
4. 组件只保留 UI 渲染和事件绑定
5. 为异步操作添加 loading 和 error 状态
6. 数据接口定义放在 src/types/

示例结构：
- src/data/navigation.ts → export const navItems = [...]
- src/hooks/useProducts.ts → useProducts() → { data, isLoading, error }
- src/utils/formatPrice.ts → export function formatPrice(...)
- src/types/product.ts → export interface Product {...}

【源代码】
${fileContents}

【输出】
输出包含 data/*.ts、hooks/*.ts、utils/*.ts、types/*.ts 和更新后的组件文件。
`;
}
