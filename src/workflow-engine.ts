/**
 * WorkflowEngine — LangGraph 适配器
 *
 * 保持与 extension.ts 相同的接口，内部使用 LangGraph StateGraph + DeepSeek。
 * 核心职责：
 * 1. 提供 VS Code UI 层（日志、Diff 展示、人工确认）
 * 2. 将用户选择传递给 LangGraph 工作流
 * 3. 处理最终状态和错误展示
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { type FileChange, type StageDefinition } from './workflow-types';
import { type WorkflowState } from './workflow-state';
import { runWorkflow, getCompiledWorkflow } from './langgraph-workflow';
import { validateApiKey } from './llm/deepseek';
import { buildHtmlBaseline, formatBaselineConstraint } from './html-baseline';
import { buildLinkageContracts, formatLinkageConstraints } from './linkage-verifier';
import { buildScaffoldPrompt } from './prompts/stage0-scaffold';
import { buildAuditPrompt } from './prompts/stage1-audit';
import { buildDecomposePrompt } from './prompts/stage2-decompose';
import { buildExtractPrompt } from './prompts/stage3-extract';
import { buildStylePrompt } from './prompts/stage4-style';
import { buildTypesPrompt } from './prompts/stage5-types';
import { buildA11yPrompt } from './prompts/stage6-a11y';
import { buildDataSeparationPrompt } from './prompts/stage7-data';
import { buildPolishPrompt } from './prompts/stage8-polish';

// ──────────────────────────────────────────────
// 引擎
// ──────────────────────────────────────────────

export class WorkflowEngine {
  private workspaceRoot: string;
  private outputChannel: vscode.OutputChannel;
  private useLangGraph: boolean = true;

  constructor() {
    this.workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
    this.outputChannel = vscode.window.createOutputChannel('Figma Refactor');
  }

  // ── 日志 ──

  private log(message: string) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    this.outputChannel.show(true);
  }

  // ── 阶段定义（供 extension.ts 和 LangGraph 共享）──

  private getAllStages(): StageDefinition[] {
    const stages: StageDefinition[] = [];
    const root = this.workspaceRoot;

    stages.push({
      key: 'scaffold',
      label: '0. 项目脚手架',
      buildPrompt: async () => {
        const files = this.listProjectFiles();
        return buildScaffoldPrompt(files);
      },
      getOutputFiles: () => ['package.json', 'src/router.tsx'],
    });

    stages.push({
      key: 'baseline',
      label: '0.5 结构基线 + 联动契约 🏛️🔗',
      isAnalysisOnly: true,
      executeAnalysis: async () => {
        this.log('   🏛️ 提取 HTML 结构基线...');
        const baseline = await buildHtmlBaseline(this.workspaceRoot);
        const baselineText = formatBaselineConstraint(baseline);

        this.log('   🔗 扫描联动契约...');
        const contracts = await buildLinkageContracts(this.workspaceRoot);
        const linkageText = formatLinkageConstraints(contracts);

        this.log(`   📊 基线: ${baseline.files.length} 个 HTML 文件`);
        this.log(`   📊 契约: ${contracts.length} 个联动点`);

        const stateDir = path.join(this.workspaceRoot, '.figma-stage', '00-baseline');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'html-baseline-constraint.txt'), baselineText);
        fs.writeFileSync(path.join(stateDir, 'linkage-constraint.txt'), linkageText);
        fs.writeFileSync(path.join(stateDir, 'report.md'), `# 结构基线报告\n\n${baselineText}\n\n${linkageText}`);

        let summary = `🏛️  HTML 基线: ${baseline.files.length} 文件`;
        if (baseline.files.length > 0) {
          for (const f of baseline.files) {
            summary += `\n   📄 ${f.htmlFile}`;
            if (f.matchedJsxFile) summary += ` ↔ ${f.matchedJsxFile}`;
            summary += ` (${f.interactiveElements.length} 交互元素)`;
          }
        }
        if (contracts.length > 0) {
          summary += `\n🔗  联动契约: ${contracts.length} 个`;
          const navCount = contracts.filter(c =>
            ['console.log_drill', 'useNavigate_call', 'onClick_navigate'].includes(c.pattern),
          ).length;
          const callbackCount = contracts.filter(c => c.pattern === 'callback_prop').length;
          summary += ` (${navCount} 导航, ${callbackCount} 回调)`;
        } else {
          summary += '\n🔗  未发现联动契约';
        }
        return { summary };
      },
      buildPrompt: async () => '分析阶段，无需调用 LLM',
      getOutputFiles: () => ['.figma-stage/00-html-baseline/', '.figma-stage/00-linkage/', '.figma-stage/00-baseline/'],
    });

    stages.push({
      key: 'audit',
      label: '1. 代码审计',
      buildPrompt: async () => {
        const sourceCode = this.readSourceFiles();
        return buildAuditPrompt(sourceCode);
      },
      getOutputFiles: () => ['.figma-stage/01-audit/audit.json'],
      persistOutput: (changes) => {
        const auditDir = path.join(root, '.figma-stage', '01-audit');
        fs.mkdirSync(auditDir, { recursive: true });
        for (const c of changes) {
          if (c.filePath.includes('audit.json')) {
            fs.writeFileSync(path.join(auditDir, 'audit.json'), c.content);
          }
        }
      },
    });

    stages.push({
      key: 'decompose',
      label: '2. 结构分解 (单页→多页) 🛠️ + 🏛️ + 🔗',
      buildPrompt: async () => {
        const auditPath = path.join(root, '.figma-stage', '01-audit', 'audit.json');
        const auditJson = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '{}';
        const sourceCode = this.readSourceFiles();

        let htmlBaseline = '';
        let linkageConstraints = '';
        const baselinePath = path.join(root, '.figma-stage', '00-baseline', 'html-baseline-constraint.txt');
        const linkagePath = path.join(root, '.figma-stage', '00-baseline', 'linkage-constraint.txt');
        if (fs.existsSync(baselinePath)) htmlBaseline = fs.readFileSync(baselinePath, 'utf-8');
        if (fs.existsSync(linkagePath)) linkageConstraints = fs.readFileSync(linkagePath, 'utf-8');

        return buildDecomposePrompt(auditJson, sourceCode, htmlBaseline, linkageConstraints);
      },
      getOutputFiles: () => ['src/pages/', 'src/router.tsx', 'src/context/'],
    });

    stages.push({
      key: 'verify-linkage',
      label: '2.5 联动验证 🔗',
      isAnalysisOnly: true,
      executeAnalysis: async () => {
        this.log('   🔗 验证跨页联动契约...');
        const contractsPath = path.join(root, '.figma-stage', '00-linkage', 'contracts-before.json');
        if (!fs.existsSync(contractsPath)) {
          return { summary: '未找到联动契约文件（contracts-before.json），跳过验证。' };
        }

        const { verifyLinkageContracts } = require('./linkage-verifier');
        const contractsBefore = JSON.parse(fs.readFileSync(contractsPath, 'utf-8'));
        const report = await verifyLinkageContracts(root, contractsBefore);

        let summary = `# 🔗 跨页联动验证报告\n\n`;
        summary += `| 指标 | 数值 |\n|------|------|\n`;
        summary += `| 总契约数 | ${report.summary.total} |\n`;
        summary += `| ✅ 已验证通过 | ${report.summary.verified} |\n`;
        summary += `| ❌ 已断裂 | ${report.summary.broken} |\n\n`;

        if (report.brokenContracts.length > 0) {
          summary += `\n⚠️ 存在 ${report.brokenContracts.length} 个断裂的联动契约。`;
        } else if (report.summary.total > 0) {
          summary += `\n✅ 所有 ${report.summary.total} 个联动契约均已满足。\n`;
        }

        const reportDir = path.join(root, '.figma-stage', '00-linkage');
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(path.join(reportDir, 'verification-report.md'), summary);

        this.log(`   🔗 验证完成: ${report.summary.verified}/${report.summary.total} 通过`);
        if (report.brokenContracts.length > 0) {
          vscode.window.showWarningMessage(`⚠️ ${report.brokenContracts.length} 个联动契约断裂。建议重试 Stage 2。`, '知道了');
        }
        return { summary };
      },
      buildPrompt: async () => '分析阶段，无需调用 LLM',
      getOutputFiles: () => ['.figma-stage/00-linkage/report.json', '.figma-stage/00-linkage/verification-report.md'],
    });

    stages.push({
      key: 'extract',
      label: '3. 组件提取 🛠️',
      buildPrompt: async () => {
        const pageFiles = this.readGlob('src/pages/**/*.tsx');
        return buildExtractPrompt(pageFiles);
      },
      getOutputFiles: () => ['src/components/', 'src/pages/'],
    });

    stages.push({
      key: 'style',
      label: '4. 样式提取 (内联→Tailwind)',
      buildPrompt: async () => {
        const allCode = this.readGlob('src/**/*.tsx');
        return buildStylePrompt(allCode);
      },
      getOutputFiles: () => ['src/styles/', 'src/**/*.tsx'],
    });

    stages.push({
      key: 'types',
      label: '5. TypeScript 增强',
      buildPrompt: async () => {
        const allCode = this.readGlob('src/**/*.{ts,tsx}');
        return buildTypesPrompt(allCode);
      },
      getOutputFiles: () => ['src/**/*.{ts,tsx}'],
    });

    stages.push({
      key: 'a11y',
      label: '6. 可访问性增强',
      buildPrompt: async () => {
        const allCode = this.readGlob('src/**/*.tsx');
        return buildA11yPrompt(allCode);
      },
      getOutputFiles: () => ['src/**/*.tsx'],
    });

    stages.push({
      key: 'data',
      label: '7. 数据层分离',
      buildPrompt: async () => {
        const allCode = this.readGlob('src/**/*.tsx');
        return buildDataSeparationPrompt(allCode);
      },
      getOutputFiles: () => ['src/data/', 'src/hooks/', 'src/utils/', 'src/types/'],
    });

    stages.push({
      key: 'polish',
      label: '8. 最终清理',
      buildPrompt: async () => {
        const allCode = this.readGlob('src/**/*.{ts,tsx}');
        return buildPolishPrompt(allCode);
      },
      getOutputFiles: () => ['src/**/*.{ts,tsx}'],
    });

    return stages;
  }

  // ── 辅助 ──

  private listProjectFiles(): string[] {
    const files: string[] = [];
    const walkDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== '.git') {
              walkDir(fullPath);
            }
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx') || entry.name.endsWith('.json')) {
            files.push(path.relative(this.workspaceRoot, fullPath));
          }
        }
      } catch { /* skip */ }
    };
    walkDir(this.workspaceRoot);
    return files;
  }

  private readSourceFiles(): string {
    const files = this.listProjectFiles();
    return files.map((file) => {
      try {
        return `// --- ${file} ---\n${fs.readFileSync(path.join(this.workspaceRoot, file), 'utf-8')}`;
      } catch { return ''; }
    }).join('\n\n');
  }

  private readGlob(pattern: string): string {
    let files: string[];
    try {
      const result = require('child_process').execSync(
        `find ${this.workspaceRoot}/src -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.jsx" \\) 2>/dev/null`,
        { encoding: 'utf-8' },
      );
      files = result.split('\n').filter(Boolean).map((f: string) => path.relative(this.workspaceRoot, f.trim()));
    } catch {
      files = [];
    }
    return files.map((file) => {
      try {
        return `// --- ${file} ---\n${fs.readFileSync(path.join(this.workspaceRoot, file), 'utf-8')}`;
      } catch { return ''; }
    }).join('\n\n');
  }

  // ── 变更确认 ──

  private async confirmChanges(
    stageName: string,
    changes: FileChange[],
  ): Promise<'continue' | 'skip' | 'abort' | 'retry'> {
    if (changes.length === 0) {
      this.log(`⚠️  ${stageName}: 没有变更`);
      return 'continue';
    }

    this.log(`\n📋 === ${stageName} ===`);
    this.log(`   ${changes.length} 个文件待变更:`);

    const summaryItems = changes.map((c) => ({
      label: c.filePath,
      description: `${c.content.length} 字符`,
    }));

    await vscode.window.showQuickPick(summaryItems, {
      placeHolder: `📋 阶段 "${stageName}" — ${changes.length} 个文件待变更`,
    });

    // 展示第一个文件的 diff
    for (const change of changes.slice(0, 2)) {
      const uri = vscode.Uri.file(path.join(this.workspaceRoot, change.filePath));
      let existingContent = '';
      try {
        existingContent = fs.readFileSync(uri.fsPath, 'utf-8');
      } catch { /* 新文件 */ }

      const originalDoc = await vscode.workspace.openTextDocument({ content: existingContent });
      const modifiedDoc = await vscode.workspace.openTextDocument({ content: change.content });
      await vscode.window.showTextDocument(originalDoc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
      await vscode.window.showTextDocument(modifiedDoc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
    }

    const choice = await vscode.window.showQuickPick(
      ['继续', '跳过', '中止', '重试'],
      { placeHolder: `阶段 "${stageName}" — 确认应用这些变更?` },
    );

    switch (choice) {
      case '继续': return 'continue';
      case '跳过': return 'skip';
      case '重试': return 'retry';
      default: return 'abort';
    }
  }

  // ── 入口 ──

  async run(selectedKeys: string[], autoMode: boolean = false): Promise<void> {
    this.log('╔════════════════════════════════════════╗');
    this.log('║  Figma 机翻代码 → 可维护 React UI   ║');
    this.log('║    LangGraph + DeepSeek 工作流引擎   ║');
    this.log(`║     Mode: ${autoMode ? '🤖 AUTO' : '👤 MANUAL'}                      ║`);
    this.log('╚════════════════════════════════════════╝\n');

    // 验证 DeepSeek API Key
    const isKeyValid = await validateApiKey();
    if (!isKeyValid) {
      const configKey = process.env.DEEPSEEK_API_KEY ||
        vscode.workspace.getConfiguration('figma-refactor').get('deepseekApiKey', '');
      if (!configKey) {
        const setKey = await vscode.window.showErrorMessage(
          '❌ 未设置 DeepSeek API Key。请在 VS Code 设置中配置 "figma-refactor.deepseekApiKey"，或设置环境变量 DEEPSEEK_API_KEY。',
          { modal: true },
          '打开设置',
          '取消',
        );
        if (setKey === '打开设置') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'figma-refactor.deepseekApiKey');
        }
        return;
      }
      // API Key 存在但验证失败
      this.log('⚠️  DeepSeek API Key 验证失败，将尝试继续...');
    } else {
      this.log('✅ DeepSeek API Key 验证通过');
    }

    const allStages = this.getAllStages();
    const selectedStages = allStages.filter((s) => selectedKeys.includes(s.key));

    if (selectedStages.length === 0) {
      this.log('❌ 未选择任何阶段');
      return;
    }

    this.log(`📋 计划执行 ${selectedStages.length} 个阶段:`);
    selectedStages.forEach((s) => this.log(`   ${s.label}`));

    try {
      // 使用 LangGraph 执行工作流
      const finalState = await runWorkflow(
        selectedKeys,
        allStages,
        autoMode,
        this.workspaceRoot,
      );

      // 输出结果
      this.log('\n🎉 工作流执行完毕！');
      this.log(`   ✅ 完成: ${finalState.completedStages.length} 个阶段`);
      this.log(`   ⏭️  跳过: ${finalState.skippedStages.length} 个阶段`);
      this.log(`   ❌ 失败: ${finalState.failedStages.length} 个阶段`);

      if (finalState.error) {
        this.log(`   ⚠️  错误: ${finalState.error}`);
      }

      // Manual 模式：检查是否有暂存的变更需要确认
      if (!autoMode) {
        await this.processPendingChanges(selectedStages);
      }

      const message = autoMode
        ? '🤖 Auto Debug 完成！请检查 .figma-stage/ 目录下的报告文件。'
        : 'Figma Refactor 工作流完成！运行 npm install && npm run dev 启动。';
      vscode.window.showInformationMessage(message);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`❌ 工作流出错: ${msg}`);
      vscode.window.showErrorMessage(`Figma Refactor 工作流出错: ${msg}`);
    }
  }

  /**
   * Manual 模式下处理暂存的变更（供用户确认）
   */
  private async processPendingChanges(selectedStages: StageDefinition[]): Promise<void> {
    const pendingDir = path.join(this.workspaceRoot, '.figma-stage', 'pending');
    if (!fs.existsSync(pendingDir)) return;

    const pendingFiles = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
    if (pendingFiles.length === 0) return;

    this.log(`\n📋 发现 ${pendingFiles.length} 个阶段的暂存变更待确认:`);

    for (const pendingFile of pendingFiles) {
      const stageKey = pendingFile.replace('.json', '');
      const stage = selectedStages.find(s => s.key === stageKey);
      if (!stage) continue;

      const changes: FileChange[] = JSON.parse(
        fs.readFileSync(path.join(pendingDir, pendingFile), 'utf-8'),
      );

      const decision = await this.confirmChanges(stage.label, changes);
      if (decision === 'continue') {
        this.applyChanges(changes);
        if (stage.persistOutput) stage.persistOutput(changes);
        this.log(`✅ ${stage.label} 已确认并写入`);
      } else if (decision === 'skip') {
        this.log(`⏭️  ${stage.label} 已跳过`);
      } else if (decision === 'abort') {
        this.log('🛑 用户中止');
        break;
      }
      // 'retry' would need to re-run the stage, which is complex with LangGraph
      // For now, retry means skip in manual mode
    }

    // 清理暂存
    fs.rmSync(pendingDir, { recursive: true, force: true });
  }

  // ── 应用变更 ──

  private applyChanges(changes: FileChange[]): void {
    for (const change of changes) {
      const fullPath = path.join(this.workspaceRoot, change.filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      if (fs.existsSync(fullPath)) {
        const backupPath = fullPath + '.bak';
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(fullPath, backupPath);
          this.log(`  💾 备份: ${change.filePath}.bak`);
        }
      }
      fs.writeFileSync(fullPath, change.content, 'utf-8');
      this.log(`  ✅ 写入: ${change.filePath}`);
    }
  }
}
