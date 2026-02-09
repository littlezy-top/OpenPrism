import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  transferStart,
  transferStep,
  transferSubmitImages,
  listProjects,
} from '../api/client';
import type {
  LLMConfig,
  ProjectMeta,
} from '../api/client';

interface TransferPanelProps {
  projectId: string;
  mainFile: string;
  llmConfig?: Partial<LLMConfig>;
}

const ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'latexmk'] as const;

export default function TransferPanel({ projectId, mainFile, llmConfig }: TransferPanelProps) {
  const { t } = useTranslation();

  // Target selection
  const [targetProjectId, setTargetProjectId] = useState('');
  const [targetMainFile, setTargetMainFile] = useState('main.tex');
  const [engine, setEngine] = useState('pdflatex');
  const [layoutCheck, setLayoutCheck] = useState(false);

  // Dropdown open states
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [engineDropdownOpen, setEngineDropdownOpen] = useState(false);

  // Job state
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState<string>('idle');
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  // Project list for target selection
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  // Refs for click-outside
  const projectRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<HTMLDivElement>(null);

  // Load projects on mount
  useEffect(() => {
    if (!projectsLoaded) {
      listProjects()
        .then(res => {
          setProjects(res.projects.filter(p => p.id !== projectId));
          setProjectsLoaded(true);
        })
        .catch(() => {});
    }
  }, [projectId, projectsLoaded]);

  // Click outside to close dropdowns
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (projectRef.current && !projectRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false);
      }
      if (engineRef.current && !engineRef.current.contains(e.target as Node)) {
        setEngineDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedProjectName = projects.find(p => p.id === targetProjectId)?.name || '';

  const handleStart = useCallback(async () => {
    if (!targetProjectId || !targetMainFile) return;
    setError('');
    setProgressLog([]);
    setRunning(true);
    setStatus('starting');

    try {
      const res = await transferStart({
        sourceProjectId: projectId,
        sourceMainFile: mainFile,
        targetProjectId,
        targetMainFile,
        engine,
        layoutCheck,
        llmConfig,
      });
      setJobId(res.jobId);
      setStatus('started');
      await runGraph(res.jobId);
    } catch (err: any) {
      setError(err.message || 'Failed to start transfer');
      setRunning(false);
      setStatus('error');
    }
  }, [targetProjectId, targetMainFile, projectId, mainFile, engine, layoutCheck, llmConfig]);

  const runGraph = useCallback(async (jid: string) => {
    try {
      const res = await transferStep(jid);
      setProgressLog(res.progressLog || []);
      setStatus(res.status);

      if (res.status === 'waiting_images') {
        setRunning(false);
        return;
      }
      if (res.status === 'success' || res.status === 'failed') {
        setRunning(false);
        return;
      }
      if (res.error) {
        setError(res.error);
        setRunning(false);
        return;
      }
    } catch (err: any) {
      setError(err.message || 'Step failed');
      setRunning(false);
      setStatus('error');
    }
  }, []);

  const chevronSvg = (open: boolean) => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={open ? 'rotate' : ''}>
      <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );

  const checkSvg = (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );

  return (
    <div className="transfer-panel">
      {/* Target project selection */}
      <div className="field">
        <label>{t('目标项目')}</label>
        <div className="ios-select-wrapper" ref={projectRef}>
          <button
            className="ios-select-trigger"
            onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
          >
            <span>{selectedProjectName || t('选择目标项目...')}</span>
            {chevronSvg(projectDropdownOpen)}
          </button>
          {projectDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              {projects.map(p => (
                <div
                  key={p.id}
                  className={`ios-dropdown-item ${targetProjectId === p.id ? 'active' : ''}`}
                  onClick={() => { setTargetProjectId(p.id); setProjectDropdownOpen(false); }}
                >
                  {p.name}
                  {targetProjectId === p.id && checkSvg}
                </div>
              ))}
              {projects.length === 0 && (
                <div className="ios-dropdown-item" style={{ color: 'var(--muted)', pointerEvents: 'none' }}>
                  {t('暂无可选项目')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Target main file */}
      <div className="field">
        <label>{t('目标主文件')}</label>
        <input
          className="input"
          type="text"
          placeholder="main.tex"
          value={targetMainFile}
          onChange={e => setTargetMainFile(e.target.value)}
        />
      </div>

      {/* Engine selection */}
      <div className="field">
        <label>{t('编译引擎')}</label>
        <div className="ios-select-wrapper" ref={engineRef}>
          <button
            className="ios-select-trigger"
            onClick={() => setEngineDropdownOpen(!engineDropdownOpen)}
          >
            <span>{engine}</span>
            {chevronSvg(engineDropdownOpen)}
          </button>
          {engineDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              {ENGINES.map(eng => (
                <div
                  key={eng}
                  className={`ios-dropdown-item ${engine === eng ? 'active' : ''}`}
                  onClick={() => { setEngine(eng); setEngineDropdownOpen(false); }}
                >
                  {eng}
                  {engine === eng && checkSvg}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Layout check toggle */}
      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={layoutCheck}
          onChange={e => setLayoutCheck(e.target.checked)}
        />
        {t('启用排版检查 (VLM)')}
      </label>

      {/* Start button */}
      <button
        className="btn primary"
        style={{ width: '100%', marginBottom: 12 }}
        disabled={running || !targetProjectId || !targetMainFile}
        onClick={handleStart}
      >
        {running ? t('转换中...') : t('开始转换')}
      </button>

      {/* Status */}
      {status !== 'idle' && (
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          <strong>{t('状态')}:</strong> {status}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ fontSize: 12, color: '#d32f2f', marginBottom: 8 }}>
          {error}
        </div>
      )}

      {/* Progress log */}
      {progressLog.length > 0 && (
        <div style={{
          fontSize: 11,
          fontFamily: 'monospace',
          background: 'rgba(120, 98, 83, 0.06)',
          borderRadius: 8,
          padding: 8,
          maxHeight: 300,
          overflowY: 'auto' as const,
        }}>
          {progressLog.map((line, i) => (
            <div key={i} style={{ marginBottom: 2 }}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
