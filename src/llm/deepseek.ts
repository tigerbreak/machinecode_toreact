/**
 * DeepSeek LLM Client
 *
 * 封装 OpenAI SDK 调用 DeepSeek V4 Flash，提供统一的 callDeepSeek() 接口。
 * 支持流式和非流式输出，内置指数退避重试。
 */

import OpenAI from 'openai';

// ──────────────────────────────────────────────
// 配置
// ──────────────────────────────────────────────

const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.3;
const BASE_URL = 'https://api.deepseek.com';
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // ms

// ──────────────────────────────────────────────
// 接口
// ──────────────────────────────────────────────

export interface CallDeepSeekOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  onChunk?: (chunk: string) => void;
}

// ──────────────────────────────────────────────
// API Key 获取
// ──────────────────────────────────────────────

function getApiKey(): string {
  // 1. 环境变量优先
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;

  // 2. VS Code 配置（仅在 VS Code 环境中可用）
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    const config = vscode.workspace?.getConfiguration('figma-refactor');
    const cfgKey: string = config?.get('deepseekApiKey', '') || '';
    if (cfgKey) return cfgKey;
  } catch {
    // 不在 VS Code 环境中，忽略
  }

  return '';
}

function createClient(): OpenAI {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY 未设置。请通过环境变量或 VS Code 设置 "figma-refactor.deepseekApiKey" 配置。',
    );
  }

  return new OpenAI({
    apiKey,
    baseURL: BASE_URL,
  });
}

// ──────────────────────────────────────────────
// 指数退避延迟
// ──────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────
// 核心 API
// ──────────────────────────────────────────────

/**
 * 调用 DeepSeek V4 Flash API
 *
 * @param prompt  用户 prompt
 * @param options 可选参数（model, maxTokens, temperature, stream, onChunk）
 * @returns       LLM 响应的文本内容
 */
export async function callDeepSeek(
  prompt: string,
  options?: CallDeepSeekOptions,
): Promise<string> {
  const model = options?.model || DEFAULT_MODEL;
  const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS;
  const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
  const stream = options?.stream ?? false;
  const onChunk = options?.onChunk;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = createClient();

      if (stream) {
        // ── 流式模式 ──
        const streamResponse = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature,
          stream: true,
        });

        let result = '';
        for await (const chunk of streamResponse) {
          const delta = chunk.choices?.[0]?.delta?.content || '';
          if (delta) {
            result += delta;
            onChunk?.(delta);
          }
        }
        return result;
      } else {
        // ── 非流式模式 ──
        const response = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature,
        });

        return response.choices?.[0]?.message?.content || '';
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < MAX_RETRIES) {
        const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
        console.warn(
          `[DeepSeek] 第 ${attempt} 次调用失败 (${lastError.message})，${retryDelay}ms 后重试...`,
        );
        await delay(retryDelay);
      }
    }
  }

  throw lastError || new Error('DeepSeek 调用失败：已达最大重试次数');
}

/**
 * 验证 DeepSeek API Key 是否有效（轻量调用测试）
 */
export async function validateApiKey(): Promise<boolean> {
  try {
    const result = await callDeepSeek('Respond with exactly: OK', {
      maxTokens: 10,
      temperature: 0,
    });
    return result.trim().toUpperCase() === 'OK';
  } catch {
    return false;
  }
}
