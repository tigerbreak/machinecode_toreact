#!/usr/bin/env node
/**
 * LangGraph Workflow Runner (Node.js)
 *
 * Called by FastAPI backend via subprocess.
 * Accepts config via JSON on stdin, outputs results as NDJSON on stdout.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const PROJECT_ROOT = process.env.PROJECT_ROOT || '/workspace/project/machinecode_toreact';
const require = createRequire(PROJECT_ROOT + '/');

// ── Read config from stdin ─────────────────────────────────────
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  let config;
  try {
    config = JSON.parse(input);
  } catch {
    writeError('Invalid JSON input');
    process.exit(1);
  }

  const { workspace, selectedKeys, apiKey, autoMode = true } = config;
  if (!workspace || !selectedKeys) {
    writeError('Missing required fields: workspace, selectedKeys');
    process.exit(1);
  }

  // Set API key
  if (apiKey) process.env.DEEPSEEK_API_KEY = apiKey;

  try {
    await runWorkflow(workspace, selectedKeys, autoMode);
    writeResult({ type: 'complete', message: 'Workflow finished' });
    process.exit(0);
  } catch (err) {
    writeError(err.message || String(err));
    process.exit(1);
  }
});

// ── Helpers ─────────────────────────────────────────────────────

function writeResult(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function writeError(msg) {
  process.stderr.write(msg + '\n');
}

function writeLog(msg) {
  writeResult({ type: 'log', message: msg });
}

function writeStageResult(stageKey, status, detail) {
  writeResult({ type: 'stage', key: stageKey, status, ...detail });
}

// ── Main ─────────────────────────────────────────────────────────

async function runWorkflow(workspace, selectedKeys, autoMode) {
  // 1. Setup vscode mock
  writeLog('Setting up vscode mock...');
  const vscodeMockDir = path.join(PROJECT_ROOT, 'node_modules', 'vscode');
  if (!fs.existsSync(vscodeMockDir)) {
    fs.mkdirSync(vscodeMockDir, { recursive: true });
    fs.writeFileSync(path.join(vscodeMockDir, 'index.js'), `
      module.exports = {
        workspace: { workspaceFolders: [{ uri: { fsPath: "${workspace}" } }], getConfiguration: () => ({ get: () => "" }) },
        window: { createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }), showQuickPick: async () => "continue", showInformationMessage: async () => "continue", showErrorMessage: async () => "skip" },
        Uri: { file: (p) => ({ fsPath: p }) },
        ViewColumn: { Beside: 2 },
        commands: { executeCommand: async () => {} },
      };
    `);
  }

  // 2. Load LangGraph workflow modules
  writeLog('Loading LangGraph workflow...');
  const lgModule = await import(path.join(PROJECT_ROOT, 'out', 'langgraph-workflow.js'));
  const { buildHtmlBaseline, formatBaselineConstraint } = await import(path.join(PROJECT_ROOT, 'out', 'html-baseline.js'));
  const { buildLinkageContracts, formatLinkageConstraints, verifyLinkageContracts } = await import(path.join(PROJECT_ROOT, 'out', 'linkage-verifier.js'));
  const { callDeepSeek } = await import(path.join(PROJECT_ROOT, 'out', 'llm', 'deepseek.js'));
  const { buildAuditPrompt } = await import(path.join(PROJECT_ROOT, 'out', 'prompts', 'stage1-audit.js'));
  const { buildDecomposePrompt } = await import(path.join(PROJECT_ROOT, 'out', 'prompts', 'stage2-decompose.js'));

  const { runWorkflow, buildGraph } = lgModule;

  // 3. Build all stage definitions
  writeLog('Building stage definitions...');

  const stageDefs = {
    baseline: {
      key: 'baseline', label: 'HTML 结构基线', analysisOnly: true,
      execute: async () => {
        writeLog('[baseline] Scanning HTML files...');
        const baseline = await buildHtmlBaseline(workspace);
        const baselineText = formatBaselineConstraint(baseline);

        const stageDir = path.join(workspace, '.figma-stage', '00-baseline');
        fs.mkdirSync(stageDir, { recursive: true });
        fs.writeFileSync(path.join(stageDir, 'html-baseline-constraint.txt'), baselineText);
        fs.writeFileSync(path.join(stageDir, 'report.md'),
          `# 结构基线报告\n\n${baselineText}`);

        const files = baseline.files.map(f => ({
          file: f.htmlFile,
          elements: f.interactiveElements.length,
          identity: f.pageIdentity,
          matchedJsx: f.matchedJsxFile,
        }));

        return {
          summary: `发现 ${baseline.files.length} 个 HTML 文件`,
          files,
          baseline,
        };
      },
    },
    linkage: {
      key: 'linkage', label: '联动契约', analysisOnly: true,
      execute: async () => {
        writeLog('[linkage] Scanning contracts...');
        const contracts = await buildLinkageContracts(workspace);

        const stageDir = path.join(workspace, '.figma-stage', '00-linkage');
        fs.mkdirSync(stageDir, { recursive: true });
        fs.writeFileSync(path.join(stageDir, 'contracts-before.json'), JSON.stringify(contracts, null, 2));

        return {
          summary: `发现 ${contracts.length} 个联动契约`,
          contracts: contracts.map(c => ({
            pattern: c.pattern,
            source: c.sourceComponent,
            target: c.targetComponent,
            snippet: (c.originalSnippet || '').slice(0, 80),
          })),
        };
      },
    },
    audit: {
      key: 'audit', label: '代码审计', analysisOnly: false,
      execute: async () => {
        writeLog('[audit] Reading source files...');
        const source = readSourceFiles(workspace);

        writeLog('[audit] Calling DeepSeek...');
        const prompt = buildAuditPrompt(source);
        const resp = await callDeepSeek(prompt, { maxTokens: 8192 });

        const parsed = JSON.parse(resp.match(/\{[\s\S]*\}/)?.[0] || resp);
        const files = parsed.files || [];
        for (const f of files) {
          const fp = f.path || f.filePath;
          if (fp) {
            const fullPath = path.join(workspace, fp);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, f.content || '');
          }
        }

        // Extract issues from audit.json
        let issues = [];
        for (const f of files) {
          const fp = f.path || f.filePath;
          if (fp && fp.includes('audit.json')) {
            try {
              const auditJson = JSON.parse(f.content);
              issues = (auditJson.issues || []).map(i => ({
                severity: i.severity,
                category: i.category,
                message: i.message,
                file: i.file,
                suggestion: i.suggestion,
              }));
            } catch {}
          }
        }

        writeStageResult('audit', 'ok', { summary: parsed.summary });
        return {
          summary: parsed.summary || '审计完成',
          files: files.map(f => ({ path: f.path || f.filePath, size: (f.content || '').length })),
          issues,
        };
      },
    },
    decompose: {
      key: 'decompose', label: '结构分解', analysisOnly: false,
      execute: async () => {
        writeLog('[decompose] Reading source and audit results...');
        const source = readSourceFiles(workspace);

        const auditPath = path.join(workspace, '.figma-stage', '01-audit', 'audit.json');
        const auditJson = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '{}';

        const baselinePath = path.join(workspace, '.figma-stage', '00-baseline', 'html-baseline-constraint.txt');
        const htmlBaselineText = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, 'utf-8') : '';

        const linkagePath = path.join(workspace, '.figma-stage', '00-linkage', 'contracts-before.json');
        const linkageContractsText = fs.existsSync(linkagePath) ? fs.readFileSync(linkagePath, 'utf-8') : '';

        writeLog('[decompose] Calling DeepSeek...');
        const prompt = buildDecomposePrompt(auditJson, source);
        const resp = await callDeepSeek(prompt, { maxTokens: 16384 });

        const parsed = JSON.parse(resp.match(/\{[\s\S]*\}/)?.[0] || resp);
        const files = parsed.files || [];
        for (const f of files) {
          const fp = f.path || f.filePath;
          if (fp) {
            const fullPath = path.join(workspace, fp);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, f.content || '');
          }
        }

        writeStageResult('decompose', 'ok', { summary: parsed.summary });
        return {
          summary: parsed.summary || '分解完成',
          files: files.map(f => ({
            path: f.path || f.filePath,
            lines: (f.content || '').split('\n').length,
            size: (f.content || '').length,
            preview: (f.content || '').slice(0, 200),
          })),
        };
      },
    },
    verify: {
      key: 'verify', label: '联动验证', analysisOnly: true,
      execute: async () => {
        writeLog('[verify] Verifying contracts...');
        const contractsPath = path.join(workspace, '.figma-stage', '00-linkage', 'contracts-before.json');
        if (!fs.existsSync(contractsPath)) {
          return { summary: '未找到契约文件', verified: 0, broken: 0 };
        }
        const contracts = JSON.parse(fs.readFileSync(contractsPath, 'utf-8'));
        const report = await verifyLinkageContracts(workspace, contracts);

        const reportPath = path.join(workspace, '.figma-stage', '00-linkage', 'verification-report.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

        return {
          summary: `联动验证: ${report.summary.verified}/${report.summary.total} 通过`,
          total: report.summary.total,
          verified: report.summary.verified,
          broken: report.summary.broken,
          brokenContracts: report.brokenContracts.map(c => ({
            source: c.sourceComponent,
            pattern: c.pattern,
            detail: c.verificationDetail,
          })),
        };
      },
    },
  };

  // 4. Run selected stages
  writeLog(`Starting workflow with stages: ${selectedKeys.join(', ')}`);

  const results = {};
  let hasError = false;

  for (const key of selectedKeys) {
    const def = stageDefs[key];
    if (!def) {
      writeStageResult(key, 'error', { error: `Unknown stage: ${key}` });
      hasError = true;
      continue;
    }

    try {
      writeLog(`▶ Running stage: ${def.label} (${key})`);
      writeStageResult(key, 'running', {});

      const result = await def.execute();

      results[key] = result;
      writeStageResult(key, 'ok', { summary: result.summary });

      writeLog(`  ✅ ${def.label} 完成`);
    } catch (err) {
      writeStageResult(key, 'error', { error: err.message });
      writeLog(`  ❌ ${def.label} 失败: ${err.message}`);
      hasError = true;
      break;
    }
  }

  // 5. Save results
  const resultPath = path.join(workspace, '.figma-stage', 'run-results.json');
  fs.writeFileSync(resultPath, JSON.stringify({ results, hasError, selectedKeys }, null, 2));

  writeResult({ type: 'results', results, hasError });
}

// ── Utility ──────────────────────────────────────────────────────

function readSourceFiles(root) {
  const files = [];
  const walkDir = (dir) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', '.git', '.figma-stage', 'out'].includes(entry.name)) {
            walkDir(fullPath);
          }
        } else if (entry.name.match(/\.(jsx|tsx|ts|json)$/)) {
          files.push(path.relative(root, fullPath));
        }
      }
    } catch {}
  };
  walkDir(root);
  return files.map(f => {
    try {
      return `// --- ${f} ---\n${fs.readFileSync(path.join(root, f), 'utf-8')}`;
    } catch { return ''; }
  }).join('\n\n');
}
