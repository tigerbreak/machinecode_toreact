import { useState, useEffect, useCallback, useRef } from 'react'
import type { Stage, Run, StageStatus, FileInfo, PageInput, PagePreview, LinkageResponse } from './api'
import { fetchStages, createRun, getRun, listRuns, listFiles, getFileContent, getLogs, createWorkspace, createRunWithWorkspace, getRunPages, getPreviewUrl, getLinkage } from './api'
import './App.css'

// ── Icons ────────────────────────────────────────────────────────
const CheckIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
const CrossIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
const SpinnerIcon = () => <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round"/></svg>
const ClockIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
const PlayIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
const AddIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
const TrashIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>

// ── Types ────────────────────────────────────────────────────────

type AppView = 'input' | 'pipeline' | 'results' | 'files';
type ResultsTab = 'preview' | 'results' | 'files' | 'linkage';

interface PageEntry {
  id: string;
  name: string;
  htmlContent: string;
  jsxContent: string;
  linkageGroup: string;
}

// ── App ──────────────────────────────────────────────────────────

export default function App() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [selected, setSelected] = useState<string[]>(['baseline', 'linkage', 'audit', 'decompose', 'verify']);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [currentRun, setCurrentRun] = useState<Run | null>(null);
  const [runHistory, setRunHistory] = useState<{ id: string; status: string; stages: StageStatus[]; created_at: string }[]>([]);
  const [view, setView] = useState<AppView>('input');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const pollingRef = useRef<number>(0);

  // ── Preview / Results view state ──────────────────────────────
  const [resultsTab, setResultsTab] = useState<ResultsTab>('preview');
  const [pagePreviews, setPagePreviews] = useState<PagePreview[]>([]);
  const [selectedPageIdx, setSelectedPageIdx] = useState(0);
  const [linkageData, setLinkageData] = useState<LinkageResponse | null>(null);
  const [previewCodeFile, setPreviewCodeFile] = useState<string | null>(null);
  const [previewCodeContent, setPreviewCodeContent] = useState('');

  // ── Input view state ──────────────────────────────────────────
  const [pages, setPages] = useState<PageEntry[]>([
    { id: crypto.randomUUID(), name: 'page1', htmlContent: '', jsxContent: '', linkageGroup: 'default' },
  ]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pagesSaved, setPagesSaved] = useState(false);

  useEffect(() => {
    fetchStages().then(setStages).catch(() => {});
    listRuns().then(setRunHistory).catch(() => {});
  }, []);

  // Poll run status & fetch preview data on completion
  useEffect(() => {
    if (!currentRun || currentRun.status === 'complete' || currentRun.status === 'error') {
      clearInterval(pollingRef.current);
      return;
    }
    pollingRef.current = window.setInterval(async () => {
      try {
        const updated = await getRun(currentRun.id);
        setCurrentRun(updated);
        setLogs(updated.logs);
        if (updated.status === 'complete' || updated.status === 'error') {
          clearInterval(pollingRef.current);
          const flist = await listFiles(currentRun.id);
          setFiles(flist);
          listRuns().then(setRunHistory);
          // Fetch preview and linkage data on completion
          if (updated.status === 'complete') {
            try {
              const pages = await getRunPages(currentRun.id);
              if (pages.pages?.length > 0) {
                setPagePreviews(pages.pages);
                setResultsTab('preview');
              }
            } catch {}
            try {
              const linkage = await getLinkage(currentRun.id);
              if (linkage.groups?.length > 0) {
                setLinkageData(linkage);
              }
            } catch {}
          }
        }
      } catch {}
    }, 1000);
    return () => clearInterval(pollingRef.current);
  }, [currentRun?.id, currentRun?.status]);

  // ── Input view handlers ───────────────────────────────────────

  const addPage = () => {
    setPages(prev => [...prev, {
      id: crypto.randomUUID(),
      name: `page${prev.length + 1}`,
      htmlContent: '',
      jsxContent: '',
      linkageGroup: 'default',
    }]);
    setPagesSaved(false);
  };

  const removePage = (id: string) => {
    if (pages.length <= 1) return;
    setPages(prev => prev.filter(p => p.id !== id));
    setPagesSaved(false);
  };

  const updatePage = (id: string, field: keyof PageEntry, value: string) => {
    setPages(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
    setPagesSaved(false);
  };

  const handleSubmitPages = async () => {
    setError('');
    setSubmitting(true);
    try {
      const apiPages: PageInput[] = pages.map(p => ({
        name: p.name,
        htmlContent: p.htmlContent,
        jsxContent: p.jsxContent,
        linkageGroup: p.linkageGroup,
      }));
      const ws = await createWorkspace(apiPages);
      setWorkspacePath(ws.path);
      setWorkspaceId(ws.id);
      setPagesSaved(true);
      setView('pipeline');
    } catch (e: any) {
      setError(e.message || 'Failed to save pages');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Pipeline handlers ─────────────────────────────────────────

  const handleRun = useCallback(async () => {
    setError('');
    setView('pipeline');
    try {
      const result = workspacePath
        ? await createRunWithWorkspace(selected, workspacePath, apiKey)
        : await createRun(selected, apiKey);
      const run = await getRun(result.id);
      setCurrentRun(run);
      setLogs(run.logs);
    } catch (e: any) {
      setError(e.message || 'Failed to start run');
    }
  }, [selected, apiKey, workspacePath]);

  const handleNewInput = () => {
    setWorkspacePath(null);
    setWorkspaceId(null);
    setPagesSaved(false);
    setView('input');
    setCurrentRun(null);
    setFiles([]);
    setSelectedFile(null);
    setFileContent('');
    setLogs([]);
    setError('');
  };

  const handleSelectFile = useCallback(async (filePath: string) => {
    if (!currentRun) return;
    setSelectedFile(filePath);
    try {
      const content = await getFileContent(currentRun.id, filePath);
      setFileContent(content);
    } catch {
      setFileContent('// Error loading file');
    }
  }, [currentRun]);

  const toggleStage = (key: string) => {
    setSelected(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const getStage = (key: string) => stages.find(s => s.key === key);

  const stageIcons: Record<string, string> = {
    baseline: '📋', linkage: '🔗', audit: '🔍',
    decompose: '🔧', verify: '✅',
  };

  // ── Get unique group names ────────────────────────────────────
  const groups = [...new Set(pages.map(p => p.linkageGroup))];

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1><span className="logo">⚙️</span> Figma Refactor Pipeline</h1>
          <span className="badge">LangGraph + DeepSeek V4 Flash</span>
        </div>
        <p className="subtitle">将 Figma 导出的「机翻」React 代码转换为可维护的多页应用</p>
        <div className="header-tabs">
          <button className={`htab ${view === 'input' ? 'active' : ''}`} onClick={handleNewInput}>
            {'📝'} 输入
          </button>
          <button className={`htab ${view === 'pipeline' || view === 'results' || view === 'files' ? 'active' : ''}`}
            onClick={() => setView(currentRun ? 'results' : 'pipeline')}>
            {'⚙️'} 管线
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          {view === 'input' ? (
            <div className="sidebar-input-info">
              <div className="section">
                <h3>{'📝'} 页面输入</h3>
                <p className="sidebar-hint">
                  添加 Figma 导出的页面内容，每个页面包含 HTML 结构和机翻的 React 代码。
                  通过「联动分组」标记关联页面。
                </p>
              </div>
              <div className="section">
                <h3>页面列表 ({pages.length})</h3>
                <div className="page-list-sidebar">
                  {pages.map((p, i) => (
                    <div key={p.id} className="page-sidebar-item"
                      onClick={() => document.getElementById(`page-card-${p.id}`)?.scrollIntoView({ behavior: 'smooth' })}>
                      <span className="psi-index">{i + 1}</span>
                      <span className="psi-name">{p.name}</span>
                      <span className="psi-group-tag">{p.linkageGroup}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="section">
                <h3>联动分组</h3>
                <div className="group-list-sidebar">
                  {groups.map(g => (
                    <div key={g} className="group-item">
                      <span className="group-tag">{g}</span>
                      <span className="group-count">{pages.filter(p => p.linkageGroup === g).length} 页</span>
                    </div>
                  ))}
                </div>
              </div>
              <button className="btn-run" onClick={handleSubmitPages} disabled={submitting}>
                {submitting ? <><SpinnerIcon /> 保存中...</> : <><PlayIcon /> 保存并前往管线</>}
              </button>
            </div>
          ) : (
            <>
              <div className="section">
                <h3>管线阶段</h3>
                <div className="stage-list">
                  {['baseline', 'linkage', 'audit', 'decompose', 'verify'].map(key => {
                    const stage = getStage(key);
                    if (!stage) return null;
                    const isSelected = selected.includes(key);
                    const runStage = currentRun?.stages.find(s => s.key === key);
                    return (
                      <label key={key} className={`stage-item ${isSelected ? 'active' : ''}`}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleStage(key)}
                          disabled={currentRun?.status === 'running'}
                        />
                        <span className="stage-icon">{stageIcons[key]}</span>
                        <div className="stage-info">
                          <span className="stage-name">{stage.label}</span>
                          <span className="stage-desc">{stage.description}</span>
                        </div>
                        {runStage && <StageBadge status={runStage.status} />}
                      </label>
                    );
                  })}
                </div>
              </div>

              {stages.length === 0 && <p className="loading-text">加载阶段列表...</p>}

              <div className="section">
                <h3>DeepSeek API Key</h3>
                <div className="api-key-input">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="input"
                  />
                  <button className="btn-icon" onClick={() => setShowKey(!showKey)} title={showKey ? '隐藏' : '显示'}>
                    {showKey ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>

              {workspacePath && pagesSaved && (
                <div className="section">
                  <div className="workspace-info">
                    <span className="ws-badge">{'✅'} 已保存</span>
                    <span className="ws-id">{workspaceId}</span>
                    <button className="btn-link" onClick={handleNewInput}>{'✕'} 更换</button>
                  </div>
                </div>
              )}

              <button
                className={`btn-run ${currentRun?.status === 'running' ? 'running' : ''}`}
                onClick={handleRun}
                disabled={currentRun?.status === 'running' || selected.length === 0}
              >
                {currentRun?.status === 'running' ? (
                  <><SpinnerIcon /> 运行中...</>
                ) : (
                  <><PlayIcon /> 开始运行</>
                )}
              </button>

              {error && <div className="error-msg">{error}</div>}

              <div className="section">
                <h3>历史记录</h3>
                <div className="history-list">
                  {runHistory.slice(0, 10).map(r => (
                    <div
                      key={r.id}
                      className={`history-item ${r.id === currentRun?.id ? 'active' : ''}`}
                      onClick={async () => {
                        const run = await getRun(r.id);
                        setCurrentRun(run);
                        setLogs(run.logs);
                        const flist = await listFiles(r.id);
                        setFiles(flist);
                        if (run.status === 'complete' || run.status === 'error') {
                          setView('results');
                        }
                      }}
                    >
                      <div className="history-id">{r.id}</div>
                      <div className="history-status">
                        {r.status === 'complete' ? '✅' : r.status === 'error' ? '❌' : '🔄'}
                        <span className="history-date">{r.created_at.slice(5, 16).replace('T', ' ')}</span>
                      </div>
                      <div className="history-stages">
                        {r.stages.map(s => (
                          <span key={s.key} className={`hs-badge ${s.status}`} title={s.summary || ''}>
                            {s.status === 'ok' ? '\u2713' : s.status === 'error' ? '\u2717' : '\u25CB'}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </aside>

        <main className="main">
          {view === 'input' ? (
            <div className="input-view">
              <div className="input-header">
                <h2>{'📝'} 输入 Figma 导出内容</h2>
                <p>添加每一页的 HTML 结构和对应的机翻 React 代码。通过联动分组标记跨页面关联。</p>
              </div>

              {pages.map((page, index) => (
                <div key={page.id} id={`page-card-${page.id}`} className="page-card">
                  <div className="page-card-header">
                    <div className="page-card-title">
                      <span className="page-index">页面 {index + 1}</span>
                      <input
                        className="page-name-input"
                        value={page.name}
                        onChange={e => updatePage(page.id, 'name', e.target.value)}
                        placeholder="页面名称 (如: login, dashboard)"
                      />
                    </div>
                    <div className="page-card-actions">
                      <div className="linkage-group-select">
                        <label>联动分组:</label>
                        <select
                          value={page.linkageGroup}
                          onChange={e => {
                            const val = e.target.value;
                            if (val === '__new__') {
                              const name = prompt('输入新分组名称:');
                              if (name && name.trim()) {
                                updatePage(page.id, 'linkageGroup', name.trim());
                              }
                            } else {
                              updatePage(page.id, 'linkageGroup', val);
                            }
                          }}
                        >
                          {groups.map(g => <option key={g} value={g}>{g}</option>)}
                          <option value="__new__">{'──'} 新建分组 {'──'}</option>
                        </select>
                      </div>
                      {pages.length > 1 && (
                        <button className="btn-icon btn-remove" onClick={() => removePage(page.id)} title="删除页面">
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="page-card-editors">
                    <div className="editor-pane">
                      <label>{'🌐'} HTML 结构</label>
                      <textarea
                        className="code-textarea"
                        value={page.htmlContent}
                        onChange={e => updatePage(page.id, 'htmlContent', e.target.value)}
                        placeholder={`<div class="login-page">\n  <input type="text" placeholder="用户名"/>\n  <button>登录</button>\n</div>`}
                        rows={10}
                        spellCheck={false}
                      />
                    </div>
                    <div className="editor-pane">
                      <label>{'⚛️'} 机翻 React 代码</label>
                      <textarea
                        className="code-textarea"
                        value={page.jsxContent}
                        onChange={e => updatePage(page.id, 'jsxContent', e.target.value)}
                        placeholder={`import React from 'react';\n\nexport default function LoginPage() {\n  return (\n    <div className="login-page">\n      <input type="text" placeholder="用户名"/>\n      <button>登录</button>\n    </div>\n  );\n}`}
                        rows={10}
                        spellCheck={false}
                      />
                    </div>
                  </div>
                </div>
              ))}

              <div className="input-actions">
                <button className="btn-add" onClick={addPage}>
                  <AddIcon /> 添加页面
                </button>
                <button className="btn-run" onClick={handleSubmitPages} disabled={submitting}>
                  {submitting ? <><SpinnerIcon /> 保存中...</> : <><PlayIcon /> 保存并开始分析</>}
                </button>
              </div>
            </div>
          ) : !currentRun ? (
            <div className="empty-state">
              <div className="empty-icon">📋</div>
              <h2>准备就绪</h2>
              <p>已保存页面内容，选择左侧阶段后点击「开始运行」</p>
              <p className="empty-hint">支持 5 个阶段：HTML 基线分析 → 联动契约 → 代码审计 → 结构分解 → 联动验证</p>
            </div>
          ) : currentRun.status === 'running' ? (
            <div className="pipeline-view">
              <div className="pipeline-progress">
                {currentRun.stages.map((s, i) => (
                  <div key={s.key} className={`pp-node ${s.status}`}>
                    <span className="pp-badge">
                      {s.status === 'ok' ? <CheckIcon /> : s.status === 'error' ? <CrossIcon /> : s.status === 'running' ? <SpinnerIcon /> : <ClockIcon />}
                    </span>
                    <span className="pp-label">{getStage(s.key)?.label || s.key}</span>
                    {i < currentRun.stages.length - 1 && <div className="pp-line" />}
                  </div>
                ))}
              </div>
              <div className="log-view">
                <h3>{'📋'} 日志</h3>
                <div className="log-list">
                  {logs.map((line, i) => (
                    <div key={i} className={`log-line ${line.includes('✅') ? 'ok' : line.includes('❌') ? 'err' : ''}`}>
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="results-view">
              <div className="results-tabs">
                {pagePreviews.length > 0 && (
                  <button className={`tab ${resultsTab === 'preview' ? 'active' : ''}`}
                    onClick={() => setResultsTab('preview')}>
                    {'🎨'} 预览
                  </button>
                )}
                <button className={`tab ${resultsTab === 'results' ? 'active' : ''}`}
                  onClick={() => setResultsTab('results')}>
                  {'📊'} 分析
                </button>
                <button className={`tab ${resultsTab === 'files' ? 'active' : ''}`}
                  onClick={() => { setResultsTab('files'); }}>
                  {'📁'} 文件 ({files.length})
                </button>
                {linkageData && (
                  <button className={`tab ${resultsTab === 'linkage' ? 'active' : ''}`}
                    onClick={() => setResultsTab('linkage')}>
                    {'🔗'} 联动
                  </button>
                )}
              </div>

              {resultsTab === 'preview' && pagePreviews.length > 0 && (
                <div className="preview-content">
                  {/* Page tabs */}
                  <div className="preview-page-tabs">
                    {pagePreviews.map((p, i) => (
                      <button
                        key={p.name}
                        className={`ppt-btn ${i === selectedPageIdx ? 'active' : ''}`}
                        onClick={() => setSelectedPageIdx(i)}
                      >
                        <span className="ppt-group">{p.group}</span>
                        <span className="ppt-name">{p.name}</span>
                      </button>
                    ))}
                    {/* Full app preview */}
                    <button
                      className={`ppt-btn ${selectedPageIdx === -1 ? 'active' : ''}`}
                      onClick={() => setSelectedPageIdx(-1)}
                    >
                      <span className="ppt-group">⚡</span>
                      <span className="ppt-name">运行效果</span>
                    </button>
                  </div>

                  {selectedPageIdx === -1 ? (
                    /* Full app preview */
                    <div className="preview-app">
                      <div className="preview-app-bar">
                        <span>{'⚛️'} 完整多页应用预览</span>
                        <span className="preview-pages-count">{pagePreviews.length} 页</span>
                      </div>
                      <iframe
                        className="preview-iframe preview-iframe-full"
                        src={getPreviewUrl(currentRun.id, 'app.html')}
                        title="React App Preview"
                      />
                    </div>
                  ) : (
                    /* Per-page preview */
                    (() => {
                      const page = pagePreviews[selectedPageIdx];
                      const groupPages = pagePreviews.filter(p => p.group === page.group);
                      const pageInGroup = groupPages.findIndex(p => p.name === page.name);
                      return (
                        <div className="per-page-preview">
                          {/* Side-by-side: HTML original | React preview */}
                          <div className="per-page-columns">
                            <div className="per-page-col">
                              <div className="col-header">{'🌐'} 原始 HTML</div>
                              <iframe
                                className="preview-iframe"
                                src={getPreviewUrl(currentRun.id, `${page.name}-original.html`)}
                                title={`${page.name} HTML`}
                              />
                            </div>
                            <div className="per-page-col">
                              <div className="col-header">{'⚛️'} React 组件</div>
                              <iframe
                                className="preview-iframe"
                                src={getPreviewUrl(currentRun.id, `${page.name}-react.html`)}
                                title={`${page.name} React`}
                              />
                            </div>
                          </div>

                          {/* React code */}
                          <div className="code-preview-section">
                            <div className="code-preview-header">
                              <span>{'📄'} React 代码 — {page.name}</span>
                              <div className="code-file-selector">
                                {page.generated?.length > 0 && (
                                  <select
                                    value={previewCodeFile || ''}
                                    onChange={e => {
                                      const f = page.generated.find(g => g.path === e.target.value);
                                      if (f) { setPreviewCodeFile(f.path); setPreviewCodeContent(f.content); }
                                    }}
                                  >
                                    <option value="">机翻代码 (JSX)</option>
                                    {page.generated.map(g => (
                                      <option key={g.path} value={g.path}>{g.path.replace(/^src\//, '')}</option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            </div>
                            <pre className="preview-code">
                              <code>{previewCodeFile ? previewCodeContent : page.jsxContent || '// No code'}</code>
                            </pre>
                          </div>

                          {/* Group navigation hint */}
                          {groupPages.length > 1 && (
                            <div className="group-nav-hint">
                              <span className="gnh-icon">{'🔗'}</span>
                              <span>该页面在分组 <strong>{page.group}</strong> 中 (共 {groupPages.length} 页)</span>
                              <div className="gnh-pages">
                                {groupPages.map((gp, gi) => (
                                  <span key={gp.name}
                                    className={`gnh-page ${gp.name === page.name ? 'active' : ''}`}
                                    onClick={() => setSelectedPageIdx(pagePreviews.indexOf(gp))}>
                                    {gi + 1}. {gp.name}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()
                  )}
                </div>
              )}

              {resultsTab === 'results' && (
                <div className="results-content">
                  <div className="summary-bar">
                    <span className={`sum-badge ${currentRun.status === 'complete' ? 'ok' : 'err'}`}>
                      {currentRun.status === 'complete' ? '✅ 完成' : '❌ 失败'}
                    </span>
                  </div>
                  {currentRun.stages.map(s => (
                    <div key={s.key} className="result-card">
                      <div className="result-header">
                        <span className={`r-status ${s.status}`}>
                          {s.status === 'ok' ? <CheckIcon /> : s.status === 'error' ? <CrossIcon /> : <ClockIcon />}
                        </span>
                        <strong>{getStage(s.key)?.label || s.key}</strong>
                        {s.summary && <span className="r-summary">{s.summary}</span>}
                      </div>
                      {s.error && <div className="r-error">{s.error}</div>}
                      {currentRun.results?.[s.key] && (
                        <div className="r-detail">
                          {currentRun.results[s.key].issues && (
                            <div className="issues-list">
                              {currentRun.results[s.key].issues.slice(0, 10).map((issue: any, i: number) => (
                                <div key={i} className={`issue-item ${issue.severity}`}>
                                  <span className={`issue-badge ${issue.severity}`}>{issue.severity}</span>
                                  <span className="issue-cat">{issue.category}</span>
                                  <span className="issue-msg">{issue.message}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {currentRun.results[s.key].brokenContracts && currentRun.results[s.key].brokenContracts.length > 0 && (
                            <div className="broken-list">
                              <h4>{'❌'} 断裂契约</h4>
                              {currentRun.results[s.key].brokenContracts.map((c: any, i: number) => (
                                <div key={i} className="broken-item">
                                  <strong>[{c.pattern}]</strong> {c.source} {'→'} {c.parameter || '?'}
                                  <span className="broken-detail">{c.detail}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {currentRun.results[s.key].files && (
                            <div className="files-summary">
                              {currentRun.results[s.key].files.map((f: any, i: number) => (
                                <div key={i} className="file-chip" onClick={() => handleSelectFile(f.path)}>
                                  {'📄'} {f.path} ({f.lines || f.size || 0} 行)
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  <div className="log-view">
                    <h3>{'📋'} 完整日志</h3>
                    <div className="log-list">
                      {logs.map((line, i) => (
                        <div key={i} className={`log-line ${line.includes('✅') ? 'ok' : line.includes('❌') ? 'err' : ''}`}>
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {resultsTab === 'files' && (
                <div className="files-view">
                  <div className="file-tree">
                    <h3>源文件</h3>
                    {files.filter(f => f.type === 'source').map(f => (
                      <div
                        key={f.path}
                        className={`file-item ${selectedFile === f.path ? 'active' : ''}`}
                        onClick={() => handleSelectFile(f.path)}
                      >
                        <span className="file-icon">
                          {f.path.endsWith('.tsx') || f.path.endsWith('.jsx') ? '📄' :
                           f.path.endsWith('.ts') ? '📘' :
                           f.path.endsWith('.json') ? '📋' :
                           f.path.endsWith('.html') ? '🌐' : '📄'}
                        </span>
                        <span className="file-name">{f.path.replace(/^src\//, '')}</span>
                        <span className="file-size">{f.lines} 行</span>
                      </div>
                    ))}
                    <h3 style={{ marginTop: 24 }}>产物</h3>
                    {files.filter(f => f.type === 'artifact').map(f => (
                      <div
                        key={f.path}
                        className={`file-item ${selectedFile === f.path ? 'active' : ''}`}
                        onClick={() => handleSelectFile(f.path)}
                      >
                        <span className="file-icon">📊</span>
                        <span className="file-name">{f.path.replace(/^\.figma-stage\//, '')}</span>
                        <span className="file-size">{(f.size / 1024).toFixed(1)} KB</span>
                      </div>
                    ))}
                  </div>
                  <div className="file-viewer">
                    {selectedFile ? (
                      <>
                        <div className="viewer-header">
                          <span>{selectedFile}</span>
                          <button className="btn-icon" onClick={() => setSelectedFile(null)}>{'✕'}</button>
                        </div>
                        <pre className="viewer-content"><code>{fileContent}</code></pre>
                      </>
                    ) : (
                      <div className="viewer-empty">
                        <div className="empty-icon">📁</div>
                        <p>选择一个文件查看内容</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {resultsTab === 'linkage' && linkageData && (
                <div className="linkage-view">
                  <div className="linkage-header">
                    <h3>{'🔗'} 联动关系</h3>
                    <span className="linkage-summary">{linkageData.groups.length} 个分组, {linkageData.contracts.length} 个契约</span>
                  </div>
                  {linkageData.groups.map(group => (
                    <div key={group.name} className="linkage-group">
                      <div className="linkage-group-header">
                        <span className="lg-badge">{group.name}</span>
                        <span className="lg-count">{group.pages.join(', ')} ({group.contracts.length} 个联动)</span>
                      </div>
                      <div className="linkage-graph">
                        {group.pages.map((p, i) => (
                          <span key={p} className="lg-node" onClick={() => {
                            const idx = pagePreviews.findIndex(pp => pp.name === p);
                            if (idx >= 0) { setSelectedPageIdx(idx); setResultsTab('preview'); }
                          }}>{p}</span>
                        ))}
                      </div>
                      {group.contracts.map((c, ci) => (
                        <div key={ci} className="linkage-contract">
                          <span className="lc-pattern">[{c.pattern}]</span>
                          <span className="lc-arrow">{c.source} {'→'} {c.target}</span>
                          <code className="lc-snippet">{c.snippet}</code>
                        </div>
                      ))}
                    </div>
                  ))}
                  {linkageData.verification?.brokenContracts?.length > 0 && (
                    <div className="linkage-broken">
                      <h4>{'❌'} 断裂契约</h4>
                      {linkageData.verification.brokenContracts.map((bc: any, i: number) => (
                        <div key={i} className="broken-item">
                          <strong>[{bc.pattern}]</strong> {bc.source} {'→'} {bc.parameter || bc.target}
                          <span className="broken-detail">{bc.detail || bc.verificationDetail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// ── StageBadge ───────────────────────────────────────────────────

function StageBadge({ status }: { status: string }) {
  if (status === 'ok') return <span className="badge badge-ok"><CheckIcon /></span>;
  if (status === 'error') return <span className="badge badge-err"><CrossIcon /></span>;
  if (status === 'running') return <span className="badge badge-run"><SpinnerIcon /></span>;
  return <span className="badge badge-pending"><ClockIcon /></span>;
}
