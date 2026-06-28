/**
 * Workflow 共享类型
 *
 * 将 WorkflowEngine 中的类型定义提取为共享模块，
 * 供 workflow-engine.ts 和 langgraph-workflow.ts 共同引用。
 */

// ──────────────────────────────────────────────
// 文件变更
// ──────────────────────────────────────────────

export interface FileChange {
  filePath: string;
  content: string;
}

// ──────────────────────────────────────────────
// 阶段定义
// ──────────────────────────────────────────────

export interface StageDefinition {
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
