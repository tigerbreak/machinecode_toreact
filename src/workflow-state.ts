/**
 * LangGraph Workflow State
 *
 * 定义工作流所有阶段共享的状态类型，覆盖原 WorkflowEngine 的所有状态变量。
 * 使用 LangGraph 的 Annotation API 作为 StateGraph 的 StateSchema。
 */

import { Annotation } from '@langchain/langgraph';
import { type FileChange, type StageDefinition } from './workflow-types';

// ──────────────────────────────────────────────
// 阶段结果
// ──────────────────────────────────────────────

export interface StageResult {
  files: FileChange[];
  summary: string;
  status: 'success' | 'failed' | 'skipped';
}

// ──────────────────────────────────────────────
// 工作流状态接口（纯类型，供 TypeScript 引用）
// ──────────────────────────────────────────────

export interface WorkflowState {
  selectedKeys: string[];
  allStages: StageDefinition[];
  autoMode: boolean;
  currentStageIndex: number;
  completedStages: number[];
  failedStages: number[];
  skippedStages: number[];
  workspaceRoot: string;
  stageResults: Record<string, StageResult>;
  error: string | null;
  healAttempts: number;
  maxHealRetries: number;
}

// ──────────────────────────────────────────────
// LangGraph Annotation Root（实际 StateSchema）
// ──────────────────────────────────────────────

export const State = Annotation.Root({
  selectedKeys: Annotation<string[]>({
    value: (a: string[], b?: string[]) => b ?? a,
    default: () => [] as string[],
  }),
  allStages: Annotation<StageDefinition[]>({
    value: (a: StageDefinition[], b?: StageDefinition[]) => b ?? a,
    default: () => [] as StageDefinition[],
  }),
  autoMode: Annotation<boolean>({
    value: (a: boolean, b?: boolean) => b ?? a,
    default: () => false,
  }),
  currentStageIndex: Annotation<number>({
    value: (a: number, b?: number) => b ?? a,
    default: () => 0,
  }),
  completedStages: Annotation<number[]>({
    value: (a: number[], b?: number[]) =>
      b ? [...new Set([...a, ...b])] : a,
    default: () => [] as number[],
  }),
  failedStages: Annotation<number[]>({
    value: (a: number[], b?: number[]) =>
      b ? [...new Set([...a, ...b])] : a,
    default: () => [] as number[],
  }),
  skippedStages: Annotation<number[]>({
    value: (a: number[], b?: number[]) =>
      b ? [...new Set([...a, ...b])] : a,
    default: () => [] as number[],
  }),
  workspaceRoot: Annotation<string>({
    value: (a: string, b?: string) => b ?? a,
    default: () => '',
  }),
  stageResults: Annotation<Record<string, StageResult>>({
    value: (
      a: Record<string, StageResult>,
      b?: Record<string, StageResult>,
    ) => (b ? { ...a, ...b } : a),
    default: () => ({}) as Record<string, StageResult>,
  }),
  error: Annotation<string | null>({
    value: (a: string | null, b?: string | null) =>
      b !== undefined ? b : a,
    default: () => null as string | null,
  }),
  healAttempts: Annotation<number>({
    value: (a: number, b?: number) => b ?? a,
    default: () => 0,
  }),
  maxHealRetries: Annotation<number>({
    value: (a: number, b?: number) => b ?? a,
    default: () => 3,
  }),
});

// ──────────────────────────────────────────────
// 初始状态工厂
// ──────────────────────────────────────────────

export function createInitialState(
  selectedKeys: string[],
  allStages: StageDefinition[],
  autoMode: boolean,
  workspaceRoot: string,
): WorkflowState {
  return {
    selectedKeys,
    allStages,
    autoMode,
    currentStageIndex: 0,
    completedStages: [],
    failedStages: [],
    skippedStages: [],
    workspaceRoot,
    stageResults: {},
    error: null,
    healAttempts: 0,
    maxHealRetries: 3,
  };
}
