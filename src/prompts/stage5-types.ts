/**
 * Stage 5 Prompt — TypeScript 增强
 *
 * 为所有组件添加完整的 TypeScript 类型，消除 any。
 */

import { BASE_SYSTEM_PROMPT } from './base-prompt';

export function buildTypesPrompt(fileContents: string): string {
  return `
${BASE_SYSTEM_PROMPT}

【阶段目标：TypeScript 增强】
增强以下文件的 TypeScript 类型安全。

要求：
1. 为所有 props 创建接口，命名如: ButtonProps, CardProps, HomePageProps
2. 确保没有 any 类型 — 都用具体类型替代
3. 为事件处理器添加正确的类型: React.MouseEvent<HTMLButtonElement>
4. 使用 satisfies 关键字确保类型安全
5. 为 API 响应数据定义类型
6. 使用 const 断言 (as const) 给常量
7. 添加泛型约束 (extends) 到通用组件
8. 对于复杂的状态，使用 discriminated union 替代 boolean flag:
   type AsyncState<T> =
     | { status: 'idle' }
     | { status: 'loading' }
     | { status: 'error'; error: string }
     | { status: 'success'; data: T };
9. 导出所有接口 (export interface)

【源代码】
${fileContents}

【输出】
输出类型增强后的所有文件。
`;
}
