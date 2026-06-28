/**
 * Stage 8 Prompt — 最终清理
 *
 * 删除死代码、排序 imports、统一命名规范。
 */

import { BASE_SYSTEM_PROMPT } from './base-prompt';

export function buildPolishPrompt(fileContents: string): string {
  return `
${BASE_SYSTEM_PROMPT}

【阶段目标：最终清理】
对以下文件执行最终清理。

清理清单：
1. 删除所有被注释掉的代码块（注释中保留 TODO/FIXME/HACK）
2. 删除未使用的 import
3. 删除未使用的变量和函数
4. 统一命名规范: 组件 PascalCase, 工具函数 camelCase, 常量 UPPER_SNAKE_CASE
5. 合并重复的接口/类型
6. 修复 eslint 警告（如果有）
7. 确保每个文件末尾有一个空行
8. 排序 import: 外部库 → 内部模块 → 样式文件
9. 不要改变任何业务逻辑

【源代码】
${fileContents}

【输出】
输出清理后的所有文件。
`;
}
