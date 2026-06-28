/**
 * LangGraph 工作流
 *
 * 定义完整的 StateGraph，包含所有阶段节点和条件边。
 * 每个阶段对应一个 Graph Node，由 LangGraph 状态机驱动执行顺序。
 *
 * 图结构:
 *   START → route[0] → stage → route[1] → stage → ... → finish → END
 *                            ↕ (autoHeal)
 */

import { StateGraph, START, END } from '@langchain/langgraph';
import * as path from 'path';
import * as fs from 'fs';

import { type FileChange, type StageDefinition } from './workflow-types';
import { State, type WorkflowState, createInitialState } from './workflow-state';
import { callDeepSeek } from './llm/deepseek';
import { checkSyntaxOrRaise } from './ast-guard';
import { buildHtmlBaseline, formatBaselineConstraint } from './html-baseline';
import {
  buildLinkageContracts,
  verifyLinkageContracts,
  formatLinkageConstraints,
} from './linkage-verifier';
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
// 辅助函数
// ──────────────────────────────────────────────

function readSourceFiles(root: string): string {
  const files: string[] = [];
  const walkDir = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== '.figma-stage' && entry.name !== 'out') {
            walkDir(fullPath);
          }
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx') || entry.name.endsWith('.json')) {
          files.push(path.relative(root, fullPath));
        }
      }
    } catch { /* skip */ }
  };
  walkDir(root);
  return files
    .map((f) => {
      try {
        return `// --- ${f} ---\n${fs.readFileSync(path.join(root, f), 'utf-8')}`;
      } catch { return ''; }
    })
    .join('\n\n');
}

function readGlob(root: string): string {
  let files: string[];
  try {
    const result = require('child_process').execSync(
      `find ${root}/src -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.jsx" \\) 2>/dev/null`,
      { encoding: 'utf-8' },
    );
    files = result.split('\n').filter(Boolean).map((f: string) => path.relative(root, f.trim()));
  } catch {
    files = [];
  }
  return files
    .map((f) => {
      try {
        return `// --- ${f} ---\n${fs.readFileSync(path.join(root, f), 'utf-8')}`;
      } catch { return ''; }
    })
    .join('\n\n');
}

function applyChanges(root: string, changes: FileChange[]): void {
  for (const change of changes) {
    const fullPath = path.join(root, change.filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (fs.existsSync(fullPath)) {
      const backupPath = fullPath + '.bak';
      if (!fs.existsSync(backupPath)) fs.copyFileSync(fullPath, backupPath);
    }
    fs.writeFileSync(fullPath, change.content, 'utf-8');
  }
}

function extractJson(text: string): any {
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch) return JSON.parse(jsonBlockMatch[1]);
  const codeBlockMatch = text.match(/```\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1]); } catch { /* not json */ }
  }
  return JSON.parse(text);
}

async function executeStage(
  state: WorkflowState,
  key: string,
  buildPromptFn: () => string | Promise<string>,
  persistOutputFn?: (changes: FileChange[]) => void,
): Promise<Partial<WorkflowState>> {
  const { workspaceRoot, autoMode, allStages } = state;
  const stageIdx = allStages.findIndex((s) => s.key === key);

  const prompt = await buildPromptFn();
  const response = await callDeepSeek(prompt);

  let parsed: { files?: FileChange[]; summary?: string };
  try {
    parsed = extractJson(response);
  } catch (e) {
    return {
      error: `JSON 解析失败 (${key}): ${e}`,
      failedStages: [stageIdx],
      currentStageIndex: allStages.findIndex((s) => s.key === key),
    };
  }

  // Normalize: LLM may return "path" (from prompt template) or "filePath"
  const changes: FileChange[] = (parsed.files || []).map((f: any) => ({
    filePath: f.filePath || f.path || '',
    content: f.content || '',
  }));
  const summary = parsed.summary || '';

  // Filter out entries with empty filePath
  const validChanges = changes.filter((c) => c.filePath);
  const outputPaths = validChanges.map((c) => c.filePath);
  const syntaxResult = await checkSyntaxOrRaise(workspaceRoot, outputPaths);
  if (!syntaxResult.valid) {
    return {
      error: `AST 语法检查失败 (${key}): ${syntaxResult.errors.join('; ')}`,
      failedStages: [stageIdx],
      currentStageIndex: allStages.findIndex((s) => s.key === key),
    };
  }

  if (autoMode) {
    applyChanges(workspaceRoot, validChanges);
    if (persistOutputFn) persistOutputFn(validChanges);
  } else {
    const stageDir = path.join(workspaceRoot, '.figma-stage', 'pending');
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, `${key}.json`), JSON.stringify(validChanges, null, 2));
  }

  return {
    completedStages: [stageIdx],
    stageResults: {
      [key]: { files: validChanges, summary, status: 'success' },
    },
  };
}

// ──────────────────────────────────────────────
// 阶段节点
// ──────────────────────────────────────────────

async function scaffoldNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const files = readSourceFiles(state.workspaceRoot)
    .split('\n')
    .filter((l) => l.startsWith('// --- '))
    .map((l) => l.replace('// --- ', '').replace(' ---', ''));
  return executeStage(state, 'scaffold', () => buildScaffoldPrompt(files));
}

async function baselineNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const { workspaceRoot, allStages } = state;
  const stageIdx = allStages.findIndex((s) => s.key === 'baseline');

  const [baseline, contracts] = await Promise.all([
    buildHtmlBaseline(workspaceRoot),
    buildLinkageContracts(workspaceRoot),
  ]);
  const baselineText = formatBaselineConstraint(baseline);
  const linkageText = formatLinkageConstraints(contracts);

  const stateDir = path.join(workspaceRoot, '.figma-stage', '00-baseline');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'html-baseline-constraint.txt'), baselineText);
  fs.writeFileSync(path.join(stateDir, 'linkage-constraint.txt'), linkageText);
  fs.writeFileSync(path.join(stateDir, 'report.md'), `# 结构基线报告\n\n${baselineText}\n\n${linkageText}`);

  let summary = `🏛️  HTML 基线: ${baseline.files.length} 文件`;
  for (const f of baseline.files) {
    summary += `\n   📄 ${f.htmlFile}`;
    if (f.matchedJsxFile) summary += ` ↔ ${f.matchedJsxFile}`;
    summary += ` (${f.interactiveElements.length} 交互元素)`;
  }
  summary += contracts.length > 0 ? `\n🔗  联动契约: ${contracts.length} 个` : '\n🔗  未发现联动契约';

  return { completedStages: [stageIdx], stageResults: { baseline: { files: [], summary, status: 'success' } } };
}

async function auditNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const sourceCode = readSourceFiles(state.workspaceRoot);
  return executeStage(state, 'audit', () => buildAuditPrompt(sourceCode), (changes) => {
    const auditDir = path.join(state.workspaceRoot, '.figma-stage', '01-audit');
    fs.mkdirSync(auditDir, { recursive: true });
    for (const c of changes) {
      if (c.filePath.includes('audit.json')) fs.writeFileSync(path.join(auditDir, 'audit.json'), c.content);
    }
  });
}

async function decomposeNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const { workspaceRoot } = state;
  const auditPath = path.join(workspaceRoot, '.figma-stage', '01-audit', 'audit.json');
  const auditJson = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '{}';
  const sourceCode = readSourceFiles(workspaceRoot);

  const baselinePath = path.join(workspaceRoot, '.figma-stage', '00-baseline', 'html-baseline-constraint.txt');
  const linkagePath = path.join(workspaceRoot, '.figma-stage', '00-baseline', 'linkage-constraint.txt');
  const htmlBaseline = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, 'utf-8') : '';
  const linkageConstraints = fs.existsSync(linkagePath) ? fs.readFileSync(linkagePath, 'utf-8') : '';

  return executeStage(state, 'decompose', () => buildDecomposePrompt(auditJson, sourceCode, htmlBaseline, linkageConstraints));
}

async function verifyLinkageNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const { workspaceRoot, allStages } = state;
  const stageIdx = allStages.findIndex((s) => s.key === 'verify-linkage');

  const contractsPath = path.join(workspaceRoot, '.figma-stage', '00-linkage', 'contracts-before.json');
  if (!fs.existsSync(contractsPath)) {
    return { completedStages: [stageIdx], stageResults: { 'verify-linkage': { files: [], summary: '未找到联动契约文件，跳过验证。', status: 'success' } } };
  }

  const contractsBefore = JSON.parse(fs.readFileSync(contractsPath, 'utf-8'));
  const report = await verifyLinkageContracts(workspaceRoot, contractsBefore);

  let summary = `# 🔗 跨页联动验证报告\n\n| 指标 | 数值 |\n|------|------|\n| 总契约数 | ${report.summary.total} |\n| ✅ 已验证通过 | ${report.summary.verified} |\n| ❌ 已断裂 | ${report.summary.broken} |\n\n`;
  if (report.brokenContracts.length > 0) {
    summary += `\n⚠️ 存在 ${report.brokenContracts.length} 个断裂的联动契约。`;
  } else if (report.summary.total > 0) {
    summary += `\n✅ 所有 ${report.summary.total} 个联动契约均已满足。\n`;
  }

  const reportDir = path.join(workspaceRoot, '.figma-stage', '00-linkage');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'verification-report.md'), summary);

  return { completedStages: [stageIdx], stageResults: { 'verify-linkage': { files: [], summary, status: report.brokenContracts.length > 0 ? 'failed' : 'success' } } };
}

async function extractNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  return executeStage(state, 'extract', () => buildExtractPrompt(readGlob(state.workspaceRoot)));
}

async function styleNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  return executeStage(state, 'style', () => buildStylePrompt(readGlob(state.workspaceRoot)));
}

async function typesNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  return executeStage(state, 'types', () => buildTypesPrompt(readGlob(state.workspaceRoot)));
}

async function a11yNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  return executeStage(state, 'a11y', () => buildA11yPrompt(readGlob(state.workspaceRoot)));
}

async function dataNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  return executeStage(state, 'data', () => buildDataSeparationPrompt(readGlob(state.workspaceRoot)));
}

async function polishNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  return executeStage(state, 'polish', () => buildPolishPrompt(readGlob(state.workspaceRoot)));
}

// ──────────────────────────────────────────────
// Auto-heal 节点
// ──────────────────────────────────────────────

async function autoHealNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const { workspaceRoot, healAttempts, maxHealRetries } = state;

  if (healAttempts >= maxHealRetries) {
    return { healAttempts: healAttempts + 1 };
  }

  const auditPath = path.join(workspaceRoot, '.figma-stage', '01-audit', 'audit.json');
  const auditJson = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '{}';
  const sourceCode = readSourceFiles(workspaceRoot);

  const baselinePath = path.join(workspaceRoot, '.figma-stage', '00-baseline', 'html-baseline-constraint.txt');
  const linkagePath = path.join(workspaceRoot, '.figma-stage', '00-baseline', 'linkage-constraint.txt');
  const htmlBaseline = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, 'utf-8') : '';
  const linkageConstraints = fs.existsSync(linkagePath) ? fs.readFileSync(linkagePath, 'utf-8') : '';

  // For auto-heal, always use autoMode
  const healState = { ...state, autoMode: true };
  const result = await executeStage(healState, 'decompose', () => buildDecomposePrompt(auditJson, sourceCode, htmlBaseline, linkageConstraints));

  return {
    ...result,
    healAttempts: healAttempts + 1,
  };
}

// ──────────────────────────────────────────────
// 路由函数
// ──────────────────────────────────────────────

function getStageKeyByIndex(state: WorkflowState, idx: number): string | null {
  if (idx < 0 || idx >= state.selectedKeys.length) return null;
  return state.selectedKeys[idx];
}

function routeToNextStage(state: WorkflowState): string {
  const nextIdx = state.currentStageIndex + 1;
  const nextKey = getStageKeyByIndex(state, nextIdx);
  if (!nextKey) return 'finish';
  return nextKey;
}

function decideAfterVerify(state: WorkflowState): string {
  const verifyResult = state.stageResults['verify-linkage'];
  if (verifyResult?.status === 'failed' && state.healAttempts < state.maxHealRetries) {
    return 'autoHeal';
  }
  const nextIdx = state.currentStageIndex + 1;
  const nextKey = getStageKeyByIndex(state, nextIdx);
  if (!nextKey) return 'finish';
  return nextKey;
}

// ──────────────────────────────────────────────
// 构建 & 编译
// ──────────────────────────────────────────────

export function buildGraph() {
  const workflow = new StateGraph(State) as any;

  // 添加阶段节点
  workflow.addNode('scaffold', scaffoldNode);
  workflow.addNode('baseline', baselineNode);
  workflow.addNode('audit', auditNode);
  workflow.addNode('decompose', decomposeNode);
  workflow.addNode('verifyLinkage', verifyLinkageNode);
  workflow.addNode('extract', extractNode);
  workflow.addNode('style', styleNode);
  workflow.addNode('types', typesNode);
  workflow.addNode('a11y', a11yNode);
  workflow.addNode('data', dataNode);
  workflow.addNode('polish', polishNode);

  // 控制节点
  workflow.addNode('autoHeal', autoHealNode);
  workflow.addNode('finish', (_state: WorkflowState) => ({}));

  // START → 第一个阶段
  workflow.addConditionalEdges(START, (state: WorkflowState) => {
    const firstKey = getStageKeyByIndex(state, 0);
    return firstKey || 'finish';
  }, {
    scaffold: 'scaffold',
    baseline: 'baseline',
    audit: 'audit',
    decompose: 'decompose',
    verifyLinkage: 'verifyLinkage',
    extract: 'extract',
    style: 'style',
    types: 'types',
    a11y: 'a11y',
    data: 'data',
    polish: 'polish',
    finish: 'finish',
  });

  // 每个阶段执行后路由到下一阶段
  const allNodeNames = [
    'scaffold', 'baseline', 'audit', 'decompose', 'verifyLinkage',
    'extract', 'style', 'types', 'a11y', 'data', 'polish',
    'autoHeal', 'finish',
  ] as const;

  // 所有节点执行后都路由到下一阶段
  // 注意 verifyLinkage 后面我们会覆盖
  for (const nodeName of allNodeNames) {
    if (nodeName === 'verifyLinkage' || nodeName === 'autoHeal' || nodeName === 'finish') continue;
    workflow.addConditionalEdges(nodeName, routeToNextStage);
  }

  // verifyLinkage 特殊：可能触 autoHeal
  workflow.addConditionalEdges('verifyLinkage', decideAfterVerify);

  // autoHeal → 路由到下一阶段
  workflow.addConditionalEdges('autoHeal', routeToNextStage);

  // finish → END
  workflow.addEdge('finish', END);

  return workflow;
}

let compiledApp: any = null;

export function getCompiledWorkflow() {
  if (!compiledApp) {
    compiledApp = buildGraph().compile();
  }
  return compiledApp;
}

export async function runWorkflow(
  selectedKeys: string[],
  allStages: StageDefinition[],
  autoMode: boolean,
  workspaceRoot: string,
): Promise<WorkflowState> {
  const initialState = createInitialState(selectedKeys, allStages, autoMode, workspaceRoot);
  const app = getCompiledWorkflow();
  const result = await app.invoke(initialState, {
    configurable: { thread_id: `figma-refactor-${Date.now()}` },
  });
  return result as unknown as WorkflowState;
}
