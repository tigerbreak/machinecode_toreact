# Figma 机翻代码 → 可维护 React UI · 工作流

基于 **VS Code `vscode.lm` API + Gemini 模型** 的多阶段 Prompt 编排系统。

将 Figma 导出的"机翻"单页 React 代码，自动重构为可维护的**多页 React 项目**，
并自动保证 **HTML 结构保真度** 和 **跨页联动正确性**。

---

## 工作流总览（11 阶段）

```
 0. 项目脚手架 ────── 创建目录、依赖、路由骨架
 0.5 结构基线+联动契约  🏛️🔗   ← 新增
     ├─ 读取 .html 黄金基准 → DOM 结构指纹
     └─ 扫描 .jsx 导航意图 → 联动契约
 ──────────────────────────────────────
 1. 代码审计
 2. 结构分解 (单页→多页) 🛠️+🏛️+🔗  ← 注入约束
 2.5 联动验证              🔗       ← 新增
     └─ 重构后验证所有页面导航是否断裂
 ──────────────────────────────────────
 3. 组件提取 🛠️
 4. 样式提取 (内联→Tailwind)
 5. TypeScript 增强
 6. 可访问性增强
 7. 数据层分离
 8. 最终清理
```

---

## 先决条件

| 条件 | 说明 |
|------|------|
| **VS Code** | 最新稳定版 |
| **GitHub Copilot** | 已登录并启用（提供 Gemini 模型访问） |
| **Node.js** | ≥ 18.x |
| **Figma 导出** | 同时有 `.html`（UI 基准）和 `.jsx`/`.tsx`（机翻代码）|

---

## 快速开始

### 1. 准备你的 Figma 导出项目

```
你的-figma-项目/
├── test.html          ← UI 黄金基准（从 Figma 导出）
├── test.jsx           ← 机翻 React 代码（从 Figma 导出）
├── test02.html        ← 第二页 UI 基准
├── test02.jsx         ← 第二页机翻代码
└── ...其他文件...
```

> 匹配规则：工作流自动根据文件名配对（`test.html ↔ test.jsx`）。
> 无 HTML 文件时，结构基线阶段自动跳过。

### 2. 启动工作流

```bash
# 方式 A：把本项目直接作为开发环境
git clone https://github.com/tigerbreak/machinecode_toreact.git
cd machinecode_toreact
npm install && npm run compile
cp /path/to/你的-figma-导出/*.{html,jsx,tsx} .
# F5 启动 Extension Host → 打开当前文件夹

# 方式 B：把工作流集成到你的 Figma 项目
cd 你的-figma-项目
npm init -y
npm install -D typescript @types/vscode
# 复制 src/ tsconfig.json package.json 到项目根目录
npm install && npm run compile
# F5 启动
```

### 3. 运行阶段

```
Cmd+Shift+P → "Figma Refactor: Start Workflow"
```

在弹出的 QuickPick 菜单中选择阶段（支持多选）：

```
☐ 0.  项目脚手架
☑ 0.5 结构基线 + 联动契约 🏛️🔗    ← 首次运行建议必选
☑ 1.  代码审计
☑ 2.  结构分解 🛠️+🏛️+🔗
☐ 2.5 联动验证 🔗                   ← 结构分解后运行
☐ 3.  组件提取 🛠️
☐ 4.  样式提取
☐ 5.  TypeScript 增强
☐ 6.  可访问性增强
☐ 7.  数据层分离
☐ 8.  最终清理
```

> 推荐首次使用选择 **0.5 + 1 + 2**，确认结果后再继续后续阶段。

### 4. 人工确认

每个阶段 LLM 输出后，VS Code 会弹出并排 Diff 编辑器让你确认变更：
- ✅ **Approve** → 写入文件，进入下一阶段
- 🔄 **Retry** → 重新生成（语法错误时自动触发）
- ⏭ **Skip** → 跳过本阶段
- ⛔ **Abort** → 终止整个工作流

---

## 核心特性

### 🏛️ HTML 结构保真度

工作流读取 `.html` 文件作为**黄金基准**，提取：
- **DOM 树结构指纹**（标签层级、嵌套深度）
- **交互元素清单**（按钮、输入框、分页控件等）
- **文本内容清单**（按钮文字、表头、标签等）

结构约束注入到 LLM Prompt，要求：
> ✅ 交互元素全部保留，功能等价
> ✅ DOM 层级不得合并或扁平化
> ✅ 分页控件、筛选栏、表格列数必须一致
> ❌ 禁止删除交互元素、合并 DOM、改变表单结构

### 🔗 跨页联动契约

重构前扫描所有 JSX 文件，识别导航模式：

| 模式 | 自动检测 |
|------|---------|
| `console.log('下钻跳转', id)` | → 转为 `navigate(/detail/:id)` |
| `onBack` prop | → 转为 `navigate(-1)` |
| `setShowXxx / setCurrentView` | → 转为 React Router 路由 |
| `<a href="/path">` | → 转为 `<Link to="/path">` |

重构后自动验证所有契约是否断裂，并在 Stage 2.5 生成报告。

---

## 测试用例

项目内置测试用例，用于验证工作流的核心逻辑：

```
test-fixtures/
├── test.html          ← 第一页 UI 基准（全球时间沉积物总账）
├── test.jsx           ← 第一页机翻代码（含脏数据池、分页、过滤）
├── test02.html        ← 第二页 UI 基准（用户详情+审批）
└── test02.jsx         ← 第二页机翻代码（含 Chart.js、审批工作流）
```

验证方式：

```bash
npm run compile
node -e "
const { buildHtmlBaseline } = require('./out/html-baseline.js');
const { buildLinkageContracts } = require('./out/linkage-verifier.js');

(async () => {
  const baseline = await buildHtmlBaseline('./test-fixtures');
  console.log('🏛️  HTML 基线:', baseline.files.length, '文件配对');
  baseline.files.forEach(f => {
    console.log('   ', f.htmlFile, '↔', f.matchedJsxFile);
    console.log('   ', f.interactiveElements.length, '交互元素,', f.pageIdentity);
  });

  const contracts = await buildLinkageContracts('./test-fixtures');
  console.log('\\n🔗  联动契约:', contracts.length, '个');
  const nav = contracts.filter(c => c.pattern === 'console.log_drill');
  const cb = contracts.filter(c => c.pattern === 'callback_prop');
  console.log('   导航:', nav.length, '回调:', cb.length);
})();
"
```

预期输出：

```
🏛️  HTML 基线: 2 文件配对
   test.html ↔ test.jsx  (8 交互元素)
   test02.html ↔ test02.jsx  (3 交互元素)
🔗  联动契约: 5 个
   导航: 1 (第1页→第2页)  回调: 1 (第2页→第1页)
```

---

## 项目结构

```
src/
├── extension.ts              # VS Code 扩展入口（注册命令 + QuickPick）
├── workflow-engine.ts        # 多阶段编排引擎（Prompt→LLM→AST→Diff）
├── ast-guard.ts              # 语法检查卡点（esbuild → tsc 两级回退）
├── html-baseline.ts          # 🆕 HTML 结构基线提取器 + DOM 解析
├── linkage-verifier.ts       # 🆕 跨页联动契约构建 + 验证
└── prompts/
    ├── base-prompt.ts        # 共享基础 Prompt（设计令牌 + 结构保真 + 联动约束）
    ├── stage0-scaffold.ts    # 项目脚手架
    ├── stage1-audit.ts       # 代码审计
    ├── stage2-decompose.ts   # 结构分解（注入 🏛️+🔗 约束）
    ├── stage3-extract.ts     # 组件提取
    ├── stage4-style.ts       # 样式提取
    ├── stage5-types.ts       # TypeScript 增强
    ├── stage6-a11y.ts        # 可访问性增强
    ├── stage7-data.ts        # 数据层分离
    └── stage8-polish.ts      # 最终清理
```

---

## 设计文档

详见 [DESIGN.md](./DESIGN.md) 了解架构设计、阶段数据流、失败恢复策略。

