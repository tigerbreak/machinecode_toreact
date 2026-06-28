#!/usr/bin/env node
/**
 * Preview Builder
 *
 * Reads the workspace output from a completed run and builds:
 * 1. A bundled React app (routed multi-page) for live preview
 * 2. Per-page HTML snippets for original HTML preview
 * 3. Per-page React component preview code
 *
 * Usage: node preview-builder.mjs <workspace_dir>
 * Output: <workspace_dir>/.figma-stage/preview/
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const PREVIEW_DIR = '.figma-stage/preview';
const workspace = process.argv[2];

if (!workspace || !fs.existsSync(workspace)) {
  console.error('Usage: node preview-builder.mjs <workspace_dir>');
  process.exit(1);
}

const wsDir = path.resolve(workspace);
const previewDir = path.join(wsDir, PREVIEW_DIR);
fs.mkdirSync(previewDir, { recursive: true });

// ── 1. Read original inputs (HTML + JSX) ──────────────────────────
const srcDir = path.join(wsDir, 'src');
const htmlFiles = fs.readdirSync(wsDir).filter(f => f.endsWith('.html'));
const jsxFiles = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).filter(f => f.endsWith('.jsx')) : [];

// ── 2. Read linkage config ────────────────────────────────────────
let linkageConfig = {};
const linkageFile = path.join(wsDir, '.figma-linkage.json');
if (fs.existsSync(linkageFile)) {
  linkageConfig = JSON.parse(fs.readFileSync(linkageFile, 'utf-8'));
}

// ── 3. Read decomposition output (generated React files) ──────────
const generatedFiles = [];
if (fs.existsSync(srcDir)) {
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) {
        if (!['node_modules'].includes(f.name)) walk(full);
      } else if (f.name.match(/\.(tsx|ts|jsx|js|json)$/) && !f.name.startsWith('test')) {
        generatedFiles.push(full);
      }
    }
  };
  walk(srcDir);
}

// ── 4. Build page data ────────────────────────────────────────────
const pages = [];

for (const htmlFile of htmlFiles) {
  const basename = path.basename(htmlFile, '.html');
  const htmlContent = fs.readFileSync(path.join(wsDir, htmlFile), 'utf-8');

  // Find matching JSX
  const jsxMatch = jsxFiles.find(f => f.startsWith(basename) && f.endsWith('.jsx'));
  const jsxContent = jsxMatch
    ? fs.readFileSync(path.join(srcDir, jsxMatch), 'utf-8')
    : '';

  // Find generated React components for this page
  const generated = generatedFiles
    .filter(f => f.toLowerCase().includes(basename.toLowerCase()))
    .map(f => ({
      path: path.relative(wsDir, f),
      content: fs.readFileSync(f, 'utf-8'),
    }));

  // Find which group this page belongs to
  let pageGroup = 'default';
  for (const [group, names] of Object.entries(linkageConfig)) {
    if (names.includes(basename)) {
      pageGroup = group;
      break;
    }
  }

  pages.push({
    name: basename,
    group: pageGroup,
    htmlContent,
    jsxContent,
    generated,
  });
}

// ── 5. Write page data as JSON for the frontend ──────────────────
fs.writeFileSync(path.join(previewDir, 'pages.json'), JSON.stringify({ pages, groups: linkageConfig }, null, 2));

// ── 6. Build per-page HTML previews (isolated iframes) ──────────
for (const page of pages) {
  // Original HTML preview
  const htmlPreview = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${page.name} - HTML Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f8fafc; padding: 16px;
    }
    .preview-wrapper { max-width: 100%; }
  </style>
</head>
<body>
  <div class="preview-wrapper">
    ${page.htmlContent}
  </div>
  <script>
    // Auto-link inline event handlers for preview
    document.querySelectorAll('[onclick]').forEach(el => {
      try { el.onclick = new Function(el.getAttribute('onclick')); } catch {}
    });
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(previewDir, `${page.name}-original.html`), htmlPreview);

  // React preview (isolated component rendering)
  let reactComponentContent = page.jsxContent;
  // Try to find the actual generated React component instead
  if (page.generated.length > 0) {
    reactComponentContent = page.generated[0].content;
  }
  const reactPreview = buildReactPreviewHtml(page.name, reactComponentContent);
  fs.writeFileSync(path.join(previewDir, `${page.name}-react.html`), reactPreview);
}

// ── 7. Build full routed app preview ────────────────────────────
// Collect all unique groups
const groups = {};
for (const page of pages) {
  if (!groups[page.group]) groups[page.group] = [];
  groups[page.group].push(page);
}

// Build the full app with routing
const fullAppHtml = buildFullAppPreview(pages, generatedFiles, wsDir);
fs.writeFileSync(path.join(previewDir, 'app.html'), fullAppHtml);

// Write summary
const summary = {
  pages: pages.length,
  groups: Object.keys(groups).length,
  pageNames: pages.map(p => p.name),
  groupNames: Object.keys(groups),
};
fs.writeFileSync(path.join(previewDir, 'summary.json'), JSON.stringify(summary, null, 2));

console.log(JSON.stringify({ success: true, pages: pages.length, previewDir }));
process.exit(0);

// ── Helpers ───────────────────────────────────────────────────────

function buildReactPreviewHtml(pageName, reactCode) {
  // Sanitize: extract the default export component
  const componentName = extractComponentName(reactCode) || 'Preview';
  const reactCodeClean = reactCode
    .replace(/import\s+.*?from\s+['"].*?['"]\s*;?\n?/gs, '')
    .replace(/export\s+default\s+function/, 'function')
    .replace(/export\s+const/, 'const')
    .replace(/export\s+default\s+/, '');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageName} - React Preview</title>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 16px; }
    .preview-error { color: #ef4444; padding: 20px; text-align: center; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { createElement: h, useState, useEffect, useRef, useMemo, useCallback } = React;

    ${reactCodeClean}

    function ${componentName}Wrapper() {
      try {
        return h(${componentName});
      } catch(e) {
        return h('div', { className: 'preview-error' }, 'Render Error: ' + e.message);
      }
    }

    ReactDOM.createRoot(document.getElementById('root')).render(h(${componentName}Wrapper));
  </script>
</body>
</html>`;
}

function buildFullAppPreview(pages, generatedFiles, wsDir) {
  // Generate a simple app that shows all pages in tabs
  const navItems = pages.map((p, i) =>
    `<button class="nav-btn" onclick="switchPage(${i})">${p.name}</button>`
  ).join('\n      ');

  const pagePreviews = pages.map((p, i) =>
    `<div class="page-preview" id="preview-${i}" style="display:${i === 0 ? 'block' : 'none'}">
      <iframe src="./${p.name}-react.html" class="preview-iframe" id="iframe-${i}"></iframe>
    </div>`
  ).join('\n    ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>React App Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; height: 100vh; display: flex; flex-direction: column; }
    .app-header { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: #1e293b; border-bottom: 1px solid #334155; }
    .app-header h1 { font-size: 0.9rem; font-weight: 600; }
    .nav { display: flex; gap: 4px; margin-left: auto; }
    .nav-btn { padding: 6px 14px; border: 1px solid #334155; border-radius: 6px; background: transparent; color: #94a3b8; cursor: pointer; font-size: 0.78rem; transition: all 0.15s; }
    .nav-btn:hover { background: #334155; color: #e2e8f0; }
    .nav-btn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
    .preview-container { flex: 1; overflow: hidden; }
    .page-preview { width: 100%; height: 100%; }
    .preview-iframe { width: 100%; height: 100%; border: none; background: #fff; }
  </style>
</head>
<body>
  <div class="app-header">
    <h1>⚛️ ${pages.length} 页预览</h1>
    <div class="nav">${navItems}</div>
  </div>
  <div class="preview-container">
    ${pagePreviews}
  </div>
  <script>
    let currentPage = 0;
    const navBtns = document.querySelectorAll('.nav-btn');
    function switchPage(i) {
      document.getElementById('preview-' + currentPage).style.display = 'none';
      navBtns[currentPage].classList.remove('active');
      document.getElementById('preview-' + i).style.display = 'block';
      navBtns[i].classList.add('active');
      currentPage = i;
      // Reload iframe
      const iframe = document.getElementById('iframe-' + i);
      iframe.src = iframe.src;
    }
    navBtns[0].classList.add('active');
  </script>
</body>
</html>`;
}

function extractComponentName(code) {
  const match = code.match(/(?:export\s+default\s+)?(?:function|const)\s+(\w+)/);
  return match ? match[1] : null;
}
