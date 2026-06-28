/**
 * HTML 结构基线（Structure Baseline）
 *
 * 通用解决方案，解决"HTML 黄金基准 vs React 重构保真度"问题。
 *
 * 原理：
 *   1. 扫描项目中所有 .html 文件
 *   2. 对每个 .html 匹配同名的 .jsx/.tsx 文件（同一设计的不同导出格式）
 *   3. 提取 HTML DOM 结构指纹（标签树 + 文本内容 + 交互元素）
 *   4. 后续 LLM Stage 的 Prompt 中注入此结构约束，
 *      要求重构后的 React 代码保持相同的 DOM 骨架
 *
 * 匹配规则：
 *   - test.html  ↔ test.jsx / test.tsx (同名不同后缀)
 *   - index.html ↔ App.tsx / index.tsx (fallback)
 */

import * as fs from 'fs';
import * as path from 'path';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/** DOM 节点指纹 */
export interface DomNodeFingerprint {
  tag: string;
  /** 直接文本内容（trimmed） */
  text?: string;
  /** 关键属性白名单（id, class, role, type, href, src, alt, placeholder, aria-*） */
  attributes: Record<string, string>;
  children: DomNodeFingerprint[];
  /** 结构路径标识，如 "div.div.table.tbody.tr.td.button" */
  structuralPath: string;
  /** 在父级中的索引 */
  index: number;
}

/** 交互元素记录（按钮、链接、输入框等） */
export interface InteractiveElement {
  tag: string;
  structuralPath: string;
  text: string;
  attributes: Record<string, string>;
  /** 可能关联的交互意图 */
  intent?: 'navigation' | 'submit' | 'filter' | 'pagination' | 'modal' | 'unknown';
}

/** 单个 HTML 文件的基线 */
export interface HtmlFileBaseline {
  htmlFile: string;
  matchedJsxFile: string | null;
  structure: DomNodeFingerprint;
  interactiveElements: InteractiveElement[];
  allTextContent: string[];
  /** 页面标题 / h1 / h2 等标识性文本 */
  pageIdentity: string[];
}

/** 完整基线报告 */
export interface HtmlBaselineReport {
  reportFile: string;
  files: HtmlFileBaseline[];
  summary: string;
}

// ──────────────────────────────────────────────
// 解析器（轻量 HTML DOM 解析，无第三方依赖）
// ──────────────────────────────────────────────

/**
 * 极简 HTML 解析器 — 只提取结构指纹所需的信息。
 * 不依赖 jsdom/cheerio，避免增加依赖。
 */
class SimpleHtmlParser {
  private html: string;
  private pos: number = 0;

  constructor(html: string) {
    this.html = html;
  }

  /** 解析完整文档 */
  parseDocument(): DomNodeFingerprint {
    // 跳过 DOCTYPE
    this.skipDoctype();
    // 跳过 <html><head>... 直接解析 <body> 内容
    // 但为了结构完整性，解析整个树
    const node = this.parseNode();
    return node || this.createEmptyNode('root');
  }

  private createEmptyNode(tag: string): DomNodeFingerprint {
    return { tag, attributes: {}, children: [], structuralPath: tag, index: 0 };
  }

  private skipDoctype(): void {
    const doctypeMatch = this.html.slice(this.pos).match(/^<!DOCTYPE\s+[^>]*>/i);
    if (doctypeMatch) {
      this.pos += doctypeMatch[0].length;
    }
  }

  private parseNode(): DomNodeFingerprint | null {
    this.skipWhitespace();

    if (this.pos >= this.html.length) return null;

    // 检查是否是闭合标签
    if (this.html[this.pos] === '<' && this.html[this.pos + 1] === '/') {
      return null;
    }

    // 检查是否是注释
    if (this.html.slice(this.pos).startsWith('<!--')) {
      const end = this.html.indexOf('-->', this.pos);
      if (end !== -1) this.pos = end + 3;
      return this.parseNode(); // 跳过注释
    }

    // 检查是否是 script/style 的内联文本
    if (this.html[this.pos] !== '<') {
      return this.parseTextNode();
    }

    // 解析标签
    const tagMatch = this.html.slice(this.pos).match(/^<(\w[\w-]*)/);
    if (!tagMatch) {
      // 跳过无法识别的 <
      this.pos++;
      return this.parseNode();
    }

    const tag = tagMatch[1].toLowerCase();
    this.pos += tagMatch[0].length;

    // 跳过 self-closing 标签
    if (['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr'].includes(tag)) {
      const selfClosingAttrs = this.parseAttributes();
      this.skipToTagEnd();
      return {
        tag,
        attributes: selfClosingAttrs,
        children: [],
        structuralPath: tag,
        index: 0,
      };
    }

    // 跳过 script/style 内容
    if (tag === 'script' || tag === 'style') {
      this.skipToClosingTag(tag);
      return null; // 不索引 script/style
    }

    // 解析属性
    const attributes = this.parseAttributes();

    // 跳过标签结尾
    this.skipToTagEnd();

    // 解析子节点
    const children: DomNodeFingerprint[] = [];
    let childIndex = 0;
    while (this.pos < this.html.length) {
      this.skipWhitespace();

      // 检查是否到达闭合标签
      if (this.html.slice(this.pos).startsWith(`</${tag}`)) {
        break;
      }

      // 跳过注释
      if (this.html.slice(this.pos).startsWith('<!--')) {
        const end = this.html.indexOf('-->', this.pos);
        if (end !== -1) this.pos = end + 3;
        continue;
      }

      const child = this.parseNode();
      if (child) {
        child.index = childIndex++;
        children.push(child);
      } else {
        // parseNode 返回 null（空文本等），继续下一个
        this.pos++;
        if (this.pos >= this.html.length) break;
        continue;
      }
    }

    // 跳过闭合标签
    const closeMatch = this.html.slice(this.pos).match(new RegExp(`^</${tag}\\s*>`));
    if (closeMatch) {
      this.pos += closeMatch[0].length;
    }

    // 提取直接文本内容
    let text: string | undefined;
    if (children.length === 0 || (children.length === 1 && !children[0].children.length && !Object.keys(children[0].attributes).length)) {
      const textContent = this.extractDirectText(children);
      if (textContent) text = textContent;
    }

    return {
      tag,
      text,
      attributes,
      children,
      structuralPath: tag,
      index: 0,
    };
  }

  private parseTextNode(): DomNodeFingerprint | null {
    const end = this.html.indexOf('<', this.pos);
    if (end === -1) return null;

    const text = this.html.slice(this.pos, end).trim();
    this.pos = end;

    if (!text) return null;

    return {
      tag: '#text',
      text,
      attributes: {},
      children: [],
      structuralPath: '#text',
      index: 0,
    };
  }

  private parseAttributes(): Record<string, string> {
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w[\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
    let match;

    while (this.pos < this.html.length) {
      this.skipWhitespace();
      if (this.html[this.pos] === '>' || this.html[this.pos] === '/') break;

      attrRegex.lastIndex = 0;
      const remaining = this.html.slice(this.pos);
      match = attrRegex.exec(remaining);

      if (match && match.index === 0) {
        const name = match[1].toLowerCase();
        // 白名单：只保留结构相关的属性
        if (['id', 'class', 'role', 'type', 'href', 'src', 'alt', 'placeholder',
             'aria-label', 'aria-hidden', 'aria-modal', 'aria-current',
             'data-testid', 'name', 'value', 'for', 'action', 'method'].includes(name)) {
          attrs[name] = match[2] || match[3] || match[4] || '';
        }
        this.pos += match[0].length;
      } else {
        break;
      }
    }
    return attrs;
  }

  private skipWhitespace(): void {
    while (this.pos < this.html.length && /\s/.test(this.html[this.pos])) {
      this.pos++;
    }
  }

  private skipToTagEnd(): void {
    while (this.pos < this.html.length && this.html[this.pos] !== '>') {
      this.pos++;
    }
    if (this.pos < this.html.length) this.pos++;
  }

  private skipToClosingTag(tag: string): void {
    const closeRegex = new RegExp(`</${tag}\\s*>`);
    const match = this.html.slice(this.pos).match(closeRegex);
    if (match) {
      this.pos += match.index! + match[0].length;
    } else {
      this.pos = this.html.length;
    }
  }

  private extractDirectText(children: DomNodeFingerprint[]): string | undefined {
    const texts = children
      .filter(c => c.tag === '#text')
      .map(c => c.text?.trim())
      .filter(Boolean);
    return texts.length > 0 ? texts.join(' ') : undefined;
  }
}

// ──────────────────────────────────────────────
// 交互元素识别
// ──────────────────────────────────────────────

function inferIntent(el: InteractiveElement): 'navigation' | 'submit' | 'filter' | 'pagination' | 'modal' | 'unknown' {
  const text = el.text.toLowerCase();
  const attrs = el.attributes;

  if (text.includes('上一页') || text.includes('下一页') || /^\d+$/.test(text.trim())) {
    return 'pagination';
  }
  if (text.includes('搜索') || text.includes('过滤') || text.includes('filter') || text.includes('search')) {
    return 'filter';
  }
  if (text.includes('批准') || text.includes('驳回') || text.includes('approve') || text.includes('reject')) {
    return 'submit';
  }
  if (el.tag === 'a' || text.includes('返回') || text.includes('详情') || text.includes('跳转') || text.includes('drill') || text.includes('下钻')) {
    return 'navigation';
  }
  if (attrs['role'] === 'dialog' || attrs['aria-modal'] === 'true') {
    return 'modal';
  }
  return 'unknown';
}

function extractInteractiveElements(
  node: DomNodeFingerprint,
  basePath: string,
): InteractiveElement[] {
  const results: InteractiveElement[] = [];
  const currentPath = basePath ? `${basePath}.${node.structuralPath}` : node.structuralPath;

  const interactiveTags = ['button', 'a', 'input', 'select', 'textarea', 'details', 'summary'];
  const interactiveRoles = ['button', 'link', 'tab', 'menuitem', 'option'];

  if (interactiveTags.includes(node.tag) || interactiveRoles.includes(node.attributes['role'] || '')) {
    const el: InteractiveElement = {
      tag: node.tag,
      structuralPath: currentPath,
      text: node.text || node.attributes['aria-label'] || node.attributes['placeholder'] || '',
      attributes: { ...node.attributes },
    };
    el.intent = inferIntent(el);
    results.push(el);
  }

  for (const child of node.children) {
    results.push(...extractInteractiveElements(child, currentPath));
  }

  return results;
}

function extractAllText(node: DomNodeFingerprint): string[] {
  const texts: string[] = [];
  if (node.text && node.text.length > 2) texts.push(node.text);
  for (const child of node.children) {
    texts.push(...extractAllText(child));
  }
  return texts;
}

function extractPageIdentity(node: DomNodeFingerprint): string[] {
  const identity: string[] = [];
  // 从 h1, h2, title 中提取
  for (const child of node.children) {
    if (['h1', 'h2', 'h3', 'title'].includes(child.tag) && child.text) {
      identity.push(child.text);
    }
    identity.push(...extractPageIdentity(child));
  }
  return identity;
}

// ──────────────────────────────────────────────
// 主 API
// ──────────────────────────────────────────────

/**
 * 为 DOM 树中的每个节点计算结构路径
 * 根节点路径 = tag, 子节点路径 = parentPath + '.' + child.tag
 */
function assignStructuralPaths(
  node: DomNodeFingerprint,
  parentPath: string = '',
): void {
  const fullPath = parentPath ? `${parentPath}.${node.tag}` : node.tag;
  node.structuralPath = fullPath;
  for (let i = 0; i < node.children.length; i++) {
    assignStructuralPaths(node.children[i], fullPath);
  }
}

/**
 * 从 workspace 中扫描所有 HTML 文件，构建结构基线
 *
 * @param workspaceRoot 项目根路径
 * @returns 基线报告
 */
export async function buildHtmlBaseline(
  workspaceRoot: string,
): Promise<HtmlBaselineReport> {
  // 1. 扫描 HTML 文件
  const htmlFiles = findHtmlFiles(workspaceRoot);

  if (htmlFiles.length === 0) {
    return {
      reportFile: '',
      files: [],
      summary: '未发现 HTML 文件，跳过结构基线',
    };
  }

  // 2. 匹配 JSX/TSX 文件
  const filePairs = matchJsxFiles(htmlFiles, workspaceRoot);

  // 3. 逐个解析
  const fileBaselines: HtmlFileBaseline[] = [];

  for (const pair of filePairs) {
    const htmlContent = fs.readFileSync(pair.htmlPath, 'utf-8');
    const parser = new SimpleHtmlParser(htmlContent);
    const dom = parser.parseDocument();

    // 计算结构路径
    assignStructuralPaths(dom);

    const interactiveElements = extractInteractiveElements(dom, '');
    const allTextContent = extractAllText(dom);
    const pageIdentity = extractPageIdentity(dom);

    fileBaselines.push({
      htmlFile: pair.relativePath,
      matchedJsxFile: pair.matchedJsx ? pair.matchedJsxRelative : null,
      structure: dom,
      interactiveElements,
      allTextContent,
      pageIdentity,
    });
  }

  // 4. 写入报告
  const reportDir = path.join(workspaceRoot, '.figma-stage', '00-html-baseline');
  fs.mkdirSync(reportDir, { recursive: true });

  const report: HtmlBaselineReport = {
    reportFile: path.join(reportDir, 'baseline.json'),
    files: fileBaselines,
    summary: `发现 ${fileBaselines.length} 对 HTML ↔ JSX 匹配，共 ${fileBaselines.reduce((s, f) => s + f.interactiveElements.length, 0)} 个交互元素`,
  };

  fs.writeFileSync(report.reportFile, JSON.stringify(report, null, 2));

  return report;
}

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

interface FilePair {
  htmlPath: string;
  relativePath: string;
  matchedJsx: string | null;
  matchedJsxRelative: string | null;
}

function findHtmlFiles(root: string): string[] {
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
        } else if (entry.name.endsWith('.html')) {
          results.push(fullPath);
        }
      }
    } catch { /* skip */ }
  };
  walkDir(root);
  return results;
}

function matchJsxFiles(htmlFiles: string[], root: string): FilePair[] {
  return htmlFiles.map((htmlPath) => {
    const parsed = path.parse(htmlPath);
    const relativePath = path.relative(root, htmlPath);

    // 尝试匹配同名 .jsx 或 .tsx
    const possibleJsx = path.join(parsed.dir, `${parsed.name}.jsx`);
    const possibleTsx = path.join(parsed.dir, `${parsed.name}.tsx`);

    let matchedJsx: string | null = null;
    let matchedJsxRelative: string | null = null;

    if (fs.existsSync(possibleJsx)) {
      matchedJsx = possibleJsx;
      matchedJsxRelative = path.relative(root, possibleJsx);
    } else if (fs.existsSync(possibleTsx)) {
      matchedJsx = possibleTsx;
      matchedJsxRelative = path.relative(root, possibleTsx);
    }

    return { htmlPath, relativePath, matchedJsx, matchedJsxRelative };
  });
}

/**
 * 从已保存的报告加载基线
 */
export function loadHtmlBaseline(workspaceRoot: string): HtmlBaselineReport | null {
  const reportPath = path.join(workspaceRoot, '.figma-stage', '00-html-baseline', 'baseline.json');
  try {
    return JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 将 HTML 基线转成 Prompt 可读的结构约束文本
 */
export function formatBaselineConstraint(report: HtmlBaselineReport): string {
  if (report.files.length === 0) return '';

  const parts: string[] = [];
  parts.push('# 🏛️ HTML 结构保真约束（黄金基准）');
  parts.push('');
  parts.push(`以下 HTML 文件是 UI 的黄金基准，重构后的 React 代码必须保持相同的 DOM 结构：`);
  parts.push('');

  for (const file of report.files) {
    parts.push(`## 基准文件: ${file.htmlFile}`);
    if (file.matchedJsxFile) {
      parts.push(`对应源文件: ${file.matchedJsxFile}`);
    }
    parts.push('');

    // 页面标识
    if (file.pageIdentity.length > 0) {
      parts.push(`页面标识: ${file.pageIdentity.join(' | ')}`);
      parts.push('');
    }

    // 交互元素 — 必须保留
    parts.push('### 交互元素（必须保留且功能一致）');
    parts.push('| 元素 | 路径 | 文本 | 意图 |');
    parts.push('|------|------|------|------|');
    for (const el of file.interactiveElements) {
      const shortPath = el.structuralPath.length > 60
        ? '...' + el.structuralPath.slice(-57)
        : el.structuralPath;
      parts.push(`| <${el.tag}> | ${shortPath} | ${el.text || '-'} | ${el.intent} |`);
    }
    parts.push('');

    // 结构约束规则
    parts.push('### 结构保真规则');
    parts.push('1. 所有交互元素（上表）必须在重构后的代码中以同等功能存在');
    parts.push('2. 页面层级结构（section/div 嵌套层次）不得扁平化或重组');
    parts.push('3. 文本内容（按钮文字、表头、标签）不得随意更改');
    parts.push('4. 分页控件、筛选栏、表格结构必须保持');
    parts.push('5. 允许：样式优化（内联→Tailwind）、组件提取、代码拆分');
    parts.push('6. 禁止：删除交互元素、合并不同层级的 DOM、改变表单字段结构');
    parts.push('');
  }

  return parts.join('\n');
}
