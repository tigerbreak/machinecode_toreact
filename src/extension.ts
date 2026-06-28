/**
 * VS Code Extension 入口
 *
 * 注册两个命令：
 *   - "Figma Refactor: Start Workflow"  手动选择阶段 + 逐阶段确认
 *   - "Figma Refactor: Auto Debug"       自动全流程调试（无需人工介入）
 */

import * as vscode from 'vscode';
import { WorkflowEngine } from './workflow-engine';

/**
 * 所有可用的阶段定义（用于 UI 选择）
 */
const STAGE_PICK_ITEMS = [
  { label: '0. 项目脚手架', description: '创建目录结构、依赖、路由骨架', key: 'scaffold' },
  { label: '0.5 结构基线 + 联动契约 🏛️🔗', description: '解析 HTML 黄金基准 + 扫描页面间导航', key: 'baseline' },
  { label: '1. 代码审计', description: '扫描代码，生成组件树/路由映射/问题清单', key: 'audit' },
  { label: '2. 结构分解 🛠️ + 🏛️ + 🔗', description: '单页→多页 + 状态治理 + HTML保真 + 联动约束', key: 'decompose' },
  { label: '2.5 联动验证 🔗', description: '验证所有跨页导航契约是否被满足', key: 'verify-linkage' },
  { label: '3. 组件提取 🛠️', description: '识别重复 UI → 提取可复用组件 + 骨架去重', key: 'extract' },
  { label: '4. 样式提取', description: '内联 style → Tailwind 类名 + 设计令牌', key: 'style' },
  { label: '5. TypeScript 增强', description: '添加类型接口、消除 any、discriminated union', key: 'types' },
  { label: '6. 可访问性增强', description: '语义标签 + ARIA + 键盘导航', key: 'a11y' },
  { label: '7. 数据层分离', description: '硬编码数据 → data/hooks/utils', key: 'data' },
  { label: '8. 最终清理', description: '删除死代码、排序 import、统一命名', key: 'polish' },
];

/** 全流程自动调试的默认阶段顺序 */
const AUTO_DEBUG_KEYS = [
  'baseline',       // 0.5 结构基线 + 联动契约
  'audit',          // 1. 代码审计
  'decompose',      // 2. 结构分解
  'verify-linkage', // 2.5 联动验证（断裂自动回退 Stage 2）
  'extract',        // 3. 组件提取
  'style',          // 4. 样式提取
  'types',          // 5. TypeScript 增强
  'a11y',           // 6. 可访问性
  'data',           // 7. 数据层分离
  'polish',         // 8. 最终清理
];

export function activate(context: vscode.ExtensionContext) {
  // ── 命令 1: 手动工作流 ──
  const manualCmd = vscode.commands.registerCommand(
    'figma-refactor.startWorkflow',
    async () => {
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage('请先打开一个项目文件夹');
        return;
      }

      const selected = await vscode.window.showQuickPick(STAGE_PICK_ITEMS, {
        canPickMany: true,
        placeHolder: '选择要运行的阶段（多选，按原顺序执行）',
        ignoreFocusOut: true,
      });

      if (!selected || selected.length === 0) {
        vscode.window.showInformationMessage('未选择任何阶段');
        return;
      }

      const selectedKeys = selected.map((s) => s.key);
      const orderedKeys = STAGE_PICK_ITEMS
        .filter((item) => selectedKeys.includes(item.key))
        .map((item) => item.key);

      const engine = new WorkflowEngine();
      await engine.run(orderedKeys, false);
    },
  );

  // ── 命令 2: 自动调试全流程 ──
  const autoCmd = vscode.commands.registerCommand(
    'figma-refactor.autoDebug',
    async () => {
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage('请先打开一个项目文件夹');
        return;
      }

      const choice = await vscode.window.showInformationMessage(
        '🤖 Auto Debug 将全自动运行以下阶段（无需人工确认）：\n\n' +
        AUTO_DEBUG_KEYS.map(k => {
          const item = STAGE_PICK_ITEMS.find(i => i.key === k);
          return `  ${item?.label || k}`;
        }).join('\n') +
        '\n\n每次 LLM 输出会自动写入文件。' +
        '\n联动验证断裂会自动重试 Stage 2（最多 3 轮）。' +
        '\n\n开始运行？',
        { modal: true },
        '开始 Auto Debug',
        '取消',
      );

      if (choice !== '开始 Auto Debug') return;

      const engine = new WorkflowEngine();
      await engine.run(AUTO_DEBUG_KEYS, true);
    },
  );

  context.subscriptions.push(manualCmd, autoCmd);
}

export function deactivate() {
  // 清理资源（如有必要）
}
