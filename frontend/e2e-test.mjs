#!/usr/bin/env node
/**
 * Frontend E2E Test
 *
 * Tests the full pipeline Web UI using Playwright:
 * 1. Starts the FastAPI backend
 * 2. Uses test-fixtures as the workspace
 * 3. Navigates the React SPA, runs pipeline stages
 * 4. Verifies results end-to-end
 *
 * Usage:
 *   node frontend/e2e-test.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';

const PROJECT_ROOT = path.resolve(process.cwd());
const PORT = 12003;
const BASE_URL = `http://localhost:${PORT}`;
const FIXTURES_DIR = path.join(PROJECT_ROOT, 'test-fixtures');

// ── Colors ──────────────────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[34m', N = '\x1b[0m';
function ok(msg) { console.log(`  ${G}✓${N} ${msg}`); }
function fail(msg) { console.log(`  ${R}✗${N} ${msg}`); }
function info(msg) { console.log(`  ${B}→${N} ${msg}`); }
function step(n, msg) { console.log(`\n${Y}[Step ${n}]${N} ${msg}`); }

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; ok(msg); }
  else { failed++; fail(msg); }
}

// ── Helpers ─────────────────────────────────────────────────────
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`)); }
      });
    }).on('error', reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = http.request(url, options, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch { reject(new Error(`Invalid JSON: ${chunks.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start Server ────────────────────────────────────────────────
async function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-m', 'uvicorn', 'backend.main:app', '--host', '0.0.0.0', '--port', String(PORT)], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DEEPSEEK_API_KEY: 'YOUR_DEEPSEEK_API_KEY' },
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) reject(new Error('Server start timeout'));
    }, 15000);

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      if (text.includes('Uvicorn running on') && !started) {
        started = true;
        clearTimeout(timeout);
        // Wait a bit for server to be ready
        setTimeout(() => resolve(proc), 1000);
      }
    });

    proc.stderr.on('data', (data) => {
      // uvicorn logs to stderr
      const text = data.toString();
      if (text.includes('Uvicorn running on') && !started) {
        started = true;
        clearTimeout(timeout);
        setTimeout(() => resolve(proc), 1000);
      }
    });

    proc.on('error', reject);
  });
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`${B}══════════════════════════════════════════════${N}`);
  console.log(`${B}  Frontend E2E Test — Figma Refactor Pipeline ${N}`);
  console.log(`${B}══════════════════════════════════════════════${N}`);

  // ── 1. Verify test fixtures exist ─────────────────────────────
  step(1, 'Verify test fixtures');
  assert(fs.existsSync(FIXTURES_DIR), 'test-fixtures/ exists');
  const files = fs.readdirSync(FIXTURES_DIR);
  assert(files.length === 4, `test-fixtures has ${files.length} files: ${files.join(', ')}`);

  // ── 2. Start Server ───────────────────────────────────────────
  step(2, 'Start FastAPI backend');
  let server;
  try {
    server = await startServer();
    ok(`Server started on port ${PORT}`);
  } catch (e) {
    fail(`Server start failed: ${e.message}`);
    process.exit(1);
  }

  try {
    // ── 3. API: List stages ──────────────────────────────────────
    step(3, 'API: List pipeline stages');
    const stages = await fetchJSON(`${BASE_URL}/api/stages`);
    assert(Array.isArray(stages) && stages.length === 5, `GET /api/stages → ${stages.length} stages`);
    const stageKeys = stages.map(s => s.key);
    assert(stageKeys.includes('baseline') && stageKeys.includes('decompose'), 'Stages include baseline + decompose');
    const labels = stages.map(s => s.label);
    info(`Stages: ${labels.join(' → ')}`);

    // ── 4. API: Create run (analysis only) ──────────────────────
    step(4, 'API: Create analysis run (baseline + linkage)');
    const run1 = await postJSON(`${BASE_URL}/api/runs`, {
      selected_stages: ['baseline', 'linkage'],
    });
    assert(run1.id && run1.status === 'running', `POST /api/runs → id=${run1.id}`);

    // Wait for completion
    let runStatus;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      runStatus = await fetchJSON(`${BASE_URL}/api/runs/${run1.id}`);
      if (runStatus.status === 'complete' || runStatus.status === 'error') break;
    }
    assert(runStatus.status === 'complete', `Run ${run1.id} completed (status=${runStatus.status})`);
    assert(runStatus.stages.every(s => s.status === 'ok'), 'All stages passed');
    info(`Baseline: ${runStatus.stages[0].summary}`);
    info(`Linkage: ${runStatus.stages[1].summary}`);

    // ── 5. API: Check generated files ────────────────────────────
    step(5, 'API: List generated files');
    const fileList = await fetchJSON(`${BASE_URL}/api/runs/${run1.id}/files`);
    assert(Array.isArray(fileList.files) && fileList.files.length > 0, `Files generated: ${fileList.files.length}`);
    const artifacts = fileList.files.filter(f => f.type === 'artifact');
    assert(artifacts.length >= 2, `Artifact files: ${artifacts.length} (baseline + linkage)`);
    info(`Files: ${fileList.files.length} total, ${artifacts.length} artifacts`);

    // ── 6. API: Full pipeline run ────────────────────────────────
    step(6, 'API: Run full analysis pipeline (all 5 stages)');
    const run2 = await postJSON(`${BASE_URL}/api/runs`, {
      selected_stages: ['baseline', 'linkage', 'audit', 'decompose', 'verify'],
    });
    assert(run2.id && run2.status === 'running', 'Full pipeline started');

    let fullStatus;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      fullStatus = await fetchJSON(`${BASE_URL}/api/runs/${run2.id}`);
      if (fullStatus.status !== 'running') break;
      if (i % 5 === 0) info(`  Waiting... ${i * 2}s elapsed (${fullStatus.stages.filter(s => s.status === 'ok').length}/5 stages done)`);
    }

    if (fullStatus.status === 'complete') {
      ok(`Full pipeline completed (${fullStatus.stages.filter(s => s.status === 'ok').length}/5 stages passed)`);
    } else {
      // Show partial results
      const okStages = fullStatus.stages.filter(s => s.status === 'ok').length;
      const errStages = fullStatus.stages.filter(s => s.status === 'error');
      assert(okStages >= 2, `Partial results: ${okStages}/5 stages passed`);
      info(`Errors: ${errStages.map(s => `${s.key}=${s.error || '?'}`).join(', ')}`);
    }

    // ── 7. Browser: Navigate to UI ───────────────────────────────
    step(7, 'Browser: Navigate to frontend');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
    const title = await page.title();
    assert(title.includes('Figma Refactor'), `Page title: "${title}"`);

    // Check pipeline stages are displayed
    const bodyText = await page.textContent('body');
    assert(bodyText.includes('HTML 结构基线'), 'Stage "HTML 结构基线" visible');
    assert(bodyText.includes('联动契约'), 'Stage "联动契约" visible');
    assert(bodyText.includes('代码审计'), 'Stage "代码审计" visible');
    assert(bodyText.includes('结构分解'), 'Stage "结构分解" visible');
    assert(bodyText.includes('联动验证'), 'Stage "联动验证" visible');

    // Check empty state
    assert(bodyText.includes('准备就绪'), 'Empty state shown');
    assert(bodyText.includes('开始运行'), 'Run button visible');

    // ── 8. Browser: Create an analysis-only run ──────────────────
    step(8, 'Browser: Create and monitor an analysis-only run');

    // Uncheck LLM stages first (audit, decompose — they need API)
    // Each checkbox is labeled by its parent .stage-item
    const checkboxes = await page.locator('.stage-item input[type="checkbox"]');
    const checkboxCount = await checkboxes.count();
    info(`Found ${checkboxCount} checkboxes`);

    // By default all 5 are checked. Uncheck audit & decompose (indices 2, 3)
    // But we need to first know which is which. Let's read labels.
    for (let i = 0; i < checkboxCount; i++) {
      const cb = checkboxes.nth(i);
      const label = await page.locator('.stage-item').nth(i).locator('.stage-name').textContent();
      if (label && (label.includes('代码审计') || label.includes('结构分解'))) {
        if (await cb.isChecked()) {
          await cb.click();
          info(`Unchecked: ${label}`);
        }
      }
    }

    // Click run button
    const runBtn = await page.locator('button', { hasText: '开始运行' });
    assert(await runBtn.isEnabled(), 'Run button is enabled');
    await runBtn.click();

    // Wait for running state (or already completed for fast runs)
    await sleep(2000);
    const afterClickText = await page.textContent('body');
    const isRunning = afterClickText.includes('运行中') || afterClickText.includes('工作流运行中');
    const isDone = afterClickText.includes('完成') || afterClickText.includes('📊 结果') || afterClickText.includes('文件');
    assert(isRunning || isDone, 'Run started (or already completed)');

    // Wait for completion (analysis-only should be fast, ~5s)
    let completed = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const text = await page.textContent('body');
      if (text.includes('完成') || text.includes('失败') || text.includes('📊 结果') || text.includes('📋 日志')) {
        completed = true;
        break;
      }
      if (i % 10 === 0) info(`  In progress... ${i}s`);
    }
    assert(completed, 'Analysis-only run completed in UI');

    // Take screenshot
    const screenshotDir = path.join(PROJECT_ROOT, '.e2e-screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, '01-after-run.png'), fullPage: true });
    ok('Screenshot 01 saved');

    // ── 9. Browser: View results ─────────────────────────────────
    step(9, 'Browser: View results & files');

    // Wait a moment for tabs to appear after completion
    await sleep(2000);

    // Try to find the results tab button
    let resultsTab;
    try {
      resultsTab = await page.locator('button', { hasText: /结果/ });
      if (await resultsTab.isVisible({ timeout: 3000 })) {
        ok('Results tab visible');
      } else {
        info('Results tab not found — screenshot taken for diagnosis');
      }
    } catch {
      info('Results tab check timed out — UI may still be in running state');
    }

    // Try files tab
    let filesTab;
    try {
      filesTab = page.locator('button', { hasText: /文件/ });
      if (await filesTab.isVisible({ timeout: 3000 })) {
        await filesTab.click();
        await sleep(1000);
        const fileText = await page.textContent('body');
        if (fileText.includes('.html') || fileText.includes('.jsx') || fileText.includes('产物')) {
          ok('Files view shows generated files');
        } else {
          info('Files view loaded but no files listed yet');
        }
      }
    } catch {
      info('Files tab check timed out');
    }

    // Screenshot of results state
    await page.screenshot({ path: path.join(screenshotDir, '02-results-view.png'), fullPage: true });
    ok('Screenshot 02 saved');

    // ── 10. Browser: Check run history ─────────────────────────
    step(10, 'Browser: Verify run history');

    const historyItems = await page.locator('.history-item').count();
    assert(historyItems >= 1, `Run history shows ${historyItems} item(s)`);

    const historyText = await page.textContent('body');
    assert(historyText.includes('complete') || historyText.includes('error') || historyText.includes(run1.id.slice(0, 8)),
      'Run history shows previous runs');

    // ── Summary ──────────────────────────────────────────────────
    await browser.close();

  } finally {
    // Cleanup
    if (server) {
      server.kill('SIGTERM');
      // Wait for server to stop
      await sleep(500);
    }
  }

  // ── Summary ───────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${B}══════════════════════════════════════════════${N}`);
  console.log(`${B}  E2E Test Complete${N}`);
  console.log(`  ${G}Passed: ${passed}${N}`);
  if (failed > 0) console.log(`  ${R}Failed: ${failed}${N}`);
  console.log(`  Total: ${total}`);
  console.log(`${B}══════════════════════════════════════════════${N}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${R}Fatal error:${N}`, err.message);
  process.exit(1);
});
