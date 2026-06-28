import { useState, useEffect, useCallback, useRef } from 'react'
import type { Stage, Run, StageStatus, FileInfo } from './api'
import { fetchStages, createRun, getRun, listRuns, listFiles, getFileContent, getLogs } from './api'
import './App.css'

// ── Icons ────────────────────────────────────────────────────────
const CheckIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
const CrossIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
const SpinnerIcon = () => <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" strokeLinecap="round"/></svg>
const ClockIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
const PlayIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
const StopIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>

// ── Types ────────────────────────────────────────────────────────

type AppView = 'pipeline' | 'results' | 'files';

// ── App ──────────────────────────────────────────────────────────

export default function App() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [selected, setSelected] = useState<string[]>(['baseline', 'linkage', 'audit', 'decompose', 'verify']);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [currentRun, setCurrentRun] = useState<Run | null>(null);
  const [runHistory, setRunHistory] = useState<{ id: string; status: string; stages: StageStatus[]; created_at: string }[]>([]);
  const [view, setView] = useState<AppView>('pipeline');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const pollingRef = useRef<number>(0);

  useEffect(() => {
    fetchStages().then(setStages).catch(() => {});
    listRuns().then(setRunHistory).catch(() => {});
  }, []);

  // Poll run status
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
          // Refresh files and history
          const flist = await listFiles(currentRun.id);
          setFiles(flist);
          listRuns().then(setRunHistory);
        }
      } catch {}
    }, 1000);
    return () => clearInterval(pollingRef.current);
  }, [currentRun?.id, currentRun?.status]);

  const handleRun = useCallback(async () => {
    setError('');
    setView('pipeline');
    try {
      const result = await createRun(selected, apiKey);
      const run = await getRun(result.id);
      setCurrentRun(run);
      setLogs(run.logs);
    } catch (e: any) {
      setError(e.message || 'Failed to start run');
    }
  }, [selected, apiKey]);

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

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1><span className="logo">⚙️</span> Figma Refactor Pipeline</h1>
          <span className="badge">LangGraph + DeepSeek V4 Flash</span>
        </div>
        <p className="subtitle">将 Figma 导出的「机翻」React 代码转换为可维护的多页应用</p>
      </header>

      <div className="layout">
        <aside className="sidebar">
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
                  }}
                >
                  <span className={`status-dot ${r.status}`} />
                  <span className="history-id">{r.id.slice(0, 8)}</span>
                  <span className={`history-status ${r.status}`}>{r.status}</span>
                </div>
              ))}
              {runHistory.length === 0 && <span className="empty-text">暂无记录</span>}
            </div>
          </div>
        </aside>

        <main className="main">
          {!currentRun ? (
            <div className="empty-state">
              <div className="empty-icon">🚀</div>
              <h2>准备就绪</h2>
              <p>选择左侧管线阶段，点击「开始运行」启动 LangGraph 工作流</p>
              <div className="pipeline-vis">
                {['baseline', 'linkage', 'audit', 'decompose', 'verify'].map((key, i) => {
                  const stage = getStage(key);
                  return (
                    <div key={key} className="pipe-step">
                      <div className={`pipe-node ${selected.includes(key) ? 'selected' : ''}`}>
                        <span className="pipe-icon">{stageIcons[key]}</span>
                      </div>
                      <span className="pipe-label">{stage?.label || key}</span>
                      {i < 4 && <div className="pipe-arrow">→</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : currentRun.status === 'running' ? (
            <div className="running-view">
              <div className="running-header">
                <SpinnerIcon />
                <h2>工作流运行中...</h2>
              </div>
              <div className="pipeline-progress">
                {currentRun.stages.map((s, i) => (
                  <div key={s.key} className={`pp-step ${s.status}`}>
                    <div className="pp-node">
                      {s.status === 'ok' ? <CheckIcon /> :
                       s.status === 'error' ? <CrossIcon /> :
                       s.status === 'running' ? <SpinnerIcon /> :
                       <ClockIcon />}
                    </div>
                    <span className="pp-label">{getStage(s.key)?.label || s.key}</span>
                    {i < currentRun.stages.length - 1 && <div className="pp-line" />}
                  </div>
                ))}
              </div>
              <div className="log-view">
                <h3>📋 日志</h3>
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
                <button className={`tab ${view === 'results' ? 'active' : ''}`} onClick={() => setView('results')}>
                  📊 结果
                </button>
                <button className={`tab ${view === 'files' ? 'active' : ''}`} onClick={() => { setView('files'); }}>
                  📁 文件 ({files.length})
                </button>
              </div>

              {view === 'results' && (
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
                              <h4>❌ 断裂契约</h4>
                              {currentRun.results[s.key].brokenContracts.map((c: any, i: number) => (
                                <div key={i} className="broken-item">
                                  <strong>[{c.pattern}]</strong> {c.source} → {c.parameter || '?'}
                                  <span className="broken-detail">{c.detail}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {currentRun.results[s.key].files && (
                            <div className="files-summary">
                              {currentRun.results[s.key].files.map((f: any, i: number) => (
                                <div key={i} className="file-chip" onClick={() => handleSelectFile(f.path)}>
                                  📄 {f.path} ({f.lines || f.size || 0} 行)
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  <div className="log-view">
                    <h3>📋 完整日志</h3>
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

              {view === 'files' && (
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
                          <button className="btn-icon" onClick={() => setSelectedFile(null)}>✕</button>
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
