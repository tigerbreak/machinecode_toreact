# Figma 机翻代码 → 可维护 React UI · 工作流

基于 **VS Code `vscode.lm` API + Gemini 模型** 的多阶段 Prompt 编排系统。

## 快速开始

```bash
# 1. 在 VS Code 中打开此项目 (确保 Copilot 已登录)
# 2. 安装依赖
npm install
# 3. 编译
npm run compile
# 4. 按 F5 启动 Extension Host
# 5. 打开 Figma 导出的项目文件夹
# 6. 运行命令: "Figma Refactor: Start Workflow"
# 7. 选择要运行的阶段 → 逐阶段确认 diff
```

## 项目结构

```
src/
├── extension.ts              # VS Code 扩展入口
├── workflow-engine.ts        # 多阶段编排引擎
├── ast-guard.ts              # 语法检查卡点 (esbuild/tsc)
└── prompts/
    ├── base-prompt.ts        # 共享基础 Prompt + 设计令牌收敛规则
    ├── stage0-scaffold.ts    # 项目脚手架
    ├── stage1-audit.ts       # 代码审计
    ├── stage2-decompose.ts   # 结构分解 (单页→多页)  🛠️ 状态增强
    ├── stage3-extract.ts     # 组件提取 🛠️ 骨架去重
    ├── stage4-style.ts       # 样式提取 (内联→Tailwind)
    ├── stage5-types.ts       # TypeScript 增强
    ├── stage6-a11y.ts        # 可访问性增强
    ├── stage7-data.ts        # 数据层分离
    └── stage8-polish.ts      # 最终清理
```

## 9 阶段管道

```
脚手架 → 代码审计 → 结构分解(单页→多页) → 组件提取 → 样式提取
→ TypeScript 增强 → 可访问性 → 数据层分离 → 最终清理
```

每个阶段: **Prompt → LLM (Gemini) → JSON → AST 检查 → Diff 确认 → 写入**

详见 [DESIGN.md](./DESIGN.md)

