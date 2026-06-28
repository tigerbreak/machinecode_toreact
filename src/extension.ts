/**
 * VS Code Extension 入口
 *
 * 注册 "Figma Refactor: Start Workflow" 命令，
 * 让用户选择要运行的阶段后启动 WorkflowEngine。
 */

import * as vscode from 'vscode';
import { WorkflowEngine } from './workflow-engine';

/**
 * 所有可用的阶段定义（用于 UI 选择）
 */
const STAGE_PICK_ITEMS = [
  { label: '0. 项目脚手架', description: '创建目录结构、依赖、路由骨架', key: 'scaffold' },
  { label: '0.5 结构基线 + 联动契约 🏛️🔗', description: '解析 HTML 黄金基准 + 扫描页面间导航（新增）', key: 'baseline' },
  { label: '1. 代码审计', description: '扫描代码，生成组件树/路由映射/问题清单', key: 'audit' },
  { label: '2. 结构分解 🛠️ + 🏛️ + 🔗', description: '单页→多页 + 状态治理 + HTML保真 + 联动约束', key: 'decompose' },
  { label: '2.5 联动验证 🔗', description: '验证所有跨页导航契约是否被满足（新增）', key: 'verify-linkage' },
  { label: '3. 组件提取 🛠️', description: '识别重复 UI → 提取可复用组件 + 骨架去重', key: 'extract' },
  { label: '4. 样式提取', description: '内联 style → Tailwind 类名 + 设计令牌', key: 'style' },
  { label: '5. TypeScript 增强', description: '添加类型接口、消除 any、discriminated union', key: 'types' },
  { label: '6. 可访问性增强', description: '语义标签 + ARIA + 键盘导航', key: 'a11y' },
  { label: '7. 数据层分离', description: '硬编码数据 → data/hooks/utils', key: 'data' },
  { label: '8. 最终清理', description: '删除死代码、排序 import、统一命名', key: 'polish' },
];

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'figma-refactor.startWorkflow',
    async () => {
      // 检查工作区
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage('请先打开一个项目文件夹');
        return;
      }

      // 让用户选择要运行的阶段
      const selected = await vscode.window.showQuickPick(STAGE_PICK_ITEMS, {
        canPickMany: true,
        placeHolder: '选择要运行的阶段（多选，按原顺序执行）',
        ignoreFocusOut: true,
      });

      if (!selected || selected.length === 0) {
        vscode.window.showInformationMessage('未选择任何阶段');
        return;
      }

      // 按原始顺序排序
      const selectedKeys = selected.map((s) => s.key);
      const orderedKeys = STAGE_PICK_ITEMS
        .filter((item) => selectedKeys.includes(item.key))
        .map((item) => item.key);

      // 启动工作流
      const engine = new WorkflowEngine();
      await engine.run(orderedKeys);
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {
  // 清理资源（如有必要）
}
