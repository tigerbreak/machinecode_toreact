/**
 * Stage 0 Prompt — 项目脚手架
 *
 * 确保目标项目目录结构、依赖、路由骨架就绪。
 */

import { BASE_SYSTEM_PROMPT } from './base-prompt';

export function buildScaffoldPrompt(projectFiles: string[]): string {
  return `
${BASE_SYSTEM_PROMPT}

【阶段目标：项目脚手架】
你需要确保目标项目目录结构就绪：
src/pages/ src/components/ src/hooks/ src/utils/ src/data/ src/types/ src/styles/ src/context/

检查 package.json，如有必要补充以下依赖：
- react, react-dom (React 19)
- react-router-dom
- tailwindcss, postcss, autoprefixer
- typescript, @types/react, @types/react-dom
- vite, @vitejs/plugin-react

创建路由骨架 src/router.tsx（使用 lazy() + Suspense + Outlet）。

【输入】
当前项目已有文件列表：${projectFiles.join(', ')}

【输出】
输出包含需要创建/更新的所有文件。
`;
}
