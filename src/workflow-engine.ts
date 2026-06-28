/**
 * WorkflowEngine — 多阶段 Prompt 编排引擎
 *
 * 核心职责：
 * 1. 组装 Prompt → 调用 vscode.lm.sendChatRequest() (Gemini)
 * 2. 解析 JSON 输出 → 展示 diff → 人工确认
 * 3. 状态管理 + 失败恢复
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { checkSyntaxOrRaise, showSyntaxErrors } from './ast-guard';
import { buildHtmlBaseline, loadHtmlBaseline, formatBaselineConstraint } from './html-baseline';
import { buildLinkageContracts, verifyLinkageContracts, formatLinkageConstraints } from './linkage-verifier';
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
// 类型定义
// ──────────────────────────────────────────────

interface FileChange {
  filePath: string;
  content: string;
}

interface StageDefinition {
  key: string;
  label: string;
  buildPrompt: () => Promise<string>;
  /** 此阶段是纯分析（本地计算，不调用 LLM） */
  isAnalysisOnly?: boolean;
  /** 分析阶段的执行函数（直接返回变更，不走 LLM + JSON 解析） */
  executeAnalysis?: () => Promise<{ files?: FileChange[]; summary?: string }>;
  /** 此阶段输出文件列表用于 AST 检查 */
  getOutputFiles: () => string[];
  /** 写入本阶段产物到 .figma-stage/ */
  persistOutput?: (changes: FileChange[]) => void;
}

interface WorkflowState {
  currentStage: number;
  status: 'running' | 'done' | 'abort';
  completedStages: number[];
  skippedStages: number[];
  failedStages: number[];
  selectedKeys: string[];
  workspaceRoot: string;
}

// ──────────────────────────────────────────────
// 引擎
// ──────────────────────────────────────────────

export class WorkflowEngine {
  private workspaceRoot: string;
  private outputChannel: vscode.OutputChannel;
  private model: vscode.LanguageModelChat | null = null;
  private state: WorkflowState;

  constructor() {
    this.workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
    this.outputChannel = vscode.window.createOutputChannel('Figma Refactor');
    this.state = this.loadState();
  }

  // ── 日志 ──

  private log(message: string) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    this.outputChannel.show(true);
  }

  // ── 状态持久化 ──

  private statePath(): string {
    return path.join(this.workspaceRoot, '.figma-stage', 'state.json');
  }

  private loadState(): WorkflowState {
    try {
      return JSON.parse(fs.readFileSync(this.statePath(), 'utf-8'));
    } catch {
      return {
        currentStage: 0,
        status: 'running',
        completedStages: [],
        skippedStages: [],
        failedStages: [],
        selectedKeys: [],
        workspaceRoot: this.workspaceRoot,
      };
    }
  }

  private saveState(): void {
    const dir = path.dirname(this.statePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.statePath(), JSON.stringify(this.state, null, 2));
  }

  // ── 模型初始化 ──

  private async initModel(): Promise<void> {
    if (this.model) return;

    this.log('🔌 初始化语言模型 (优先 Gemini)...');

    // 优先选择 Gemini 模型（用户指定）
    const geminiModels = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: 'gemini-2.0-flash',
    });

    if (geminiModels.length > 0) {
      this.model = geminiModels[0];
      this.log(`✅ 已选择 Gemini 模型: ${this.model.id}`);
      return;
    }

    // 第一回退：其他 Gemini 变体
    const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const geminiFallback = allModels.filter((m) =>
      m.id.toLowerCase().includes('gemini'),
    );
    if (geminiFallback.length > 0) {
      this.model = geminiFallback[0];
      this.log(`⚠️ 使用回退 Gemini 模型: ${this.model.id}`);
      return;
    }

    // 第二回退：任意可用模型
    if (allModels.length > 0) {
      this.model = allModels[0];
      this.log(`⚠️ 使用任意可用模型: ${this.model.id}`);
      return;
    }

    throw new Error('❌ 没有可用的语言模型。请确认 Copilot 已登录。');
  }

  // ── LLM 调用 ──

  private async callLm(prompt: string): Promise<string> {
    await this.initModel();

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(prompt),
    ];

    this.log(`📤 发送请求到 ${this.model!.id} (${prompt.slice(0, 60)}...)`);

    const response = await this.model!.sendRequest(messages);

    let result = '';
    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        result += chunk.value;
      }
    }

    this.log(`📥 收到响应 (${result.length} 字符)`);
    return result;
  }

  // ── JSON 解析 ──

  private extractJson(text: string): any {
    // 尝试从 ```json ... ``` 中提取
    const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return JSON.parse(jsonBlockMatch[1]);
    }
    // 尝试从 ``` ... ``` 中提取
    const codeBlockMatch = text.match(/```\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1]);
      } catch {
        // 不是 JSON 代码块，继续
      }
    }
    // 直接尝试解析
    return JSON.parse(text);
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
      // 最多展示 2 个文件 diff
      const uri = vscode.Uri.file(
        path.join(this.workspaceRoot, change.filePath),
      );
      let existingContent = '';
      try {
        existingContent = fs.readFileSync(uri.fsPath, 'utf-8');
      } catch {
        // 新文件
      }

      const originalDoc = await vscode.workspace.openTextDocument({
        content: existingContent,
      });
      const modifiedDoc = await vscode.workspace.openTextDocument({
        content: change.content,
      });
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
      case '继续':
        return 'continue';
      case '跳过':
        return 'skip';
      case '重试':
        return 'retry';
      default:
        return 'abort';
    }
  }

  // ── 应用变更 ──

  private applyChanges(changes: FileChange[]): void {
    for (const change of changes) {
      const fullPath = path.join(this.workspaceRoot, change.filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      // 备份原文件
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

  // ── 阶段编排 ──

  /**
   * 获取所有阶段定义
   */
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

    // ── 新增: HTML 结构基线 + 联动契约 ──
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

        // 将基线约束保存到后续阶段可读的位置
        const stateDir = path.join(this.workspaceRoot, '.figma-stage', '00-baseline');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(
          path.join(stateDir, 'html-baseline-constraint.txt'),
          baselineText,
        );
        fs.writeFileSync(
          path.join(stateDir, 'linkage-constraint.txt'),
          linkageText,
        );
        // 同时写入人类可读报告供用户查看
        fs.writeFileSync(
          path.join(stateDir, 'report.md'),
          `# 结构基线报告\n\n${baselineText}\n\n${linkageText}`,
        );

        // 统计摘要
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
          const callbackCount = contracts.filter(c =>
            c.pattern === 'callback_prop',
          ).length;
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
        const auditJson = fs.existsSync(auditPath)
          ? fs.readFileSync(auditPath, 'utf-8')
          : '{}';
        const sourceCode = this.readSourceFiles();

        // 读取 HTML 基线约束和联动约束
        let htmlBaseline = '';
        let linkageConstraints = '';
        const baselinePath = path.join(root, '.figma-stage', '00-baseline', 'html-baseline-constraint.txt');
        const linkagePath = path.join(root, '.figma-stage', '00-baseline', 'linkage-constraint.txt');
        if (fs.existsSync(baselinePath)) {
          htmlBaseline = fs.readFileSync(baselinePath, 'utf-8');
        }
        if (fs.existsSync(linkagePath)) {
          linkageConstraints = fs.readFileSync(linkagePath, 'utf-8');
        }

        return buildDecomposePrompt(auditJson, sourceCode, htmlBaseline, linkageConstraints);
      },
      getOutputFiles: () => ['src/pages/', 'src/router.tsx', 'src/context/'],
    });

    // ── 新增: 联动契约验证 ──
    stages.push({
      key: 'verify-linkage',
      label: '2.5 联动验证 🔗',
      isAnalysisOnly: true,
      executeAnalysis: async () => {
        this.log('   🔗 验证跨页联动契约...');

        // 加载重构前的契约
        const contractsPath = path.join(root, '.figma-stage', '00-linkage', 'contracts-before.json');
        if (!fs.existsSync(contractsPath)) {
          return { summary: '未找到联动契约文件（contracts-before.json），跳过验证。' };
        }

        const contractsBefore = JSON.parse(fs.readFileSync(contractsPath, 'utf-8'));

        // 扫描当前文件验证
        const report = await verifyLinkageContracts(root, contractsBefore);

        // 生成报告
        let summary = `# 🔗 跨页联动验证报告\n\n`;
        summary += `| 指标 | 数值 |\n|------|------|\n`;
        summary += `| 总契约数 | ${report.summary.total} |\n`;
        summary += `| ✅ 已验证通过 | ${report.summary.verified} |\n`;
        summary += `| ❌ 已断裂 | ${report.summary.broken} |\n\n`;

        if (report.brokenContracts.length > 0) {
          summary += `## ❌ 断裂的联动契约\n\n`;
          summary += `| 源组件 | 模式 | 参数 | 详情 |\n`;
          summary += `|--------|------|------|------|\n`;
          for (const c of report.brokenContracts) {
            summary += `| ${c.sourceComponent} | ${c.pattern} | ${c.parameter || '-'} | ${c.verificationDetail || '未验证'} |\n`;
          }
          summary += `\n⚠️ 存在 ${report.brokenContracts.length} 个断裂的联动契约。`;
          summary += `\n建议：重新运行 Stage 2 (结构分解) 确保所有页面间导航被正确转换。\n`;
        } else if (report.summary.total > 0) {
          summary += `\n✅ 所有 ${report.summary.total} 个联动契约均已满足。\n`;
        }

        // 写入报告文件
        const reportDir = path.join(root, '.figma-stage', '00-linkage');
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(path.join(reportDir, 'verification-report.md'), summary);

        this.log(`   🔗 验证完成: ${report.summary.verified}/${report.summary.total} 通过`);

        if (report.brokenContracts.length > 0) {
          vscode.window.showWarningMessage(
            `⚠️ ${report.brokenContracts.length} 个联动契约断裂。建议重试 Stage 2。`,
            '知道了',
          );
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
      getOutputFiles: () => [
        'src/data/',
        'src/hooks/',
        'src/utils/',
        'src/types/',
      ],
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
          } else if (
            entry.name.endsWith('.ts') ||
            entry.name.endsWith('.tsx') ||
            entry.name.endsWith('.json')
          ) {
            files.push(path.relative(this.workspaceRoot, fullPath));
          }
        }
      } catch {
        // 忽略无法读取的目录
      }
    };
    walkDir(this.workspaceRoot);
    return files;
  }

  private readSourceFiles(): string {
    const files = this.listProjectFiles();
    const parts: string[] = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(
          path.join(this.workspaceRoot, file),
          'utf-8',
        );
        parts.push(`// --- ${file} ---\n${content}`);
      } catch {
        // 忽略无法读取的文件
      }
    }
    return parts.join('\n\n');
  }

  private readGlob(pattern: string): string {
    let files: string[];
    try {
      // Use find as a reliable fallback that works everywhere
      const result = require('child_process').execSync(
        `find ${this.workspaceRoot}/src -type f \\( -name "*.ts" -o -name "*.tsx" \\) 2>/dev/null`,
        { encoding: 'utf-8' },
      );
      files = result
        .split('\n')
        .filter(Boolean)
        .map((f: string) => path.relative(this.workspaceRoot, f.trim()));
    } catch {
      files = [];
    }

    const parts: string[] = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(
          path.join(this.workspaceRoot, file),
          'utf-8',
        );
        parts.push(`// --- ${file} ---\n${content}`);
      } catch {
        // ignore
      }
    }
    return parts.join('\n\n');
  }

  // ── 入口 ──

  async run(selectedKeys: string[], autoMode: boolean = false): Promise<void> {
    this.log('╔════════════════════════════════════════╗');
    this.log('║  Figma 机翻代码 → 可维护 React UI   ║');
    this.log('║     vscode.lm + Gemini 工作流引擎    ║');
    this.log(`║     Mode: ${autoMode ? '🤖 AUTO' : '👤 MANUAL'}                      ║`);
    this.log('╚════════════════════════════════════════╝\n');

    // 初始化状态
    this.state.selectedKeys = selectedKeys;
    this.state.status = 'running';
    this.saveState();

    const allStages = this.getAllStages();

    // 过滤出选中的阶段，按原顺序执行
    const selectedStages = allStages.filter((s) =>
      selectedKeys.includes(s.key),
    );

    if (selectedStages.length === 0) {
      this.log('❌ 未选择任何阶段');
      return;
    }

    this.log(`📋 计划执行 ${selectedStages.length} 个阶段:`);
    selectedStages.forEach((s) => this.log(`   ${s.label}`));

    for (const stage of selectedStages) {
      this.log(`\n🚀 执行阶段: ${stage.label}`);

      // 检查是否已完成
      const stageIndex = allStages.indexOf(stage);
      if (this.state.completedStages.includes(stageIndex)) {
        this.log(`⏭️  ${stage.label} 已完成，跳过`);
        continue;
      }

      const stageResult = await this.executeStage(stage, stageIndex, allStages, selectedStages, autoMode);

      if (stageResult === 'abort') {
        this.state.status = 'abort';
        this.saveState();
        this.log('🛑 工作流中止');
        return;
      }
    }

    // 完成
    this.state.status = 'done';
    this.saveState();

    this.log('\n🎉 工作流执行完毕！');
    this.log(`   ✅ 完成: ${this.state.completedStages.length} 个阶段`);
    this.log(`   ⏭️  跳过: ${this.state.skippedStages.length} 个阶段`);
    this.log(`   ❌ 失败: ${this.state.failedStages.length} 个阶段`);

    const message = autoMode
      ? '🤖 Auto Debug 完成！请检查 .figma-stage/ 目录下的报告文件。'
      : 'Figma Refactor 工作流完成！运行 npm install && npm run dev 启动。';
    vscode.window.showInformationMessage(message);
  }

  // ── 执行单个阶段（含自动重试/恢复逻辑）──

  /**
   * 执行一个阶段，返回 'continue' | 'skip' | 'abort'
   */
  private async executeStage(
    stage: StageDefinition,
    stageIndex: number,
    allStages: StageDefinition[],
    selectedStages: StageDefinition[],
    autoMode: boolean,
  ): Promise<'continue' | 'skip' | 'abort'> {
    let attempt = 0;
    const maxAttempts = autoMode ? 5 : 3;

    while (attempt < maxAttempts) {
      attempt++;
      if (attempt > 1) {
        this.log(`🔄 重试第 ${attempt}/${maxAttempts} 次...`);
      }

      try {
        // ── 分析阶段（本地计算，不调用 LLM）──
        if (stage.isAnalysisOnly && stage.executeAnalysis) {
          const result = await stage.executeAnalysis();
          const changes = result.files || [];
          const summary = result.summary || '';

          if (summary) {
            this.log(`\n📋 === ${stage.label} ===`);
            this.log(summary);
          }

          if (autoMode) {
            // Auto 模式：直接写入，不确认
            if (changes.length > 0) {
              this.applyChanges(changes);
              if (stage.persistOutput) {
                stage.persistOutput(changes);
              }
            }
            this.state.completedStages.push(stageIndex);
            this.saveState();
            this.log(`✅ ${stage.label} 完成`);

            // Auto-heal: 联动断裂自动回退 Stage 2
            if (stage.key === 'verify-linkage' && result.summary?.includes('断裂')) {
              return await this.autoHealLinkage(stageIndex, allStages, selectedStages, autoMode);
            }

            return 'continue';
          } else {
            // Manual 模式：弹窗确认
            const decision = await vscode.window.showInformationMessage(
              `${stage.label}\n\n${summary}`,
              { modal: true, detail: summary },
              '继续',
              '跳过',
            );

            switch (decision) {
              case '继续':
                if (changes.length > 0) {
                  this.applyChanges(changes);
                  if (stage.persistOutput) {
                    stage.persistOutput(changes);
                  }
                }
                this.state.completedStages.push(stageIndex);
                this.saveState();
                this.log(`✅ ${stage.label} 完成`);
                return 'continue';
              default:
                this.state.skippedStages.push(stageIndex);
                this.saveState();
                this.log(`⏭️  ${stage.label} 已跳过`);
                return 'continue';
            }
          }
        }

        // ── LLM 阶段 ──
        // 1. 构建 Prompt
        const prompt = await stage.buildPrompt();
        this.log(`   Prompt 构建完成 (${prompt.length} 字符)`);

        // 2. 调用 LLM
        const startTime = Date.now();
        const response = await this.callLm(prompt);
        const elapsed = Date.now() - startTime;
        this.log(`   LLM 调用完成 (${elapsed}ms)`);

        // 3. 解析 JSON
        let parsed: { files?: FileChange[]; summary?: string };
        try {
          parsed = this.extractJson(response);
        } catch (e) {
          this.log(`❌ JSON 解析失败: ${e}`);

          if (autoMode && attempt < maxAttempts) {
            // Auto 模式：用修复提示重试
            this.log('   自动修复: 发送修复指令给 LLM...');
            const fixPrompt = `${prompt}\n\n[重要] 上次输出不是 JSON 格式。请只输出严格 JSON，不要加任何解释文字。\n\n你的输出：\n${response}`;
            const fixResponse = await this.callLm(fixPrompt);
            try {
              parsed = this.extractJson(fixResponse);
              this.log('   ✅ 修复成功');
            } catch {
              this.log('   ❌ 修复失败，继续重试...');
              continue;
            }
          } else {
            if (attempt < maxAttempts) continue;
            throw new Error('LLM 输出无法解析为 JSON');
          }
        }

        const changes = parsed.files || [];

        // 4. 语法检查 (AST Guard)
        const outputFiles = changes.map((c) => c.filePath);
        const syntaxResult = await checkSyntaxOrRaise(this.workspaceRoot, outputFiles);
        if (!syntaxResult.valid) {
          showSyntaxErrors(syntaxResult.errors);
          this.log(`❌ AST 语法检查失败`);

          if (autoMode && attempt < maxAttempts) {
            // Auto 模式：告诉 LLM 修复语法错误
            this.log('   自动修复: 发送语法错误信息给 LLM...');
            const errorDetails = syntaxResult.errors.join('\n');
            const fixPrompt = `${prompt}\n\n[重要] 上次生成的代码有语法错误，请修复：\n\`\`\`\n${errorDetails}\n\`\`\`\n\n本次源代码：\n${response}`;
            const fixResponse = await this.callLm(fixPrompt);
            try {
              const fixed = this.extractJson(fixResponse);
              parsed = fixed;
              changes.length = 0;
              changes.push(...(fixed.files || []));
              // 重新检查语法
              const recheck = await checkSyntaxOrRaise(this.workspaceRoot, changes.map(c => c.filePath));
              if (recheck.valid) {
                this.log('   ✅ 语法修复成功');
              } else {
                this.log('   ⚠️ 语法修复仍未通过，继续重试...');
                continue;
              }
            } catch {
              this.log('   ❌ 语法修复 JSON 解析失败，继续重试...');
              continue;
            }
          } else {
            if (attempt < maxAttempts) continue;
            throw new Error('AST 语法检查失败，已达最大重试次数');
          }
        }

        // 5. 确认/写入
        if (autoMode) {
          // Auto 模式：直接写入，不确认
          this.applyChanges(changes);
          if (stage.persistOutput) {
            stage.persistOutput(changes);
          }
          this.state.completedStages.push(stageIndex);
          this.saveState();
          this.log(`✅ ${stage.label} 完成`);
          return 'continue';
        } else {
          // Manual 模式：人工确认
          const decision = await this.confirmChanges(stage.label, changes);

          switch (decision) {
            case 'continue':
              this.applyChanges(changes);
              if (stage.persistOutput) {
                stage.persistOutput(changes);
              }
              this.state.completedStages.push(stageIndex);
              this.saveState();
              this.log(`✅ ${stage.label} 完成`);
              return 'continue';
            case 'skip':
              this.state.skippedStages.push(stageIndex);
              this.saveState();
              this.log(`⏭️  ${stage.label} 已跳过`);
              return 'continue';
            case 'retry':
              continue;
            case 'abort':
              return 'abort';
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`❌ ${stage.label} 出错: ${msg}`);

        if (attempt >= maxAttempts) {
          if (autoMode) {
            // Auto 模式：记录失败继续
            this.state.failedStages.push(stageIndex);
            this.saveState();
            this.log(`⚠️  ${stage.label} 已达最大重试次数，继续下一阶段`);
            return 'continue';
          } else {
            const choice = await vscode.window.showErrorMessage(
              `阶段 "${stage.label}" 失败: ${msg}`,
              '跳过',
              '中止',
            );
            if (choice === '跳过') {
              this.state.skippedStages.push(stageIndex);
              this.saveState();
              return 'continue';
            } else {
              return 'abort';
            }
          }
        }
      }
    }

    return 'continue';
  }

  /**
   * Auto-heal: 联动验证断裂时自动回退重跑 Stage 2
   */
  private async autoHealLinkage(
    currentStageIndex: number,
    allStages: StageDefinition[],
    selectedStages: StageDefinition[],
    autoMode: boolean,
  ): Promise<'continue' | 'skip' | 'abort'> {
    const maxHealRetries = 3;

    for (let healAttempt = 1; healAttempt <= maxHealRetries; healAttempt++) {
      this.log(`\n🔧 Auto-heal 第 ${healAttempt}/${maxHealRetries} 次: 重新执行 Stage 2`);

      // 找到 Stage 2 (decompose)
      const decomposeStage = allStages.find(s => s.key === 'decompose');
      if (!decomposeStage) {
        this.log('❌ 未找到 Stage 2 (decompose)，无法自动修复');
        break;
      }

      const decomposeIdx = allStages.indexOf(decomposeStage);

      // 重跑 Stage 2
      const result = await this.executeStage(decomposeStage, decomposeIdx, allStages, selectedStages, true);
      if (result === 'abort') return 'abort';

      // 重跑 Stage 2.5
      const verifyStage = allStages.find(s => s.key === 'verify-linkage');
      if (!verifyStage) break;

      const verifyIdx = allStages.indexOf(verifyStage);
      // 清除完成状态，保证能重跑
      this.state.completedStages = this.state.completedStages.filter(i => i !== verifyIdx);
      this.saveState();

      const verifyResult = await this.executeStage(verifyStage, verifyIdx, allStages, selectedStages, true);
      if (verifyResult === 'abort') return 'abort';

      // 如果验证通过了就不继续 heal
      const reportPath = path.join(this.workspaceRoot, '.figma-stage', '00-linkage', 'verification-report.md');
      if (fs.existsSync(reportPath)) {
        const report = fs.readFileSync(reportPath, 'utf-8');
        if (!report.includes('断裂') && !report.includes('❌')) {
          this.log('🎉 Auto-heal 成功！所有联动契约已满足');
          return 'continue';
        }
      }

      this.log(`⚠️  第 ${healAttempt} 次 auto-heal 未完全修复`);
    }

    this.log('⚠️  Auto-heal 达到最大重试次数，联动验证仍有问题');
    return 'continue';
  }
}
