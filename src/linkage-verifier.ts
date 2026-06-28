/**
 * 跨页联动验证器（Cross-Page Linkage Verifier）
 *
 * 通用解决方案，解决"多页拆分后联动丢失"问题。
 *
 * 原理：
 *   1. 重构前：扫描所有 JSX/TSX，识别所有"导航意图"
 *      - 直接: navigate(), <Link>, useNavigate, history.push
 *      - 间接: console.log('下钻跳转'), window.open, onClick 带 ID
 *      - 声明式: onBack prop, onNav prop, onSelect prop
 *   2. 构建"联动契约"：{ source, target, param, pattern }
 *   3. 重构后：重新扫描所有页面文件，验证每个契约是否仍被满足
 *   4. 如果有契约破裂，阻止进入下一阶段并提示修复
 *
 * 匹配规则：
 *   - 静态分析：正则匹配已知导航模式
 *   - 跨文件引用：一个文件 import 了另一个文件的组件
 *   - Props 传递：onBack / onNavigate / onSelect 等回调 prop
 */

import * as fs from 'fs';
import * as path from 'path';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/** 导航模式 */
export type NavigationPattern =
  | 'console.log_drill'    // console.log('下钻跳转', id)
  | 'useNavigate_call'     // const navigate = useNavigate(); navigate(...)
  | 'Link_component'       // <Link to="...">
  | 'window_open'          // window.open(...)
  | 'onClick_navigate'     // onClick 中路由跳转
  | 'state_change'         // setShowPageX / setCurrentView
  | 'callback_prop'        // onBack / onNav / onSelect prop
  | 'import_reference'     // import 了另一个页面的组件
  | 'anchor_href'          // <a href="...">
  | 'unknown';

/** 一个联动契约 */
export interface LinkageContract {
  id: string;
  sourceFile: string;
  sourceComponent: string;
  targetFile: string | null;
  targetComponent: string | null;
  /** 传递的参数名 */
  parameter: string | null;
  pattern: NavigationPattern;
  /** 原始代码片段 */
  originalSnippet: string;
  /** 行号 */
  lineNumber: number;
  /** 重构后是否已满足 */
  verified: boolean;
  /** 验证详情 */
  verificationDetail?: string;
}

/** 联动验证报告 */
export interface LinkageReport {
  contracts: LinkageContract[];
  summary: {
    total: number;
    verified: number;
    broken: number;
    unknown: number;
  };
  brokenContracts: LinkageContract[];
}

// ──────────────────────────────────────────────
// 导航模式检测
// ──────────────────────────────────────────────

interface NavPattern {
  pattern: RegExp;
  type: NavigationPattern;
  extractParam: (match: RegExpExecArray) => string | null;
}

const NAV_PATTERNS: NavPattern[] = [
  {
    // console.log('下钻跳转', row.uuid) 或其他 drill 指示
    pattern: /console\.(?:log|warn|debug)\s*\(\s*(?:'[^']*(?:下钻|跳转|drill|navigate|详情|detail|nav)[^']*'|"[^"]*(?:下钻|跳转|drill|navigate|详情|detail|nav)[^"]*")\s*,\s*(\w+(?:\.\w+)?)\s*\)/gi,
    type: 'console.log_drill',
    extractParam: (m) => m[1] || null,
  },
  {
    // navigate('/path') 或 navigate(`/path/${id}`)
    pattern: /navigate\s*\(\s*(['"`][^'"`]+['"`])\s*(?:,\s*\{[^}]*\})?\s*\)/g,
    type: 'useNavigate_call',
    extractParam: (m) => m[1] || null,
  },
  {
    // <Link to="/path">
    pattern: /<Link\s+[^>]*to\s*=\s*\{?['"`]([^'"`]+)['"`]/g,
    type: 'Link_component',
    extractParam: (m) => m[1] || null,
  },
  {
    // window.open('/path')
    pattern: /window\.open\s*\(\s*(['"`][^'"`]+['"`])/g,
    type: 'window_open',
    extractParam: (m) => m[1] || null,
  },
  {
    // onClick 回调中可能包含导航
    pattern: /onClick\s*=\s*\{?\s*\(?\s*\w*\s*\)?\s*=>\s*\{?[^}]*navigate\s*\(/g,
    type: 'onClick_navigate',
    extractParam: () => null,
  },
  {
    // setShowPage / setCurrentPage / setActiveView 等状态切换
    pattern: /set(?:Show|Current|Active|Selected|View|Page|Tab)\w*\s*\(/g,
    type: 'state_change',
    extractParam: () => null,
  },
  {
    // onBack / onNav / onSelect / onNavigate 回调 prop
    // 匹配 interface 声明, JSX prop 传递, 解构赋值
    pattern: /(onBack|onNav|onNavigate|onSelect|onPageChange|onDrillDown|onDetail)\??\s*(?::\s*(?:[^,=\n{].*?)?)?\s*[={,]/g,
    type: 'callback_prop',
    extractParam: (m) => m[1] || null,
  },
  {
    // import 另一个组件
    pattern: /import\s+(?:\{[^}]*\}|[A-Z]\w*)\s+from\s+['"]\.\.?\/[^'"]+(?:page|screen|view)[^'"]*['"]/gi,
    type: 'import_reference',
    extractParam: () => null,
  },
  {
    // <a href="...">
    pattern: /<a\s+[^>]*href\s*=\s*['"](\/[^'"]+)['"]/g,
    type: 'anchor_href',
    extractParam: (m) => m[1] || null,
  },
];

/**
 * 分析单个文件中的导航模式
 */
function analyzeFile(filePath: string, content: string): LinkageContract[] {
  const contracts: LinkageContract[] = [];
  const lines = content.split('\n');
  const fileName = path.basename(filePath);
  const componentName = extractComponentName(content) || fileName.replace(/\.\w+$/, '');

  for (const navPattern of NAV_PATTERNS) {
    // 重置正则
    navPattern.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = navPattern.pattern.exec(content)) !== null) {
      // 估算行号
      const lineNumber = content.slice(0, match.index).split('\n').length;

      // 提取参数
      const param = navPattern.extractParam(match);

      // 推断目标组件
      let targetComponent: string | null = null;
      if (param && param.includes('/')) {
        // 可能是路径，提取最后一个 segment 作为组件名
        const segments = param.replace(/['"`]/g, '').split('/').filter(Boolean);
        if (segments.length > 0) {
          const last = segments[segments.length - 1];
          targetComponent = last.replace(/[^a-zA-Z0-9]/g, '');
          // 首字母大写
          targetComponent = targetComponent.charAt(0).toUpperCase() + targetComponent.slice(1);
        }
      }

      // 对于回调 prop，target 可能是父级传进来的
      const isCallback = navPattern.type === 'callback_prop';

      contracts.push({
        id: `${fileName}::${navPattern.type}::${match.index}`,
        sourceFile: filePath,
        sourceComponent: componentName,
        targetFile: null,
        targetComponent: isCallback ? `${componentName}的父级` : targetComponent,
        parameter: param,
        pattern: navPattern.type,
        originalSnippet: match[0].length > 100 ? match[0].slice(0, 100) + '...' : match[0],
        lineNumber,
        verified: false,
      });
    }
  }

  return contracts;
}

/**
 * 提取组件名（默认导出或 export const）
 */
function extractComponentName(content: string): string | null {
  // export default function Xxx
  const defaultFn = content.match(/export\s+default\s+function\s+(\w+)/);
  if (defaultFn) return defaultFn[1];

  // export default React.FC / const Xxx: React.FC
  const constExport = content.match(/export\s+(?:const|let|var)\s+(\w+)/);
  if (constExport) return constExport[1];

  // export default class Xxx
  const classExport = content.match(/export\s+default\s+class\s+(\w+)/);
  if (classExport) return classExport[1];

  // export default Xxx (at end)
  const defaultExport = content.match(/export\s+default\s+(\w+)/);
  if (defaultExport) return defaultExport[1];

  return null;
}

/**
 * 通过 import 关系推断跨文件引用
 */
function inferCrossFileReferences(
  contracts: LinkageContract[],
  allFiles: string[],
): void {
  // 读取所有文件内容，建立组件名→文件映射
  const componentToFile = new Map<string, string>();
  for (const file of allFiles) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const name = extractComponentName(content);
      if (name) {
        componentToFile.set(name, file);
      }
    } catch { /* skip */ }
  }

  // 对于每个契约，尝试推断目标文件
  for (const contract of contracts) {
    if (contract.targetComponent && !contract.targetComponent.includes('父级')) {
      const targetFile = componentToFile.get(contract.targetComponent);
      if (targetFile) {
        contract.targetFile = targetFile;
      }
    }

    // 从 import 语句中找路径引用
    if (!contract.targetFile && contract.parameter) {
      const cleanPath = contract.parameter.replace(/['"`]/g, '');
      // 相对路径
      const sourceDir = path.dirname(contract.sourceFile);
      const resolved = path.resolve(sourceDir, cleanPath);
      // 尝试各种扩展名
      for (const ext of ['.tsx', '.jsx', '.ts', '.js', '']) {
        const candidate = resolved + ext;
        if (allFiles.includes(candidate) || fs.existsSync(candidate)) {
          contract.targetFile = candidate;
          break;
        }
      }
    }
  }
}

// ──────────────────────────────────────────────
// 主 API
// ──────────────────────────────────────────────

/**
 * 重构前：扫描所有源文件，构建联动契约
 *
 * @param workspaceRoot 项目根路径
 * @returns 联动契约列表
 */
export async function buildLinkageContracts(
  workspaceRoot: string,
): Promise<LinkageContract[]> {
  const allFiles = findTsxFiles(workspaceRoot);
  const allContracts: LinkageContract[] = [];

  for (const file of allFiles) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const contracts = analyzeFile(file, content);
      allContracts.push(...contracts);
    } catch { /* skip */ }
  }

  // 推断跨文件引用
  inferCrossFileReferences(allContracts, allFiles);

  // 去重（同一模式多次出现只保留第一个）
  const seen = new Set<string>();
  const unique: LinkageContract[] = [];
  for (const c of allContracts) {
    // 用 source + type + line 去重
    const key = `${c.sourceFile}::${c.pattern}::${Math.floor(c.lineNumber / 3)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  // 写入文件
  const reportDir = path.join(workspaceRoot, '.figma-stage', '00-linkage');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, 'contracts-before.json'),
    JSON.stringify(unique, null, 2),
  );

  return unique;
}

/**
 * 重构后：验证所有联动契约是否仍被满足
 *
 * @param workspaceRoot 项目根路径
 * @param contractsBefore 重构前的契约列表
 * @returns 验证报告
 */
export async function verifyLinkageContracts(
  workspaceRoot: string,
  contractsBefore: LinkageContract[],
): Promise<LinkageReport> {
  const allFiles = findTsxFiles(workspaceRoot);
  const allContent = new Map<string, string>();
  for (const file of allFiles) {
    try {
      allContent.set(file, fs.readFileSync(file, 'utf-8'));
    } catch { /* skip */ }
  }

  // 检查每个契约
  for (const contract of contractsBefore) {
    if (contract.pattern === 'callback_prop') {
      // 回调 prop 需要在目标组件中查找对应的调用点
      contract.verified = verifyCallbackProp(contract, allContent);
      contract.verificationDetail = contract.verified
        ? `✅ 回调 ${contract.parameter} 仍存在于目标组件中`
        : `❌ 回调 ${contract.parameter} 在重构后丢失`;
    } else if (contract.pattern === 'state_change') {
      // 状态切换应已被路由替代
      contract.verified = verifyStateChangeReplaced(contract, allContent);
      contract.verificationDetail = contract.verified
        ? `✅ 状态切换已被路由导航替代`
        : `⚠️ 可能仍有状态切换残留`;
    } else if (contract.pattern === 'console.log_drill') {
      // console.log 应被 navigate 替代
      contract.verified = verifyDrillReplaced(contract, allContent, allFiles);
      contract.verificationDetail = contract.verified
        ? `✅ 下钻跳转已转为路由导航`
        : `❌ 下钻跳转仍是 console.log，未被转换`;
    } else {
      // 通用检查：导航目标路径仍存在
      contract.verified = verifyGenericNavigation(contract, allContent, allFiles);
      contract.verificationDetail = contract.verified
        ? `✅ 导航目标仍可达`
        : `⚠️ 未能确认导航目标是否存在`;
    }
  }

  const verified = contractsBefore.filter(c => c.verified);
  const broken = contractsBefore.filter(c => !c.verified);

  const report: LinkageReport = {
    contracts: contractsBefore,
    summary: {
      total: contractsBefore.length,
      verified: verified.length,
      broken: broken.length,
      unknown: 0,
    },
    brokenContracts: broken,
  };

  // 写入报告
  const reportDir = path.join(workspaceRoot, '.figma-stage', '00-linkage');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, 'report.json'),
    JSON.stringify(report, null, 2),
  );

  return report;
}

// ──────────────────────────────────────────────
// 验证辅助
// ──────────────────────────────────────────────

/** 验证回调 prop 是否仍被传递 */
function verifyCallbackProp(
  contract: LinkageContract,
  allContent: Map<string, string>,
): boolean {
  const propName = contract.parameter;
  if (!propName) return false;

  for (const [, content] of allContent) {
    // 检查 prop 是否仍在组件 props 或 interface 中
    if (content.includes(propName)) return true;
  }
  return false;
}

/** 验证状态切换是否已被路由替代 */
function verifyStateChangeReplaced(
  contract: LinkageContract,
  allContent: Map<string, string>,
): boolean {
  // 检查 import 中是否有 react-router-dom
  for (const [, content] of allContent) {
    if (content.includes('react-router-dom')) return true;
  }
  return false;
}

/** 验证 console.log 下钻是否被 navigate 替代 */
function verifyDrillReplaced(
  contract: LinkageContract,
  allContent: Map<string, string>,
  allFiles: string[],
): boolean {
  // 检查原文件中是否还有 console.log 下钻
  if (allContent.has(contract.sourceFile)) {
    const content = allContent.get(contract.sourceFile)!;
    if (content.includes('console.log') && (content.includes('下钻') || content.includes('跳转'))) {
      return false; // 还没被改
    }
  }
  // 检查是否有 navigate 出现
  for (const file of allFiles) {
    const content = allContent.get(file);
    if (content && content.includes('navigate(')) return true;
  }
  return false;
}

/** 通用导航验证 */
function verifyGenericNavigation(
  contract: LinkageContract,
  allContent: Map<string, string>,
  allFiles: string[],
): boolean {
  // 检查目标组件是否存在
  if (contract.targetComponent && !contract.targetComponent.includes('父级')) {
    for (const [, content] of allContent) {
      if (content.includes(contract.targetComponent)) return true;
    }
  }
  // 检查目标路径是否在 router 中出现
  if (contract.parameter) {
    const cleanPath = contract.parameter.replace(/['"`]/g, '');
    for (const file of allFiles) {
      const content = allContent.get(file);
      if (content && content.includes(cleanPath)) return true;
    }
  }
  return false;
}

// ──────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────

function findTsxFiles(root: string): string[] {
  const results: string[] = [];
  const walkDir = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== '.figma-stage' && entry.name !== 'out') {
            walkDir(fullPath);
          }
        } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx')) {
          results.push(fullPath);
        }
      }
    } catch { /* skip */ }
  };
  walkDir(root);
  return results;
}

/**
 * 将联动契约格式化为 Prompt 可读的约束文本
 */
export function formatLinkageConstraints(contracts: LinkageContract[]): string {
  if (contracts.length === 0) return '';

  // 按类型分组
  const navContracts = contracts.filter(c =>
    ['console.log_drill', 'useNavigate_call', 'onClick_navigate', 'Link_component', 'anchor_href'].includes(c.pattern),
  );
  const callbackContracts = contracts.filter(c => c.pattern === 'callback_prop');
  const stateContracts = contracts.filter(c => c.pattern === 'state_change');
  const importContracts = contracts.filter(c => c.pattern === 'import_reference');

  const parts: string[] = [];
  parts.push('# 🔗 跨页联动契约（必须保持的页面间导航）');
  parts.push('');

  if (navContracts.length > 0) {
    parts.push('## 页面导航（必须保留）');
    parts.push('| 源组件 | 导航模式 | 目标/参数 | 行号 |');
    parts.push('|--------|---------|----------|------|');
    for (const c of navContracts) {
      parts.push(`| ${c.sourceComponent} | ${c.pattern} | ${c.parameter || c.targetComponent || '-'} | L${c.lineNumber} |`);
    }
    parts.push('');
    parts.push('转换规则：');
    parts.push('- console.log 下钻 → React Router navigate()');
    parts.push('- <a href> → <Link to> 或 navigate()');
    parts.push('- 参数必须通过路由参数传递（/detail/:id）');
    parts.push('');
  }

  if (callbackContracts.length > 0) {
    parts.push('## 回调传递（必须贯通）');
    for (const c of callbackContracts) {
      parts.push(`- ${c.sourceComponent} 的 ${c.parameter} prop 必须传递到父级路由`);
    }
    parts.push('');
  }

  if (stateContracts.length > 0) {
    parts.push('## 状态切换（必须替换为路由）');
    parts.push('以下状态切换必须转换为 React Router 导航：');
    for (const c of stateContracts) {
      parts.push(`- ${c.sourceFile}:${c.lineNumber} → ${c.originalSnippet.slice(0, 60)}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}
