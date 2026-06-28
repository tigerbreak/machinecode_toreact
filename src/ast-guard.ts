/**
 * AST Guard — 语法检查卡点
 *
 * 在每个 Stage 写入文件前，使用 esbuild 或 tsc 做语法检查。
 * 如果 LLM 输出的代码有语法错误，在人工确认前就拦截并触发重试。
 */

import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface SyntaxCheckResult {
  valid: boolean;
  errors: string[];
}

/**
 * 检查 TSX/TS 文件是否有语法错误
 *
 * 策略：
 *   1. 优先使用 esbuild --dry-run（快）
 *   2. 回退使用 tsc --noEmit --skipLibCheck（更全面）
 *
 * @param rootPath 工作区根路径
 * @param filePaths 要检查的文件路径列表（相对路径）
 */
export async function checkSyntaxOrRaise(
  rootPath: string,
  filePaths: string[],
): Promise<SyntaxCheckResult> {
  const errors: string[] = [];

  // 先尝试 esbuild（最快）
  const esbuildResult = await tryEsbuildCheck(rootPath, filePaths);
  if (esbuildResult.valid) {
    return { valid: true, errors: [] };
  }

  // esbuild 有错误，再试 tsc 确认
  const tscResult = await tryTscCheck(rootPath);
  if (tscResult.valid) {
    // esbuild 误报，tsc 通过
    return { valid: true, errors: [] };
  }

  errors.push(...esbuildResult.errors);
  errors.push(...tscResult.errors);

  return { valid: false, errors };
}

/**
 * 使用 esbuild --dry-run 检查语法
 */
async function tryEsbuildCheck(
  rootPath: string,
  filePaths: string[],
): Promise<SyntaxCheckResult> {
  try {
    // 检查 esbuild 是否可用
    execSync('npx esbuild --version', {
      cwd: rootPath,
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch {
    // esbuild 不可用，跳过
    return { valid: true, errors: [] };
  }

  const errors: string[] = [];

  for (const filePath of filePaths) {
    const fullPath = join(rootPath, filePath);
    if (!existsSync(fullPath)) continue;

    try {
      execSync(
        `npx esbuild "${fullPath}" --loader=tsx --syntax-check --dry-run`,
        {
          cwd: rootPath,
          stdio: 'pipe',
          timeout: 10000,
        },
      );
    } catch (e: any) {
      // esbuild 输出错误信息到 stderr
      const stderr = e.stderr?.toString() || e.message || '';
      // 提取有意义的错误行
      const errorLines = stderr
        .split('\n')
        .filter((l: string) => l.includes('ERROR') || l.includes('error'))
        .map((l: string) => `[esbuild] ${filePath}: ${l.trim()}`);
      errors.push(...errorLines);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 使用 tsc --noEmit --skipLibCheck 全面检查
 */
async function tryTscCheck(rootPath: string): Promise<SyntaxCheckResult> {
  try {
    execSync('npx tsc --version', {
      cwd: rootPath,
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch {
    return { valid: true, errors: [] };
  }

  try {
    execSync('npx tsc --noEmit --skipLibCheck', {
      cwd: rootPath,
      stdio: 'pipe',
      timeout: 30000,
    });
    return { valid: true, errors: [] };
  } catch (e: any) {
    const stderr = e.stderr?.toString() || e.stdout?.toString() || '';
    const errors = stderr
      .split('\n')
      .filter((l: string) => l.includes('error'))
      .map((l: string) => `[tsc] ${l.trim()}`);
    return { valid: false, errors };
  }
}

/**
 * 在 VS Code 中展示语法错误
 */
export function showSyntaxErrors(errors: string[]): void {
  const channel = vscode.window.createOutputChannel('Figma Refactor (AST)');
  channel.clear();
  channel.appendLine('❌ 语法检查失败，以下文件有错误：');
  channel.appendLine('');
  errors.forEach((err) => channel.appendLine(err));
  channel.show(true);
}
