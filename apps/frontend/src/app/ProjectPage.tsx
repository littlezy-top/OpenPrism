import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  createProject,
  deleteProject,
  importArxivSSE,
  importZip,
  listProjects,
  listTemplates,
  renameProject,
  convertTemplate
} from '../api/client';

export default function ProjectPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [projects, setProjects] = useState<{ id: string; name: string; createdAt: string }[]>([]);
  const [templates, setTemplates] = useState<{ id: string; label: string; mainFile: string }[]>([]);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createTemplate, setCreateTemplate] = useState('');
  const [renameState, setRenameState] = useState<{ id: string; value: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [arxivInput, setArxivInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ phase: string; percent: number } | null>(null);
  const [templateMap, setTemplateMap] = useState<Record<string, string>>({});
  const [mainFileMap, setMainFileMap] = useState<Record<string, string>>({});
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const loadProjects = useCallback(async () => {
    const res = await listProjects();
    setProjects(res.projects || []);
  }, []);

  useEffect(() => {
    loadProjects().catch((err) => setStatus(t('加载项目失败: {{error}}', { error: String(err) })));
  }, [loadProjects, t]);

  useEffect(() => {
    listTemplates()
      .then((res) => {
        setTemplates(res.templates || []);
        if (res.templates?.length && !createTemplate) {
          setCreateTemplate(res.templates[0].id);
        }
      })
      .catch((err) => setStatus(t('模板加载失败: {{error}}', { error: String(err) })));
  }, [createTemplate, t]);

  const filteredProjects = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return projects;
    return projects.filter((item) => item.name.toLowerCase().includes(term));
  }, [filter, projects]);

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name) {
      setStatus(t('请输入项目名称。'));
      return;
    }
    try {
      const created = await createProject({ name, template: createTemplate || undefined });
      setCreateOpen(false);
      setCreateName('');
      await loadProjects();
      navigate(`/editor/${created.id}`);
    } catch (err) {
      setStatus(t('创建失败: {{error}}', { error: String(err) }));
    }
  };

  const handleRename = async () => {
    if (!renameState) return;
    const name = renameState.value.trim();
    if (!name) {
      setRenameState(null);
      return;
    }
    try {
      await renameProject(renameState.id, name);
      setRenameState(null);
      await loadProjects();
    } catch (err) {
      setStatus(t('重命名失败: {{error}}', { error: String(err) }));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(t('删除项目 {{name}}？此操作不可撤销。', { name }))) return;
    try {
      await deleteProject(id);
      await loadProjects();
    } catch (err) {
      setStatus(t('删除失败: {{error}}', { error: String(err) }));
    }
  };

  const handleImportZip = async (file: File) => {
    setImporting(true);
    try {
      const res = await importZip({ file, projectName: file.name.replace(/\.zip$/i, '') || t('Imported Project') });
      if (!res.ok || !res.project) {
        throw new Error(res.error || t('导入失败'));
      }
      setImportOpen(false);
      await loadProjects();
      navigate(`/editor/${res.project.id}`);
    } catch (err) {
      setStatus(t('Zip 导入失败: {{error}}', { error: String(err) }));
    } finally {
      setImporting(false);
    }
  };

  const handleImportArxiv = async () => {
    if (!arxivInput.trim()) {
      setStatus(t('请输入 arXiv URL 或 ID。'));
      return;
    }
    setImporting(true);
    setImportProgress({ phase: 'download', percent: 0 });
    try {
      const res = await importArxivSSE(
        { arxivIdOrUrl: arxivInput.trim() },
        (prog) => setImportProgress(prog)
      );
      if (!res.ok || !res.project) {
        throw new Error(res.error || t('导入失败'));
      }
      setArxivInput('');
      setImportOpen(false);
      await loadProjects();
      navigate(`/editor/${res.project.id}`);
    } catch (err) {
      setStatus(t('arXiv 导入失败: {{error}}', { error: String(err) }));
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  const handleConvertTemplate = async (projectId: string) => {
    const templateId = templateMap[projectId] || templates[0]?.id;
    if (!templateId) {
      setStatus(t('暂无模板可用。'));
      return;
    }
    const mainFile = mainFileMap[projectId] || 'main.tex';
    setStatus(t('正在转换模板...'));
    try {
      const res = await convertTemplate({ projectId, targetTemplate: templateId, mainFile });
      if (!res.ok) {
        throw new Error(res.error || t('模板转换失败'));
      }
      setStatus(t('模板已切换为 {{template}}', { template: templateId }));
    } catch (err) {
      setStatus(t('模板转换失败: {{error}}', { error: String(err) }));
    }
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-title">OpenPrism</div>
          <div className="brand-sub">{t('Projects Workspace')}</div>
        </div>
        <div className="toolbar">
          <button className="btn ghost" onClick={() => setCreateOpen(true)}>{t('新建项目')}</button>
          <button className="btn ghost" onClick={() => setImportOpen(true)}>{t('导入项目')}</button>
          <select
            className="select"
            value={i18n.language}
            onChange={(event) => i18n.changeLanguage(event.target.value)}
          >
            <option value="zh-CN">{t('中文')}</option>
            <option value="en-US">{t('English')}</option>
          </select>
        </div>
      </header>

      <div className="status-bar">
        <div>{status}</div>
      </div>

      <main className="project-page">
        <div className="panel-search">
          <input
            className="input"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('搜索项目...')}
          />
        </div>
        <div className="project-grid">
          {filteredProjects.map((project) => (
            <div key={project.id} className="project-card">
              {renameState?.id === project.id ? (
                <input
                  className="inline-input"
                  autoFocus
                  value={renameState.value}
                  onChange={(event) => setRenameState({ ...renameState, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleRename();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setRenameState(null);
                    }
                  }}
                  onBlur={() => setRenameState(null)}
                />
              ) : (
                <div className="project-title">{project.name}</div>
              )}
              <div className="project-meta">{new Date(project.createdAt).toLocaleString()}</div>
              <div className="project-actions">
                <button className="btn" onClick={() => navigate(`/editor/${project.id}`)}>{t('打开')}</button>
                <button className="btn ghost" onClick={() => setRenameState({ id: project.id, value: project.name })}>{t('重命名')}</button>
                <button className="btn ghost" onClick={() => handleDelete(project.id, project.name)}>{t('删除')}</button>
              </div>
              <div className="project-convert">
                <select
                  className="select"
                  value={templateMap[project.id] || templates[0]?.id || ''}
                  onChange={(event) => setTemplateMap((prev) => ({ ...prev, [project.id]: event.target.value }))}
                >
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>{tpl.label}</option>
                  ))}
                </select>
                <input
                  className="input"
                  value={mainFileMap[project.id] || 'main.tex'}
                  onChange={(event) => setMainFileMap((prev) => ({ ...prev, [project.id]: event.target.value }))}
                  placeholder="main.tex"
                />
                <button className="btn ghost" onClick={() => handleConvertTemplate(project.id)}>{t('转换模板')}</button>
              </div>
            </div>
          ))}
          {filteredProjects.length === 0 && (
            <div className="muted">{t('暂无项目。')}</div>
          )}
        </div>
      </main>

      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            handleImportZip(file);
          }
          if (event.target) {
            event.target.value = '';
          }
        }}
      />

      {createOpen && (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>{t('新建项目')}</div>
              <button className="icon-btn" onClick={() => setCreateOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t('项目名称')}</label>
                <input
                  className="input"
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder={t('My Paper')}
                />
              </div>
              <div className="field">
                <label>{t('模板')}</label>
                <select
                  className="select"
                  value={createTemplate}
                  onChange={(event) => setCreateTemplate(event.target.value)}
                >
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>{tpl.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setCreateOpen(false)}>{t('取消')}</button>
              <button className="btn" onClick={handleCreate}>{t('创建')}</button>
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="modal-backdrop" onClick={() => setImportOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>{t('导入项目')}</div>
              <button className="icon-btn" onClick={() => setImportOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t('上传 Zip 文件')}</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    className="btn"
                    onClick={() => zipInputRef.current?.click()}
                    disabled={importing}
                  >
                    {t('选择文件')}
                  </button>
                  {importing && <span className="muted">{t('导入中...')}</span>}
                </div>
              </div>
              <div className="field" style={{ borderTop: '1px solid var(--border, #e0e0e0)', paddingTop: '12px', marginTop: '4px' }}>
                <label>{t('arXiv 链接导入')}</label>
                <input
                  className="input"
                  value={arxivInput}
                  onChange={(event) => setArxivInput(event.target.value)}
                  placeholder={t('arXiv URL 或 ID，例如 2301.00001')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleImportArxiv();
                    }
                  }}
                />
              </div>
              {importProgress && (
                <div className="field" style={{ paddingTop: '8px' }}>
                  <label>
                    {importProgress.phase === 'download'
                      ? importProgress.percent >= 0
                        ? t('下载中... {{percent}}%', { percent: importProgress.percent })
                        : t('下载中...')
                      : t('解压中...')}
                  </label>
                  <div style={{
                    width: '100%',
                    height: '6px',
                    background: 'var(--border, #e0e0e0)',
                    borderRadius: '3px',
                    overflow: 'hidden',
                    marginTop: '4px'
                  }}>
                    <div style={{
                      width: importProgress.percent >= 0 ? `${importProgress.percent}%` : '100%',
                      height: '100%',
                      background: 'var(--accent, #4a90d9)',
                      borderRadius: '3px',
                      transition: 'width 0.3s ease',
                      animation: importProgress.percent < 0 ? 'indeterminate 1.5s infinite linear' : undefined
                    }} />
                  </div>
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setImportOpen(false)}>{t('取消')}</button>
              <button className="btn" onClick={handleImportArxiv} disabled={importing || !arxivInput.trim()}>
                {t('导入 arXiv')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
