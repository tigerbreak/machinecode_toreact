# Figma 机翻 React 代码 → 可维护多页 UI · 工作流设计方案

## 目录
1. [问题分析](#1-问题分析)
2. [解决方案全景](#2-解决方案全景)
3. [工作流设计](#3-工作流设计)
4. [核心 LLM Prompt 设计](#4-核心-llm-prompt-设计)
5. [关键技术决策](#5-关键技术决策)
6. [使用流程](#6-使用流程)
7. [预期效果对比](#7-预期效果对比)

---

## 1. 问题分析

### 1.1 为什么 Figma 导出的代码像"机翻"？

Figma 插件（Anima、Locofy、Figma to Code 等）的导出逻辑本质上是**将视觉树直接映射到 React DOM**，如同 Google Translate 逐词翻译——语法可能对，但读起来不像人写的。

#### 典型输入示例（真实 Figma 导出）：

```tsx
// figma-exported.tsx — 单文件 800+ 行
export default function App() {
  const [showPage2, setShowPage2] = useState(false);
  const [showPage3, setShowPage3] = useState(false);

  return (
    <div style={{ width: '100%', height: '100vh', position: 'relative' as const, background: '#FFF' }}>
      {/* 首页 */}
      {!showPage2 && !showPage3 && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '16px 24px', background: '#FFFFFF', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
            <img src="/logo.png" style={{ width: 32, height: 32 }} />
            <span style={{ fontSize: 18, fontWeight: 600, color: '#1A1A1A', marginLeft: 12 }}>平台名称</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {['功能', '定价', '关于'].map(item => (
                <button key={item} onClick={() => { /* 跳转逻辑？ */ }}
                  style={{ padding: '8px 16px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, color: '#666' }}>
                  {item}
                </button>
              ))}
              <button onClick={() => setShowPage2(true)}
                style={{ padding: '8px 20px', border: 'none', borderRadius: 8, background: '#4F46E5', color: '#FFF', cursor: 'pointer', fontSize: 14 }}>
                开始
              </button>
            </div>
          </div>
          {/* ... 往下 400 行，hero, features, footer 全部嵌套在 div 里 */}
        </div>
      )}

      {/* 页面2: 仪表盘 */}
      {showPage2 && !showPage3 && (
        <div style={{ display: 'flex', height: '100vh' }}>
          {/* 侧边栏: 80 行 */}
          {/* 主内容: 200 行 */}
        </div>
      )}

      {/* 页面3: 详情 */}  
      {showPage3 && (
        <div>{/* 150 行 */}</div>
      )}
    </div>
  );
}
```

### 1.2 五大类问题

| 类别 | 具体问题 | 后果 |
|------|---------|------|
| **🏗️ 结构** | 单页条件渲染模拟多页 | 不可路由、不可直接访问子页 |
| | 状态耦合 (`setShowPage2` 分散各处) | 改一处崩三处 |
| | 没有路由边界 | 无法懒加载、无法 SEO |
| **🧩 组件** | 800+ 行巨型组件 | 不可维护、不可测试 |
| | 无 props 接口 | 改样式得全文搜索 |
| | UI 副本重复（3处按钮=3份代码） | 改主题色要改 10+ 处 |
| **🎨 样式** | 内联 `style={{}}` 满天飞 | 无复用、无主题、无响应式 |
| | 魔数 (`marginTop: 17`, `gap: 11`) | 不知道为什么是 17 |
| | 固定像素 | 手机端直接崩 |
| **📝 类型** | `any` / 无类型 | 重构无安全网 |
| | 事件处理 `onClick={(e)=>...}` 裸奔 | 无类型推导 |
| **♿ 可访问性** | 所有元素都是 `<div>` | 读屏软件无法使用 |
| | 无 alt / aria 属性 | WCAG 不达标 |

### 1.3 问题规模估算

对于一份典型的 Figma 导出（6 个页面设计稿）：

```
源文件: 1 个 .tsx, ~1200 行
内联样式: ~80 处
条件渲染切换: ~5 处
隐式"页面": 4~6 个
可提取组件: 15~25 个
硬编码数据: 30~50 处
可访问性缺陷: 30+ 处
```

人工重构需要 2~3 天。此工作流可将时间压缩到 **30 分钟**（10 分钟 LLM 处理 + 20 分钟人工确认）。

---

## 2. 解决方案全景

### 2.1 核心理念：渐进式管道

不是一次性让 LLM 重写所有代码（那样会丢失控制），而是**8 个独立的阶段，每个阶段只做一件事**：

```
Figma 导出代码
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 0: 项目脚手架                                     │
│  (确保 Vite + React Router + Tailwind 就绪)              │
└─────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 1: 代码审计 (Code Audit)                          │
│  → 组件树 + 路由映射 + 问题清单                          │
│  → 生成 .figma-audit.json (人工审阅)                     │
└─────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 2: 结构分解 (单页 → 多页)                         │
│  → 按路由拆分为 pages/*.tsx                             │
│  → 条件渲染 → React Router                              │
│  → 状态解耦                                              │
└─────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 3: 组件提取                                       │
│  → 识别重复 UI → 提取为 components/*.tsx                │
│  → 添加 props 接口 + forwardRef + className 合并         │
└─────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 4: 样式提取                                       │
│  → 内联 style → Tailwind 类名                            │
│  → 提取设计令牌 (tokens.ts)                              │
│  → CSS Modules (复杂场景)                                │
└─────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 5: TypeScript 增强                                │
│  → 所有 props 有接口, 无 any, discriminated union        │
└─────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 6: 可访问性增强                                    │
│  → 语义标签 + ARIA + 键盘导航                            │
└─────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 7: 数据层分离                                     │
│  → 硬编码 → data/*.ts                                   │
│  → API 调用 → hooks/*.ts                               │
│  → 格式化 → utils/*.ts                                  │
└─────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 8: 最终清理                                       │
│  → 删除死代码, 排序 imports, 统一命名, lint              │
└─────────────────────────────────────────────────────────┘
      │
      ▼
可维护的 React 多页 UI ✅
```

### 2.2 为什么用 vscode.lm 而不是直接调 OpenAI API？

| 因素 | vscode.lm | 直接调 API |
|------|-----------|-----------|
| **认证** | 用户已登录 Copilot | 需自行管理 API Key |
| **模型** | 自动选择最佳可用模型 | 硬编码 model name |
| **上下文** | 自动注入工作区文件 | 需手动管理上下文窗口 |
| **安全** | 代码不出 VS Code 进程 | 需过网络 |
| **成本** | 用户已有 Copilot 订阅 | 额外 API 费用 |
| **体验** | 一个 F5 搞定 | 需单独搭建环境 |

`vscode.lm.sendChatRequest()` 是 **VS Code 1.96+** 官方 API，用 Copilot 的底层模型，零配置。

### 2.3 vscode.lm API 使用详解

```typescript
// 核心 API 调用
const [model] = await vscode.lm.selectChatModels({
  vendor: 'copilot',     // 使用 Copilot
  family: 'gpt-4o',      // 首选模型
});

// 如果没有特定模型，获取任意可用模型
const models = await vscode.lm.selectChatModels({});

// 发送请求
const response = await vscode.lm.sendChatRequest(
  model,
  messages,              // LanguageModelChatMessage[]
  { maxOutputTokens: 16384 }
);

// 读取流式响应
for await (const chunk of response.text) {
  result += chunk;
}
```

---

## 3. 工作流设计

### 3.1 阶段详解

#### Stage 0: 项目脚手架

**目标**: 确保项目骨架就绪，不会因缺少依赖导致重构失败。

**产出**:
- `package.json` (React 19 + Vite + Tailwind + React Router v7)
- `src/router.tsx` (路由骨架)
- `src/pages/`, `src/components/`, `src/hooks/`, etc. 目录

**关键设计**:
- 路由使用 `lazy()` + `Suspense`，后续阶段新增页面自动适配
- 不覆盖已有 `package.json`，仅补充缺失依赖

#### Stage 1: 代码审计

**目标**: 让 LLM 全面扫描代码，生成三个人工可读的产出物。

**产出**:
1. **组件树** — 可视化当前组件嵌套结构
2. **路由映射** — 识别哪些 div 是"隐式页面"
3. **问题清单** — 分类别、严重程度、带行号

**审计示例**:
```json
{
  "componentTree": {
    "name": "App",
    "children": [
      { "name": "HeroSection", "props": [] },
      { "name": "FeatureCard", "props": [] },
      { "name": "DashboardSidebar", "props": [] },
      { "name": "DataTable", "props": [] }
    ]
  },
  "routeMap": [
    { "path": "/", "component": "LandingPage", "label": "首页" },
    { "path": "/dashboard", "component": "DashboardPage", "label": "仪表盘" },
    { "path": "/details", "component": "DetailsPage", "label": "详情" }
  ],
  "issues": [
    {
      "severity": "error",
      "category": "structure",
      "message": "三个页面通过 useState 切换，无法直接访问子页面 URL",
      "file": "App.tsx",
      "line": 3,
      "suggestion": "拆分为路由页面，使用 react-router-dom 的 createBrowserRouter"
    }
  ]
}
```

#### Stage 2: 结构分解

**目标**: 将条件渲染的"假页面"变成真正的路由页面。

**转换模式**:
```tsx
// BEFORE: Figma 式条件渲染
const [page, setPage] = useState<'home' | 'dashboard'>('home');
return (
  <>
    {page === 'home' && <HomeView onNavigate={() => setPage('dashboard')} />}
    {page === 'dashboard' && <DashboardView />}
  </>
);

// AFTER: React Router
// src/pages/Home.tsx
export default function Home() {
  const navigate = useNavigate();
  return <HomeView onNavigate={() => navigate('/dashboard')} />;
}

// src/router.tsx
createBrowserRouter([
  { path: '/', element: <Layout />, children: [
    { index: true, element: <Navigate to="/home" /> },
    { path: 'home', element: <Home /> },
    { path: 'dashboard', element: <Dashboard /> },
  ]}
]);
```

**关键设计**:
- 保留 `navigate` 调用，不改变跳转逻辑
- 每个页面独立文件、独立状态
- 共享的 layout 提取到 `components/Layout.tsx`

#### Stage 3: 组件提取

**目标**: 从页面中提取可复用的 UI 原子。

**提取策略**:
1. LLM 分析所有页面文件，识别重复模式
2. 提取条件：同一个 UI 出现 ≥ 2 次，或者虽然是单次但逻辑足够复杂
3. 每个组件满足标准：

```tsx
// 提取后的组件标准模板
interface ButtonProps {
  variant: 'primary' | 'secondary' | 'ghost';
  size: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** 加载状态 */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', children, className, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50';
    const variants = {
      primary: 'bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500',
      secondary: 'bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-gray-400',
      ghost: 'bg-transparent text-gray-600 hover:bg-gray-100 focus:ring-gray-400',
    };
    const sizes = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-sm',
      lg: 'px-6 py-3 text-base',
    };

    return (
      <button
        ref={ref}
        className={clsx(baseStyles, variants[variant], sizes[size], className)}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
```

#### Stage 4: 样式提取

**目标**: 内联样式 → 设计系统。

**映射规则**:

```
内联样式                      → Tailwind 类
─────────────────────────────────────────────
fontSize: 18 fontWeight: 600  → text-lg font-semibold
padding: '16px 24px'          → px-6 py-4
borderRadius: 8               → rounded-lg
boxShadow: '0 2px 8px ...'    → shadow-md
color: '#4F46E5'              → text-indigo-600
background: '#4F46E5'         → bg-indigo-600
position: 'absolute' top: 0   → absolute top-0
display: 'flex'               → flex
```

**设计令牌提取**:
```typescript
// src/styles/tokens.ts
export const tokens = {
  colors: {
    primary: '#4F46E5',
    'primary-hover': '#4338CA',
    'gray-50': '#F9FAFB',
    'gray-900': '#111827',
    // ... 全部从内联样式中提取
  },
  spacing: {
    page: '1200px',   // 最大宽度
    gutter: '24px',
  },
} as const;
```

#### Stage 5: TypeScript 增强

**关键转换模式**:

```tsx
// BEFORE
const [data, setData] = useState([]);
const handleClick = (e) => { ... };
function formatDate(d) { ... }

// AFTER
interface Item { id: string; name: string; price: number; }
const [data, setData] = useState<Item[]>([]);
const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => { ... };
function formatDate(d: Date): string { ... }

// 复杂状态：discriminated union 替代 boolean flag
// BEFORE
const [loading, setLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
const [data, setData] = useState<Data | null>(null);

// AFTER
type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'success'; data: T };
  
const [state, dispatch] = useReducer(dataReducer, { status: 'idle' });
```

#### Stage 6: 可访问性

**自动转换清单**:

```
Figma 导出 → 重构后
──────────────────────────────────
<div>header</div>  → <header>
<div>nav</div>     → <nav>
<div>main</div>    → <main role="main">
<div>footer</div>  → <footer>
<img /> 无 alt     → <img alt="描述" />
<div onclick=...>  → <button> 或 role="button" tabIndex={0}
无 focus 样式      → focus:ring-2 focus:ring-indigo-500
```

#### Stage 7: 数据层分离

```tsx
// BEFORE: 组件内混合数据
function Dashboard() {
  const stats = [
    { label: '用户', value: 1245 },
    { label: '订单', value: 356 },
  ];
  return <div>{stats.map(...)}</div>;
}

// AFTER
// src/data/dashboard.ts
export interface Stat { label: string; value: number; }
export const DASHBOARD_STATS: Stat[] = [
  { label: '用户', value: 1245 },
  { label: '订单', value: 356 },
];

// src/hooks/useDashboard.ts
export function useDashboardStats() {
  // 未来只需改这里，从 API 获取
  return { data: DASHBOARD_STATS, isLoading: false };
}

// src/pages/Dashboard.tsx
function Dashboard() {
  const { data: stats } = useDashboardStats();
  return <div>{stats.map(...)}</div>;
}
```

#### Stage 8: 最终清理

- 删除被注释掉的旧代码（保留 TODO/FIXME）
- 删除未使用的 import
- 排序 imports（外部 → 内部 → 样式）
- 补充文件末尾换行
- 统一命名规范

### 3.2 人机协作机制

每个阶段在写入前都会：
1. **展示 diff** — 并排打开原文件和新文件
2. **请求确认** — QuickPick: 继续 / 跳过 / 中止
3. **失败恢复** — 出错时提供 重试 / 跳过 / 中止

这样开发者始终掌控全局，LLM 只是高效的执行者。

---

## 4. 核心 LLM Prompt 设计

### 4.1 Prompt 架构

每个阶段的 prompt 遵循统一模板：

```
[系统角色定义]
你是 React + TypeScript 重构专家，将 Figma 导出的代码转换为可维护代码。

[上下文注入]
以下是项目中的文件列表及其内容：
<file-context>

[当前阶段的输入]
{上一个阶段的产出}

[具体指令]
{本阶段需要完成的具体转换}

[输出格式]
{
  "files": [{ "path": "src/...", "content": "..." }],
  "designTokens": {...},  // 可选
  "summary": "变更说明"
}

[约束条件]
- 只输出代码，不要解释
- 使用 TypeScript 严格模式
- ...
```

### 4.2 关键设计决策

| 决策 | 原因 |
|------|------|
| **JSON 格式化输出** | 解析稳定，可批量处理文件 |
| **文件路径标准化** | `src/pages/Name.tsx` 格式，与脚手架一致 |
| **每阶段单独 prompt** | 避免 LLM 在单一请求中"遗忘"或"偷懒" |
| **上一阶段输出作为下一阶段输入** | 保持上下文连续性 |
| **`lazy()` 兼容的默认导出** | 确保路由懒加载开箱即用 |

---

## 5. 关键技术决策

### 5.1 为什么用 Tailwind 而不是 CSS-in-JS？

| 因素 | Tailwind CSS | CSS-in-JS (styled-components) |
|------|-------------|-------------------------------|
| **Figma 样式映射** | 颜色/间距/字号直接对应 class | 需要额外 styled 组件 |
| **提取难度** | LLM 容易将内联样式映射到 class | LLM 需要生成 styled 语法 |
| **运行时性能** | 零运行时 | 运行时注入 |
| **产物体积** | 仅用到的类 | 全部 JS |
| **VS Code 集成** | 官方 IntelliSense | 需插件 |

**结论**: Tailwind 对 LLM 更友好，且从 Figma 像素值到 Tailwind 语义类名的映射是可预测的。

### 5.2 为什么逐阶段运行而不是一次过？

1. **可控性** — 每个阶段都能检查 diff，发现问题及时止损
2. **上下文窗口** — LLM 的 context window 有限，逐阶段喂更小的上下文
3. **可调试** — 某一阶段结果不理想，可以只重跑该阶段
4. **幂等性** — 同一输入多次运行应产生一致结果

### 5.3 容错设计

```
LLM 返回非 JSON → catch → 提取 ```json 块 → 失败则提示重试
文件写入冲突    → 先读后写，防止覆盖人工修改
阶段失败        → 不阻塞后续阶段，允许跳过
```

---

## 6. 使用流程

### 6.1 环境要求

- VS Code 1.96+
- GitHub Copilot 已登录并启用
- Node.js 18+

### 6.2 操作步骤

```
1. 在 VS Code 中打开 Figma 导出的项目

2. 运行命令: "Figma Refactor: Start Workflow" (Cmd+Shift+P)

3. 选择要运行的阶段（新项目建议全选）

4. Stage 0: 自动创建目录结构 → 确认

5. Stage 1: LLM 扫描代码 → 展示审计报告 → 人工审阅

6. Stage 2: LLM 拆分为多页 → 展示 diff → 确认

7. Stage 3-8: 逐阶段执行 → 逐阶段确认

8. 完成！运行 npm install && npm run dev
```

### 6.3 交互界面

```
┌──────────────────────────────────────────────────┐
│  Figma 机翻代码 → 可维护 React UI  工作流引擎    │
│                                                  │
│  选择要运行的阶段:                                │
│  ☑ 0. 项目脚手架                                 │
│  ☑ 1. 代码审计                                   │
│  ☑ 2. 结构分解 (单页→多页)                       │
│  ☑ 3. 组件提取                                   │
│  ☑ 4. 样式提取 (内联→Tailwind)                   │
│  ☑ 5. TypeScript 增强                            │
│  ☑ 6. 可访问性增强                               │
│  ☑ 7. 数据层分离                                 │
│  ☑ 8. 最终清理                                   │
│                                                  │
│  ┌──────────────────────────────────────────────┐ │
│  │ [继续]  [跳过]  [中止]                        │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

---

## 7. 预期效果对比

### 7.1 指标

| 指标 | 重构前 | 重构后 |
|------|--------|--------|
| 文件数 | 1 | 25~40 |
| 单文件最大行数 | ~1200 | ~200 |
| 内联样式 | 80+ 处 | 0（全转 Tailwind） |
| 类型定义 | 0 | 40+ 接口 |
| ARIA 属性 | 0 | 80+ 处 |
| 可复用组件 | 0 | 15~25 |
| 路由 | 条件渲染 | React Router |
| 硬编码数据 | 混合在组件中 | 抽取到 data/ |
| 首次加载 JS | 全部代码 | 按路由懒加载 |

### 7.2 代码质量对比

```tsx
// ─── 重构前 ───
<div onClick={() => setShowPage2(true)}
  style={{ padding: '8px 20px', border: 'none', borderRadius: 8, 
           background: '#4F46E5', color: '#FFF', cursor: 'pointer',
           fontSize: 14, fontWeight: 500 }}>
  开始
</div>

// ─── 重构后 ───
<Button variant="primary" size="lg" onClick={() => navigate('/dashboard')}>
  开始
</Button>
```

```tsx
// ─── 重构前 ───
{showPage2 && !showPage3 && (
  <div style={{ display: 'flex', height: '100vh' }}>
    <div style={{ width: 240, background: '#F9FAFB', borderRight: '1px solid #E5E7EB' }}>
      {/* ... */}
    </div>
  </div>
)}

// ─── 重构后 ───
// src/router.tsx
{ path: '/dashboard', element: <DashboardPage /> }

// src/pages/DashboardPage.tsx
export default function DashboardPage() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

---

## 8. 扩展与展望

### 8.1 可插拔适配器

目前默认输出 Tailwind + React Router v7。可以扩展适配器支持：

```
TailwindAdapter  (默认) → Tailwind CSS
CSSModuleAdapter        → CSS Modules + CSS Variables
styledComponentsAdapter → styled-components
AntDesignAdapter        → Ant Design 组件
```

### 8.2 测试生成

未来可在 Stage 7 之后添加 Stage 7.5: **测试生成**：

- 基于组件 props 生成 Testing Library 测试
- 为页面组件生成集成测试框架
- 用 Vitest + @testing-library/react

### 8.3 CI 集成

```
pre-commit hook: 检查是否有内联样式 → 自动触发 Stage 4
PR 检查: 对比重构前后的 bundle size
```

---

## 总结

本工作流通过 **8 个渐进式阶段**，系统性地解决了 Figma 导出的 5 大类问题：

| 阶段 | 解决的问题 |
|------|-----------|
| Stage 0 | 基础设施缺失 |
| Stage 1 | 不清楚代码有什么问题 |
| Stage 2 | 单页架构、状态耦合、无法路由 |
| Stage 3 | 代码重复、巨型组件 |
| Stage 4 | 内联样式、魔数、不可维护 |
| Stage 5 | 缺少类型、any 泛滥 |
| Stage 6 | 语义缺失、不可访问 |
| Stage 7 | 数据与视图耦合 |
| Stage 8 | 死代码、命名混乱 |

每个阶段通过 **`vscode.lm.sendChatRequest()`** 调用 LLM，将结果以结构化 JSON 返回，
开发者通过 **diff 确认** 保持控制权。最终产出的是一个**开箱即用、类型安全、可访问、
按路由懒加载、样式统一**的 React 多页应用。
