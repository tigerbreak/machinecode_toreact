#!/usr/bin/env node
/**
 * Preview Builder
 *
 * Reads the workspace output from a completed run and builds:
 * 1. A bundled React app (routed multi-page) for live preview
 * 2. Per-page HTML snippets for original HTML preview
 * 3. Per-page React component preview (transpiled with esbuild)
 * 4. Full file tree listing
 *
 * Usage: node preview-builder.mjs <workspace_dir>
 * Output: <workspace_dir>/.figma-stage/preview/
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PREVIEW_DIR = '.figma-stage/preview';
const workspace = process.argv[2];

if (!workspace || !fs.existsSync(workspace)) {
  console.error('Usage: node preview-builder.mjs <workspace_dir>');
  process.exit(1);
}

const wsDir = path.resolve(workspace);
const previewDir = path.join(wsDir, PREVIEW_DIR);
const srcDir = path.join(wsDir, 'src');
fs.mkdirSync(previewDir, { recursive: true });

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(import.meta.dirname, '..');

// ── 1. Read original inputs (HTML + JSX) ──────────────────────────
const htmlFiles = fs.readdirSync(wsDir).filter(f => f.endsWith('.html'));
const jsxFiles = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).filter(f => f.endsWith('.jsx')) : [];

// ── 2. Read linkage config ────────────────────────────────────────
let linkageConfig = {};
const linkageFile = path.join(wsDir, '.figma-linkage.json');
if (fs.existsSync(linkageFile)) {
  linkageConfig = JSON.parse(fs.readFileSync(linkageFile, 'utf-8'));
}

// ── 3. Read ALL generated files (for file tree) ────────────────────
const allGeneratedFiles = [];
if (fs.existsSync(srcDir)) {
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) {
        if (!['node_modules'].includes(f.name)) walk(full);
      } else if (f.name.match(/\.(tsx|ts|jsx|js|json|css)$/)) {
        allGeneratedFiles.push(full);
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

  // Find generated files for this page
  const generated = allGeneratedFiles
    .filter(f => f.toLowerCase().includes(basename.toLowerCase()) || basename.toLowerCase().includes(path.basename(f).toLowerCase().replace(/\.\w+$/, '')))
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

// Add global/shared generated files (App.tsx, router.tsx, types.ts, etc.) as "shared" list
const sharedFiles = allGeneratedFiles.filter(f => {
  const bn = path.basename(f).replace(/\.\w+$/, '');
  return !pages.some(p => bn.toLowerCase().includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(bn.toLowerCase()));
});

// ── 5. Build file tree metadata ────────────────────────────────
const fileTree = buildFileTree(pages, allGeneratedFiles, wsDir);

// ── 6. Write page data + file tree as JSON ──────────────────────
fs.writeFileSync(path.join(previewDir, 'pages.json'), JSON.stringify({
  pages: [...pages],
  shared: sharedFiles.map(f => ({ path: path.relative(wsDir, f), content: fs.readFileSync(f, 'utf-8') })),
  groups: linkageConfig,
  fileTree,
}, null, 2));

// ── 7. Build per-page HTML previews (isolated iframes) ──────────
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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; padding: 16px; }
    .preview-wrapper { max-width: 100%; }
  </style>
</head>
<body>
  <div class="preview-wrapper">${page.htmlContent}</div>
  <script>document.querySelectorAll('[onclick]').forEach(el => { try { el.onclick = new Function(el.getAttribute('onclick')); } catch {} });</script>
</body>
</html>`;
  fs.writeFileSync(path.join(previewDir, `${page.name}-original.html`), htmlPreview);

  // React preview — transpile with esbuild
  try {
    buildReactPreviewWithEsbuild(page, previewDir, PROJECT_ROOT);
  } catch (err) {
    // Fallback: show source code
    const fallback = buildFallbackReactPreview(page.name, page.jsxContent);
    fs.writeFileSync(path.join(previewDir, `${page.name}-react.html`), fallback);
  }
}

// ── 8. Build full app preview ──────────────────────────────────
const fullAppHtml = buildFullAppPreview(pages);
fs.writeFileSync(path.join(previewDir, 'app.html'), fullAppHtml);

// Write summary
const summary = {
  pages: pages.length,
  generatedFiles: allGeneratedFiles.length,
  pageNames: pages.map(p => p.name),
  groupNames: Object.keys(linkageConfig),
};
fs.writeFileSync(path.join(previewDir, 'summary.json'), JSON.stringify(summary, null, 2));

console.log(JSON.stringify({ success: true, pages: summary.pages, files: allGeneratedFiles.length, previewDir }));
process.exit(0);

// ── Build file tree ───────────────────────────────────────────────

function buildFileTree(pages, allFiles, wsDir) {
  const tree = { name: 'src', children: [] };
  const added = new Set();

  // Per-page folder
  for (const page of pages) {
    const node = { name: page.name, children: [] };
    for (const f of allFiles) {
      const rel = path.relative(wsDir, f);
      if (!f.toLowerCase().includes(page.name.toLowerCase()) &&
          !page.name.toLowerCase().includes(path.basename(f).toLowerCase().replace(/\.\w+$/, ''))) continue;
      if (!added.has(rel)) {
        node.children.push({ name: path.basename(f), path: rel, type: 'generated' });
        added.add(rel);
      }
    }
    // Add JSX input
    const jsxPath = `src/${page.name}.jsx`;
    if (!added.has(jsxPath) && fs.existsSync(path.join(wsDir, jsxPath))) {
      node.children.unshift({ name: `${page.name}.jsx`, path: jsxPath, type: 'original' });
      added.add(jsxPath);
    }
    if (node.children.length > 0) tree.children.push(node);
  }

  // Shared files folder
  const sharedNode = { name: '__shared__', children: [] };
  for (const f of allFiles) {
    const rel = path.relative(wsDir, f);
    if (!added.has(rel)) {
      sharedNode.children.push({ name: path.basename(f), path: rel, type: 'generated' });
      added.add(rel);
    }
  }
  if (sharedNode.children.length > 0) tree.children.push(sharedNode);

  return tree;
}

// ── Build React preview with esbuild ──────────────────────────────

function buildReactPreviewWithEsbuild(page, previewDir, projectRoot) {
  const tmpDir = path.join(projectRoot, '.preview-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpEntry = path.join(tmpDir, 'entry.jsx');
  const tmpOut = path.join(tmpDir, 'out.js');

  // Clean up code for browser consumption
  const codeParts = [];

  // Clean JSX content
  let jsxC = page.jsxContent
    .replace(/import\s+.*?from\s+['"].*?['"]\s*;?\n?/gs, '')
    .replace(/export\s+default\s+function/g, 'function')
    .replace(/export\s+const/g, 'const')
    .replace(/export\s+default\s+/g, '');
  codeParts.push(jsxC);

  // Clean generated code
  for (const g of page.generated) {
    let content = g.content
      .replace(/import\s+.*?from\s+['"].*?['"]\s*;?\n?/gs, '')
      .replace(/export\s+default\s+function/g, 'function')
      .replace(/export\s+const/g, 'const')
      .replace(/export\s+default\s+/g, '')
      .replace(/useNavigate\s*\(/g, '(()=>{})(')
      .replace(/useParams\s*\(/g, '(()=>({}))(')
      .replace(/useLocation\s*\(/g, '(()=>({}))(');
    codeParts.push(`// ${g.path}\n${content}`);
  }

  const componentName = extractComponentName(jsxC) || extractComponentName(codeParts.join('\n')) || 'DefaultComponent';

  // Write entry as .jsx (esbuild auto-detects JSX from extension)
  const entryCode = codeParts.join('\n\n') + `

function Wrapper() {
  try { return React.createElement(${componentName}); }
  catch(e) { return React.createElement('div', { style: { color:'#ef4444', padding:'20px' } }, 'Render Error: ' + e.message); }
}
var root = document.getElementById('root');
if (root) ReactDOM.createRoot(root).render(React.createElement(Wrapper));
`;

  fs.writeFileSync(tmpEntry, entryCode, 'utf-8');

  // Transpile JSX → JS (no bundling; React from CDN)
  execSync(
    `npx esbuild "${tmpEntry}" --outfile="${tmpOut}" --target=es2020`,
    { cwd: projectRoot, stdio: 'pipe', timeout: 10000 }
  );

  const bundleJs = fs.readFileSync(tmpOut, 'utf-8');

  // Write HTML with React UMD from CDN
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${page.name} - React Preview</title>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>${bundleJs}</script>
</body>
</html>`;

  fs.writeFileSync(path.join(previewDir, `${page.name}-react.html`), html);

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

// ── Fallback (show source in code block) ──────────────────────────

function buildFallbackReactPreview(pageName, jsxContent) {
  const code = jsxContent
    .replace(/import\s+.*?from\s+['"].*?['"]\s*;?\n?/gs, '')
    .replace(/export\s+default\s+function/g, 'function')
    .replace(/export\s+const/g, 'const')
    .replace(/export\s+default\s+/g, '');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageName} - React Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 16px; }
    .preview-info { color: #94a3b8; font-size: 0.85rem; text-align: center; padding: 40px 20px; }
  </style>
</head>
<body>
  <div class="preview-info">
    <h3>${pageName} — React 源码</h3>
    <p style="margin-top: 8px; font-size: 0.75rem; color: #64748b;">请在「代码」标签中查看完整源码</p>
  </div>
  <pre style="background:#1e293b;padding:16px;border-radius:8px;overflow:auto;font-size:0.75rem;color:#e2e8f0;margin-top:12px;"><code>${escapeHtml(code)}</code></pre>
</body>
</html>`;
}

function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Build full app preview ─────────────────────────────────────────

function buildFullAppPreview(pages) {
  const navItems = pages.map((p, i) => `<button class="nav-btn" onclick="switchPage(${i})">${p.name}</button>`).join('\n      ');
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
  <div class="app-header"><h1>⚛️ ${pages.length} 页预览</h1><div class="nav">${navItems}</div></div>
  <div class="preview-container">${pagePreviews}</div>
  <script>
    let currentPage = 0;
    const navBtns = document.querySelectorAll('.nav-btn');
    function switchPage(i) {
      document.getElementById('preview-'+currentPage).style.display='none';
      navBtns[currentPage].classList.remove('active');
      document.getElementById('preview-'+i).style.display='block';
      navBtns[i].classList.add('active');
      currentPage = i;
    }
    navBtns[0].classList.add('active');
  </script>
</body>
</html>`;
}

// ── Extract component name ────────────────────────────────────────

function extractComponentName(code) {
  const match = code.match(/(?:export\s+default\s+)?(?:function|const)\s+(\w+)/);
  return match ? match[1] : null;
}
