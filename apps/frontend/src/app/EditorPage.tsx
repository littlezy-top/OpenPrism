import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, MouseEvent, SetStateAction, RefObject, DragEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { basicSetup } from 'codemirror';
import { latex } from '../latex/lang';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, DecorationSet, WidgetType, keymap } from '@codemirror/view';
import { search, searchKeymap } from '@codemirror/search';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { toggleComment } from '@codemirror/commands';
import { foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { GlobalWorkerOptions, getDocument, renderTextLayer } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import {
  arxivBibtex,
  arxivSearch,
  createFolder as createFolderApi,
  compileProject,
  getAllFiles,
  getFile,
  getProjectTree,
  listProjects,
  renamePath,
  updateFileOrder,
  runAgent,
  plotFromTable,
  callLLM,
  uploadFiles,
  visionToLatex,
  writeFile
} from '../api/client';
import type { ArxivPaper } from '../api/client';
import { createTwoFilesPatch, diffLines } from 'diff';
import { createLatexEngine, LatexEngine, CompileOutcome } from '../latex/engine';

GlobalWorkerOptions.workerSrc = pdfWorker;

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface WebsearchItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  bibtex: string;
  citeKey: string;
}

interface PendingChange {
  filePath: string;
  original: string;
  proposed: string;
  diff: string;
}

type InlineEdit =
  | { kind: 'new-file' | 'new-folder'; parent: string; value: string }
  | { kind: 'rename'; path: string; value: string };

type CompileEngine = 'swiftlatex' | 'tectonic' | 'auto';

type AppSettings = {
  texliveEndpoint: string;
  llmEndpoint: string;
  llmApiKey: string;
  llmModel: string;
  searchEndpoint: string;
  searchApiKey: string;
  searchModel: string;
  visionEndpoint: string;
  visionApiKey: string;
  visionModel: string;
  compileEngine: CompileEngine;
};

const DEFAULT_TASKS = [
  { value: 'polish', label: '润色' },
  { value: 'rewrite', label: '改写' },
  { value: 'structure', label: '结构调整' },
  { value: 'translate', label: '翻译' },
  { value: 'websearch', label: '检索 (arXiv)' },
  { value: 'custom', label: '自定义' }
];

const SETTINGS_KEY = 'openprism-settings-v1';
const DEFAULT_SETTINGS: AppSettings = {
  texliveEndpoint: 'https://texlive.swiftlatex.com',
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
  searchEndpoint: '',
  searchApiKey: '',
  searchModel: '',
  visionEndpoint: '',
  visionApiKey: '',
  visionModel: '',
  compileEngine: 'swiftlatex'
};

function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const engine = parsed.compileEngine;
    const compileEngine: CompileEngine =
      engine === 'swiftlatex' || engine === 'tectonic' || engine === 'auto'
        ? engine
        : DEFAULT_SETTINGS.compileEngine;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      compileEngine
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(settings: AppSettings) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

const FIGURE_EXTS = ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps'];
const TEXT_EXTS = ['.sty', '.cls', '.bst', '.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.tsv'];

function isFigureFile(path: string) {
  const lower = path.toLowerCase();
  return FIGURE_EXTS.some((ext) => lower.endsWith(ext));
}

function isTextFile(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith('.tex') || lower.endsWith('.bib') || TEXT_EXTS.some((ext) => lower.endsWith(ext));
}

function getFileTypeLabel(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tex')) return 'TEX';
  if (lower.endsWith('.bib')) return 'BIB';
  if (lower.endsWith('.cls')) return 'CLS';
  if (lower.endsWith('.sty')) return 'STY';
  if (lower.endsWith('.png')) return 'PNG';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'JPG';
  if (lower.endsWith('.svg')) return 'SVG';
  if (lower.endsWith('.pdf')) return 'PDF';
  if (lower.endsWith('.txt')) return 'TXT';
  return 'FILE';
}

function getParentPath(target: string) {
  if (!target) return '';
  const idx = target.lastIndexOf('/');
  return idx === -1 ? '' : target.slice(0, idx);
}

type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children: TreeNode[];
};

type OutlineItem = {
  title: string;
  level: number;
  pos: number;
  line: number;
};

function buildTree(items: { path: string; type: string }[], orderMap: Record<string, string[]> = {}) {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  const nodeMap = new Map<string, TreeNode>([['', root]]);

  const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));

  sorted.forEach((item) => {
    const parts = item.path.split('/').filter(Boolean);
    let currentPath = '';
    parts.forEach((part, index) => {
      const nextPath = currentPath ? `${currentPath}/${part}` : part;
      if (!nodeMap.has(nextPath)) {
        const isLeaf = index === parts.length - 1;
        const node: TreeNode = {
          name: part,
          path: nextPath,
          type: isLeaf ? (item.type === 'dir' ? 'dir' : 'file') : 'dir',
          children: []
        };
        const parent = nodeMap.get(currentPath);
        if (parent) {
          parent.children.push(node);
        }
        nodeMap.set(nextPath, node);
      }
      currentPath = nextPath;
    });
  });

  const sortNodes = (node: TreeNode) => {
    const order = orderMap[node.path] || [];
    node.children.sort((a, b) => {
      const aKey = a.name;
      const bKey = b.name;
      const aIndex = order.indexOf(aKey);
      const bIndex = order.indexOf(bKey);
      if (aIndex !== -1 || bIndex !== -1) {
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        if (aIndex !== bIndex) return aIndex - bIndex;
      }
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNodes);
  };

  sortNodes(root);
  return root;
}

function findTreeNode(root: TreeNode, targetPath: string) {
  if (root.path === targetPath) return root;
  const parts = targetPath.split('/').filter(Boolean);
  let current: TreeNode | null = root;
  let pathSoFar = '';
  for (const part of parts) {
    if (!current) return null;
    pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
    current = current.children.find((child) => child.path === pathSoFar) || null;
  }
  return current;
}

function stripLineComment(line: string) {
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '%' && !escaped) {
      return line.slice(0, i);
    }
    escaped = ch === '\\';
  }
  return line;
}

function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  lines.forEach((line, index) => {
    const clean = stripLineComment(line);
    const regex = /\\+(section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clean))) {
      const name = match[1];
      const title = (match[2] || '').trim() || '(untitled)';
      const level = name === 'section' ? 1 : name === 'subsection' ? 2 : 3;
      items.push({
        title,
        level,
        pos: offset + (match.index ?? 0),
        line: index + 1
      });
    }
    offset += line.length + 1;
  });
  return items;
}

function extractIncludeTargets(text: string) {
  const targets: string[] = [];
  const lines = text.split(/\r?\n/);
  const regex = /\\(?:input|include)\s*\{([^}]+)\}/g;
  lines.forEach((line) => {
    const clean = stripLineComment(line);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clean))) {
      const raw = (match[1] || '').trim();
      if (raw) targets.push(raw);
    }
  });
  return targets;
}

function findNearestHeading(text: string, cursorPos: number) {
  const before = text.slice(0, cursorPos);
  const lines = before.split(/\r?\n/).reverse();
  for (const line of lines) {
    const clean = stripLineComment(line);
    const match = clean.match(/\\+(section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/);
    if (match) {
      return {
        title: (match[2] || '').trim() || '(untitled)',
        level: match[1]
      };
    }
  }
  return null;
}

function findCurrentEnvironment(text: string) {
  const stack: string[] = [];
  const clean = text
    .split('\n')
    .map((line) => stripLineComment(line))
    .join('\n');
  const regex = /\\\\(begin|end)\\s*\\{([^}]+)\\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(clean))) {
    const type = match[1];
    const name = match[2].trim();
    if (!name) continue;
    if (type === 'begin') {
      stack.push(name);
    } else if (type === 'end') {
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
    }
  }
  return stack.length > 0 ? stack[stack.length - 1] : '';
}

function extractJsonBlock(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return text.slice(start, end + 1);
}

function sanitizeJsonString(raw: string) {
  let inString = false;
  let escaped = false;
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code >= 0 && code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
    }
  }
  return out;
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    try {
      return JSON.parse(sanitizeJsonString(raw)) as T;
    } catch (err2) {
      return null;
    }
  }
}

function appendLog(setter: (val: string[] | ((prev: string[]) => string[])) => void, line: string) {
  setter((prev) => [...prev, line]);
}

function latexCompletionSource(context: CompletionContext) {
  const before = context.matchBefore(/[\\/][A-Za-z]*$/);
  if (!before) return null;
  const prev = before.from > 0 ? context.state.doc.sliceString(before.from - 1, before.from) : ' ';
  if (prev && !/[\s({\n]/.test(prev)) return null;
  if (before.text.startsWith('/') && prev === ':') return null;
  const options = [
    { label: '\\section{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\section{}' },
        selection: { anchor: from + '\\section{'.length }
      });
    }},
    { label: '\\subsection{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\subsection{}' },
        selection: { anchor: from + '\\subsection{'.length }
      });
    }},
    { label: '\\subsubsection{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\subsubsection{}' },
        selection: { anchor: from + '\\subsubsection{'.length }
      });
    }},
    { label: '\\paragraph{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\paragraph{}' },
        selection: { anchor: from + '\\paragraph{'.length }
      });
    }},
    { label: '\\cite{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\cite{}' },
        selection: { anchor: from + '\\cite{'.length }
      });
    }},
    { label: '\\ref{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\ref{}' },
        selection: { anchor: from + '\\ref{'.length }
      });
    }},
    { label: '\\label{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\label{}' },
        selection: { anchor: from + '\\label{'.length }
      });
    }},
    { label: '\\begin{itemize}', type: 'keyword', apply: '\\begin{itemize}\n\\item \n\\end{itemize}' },
    { label: '\\begin{enumerate}', type: 'keyword', apply: '\\begin{enumerate}\n\\item \n\\end{enumerate}' },
    { label: '\\begin{figure}', type: 'keyword', apply: '\\begin{figure}[t]\n\\centering\n\\includegraphics[width=0.9\\linewidth]{}\n\\caption{}\n\\label{}\n\\end{figure}' },
    { label: '\\begin{table}', type: 'keyword', apply: '\\begin{table}[t]\n\\centering\n\\begin{tabular}{}\n\\end{tabular}\n\\caption{}\n\\label{}\n\\end{table}' }
  ];
  return {
    from: before.from,
    options,
    validFor: /^[\\/][A-Za-z]*$/
  };
}

const setGhostEffect = StateEffect.define<{ pos: number | null; text: string }>();

class GhostWidget extends WidgetType {
  constructor(private text: string) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ghost';
    span.textContent = this.text;
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

const ghostField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setGhostEffect)) {
        const { pos, text } = effect.value;
        if (pos == null || !text) {
          return Decoration.none;
        }
        const widget = Decoration.widget({
          widget: new GhostWidget(text),
          side: 1
        });
        return Decoration.set([widget.range(pos)]);
      }
    }
    if (tr.docChanged || tr.selectionSet) {
      return Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      background: 'transparent'
    },
    '.cm-scroller': {
      fontFamily: '"JetBrains Mono", "SF Mono", "Menlo", monospace',
      fontSize: '12px',
      lineHeight: '1.6'
    },
    '.cm-content': {
      padding: '16px'
    },
    '.cm-gutters': {
      background: 'transparent',
      border: 'none',
      color: 'rgba(122, 111, 103, 0.6)'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 12px'
    },
    '.cm-activeLine': {
      background: 'rgba(180, 74, 47, 0.08)'
    },
    '.cm-activeLineGutter': {
      background: 'transparent'
    },
    '.cm-selectionBackground': {
      background: 'rgba(180, 74, 47, 0.18)'
    }
  },
  { dark: false }
);

function buildSplitDiff(original: string, proposed: string) {
  const parts = diffLines(original, proposed);
  let leftLine = 1;
  let rightLine = 1;
  const rows: {
    left?: string;
    right?: string;
    leftNo?: number;
    rightNo?: number;
    type: 'context' | 'added' | 'removed';
  }[] = [];

  parts.forEach((part) => {
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    lines.forEach((line) => {
      if (part.added) {
        rows.push({ right: line, rightNo: rightLine++, type: 'added' });
      } else if (part.removed) {
        rows.push({ left: line, leftNo: leftLine++, type: 'removed' });
      } else {
        rows.push({
          left: line,
          right: line,
          leftNo: leftLine++,
          rightNo: rightLine++,
          type: 'context'
        });
      }
    });
  });

  return rows;
}

type CompileError = {
  message: string;
  line?: number;
  file?: string;
  raw?: string;
};

function parseCompileErrors(log: string): CompileError[] {
  if (!log) return [];
  const lines = log.split('\n');
  const errors: CompileError[] = [];
  const seen = new Set<string>();

  const pushError = (error: CompileError) => {
    const key = `${error.file || ''}:${error.line || ''}:${error.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(error);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fileLineMatch = line.match(/([A-Za-z0-9_./-]+\.tex):(\d+)/);
    if (fileLineMatch) {
      pushError({
        message: line.trim(),
        file: fileLineMatch[1],
        line: Number(fileLineMatch[2]),
        raw: line
      });
    }
    if (line.startsWith('!')) {
      const message = line.replace(/^!+\s*/, '').trim();
      let lineNo: number | undefined;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
        const match = lines[j].match(/l\.(\d+)/);
        if (match) {
          lineNo = Number(match[1]);
          break;
        }
      }
      pushError({ message, line: lineNo, raw: line });
    }
  }

  return errors;
}

function findLineOffset(text: string, line: number) {
  if (line <= 1) return 0;
  let offset = 0;
  let current = 1;
  while (current < line && offset < text.length) {
    const next = text.indexOf('\n', offset);
    if (next === -1) break;
    offset = next + 1;
    current += 1;
  }
  return offset;
}

function replaceSelection(source: string, start: number, end: number, replacement: string) {
  return source.slice(0, start) + replacement + source.slice(end);
}

function SplitDiffView({ rows }: { rows: ReturnType<typeof buildSplitDiff> }) {
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const lockRef = useRef(false);

  const syncScroll = (source: HTMLDivElement | null, target: HTMLDivElement | null) => {
    if (!source || !target || lockRef.current) return;
    lockRef.current = true;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      lockRef.current = false;
    });
  };

  return (
    <div className="split-diff">
      <div
        className="split-column"
        ref={leftRef}
        onScroll={() => syncScroll(leftRef.current, rightRef.current)}
      >
        <div className="split-header">Before</div>
        {rows.map((row, idx) => (
          <div key={`l-${idx}`} className={`split-row ${row.type}`}>
            <div className="line-no">{row.leftNo ?? ''}</div>
            <div className="line-text">{row.left ?? ''}</div>
          </div>
        ))}
      </div>
      <div
        className="split-column"
        ref={rightRef}
        onScroll={() => syncScroll(rightRef.current, leftRef.current)}
      >
        <div className="split-header">After</div>
        {rows.map((row, idx) => (
          <div key={`r-${idx}`} className={`split-row ${row.type}`}>
            <div className="line-no">{row.rightNo ?? ''}</div>
            <div className="line-text">{row.right ?? ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PdfPreview({
  pdfUrl,
  scale,
  fitWidth,
  spread,
  onFitScale,
  onTextClick,
  onOutline,
  annotations,
  annotateMode,
  onAddAnnotation,
  containerRef: externalRef
}: {
  pdfUrl: string;
  scale: number;
  fitWidth: boolean;
  spread: boolean;
  onFitScale?: (value: number | null) => void;
  onTextClick: (text: string) => void;
  onOutline?: (items: { title: string; page?: number; level: number }[]) => void;
  annotations: { id: string; page: number; x: number; y: number; text: string }[];
  annotateMode: boolean;
  onAddAnnotation?: (page: number, x: number, y: number) => void;
  containerRef?: RefObject<HTMLDivElement>;
}) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const containerRef = externalRef || localRef;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfUrl) return;
    let cancelled = false;
    container.innerHTML = '';

    const render = async () => {
      try {
        const loadingTask = getDocument(pdfUrl);
        const pdf = await loadingTask.promise;

        // 获取容器宽度用于计算缩放比例
        const containerWidth = container.clientWidth - 24; // 减去 padding
        const pageTargetWidth = spread ? Math.max(200, (containerWidth - 16) / 2) : containerWidth;

        let baseScale = scale;
        let firstPage: Awaited<ReturnType<typeof pdf.getPage>> | null = null;
        if (fitWidth && containerWidth > 0) {
          firstPage = await pdf.getPage(1);
          const originalViewport = firstPage.getViewport({ scale: 1.0 });
          baseScale = pageTargetWidth / originalViewport.width;
          if (onFitScale) {
            onFitScale(baseScale);
          }
        } else if (onFitScale) {
          onFitScale(null);
        }

        const renderPage = async (page: Awaited<ReturnType<typeof pdf.getPage>>) => {
          // 先获取原始尺寸
          const cssViewport = page.getViewport({ scale: baseScale });
          const qualityBoost = Math.min(2.4, (window.devicePixelRatio || 1) * 1.25);
          const renderViewport = page.getViewport({ scale: baseScale * qualityBoost });

          const pageWrapper = document.createElement('div');
          pageWrapper.className = 'pdf-page';
          pageWrapper.style.width = `${cssViewport.width}px`;
          pageWrapper.style.height = `${cssViewport.height}px`;
          pageWrapper.dataset.pageNumber = String(page.pageNumber);

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = renderViewport.width;
          canvas.height = renderViewport.height;
          canvas.style.width = `${cssViewport.width}px`;
          canvas.style.height = `${cssViewport.height}px`;
          pageWrapper.appendChild(canvas);

          const textLayer = document.createElement('div');
          textLayer.className = 'textLayer';
          textLayer.style.width = `${cssViewport.width}px`;
          textLayer.style.height = `${cssViewport.height}px`;
          pageWrapper.appendChild(textLayer);

          if (ctx) {
            await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
          }
          const textContent = await page.getTextContent();
          renderTextLayer({
            textContentSource: textContent,
            container: textLayer,
            viewport: cssViewport
          });
          return pageWrapper;
        };

        const wrappers: HTMLElement[] = [];
        if (firstPage) {
          if (cancelled) return;
          const firstWrapper = await renderPage(firstPage);
          wrappers.push(firstWrapper);
        }

        for (let pageNum = firstPage ? 2 : 1; pageNum <= pdf.numPages; pageNum += 1) {
          if (cancelled) return;
          const page = await pdf.getPage(pageNum);
          const wrapper = await renderPage(page);
          wrappers.push(wrapper);
        }

        if (spread) {
          for (let idx = 0; idx < wrappers.length; idx += 2) {
            const row = document.createElement('div');
            row.className = 'pdf-spread';
            row.appendChild(wrappers[idx]);
            if (wrappers[idx + 1]) {
              row.appendChild(wrappers[idx + 1]);
            }
            container.appendChild(row);
          }
        } else {
          wrappers.forEach((wrapper) => container.appendChild(wrapper));
        }

        if (onOutline) {
          try {
            const outline = await pdf.getOutline();
            const items: { title: string; page?: number; level: number }[] = [];
            const walk = async (entries: any[], level: number) => {
              if (!entries) return;
              for (const entry of entries) {
                let pageNumber: number | undefined;
                try {
                  const dest = typeof entry.dest === 'string' ? await pdf.getDestination(entry.dest) : entry.dest;
                  if (Array.isArray(dest) && dest.length > 0) {
                    const pageIndex = await pdf.getPageIndex(dest[0]);
                    pageNumber = pageIndex + 1;
                  }
                } catch {
                  pageNumber = undefined;
                }
                items.push({ title: entry.title || '(untitled)', page: pageNumber, level });
                if (entry.items?.length) {
                  await walk(entry.items, level + 1);
                }
              }
            };
            await walk(outline || [], 1);
            onOutline(items);
          } catch {
            onOutline([]);
          }
        }
      } catch (err) {
        console.error('PDF render error:', err);
        container.innerHTML = '<div class="muted">PDF 渲染失败</div>';
      }
    };

    render().catch(() => {
      container.innerHTML = '<div class="muted">PDF 渲染失败</div>';
    });

    return () => {
      cancelled = true;
      container.innerHTML = '';
    };
  }, [pdfUrl, fitWidth, onFitScale, scale, spread, onOutline]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelectorAll('.pdf-annotation').forEach((node) => node.remove());
    annotations.forEach((note) => {
      const pageEl = container.querySelector(`.pdf-page[data-page-number="${note.page}"]`) as HTMLElement | null;
      if (!pageEl) return;
      const marker = document.createElement('div');
      marker.className = 'pdf-annotation';
      marker.style.left = `${note.x * 100}%`;
      marker.style.top = `${note.y * 100}%`;
      marker.title = note.text;
      marker.dataset.annotationId = note.id;
      pageEl.appendChild(marker);
    });
  }, [annotations, pdfUrl, spread]);

  return (
    <div
      className={`pdf-preview ${annotateMode ? 'annotate' : ''}`}
      ref={containerRef}
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (annotateMode && onAddAnnotation) {
          const pageEl = target.closest('.pdf-page') as HTMLElement | null;
          if (pageEl) {
            const rect = pageEl.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width;
            const y = (event.clientY - rect.top) / rect.height;
            const page = Number(pageEl.dataset.pageNumber || 1);
            onAddAnnotation(page, x, y);
            return;
          }
        }
        if (target.tagName !== 'SPAN') return;
        const text = (target.textContent || '').trim();
        if (text.length < 3) return;
        onTextClick(text);
      }}
    />
  );
}

export default function EditorPage() {
  const navigate = useNavigate();
  const { projectId: routeProjectId } = useParams();
  const projectId = routeProjectId || '';
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [tree, setTree] = useState<{ path: string; type: string }[]>([]);
  const [fileOrder, setFileOrder] = useState<Record<string, string[]>>({});
  const [activePath, setActivePath] = useState<string>('');
  const [files, setFiles] = useState<Record<string, string>>({});
  const [editorValue, setEditorValue] = useState<string>('');
  const [selectionRange, setSelectionRange] = useState<[number, number]>([0, 0]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [inlineSuggestionText, setInlineSuggestionText] = useState('');
  const [suggestionPos, setSuggestionPos] = useState<{ left: number; top: number } | null>(null);
  const [assistantMode, setAssistantMode] = useState<'chat' | 'agent'>('agent');
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [agentMessages, setAgentMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [task, setTask] = useState(DEFAULT_TASKS[0].value);
  const [mode, setMode] = useState<'direct' | 'tools'>('direct');
  const [translateScope, setTranslateScope] = useState<'selection' | 'file' | 'project'>('selection');
  const [translateTarget, setTranslateTarget] = useState('English');
  const [taskDropdownOpen, setTaskDropdownOpen] = useState(false);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const [translateScopeDropdownOpen, setTranslateScopeDropdownOpen] = useState(false);
  const [translateTargetDropdownOpen, setTranslateTargetDropdownOpen] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [compileLog, setCompileLog] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfFitWidth, setPdfFitWidth] = useState(true);
  const [pdfFitScale, setPdfFitScale] = useState<number | null>(null);
  const [pdfSpread, setPdfSpread] = useState(false);
  const [pdfOutline, setPdfOutline] = useState<{ title: string; page?: number; level: number }[]>([]);
  const [pdfAnnotations, setPdfAnnotations] = useState<{ id: string; page: number; x: number; y: number; text: string }[]>([]);
  const [pdfAnnotateMode, setPdfAnnotateMode] = useState(false);
  const [engineName, setEngineName] = useState<string>('');
  const [isCompiling, setIsCompiling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [savePulse, setSavePulse] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [rightView, setRightView] = useState<'pdf' | 'figures' | 'diff' | 'log' | 'toc'>('pdf');
  const [selectedFigure, setSelectedFigure] = useState<string>('');
  const [diffFocus, setDiffFocus] = useState<PendingChange | null>(null);
  const [activeSidebar, setActiveSidebar] = useState<'files' | 'agent' | 'vision' | 'search' | 'websearch' | 'plot' | 'review'>('files');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [columnSizes, setColumnSizes] = useState({ sidebar: 260, editor: 640, right: 420 });
  const [editorSplit, setEditorSplit] = useState(0.7);
  const [selectedPath, setSelectedPath] = useState('');
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [dragOverPath, setDragOverPath] = useState('');
  const [dragOverKind, setDragOverKind] = useState<'file' | 'folder' | ''>('');
  const [draggingPath, setDraggingPath] = useState('');
  const [dragHint, setDragHint] = useState<{ text: string; x: number; y: number } | null>(null);
  const [mainFile, setMainFile] = useState('main.tex');
  const [fileFilter, setFileFilter] = useState('');
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [fileActionsExpanded, setFileActionsExpanded] = useState(false);
  const [visionMode, setVisionMode] = useState<'equation' | 'table' | 'figure' | 'algorithm' | 'ocr'>('equation');
  const [visionFile, setVisionFile] = useState<File | null>(null);
  const [visionPrompt, setVisionPrompt] = useState('');
  const [visionResult, setVisionResult] = useState('');
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionPreviewUrl, setVisionPreviewUrl] = useState('');
  const [arxivQuery, setArxivQuery] = useState('');
  const [arxivMaxResults, setArxivMaxResults] = useState(5);
  const [arxivResults, setArxivResults] = useState<ArxivPaper[]>([]);
  const [arxivSelected, setArxivSelected] = useState<Record<string, boolean>>({});
  const [arxivBusy, setArxivBusy] = useState(false);
  const [arxivStatus, setArxivStatus] = useState('');
  const [useLlmSearch, setUseLlmSearch] = useState(false);
  const [llmSearchOutput, setLlmSearchOutput] = useState('');
  const [arxivBibtexCache, setArxivBibtexCache] = useState<Record<string, string>>({});
  const [bibTarget, setBibTarget] = useState('');
  const [autoInsertCite, setAutoInsertCite] = useState(true);
  const [autoInsertToMain, setAutoInsertToMain] = useState(false);
  const [citeTargetFile, setCiteTargetFile] = useState('');
  const [outlineText, setOutlineText] = useState('');
  const [currentHeading, setCurrentHeading] = useState<{ title: string; level: string } | null>(null);
  const [plotType, setPlotType] = useState<'bar' | 'line' | 'heatmap'>('bar');
  const [plotTitle, setPlotTitle] = useState('');
  const [plotFilename, setPlotFilename] = useState('');
  const [plotPrompt, setPlotPrompt] = useState('');
  const [plotRetries, setPlotRetries] = useState(2);
  const [plotBusy, setPlotBusy] = useState(false);
  const [plotStatus, setPlotStatus] = useState('');
  const [plotAssetPath, setPlotAssetPath] = useState('');
  const [plotAutoInsert, setPlotAutoInsert] = useState(true);
  const [websearchQuery, setWebsearchQuery] = useState('');
  const [websearchLog, setWebsearchLog] = useState<string[]>([]);
  const [websearchBusy, setWebsearchBusy] = useState(false);
  const [websearchResults, setWebsearchResults] = useState<WebsearchItem[]>([]);
  const [websearchSelected, setWebsearchSelected] = useState<Record<string, boolean>>({});
  const [websearchParagraph, setWebsearchParagraph] = useState('');
  const [websearchItemNotes, setWebsearchItemNotes] = useState<Record<string, string>>({});
  const [websearchTargetFile, setWebsearchTargetFile] = useState('');
  const [websearchTargetBib, setWebsearchTargetBib] = useState('');
  const [reviewNotes, setReviewNotes] = useState<{ title: string; content: string }[]>([]);
  const [diagnoseBusy, setDiagnoseBusy] = useState(false);
  const [websearchSelectedAll, setWebsearchSelectedAll] = useState(false);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorAreaRef = useRef<HTMLDivElement | null>(null);
  const cmViewRef = useRef<EditorView | null>(null);
  const activePathRef = useRef<string>('');
  const inlineSuggestionRef = useRef<string>('');
  const inlineAnchorRef = useRef<number | null>(null);
  const applyingSuggestionRef = useRef(false);
  const suppressDirtyRef = useRef(false);
  const typewriterTimerRef = useRef<number | null>(null);
  const requestSuggestionRef = useRef<() => void>(() => {});
  const acceptSuggestionRef = useRef<() => void>(() => {});
  const acceptChunkRef = useRef<() => void>(() => {});
  const clearSuggestionRef = useRef<() => void>(() => {});
  const saveActiveFileRef = useRef<() => void>(() => {});
  const engineRef = useRef<LatexEngine | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const editorSplitRef = useRef<HTMLDivElement | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement | null>(null);
  const fileTreeRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  const {
    texliveEndpoint,
    llmEndpoint,
    llmApiKey,
    llmModel,
    searchEndpoint,
    searchApiKey,
    searchModel,
    visionEndpoint,
    visionApiKey,
    visionModel,
    compileEngine
  } = settings;

  useEffect(() => {
    persistSettings(settings);
  }, [settings]);

  useEffect(() => {
    engineRef.current = null;
    setEngineName('');
  }, [texliveEndpoint]);

  const llmConfig = useMemo(
    () => ({
      endpoint: llmEndpoint,
      apiKey: llmApiKey || undefined,
      model: llmModel
    }),
    [llmEndpoint, llmApiKey, llmModel]
  );

  const searchLlmConfig = useMemo(() => {
    const hasOverride = Boolean(searchEndpoint || searchApiKey || searchModel);
    return {
      endpoint: (hasOverride ? searchEndpoint : llmEndpoint) || llmEndpoint,
      apiKey: (hasOverride ? searchApiKey : llmApiKey) || undefined,
      model: (hasOverride ? searchModel : llmModel) || llmModel
    };
  }, [llmEndpoint, llmApiKey, llmModel, searchEndpoint, searchApiKey, searchModel]);

  const visionLlmConfig = useMemo(() => {
    const hasOverride = Boolean(visionEndpoint || visionApiKey || visionModel);
    return {
      endpoint: (hasOverride ? visionEndpoint : llmEndpoint) || llmEndpoint,
      apiKey: (hasOverride ? visionApiKey : llmApiKey) || undefined,
      model: (hasOverride ? visionModel : llmModel) || llmModel
    };
  }, [llmEndpoint, llmApiKey, llmModel, visionEndpoint, visionApiKey, visionModel]);

  useEffect(() => {
    if (!projectId) {
      navigate('/projects', { replace: true });
      return;
    }
    setProjectName('');
    listProjects()
      .then((res) => {
        const current = res.projects.find((item) => item.id === projectId);
        if (!current) {
          setStatus('项目不存在或已被删除。');
          return;
        }
        setProjectName(current.name);
      })
      .catch((err) => setStatus(`加载项目信息失败: ${String(err)}`));
  }, [navigate, projectId]);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  const refreshTree = async (keepActive = true) => {
    if (!projectId) return;
    const res = await getProjectTree(projectId);
    setTree(res.items);
    setFileOrder(res.fileOrder || {});
    if (!keepActive || !activePath || !res.items.find((item) => item.path === activePath)) {
      const main = res.items.find((item) => item.path.endsWith('main.tex'))?.path;
      const next = main || res.items.find((item) => item.type === 'file')?.path || '';
      if (next) {
        await openFile(next);
      }
    }
  };

  useEffect(() => {
    if (!projectId) return;
    setFiles({});
    setActivePath('');
    refreshTree(false).catch((err) => setStatus(`加载文件树失败: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);


  useEffect(() => {
    if (!editorHostRef.current || cmViewRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      const skipClear = applyingSuggestionRef.current;
      if (update.docChanged) {
        const value = update.state.doc.toString();
        setEditorValue(value);
        if (!suppressDirtyRef.current) {
          setIsDirty(true);
        } else {
          suppressDirtyRef.current = false;
        }
        const path = activePathRef.current;
        if (path) {
          setFiles((prev) => ({ ...prev, [path]: value }));
        }
      }
      if (update.selectionSet) {
        const sel = update.state.selection.main;
        setSelectionRange([sel.from, sel.to]);
        const heading = findNearestHeading(update.state.doc.toString(), sel.head);
        setCurrentHeading(heading);
      }
      if (!skipClear && inlineSuggestionRef.current && (update.docChanged || update.selectionSet)) {
        inlineSuggestionRef.current = '';
        inlineAnchorRef.current = null;
        setInlineSuggestionText('');
        setTimeout(() => {
          const view = cmViewRef.current;
          if (view) {
            view.dispatch({ effects: setGhostEffect.of({ pos: null, text: '' }) });
          }
        }, 0);
      }
      if (skipClear) {
        applyingSuggestionRef.current = false;
      }
    });

    const keymapExtension = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          saveActiveFileRef.current();
          return true;
        }
      },
      {
        key: 'Alt-/',
        run: () => {
          requestSuggestionRef.current();
          return true;
        }
      },
      {
        key: 'Mod-/',
        run: toggleComment
      },
      {
        key: 'Mod-Space',
        run: () => {
          requestSuggestionRef.current();
          return true;
        }
      },
      {
        key: 'ArrowRight',
        run: (view) => {
          const pos = view.state.selection.main.head;
          if (inlineSuggestionRef.current && inlineAnchorRef.current === pos) {
            acceptChunkRef.current();
            return true;
          }
          return false;
        }
      },
      {
        key: 'Tab',
        run: () => {
          if (!inlineSuggestionRef.current) return false;
          acceptSuggestionRef.current();
          return true;
        }
      },
      {
        key: 'Escape',
        run: () => {
          clearSuggestionRef.current();
          return true;
        }
      },
      ...foldKeymap,
      ...searchKeymap
    ]);

    const state = EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        latex(),
        indentOnInput(),
        foldGutter(),
        EditorView.lineWrapping,
        editorTheme,
        ghostField,
        search(),
        autocompletion({ override: [latexCompletionSource] }),
        updateListener,
        keymapExtension
      ]
    });

    const view = new EditorView({
      state,
      parent: editorHostRef.current
    });
    cmViewRef.current = view;

    const handleAltSlash = (event: KeyboardEvent) => {
      if (!event.altKey) return;
      if (event.key === '/' || event.key === '÷' || event.code === 'Slash') {
        event.preventDefault();
        event.stopPropagation();
        requestSuggestionRef.current();
      }
    };
    view.dom.addEventListener('keydown', handleAltSlash, true);

    return () => {
      view.dom.removeEventListener('keydown', handleAltSlash, true);
      view.destroy();
      cmViewRef.current = null;
    };
  }, []);

  const openFile = async (filePath: string) => {
    setActivePath(filePath);
    activePathRef.current = filePath;
    setSelectedPath(filePath);
    if (filePath.includes('/')) {
      const parts = filePath.split('/').slice(0, -1);
      setOpenFolders((prev) => {
        const next = { ...prev };
        let current = '';
        parts.forEach((part) => {
          current = current ? `${current}/${part}` : part;
          next[current] = true;
        });
        return next;
      });
    }
    if (Object.prototype.hasOwnProperty.call(files, filePath)) {
      const cached = files[filePath] ?? '';
      setEditorValue(cached);
      setIsDirty(false);
      setEditorDoc(cached);
      return cached;
    }
    const data = await getFile(projectId, filePath);
    setFiles((prev) => ({ ...prev, [filePath]: data.content }));
    setEditorValue(data.content);
    setIsDirty(false);
    setEditorDoc(data.content);
    return data.content;
  };

  const setEditorDoc = useCallback((value: string) => {
    const view = cmViewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    suppressDirtyRef.current = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value }
    });
  }, []);

  const clearInlineSuggestion = useCallback(() => {
    inlineSuggestionRef.current = '';
    inlineAnchorRef.current = null;
    setInlineSuggestionText('');
    setSuggestionPos(null);
    const view = cmViewRef.current;
    if (view) {
      view.dispatch({ effects: setGhostEffect.of({ pos: null, text: '' }) });
    }
  }, []);

  const nextSuggestionChunk = (text: string) => {
    const match = text.match(/^(\s*\S+\s*)/);
    return match ? match[1] : text;
  };

  const acceptInlineSuggestion = useCallback(() => {
    const view = cmViewRef.current;
    const text = inlineSuggestionRef.current;
    const pos = inlineAnchorRef.current;
    if (!view || !text || pos == null) return;
    applyingSuggestionRef.current = true;
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length }
    });
    clearInlineSuggestion();
  }, [clearInlineSuggestion]);

  const acceptSuggestionChunk = useCallback(() => {
    const view = cmViewRef.current;
    const remaining = inlineSuggestionRef.current;
    const pos = inlineAnchorRef.current;
    if (!view || !remaining || pos == null) return;
    const chunk = nextSuggestionChunk(remaining);
    applyingSuggestionRef.current = true;
    view.dispatch({
      changes: { from: pos, to: pos, insert: chunk },
      selection: { anchor: pos + chunk.length }
    });
    const leftover = remaining.slice(chunk.length);
    if (!leftover) {
      clearInlineSuggestion();
      return;
    }
    inlineSuggestionRef.current = leftover;
    inlineAnchorRef.current = pos + chunk.length;
    setInlineSuggestionText(leftover);
    view.dispatch({ effects: setGhostEffect.of({ pos: pos + chunk.length, text: leftover }) });
  }, [clearInlineSuggestion]);

  const updateSuggestionPosition = useCallback((force = false) => {
    const view = cmViewRef.current;
    const anchor = inlineAnchorRef.current;
    const host = editorAreaRef.current;
    if (!view || !host || (!inlineSuggestionRef.current && !force) || anchor == null) {
      setSuggestionPos(null);
      return;
    }
    const coords = view.coordsAtPos(anchor);
    if (!coords) {
      setSuggestionPos(null);
      return;
    }
    const rect = host.getBoundingClientRect();
    const preferredLeft = coords.left - rect.left;
    const preferredTop = coords.bottom - rect.top + 6;
    const popoverWidth = 320;
    const clampedLeft = Math.min(Math.max(12, preferredLeft), Math.max(12, rect.width - popoverWidth));
    let top = preferredTop;
    if (preferredTop + 80 > rect.height) {
      top = Math.max(12, coords.top - rect.top - 62);
    }
    setSuggestionPos({ left: clampedLeft, top });
  }, []);

  const requestInlineSuggestion = useCallback(async () => {
    const view = cmViewRef.current;
    if (!view || isSuggesting) return;
    clearInlineSuggestion();
    const pos = view.state.selection.main.head;
    const docText = view.state.doc.toString();
    const before = docText.slice(Math.max(0, pos - 4000), pos);
    const after = docText.slice(pos, pos + 400);
    const heading = findNearestHeading(docText, pos);
    const env = findCurrentEnvironment(docText.slice(0, pos));
    inlineAnchorRef.current = pos;
    setIsSuggesting(true);
    updateSuggestionPosition(true);
    try {
      const res = await runAgent({
        task: 'autocomplete',
        prompt: [
          'You are a LaTeX writing assistant.',
          'Continue after <CURSOR> with a coherent next block (1-2 paragraphs or a full environment).',
          heading ? `Current section: ${heading.title} (${heading.level}).` : '',
          env ? `You are inside environment: ${env}.` : '',
          'Preserve style and formatting.',
          'Return only the continuation text, no commentary.'
        ].filter(Boolean).join(' '),
        selection: '',
        content: `${before}<CURSOR>${after}`,
        mode: 'direct',
        projectId,
        activePath,
        compileLog,
        llmConfig
      });
      const suggestion = (res.suggestion || res.reply || '').trim();
      if (!suggestion) return;
      inlineSuggestionRef.current = suggestion;
      inlineAnchorRef.current = pos;
      setInlineSuggestionText(suggestion);
      view.dispatch({
        effects: setGhostEffect.of({ pos, text: suggestion })
      });
    } catch (err) {
      setStatus(`补全失败: ${String(err)}`);
    } finally {
      setIsSuggesting(false);
      if (!inlineSuggestionRef.current) {
        setSuggestionPos(null);
      }
    }
  }, [activePath, clearInlineSuggestion, compileLog, isSuggesting, llmConfig, projectId, updateSuggestionPosition]);

  useEffect(() => {
    if (!inlineSuggestionText) {
      setSuggestionPos(null);
      return;
    }
    updateSuggestionPosition();
  }, [inlineSuggestionText, updateSuggestionPosition]);

  useEffect(() => {
    const view = cmViewRef.current;
    if (!view) return;
    const handleScroll = () => {
      if (inlineSuggestionRef.current) {
        updateSuggestionPosition();
      }
    };
    view.scrollDOM.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', handleScroll);
    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [updateSuggestionPosition]);

  useEffect(() => {
    if (!inlineSuggestionRef.current) return;
    updateSuggestionPosition();
  }, [columnSizes, editorSplit, updateSuggestionPosition]);

  useEffect(() => {
    requestSuggestionRef.current = requestInlineSuggestion;
    acceptSuggestionRef.current = acceptInlineSuggestion;
    acceptChunkRef.current = acceptSuggestionChunk;
    clearSuggestionRef.current = clearInlineSuggestion;
  }, [requestInlineSuggestion, acceptInlineSuggestion, acceptSuggestionChunk, clearInlineSuggestion]);

  const saveActiveFile = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!activePath) return;
      setIsSaving(true);
      try {
        await writeFile(projectId, activePath, editorValue);
        setIsDirty(false);
        setSavePulse(true);
        window.setTimeout(() => setSavePulse(false), 1200);
        if (!opts?.silent) {
          setStatus(`已保存 ${activePath}`);
        }
      } catch (err) {
        setStatus(`保存失败: ${String(err)}`);
      } finally {
        setIsSaving(false);
      }
    },
    [activePath, editorValue, projectId]
  );

  useEffect(() => {
    saveActiveFileRef.current = () => saveActiveFile();
  }, [saveActiveFile]);

  useEffect(() => {
    if (!cmViewRef.current) return;
    setEditorDoc(editorValue);
  }, [editorValue, setEditorDoc]);

  useEffect(() => {
    if (!isDirty || !activePath) return;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveActiveFile({ silent: true });
    }, 1500);
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [activePath, editorValue, isDirty, saveActiveFile]);

  const createBibFile = async () => {
    if (!projectId) return;
    const parent = selectedPath && tree.find((item) => item.path === selectedPath && item.type === 'dir')
      ? selectedPath
      : getParentPath(selectedPath || activePath || '');
    const path = parent ? `${parent}/references.bib` : 'references.bib';
    const content = '% Add BibTeX entries here\n';
    await writeFile(projectId, path, content);
    await refreshTree();
    await openFile(path);
    return path;
  };

  const insertAtCursor = (text: string, opts?: { block?: boolean }) => {
    if (!activePath) return;
    const view = cmViewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    let insert = text;
    if (opts?.block) {
      const before = sel.from > 0 ? view.state.doc.sliceString(sel.from - 1, sel.from) : '';
      if (before && before !== '\n') {
        insert = `\n${insert}`;
      }
      if (!insert.endsWith('\n\n')) {
        insert = insert.endsWith('\n') ? `${insert}\n` : `${insert}\n\n`;
      }
    }
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length }
    });
  };

  const insertFigureSnippet = (filePath: string) => {
    const snippet = [
      '\\begin{figure}[t]',
      '\\centering',
      `\\includegraphics[width=0.9\\linewidth]{${filePath}}`,
      '\\caption{Caption.}',
      `\\label{fig:${filePath.replace(/[^a-zA-Z0-9]+/g, '-')}}`,
      '\\end{figure}',
      ''
    ].join('\n');
    insertAtCursor(snippet, { block: true });
  };

  const insertSectionSnippet = () => insertAtCursor('\\section{Section Title}', { block: true });

  const insertSubsectionSnippet = () => insertAtCursor('\\subsection{Subsection Title}', { block: true });

  const insertSubsubsectionSnippet = () => insertAtCursor('\\subsubsection{Subsubsection Title}', { block: true });

  const insertItemizeSnippet = () => insertAtCursor(['\\begin{itemize}', '\\item ', '\\end{itemize}'].join('\n'), { block: true });

  const insertEnumerateSnippet = () => insertAtCursor(['\\begin{enumerate}', '\\item ', '\\end{enumerate}'].join('\n'), { block: true });

  const insertEquationSnippet = () => insertAtCursor(['\\begin{equation}', 'E = mc^2', '\\end{equation}'].join('\n'), { block: true });

  const insertTableSnippet = () =>
    insertAtCursor(['\\begin{table}[t]', '\\centering', '\\begin{tabular}{lcc}', '\\toprule', 'Method & A & B \\\\', '\\midrule', 'Ours & 0.0 & 0.0 \\\\', '\\bottomrule', '\\end{tabular}', '\\caption{Table caption.}', '\\label{tab:main}', '\\end{table}'].join('\n'), { block: true });

  const insertListingSnippet = () =>
    insertAtCursor(['\\begin{lstlisting}[language=Python]', '# code here', '\\end{lstlisting}'].join('\n'), { block: true });

  const insertAlgorithmSnippet = () =>
    insertAtCursor(['\\begin{algorithm}[t]', '\\caption{Algorithm}', '\\label{alg:main}', '\\begin{algorithmic}', '\\State Initialize', '\\end{algorithmic}', '\\end{algorithm}'].join('\n'), { block: true });

  const insertCiteSnippet = () => insertAtCursor('\\cite{citation-key}');

  const insertRefSnippet = () => insertAtCursor('\\ref{label}');

  const insertLabelSnippet = () => insertAtCursor('\\label{label}');

  const insertFigureTemplate = () =>
    insertAtCursor(['\\begin{figure}[t]', '\\centering', '\\includegraphics[width=0.9\\linewidth]{figures/placeholder.png}', '\\caption{Caption.}', '\\label{fig:placeholder}', '\\end{figure}'].join('\n'), { block: true });

  const ensureFileContent = useCallback(
    async (path: string) => {
      if (Object.prototype.hasOwnProperty.call(files, path)) {
        return files[path] ?? '';
      }
      const data = await getFile(projectId, path);
      setFiles((prev) => ({ ...prev, [path]: data.content }));
      return data.content;
    },
    [files, projectId]
  );

  const buildProjectContext = useCallback(async () => {
    const root = mainFile || activePath;
    if (!root) return '';
    const visited = new Set<string>();
    const queue: string[] = [root];
    const summaries: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      if (!current.toLowerCase().endsWith('.tex')) continue;
      let content = '';
      try {
        content = await ensureFileContent(current);
      } catch {
        continue;
      }
      const outline = parseOutline(content).slice(0, 12);
      const headings = outline.map((item) => `${'  '.repeat(item.level - 1)}- ${item.title}`);
      summaries.push(`File: ${current}\n${headings.join('\n')}`);
      const baseDir = getParentPath(current);
      const includes = extractIncludeTargets(content);
      includes.forEach((raw) => {
        let target = raw.replace(/^\//, '');
        if (!target.endsWith('.tex')) {
          target = `${target}.tex`;
        }
        const resolved = baseDir ? `${baseDir}/${target}` : target;
        if (!visited.has(resolved)) {
          queue.push(resolved);
        }
      });
    }
    const filesList = Array.from(visited).join(', ');
    return `Project files: ${filesList}\nOutline:\n${summaries.join('\n')}`;
  }, [activePath, ensureFileContent, mainFile]);

  const extractBibKey = (bibtex: string) => {
    const match = bibtex.match(/@\w+\s*{\s*([^,\s]+)\s*,/);
    return match ? match[1].trim() : '';
  };

  const handleArxivSearch = useCallback(async () => {
    const query = arxivQuery.trim();
    if (!query) {
      setArxivStatus('请输入检索关键词。');
      return;
    }
    setArxivBusy(true);
    setArxivStatus('');
    try {
      if (useLlmSearch) {
        setLlmSearchOutput('');
        const res = await runAgent({
          task: 'websearch',
          prompt: [
            'Search arXiv for the user query.',
            `Return at most ${arxivMaxResults} papers.`,
            'Use arxiv_search and arxiv_bibtex tools.',
            'Return JSON ONLY in this schema:',
            '{"papers":[{"title":"","authors":[],"arxivId":"","bibtex":""}]}.'
          ].join(' '),
          selection: '',
          content: query,
          mode: 'tools',
          projectId,
          activePath,
          compileLog,
          llmConfig: searchLlmConfig,
          interaction: 'agent',
          history: []
        });
        const raw = res.reply || '';
        if (raw) {
          setLlmSearchOutput(raw);
        }
        const jsonBlock = extractJsonBlock(raw);
        if (!jsonBlock) {
          throw new Error('LLM 输出无法解析为 JSON。');
        }
        const parsed = safeJsonParse<{ papers?: { title: string; authors?: string[]; arxivId: string; bibtex?: string }[] }>(jsonBlock);
        if (!parsed) {
          throw new Error('LLM 输出 JSON 解析失败。');
        }
        const papers = parsed.papers || [];
        setArxivResults(
          papers.map((paper) => ({
            title: paper.title || '(untitled)',
            abstract: '',
            authors: paper.authors || [],
            url: paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : '',
            arxivId: paper.arxivId
          }))
        );
        const cache: Record<string, string> = {};
        papers.forEach((paper) => {
          if (paper.arxivId && paper.bibtex) {
            cache[paper.arxivId] = paper.bibtex;
          }
        });
        setArxivBibtexCache(cache);
        setArxivSelected({});
        if (papers.length === 0) {
          setArxivStatus('没有匹配结果。');
        }
      } else {
        const res = await arxivSearch({ query, maxResults: arxivMaxResults });
        if (!res.ok) {
          throw new Error(res.error || '检索失败');
        }
        setArxivResults(res.papers || []);
        setArxivSelected({});
        if ((res.papers || []).length === 0) {
          setArxivStatus('没有匹配结果。');
        }
      }
    } catch (err) {
      setArxivStatus(`检索失败: ${String(err)}`);
    } finally {
      setArxivBusy(false);
    }
  }, [arxivQuery, arxivMaxResults, useLlmSearch, projectId, activePath, compileLog, searchLlmConfig]);

  const handleArxivApply = useCallback(async () => {
    if (!projectId) return;
    const selected = arxivResults.filter((paper) => arxivSelected[paper.arxivId]);
    if (selected.length === 0) {
      setArxivStatus('请选择要导入的论文。');
      return;
    }
    let targetBib = bibTarget;
    if (!targetBib) {
      const created = await createBibFile();
      if (created) {
        targetBib = created;
        setBibTarget(created);
      }
    }
    if (!targetBib) {
      setArxivStatus('请先创建 Bib 文件。');
      return;
    }
    setArxivBusy(true);
    setArxivStatus('正在写入 Bib...');
    try {
      let content = await ensureFileContent(targetBib);
      const keys: string[] = [];
      for (const paper of selected) {
        let bibtexSource = arxivBibtexCache[paper.arxivId] || '';
        if (!bibtexSource) {
          const res = await arxivBibtex({ arxivId: paper.arxivId });
          if (!res.ok || !res.bibtex) {
            throw new Error(res.error || `生成 BibTeX 失败: ${paper.arxivId}`);
          }
          bibtexSource = res.bibtex;
        }
        const normalizedBibtex = bibtexSource.replace(/\\n/g, '\n');
        const key = extractBibKey(normalizedBibtex);
        if (key) {
          const exists = new RegExp(`@\\w+\\s*{\\s*${key}\\s*,`, 'i').test(content);
          if (exists) {
            keys.push(key);
            continue;
          }
          keys.push(key);
        }
        if (content && !content.endsWith('\n')) content += '\n';
        content += `${normalizedBibtex.trim()}\n`;
      }
      await writeFile(projectId, targetBib, content);
      setFiles((prev) => ({ ...prev, [targetBib]: content }));
      if (activePath === targetBib) {
        setEditorValue(content);
        setEditorDoc(content);
      }
      if (autoInsertCite && keys.length > 0) {
        if (activePath && activePath.toLowerCase().endsWith('.tex')) {
          insertAtCursor(`\\cite{${keys.join(',')}}`);
        } else {
          setArxivStatus('Bib 已写入。打开 TeX 文件后可插入引用。');
          setArxivBusy(false);
          return;
        }
      }
      if (autoInsertToMain && keys.length > 0) {
        const targetFile = citeTargetFile || mainFile;
        if (!targetFile) {
          setArxivStatus('未选择引用插入文件。');
          setArxivBusy(false);
          return;
        }
        const citePayload = arxivResults
          .filter((paper) => keys.includes(extractBibKey(arxivBibtexCache[paper.arxivId] || '') || ''))
          .map((paper) => ({
            title: paper.title,
            arxivId: paper.arxivId
          }));
        const prompt = [
          'Insert citations into the target TeX file.',
          `Target file: ${targetFile}.`,
          `Use \\cite{${keys.join(',')}}.`,
          'If a Related Work section exists, add the citations there.',
          'Otherwise add a Related Work subsection near the end and cite the papers.',
          'Keep edits minimal and preserve formatting.',
          citePayload.length > 0 ? `Papers: ${JSON.stringify(citePayload)}` : ''
        ].filter(Boolean).join(' ');
        try {
          const targetContent = await ensureFileContent(targetFile);
          const res = await runAgent({
            task: 'insert_citations',
            prompt,
            selection: '',
            content: targetContent || '',
            mode: 'tools',
            projectId,
            activePath: targetFile,
            compileLog,
            llmConfig: searchLlmConfig,
            interaction: 'agent',
            history: []
          });
          if (res.patches && res.patches.length > 0) {
            const nextPending = res.patches.map((patch) => ({
              filePath: patch.path,
              original: files[patch.path] ?? '',
              proposed: patch.content,
              diff: patch.diff
            }));
            setPendingChanges(nextPending);
            setRightView('diff');
            setArxivStatus('已生成引用插入建议，请在 Diff 面板应用。');
          } else {
            setArxivStatus('未生成可应用的引用修改。');
          }
        } catch (err) {
          setArxivStatus(`引用插入失败: ${String(err)}`);
        }
      } else {
        setArxivStatus('已写入 Bib。');
      }
    } catch (err) {
      setArxivStatus(`写入失败: ${String(err)}`);
    } finally {
      setArxivBusy(false);
    }
  }, [activePath, arxivResults, arxivSelected, autoInsertCite, autoInsertToMain, bibTarget, projectId, createBibFile, ensureFileContent, setEditorDoc, arxivBibtexCache, compileLog, searchLlmConfig, mainFile, files, citeTargetFile]);

  const handlePlotGenerate = async () => {
    if (!projectId) return;
    if (!selectionText || (!selectionText.includes('\\begin{tabular') && !selectionText.includes('\\begin{table'))) {
      setPlotStatus('请在编辑器中选择一个 LaTeX 表格 (tabular)。');
      return;
    }
    setPlotBusy(true);
    setPlotStatus('');
    try {
      const res = await plotFromTable({
        projectId,
        tableLatex: selectionText,
        chartType: plotType,
        title: plotTitle.trim() || undefined,
        prompt: plotPrompt.trim() || undefined,
        filename: plotFilename.trim() || undefined,
        retries: plotRetries,
        llmConfig
      });
      if (!res.ok || !res.assetPath) {
        throw new Error(res.error || '图表生成失败');
      }
      setPlotAssetPath(res.assetPath);
      setPlotStatus('图表已生成');
      await refreshTree();
      if (plotAutoInsert) {
        insertFigureSnippet(res.assetPath);
      }
    } catch (err) {
      setPlotStatus(`生成失败: ${String(err)}`);
    } finally {
      setPlotBusy(false);
    }
  };

  const runWebsearch = async () => {
    const query = websearchQuery.trim();
    if (!query) {
      setWebsearchLog(['请输入查询关键词。']);
      return;
    }
    setWebsearchBusy(true);
    setWebsearchLog([]);
    setWebsearchResults([]);
    setWebsearchSelected({});
    setWebsearchSelectedAll(false);
    setWebsearchParagraph('');
    setWebsearchItemNotes({});
    try {
      appendLog(setWebsearchLog, '拆分查询...');
      const splitRes = await callLLM({
        llmConfig: searchLlmConfig,
        messages: [
          { role: 'system', content: 'Split the query into 2-4 targeted search queries. Return JSON only: {"queries":["..."]}.' },
          { role: 'user', content: `用户问题: ${query}` }
        ]
      });
      if (!splitRes.ok || !splitRes.content) {
        throw new Error(splitRes.error || 'Query split failed');
      }
      const jsonBlock = extractJsonBlock(splitRes.content);
      if (!jsonBlock) {
        throw new Error('无法解析拆分结果 JSON。');
      }
      const parsed = safeJsonParse<{ queries?: string[] }>(jsonBlock);
      if (!parsed) {
        throw new Error('拆分结果 JSON 解析失败。');
      }
      const queries = (parsed.queries || []).filter(Boolean).slice(0, 4);
      if (queries.length === 0) {
        throw new Error('拆分结果为空。');
      }
      appendLog(setWebsearchLog, `并行检索: ${queries.join(' | ')}`);
      const aggregated: WebsearchItem[] = [];
      await Promise.all(
        queries.map(async (q, idx) => {
          appendLog(setWebsearchLog, `检索中: ${q}`);
          const res = await callLLM({
            llmConfig: searchLlmConfig,
            messages: [
              {
                role: 'system',
                content:
                  'You are a search assistant. Use the provider search. Return JSON only: {"results":[{"title":"","summary":"","url":"","bibtex":""}]}.'
              },
              { role: 'user', content: `帮我检索: ${q}` }
            ]
          });
          if (!res.ok || !res.content) {
            appendLog(setWebsearchLog, `检索失败: ${q}`);
            return;
          }
          const block = extractJsonBlock(res.content);
          if (!block) {
            appendLog(setWebsearchLog, `结果解析失败: ${q}`);
            return;
          }
          const parsedRes = safeJsonParse<{ results?: { title?: string; summary?: string; url?: string; bibtex?: string }[] }>(block);
          if (!parsedRes) {
            appendLog(setWebsearchLog, `结果 JSON 解析失败: ${q}`);
            return;
          }
          const results = parsedRes.results || [];
          results.forEach((item, i) => {
            const bibtex = item.bibtex || '';
            const citeKey = bibtex ? extractBibKey(bibtex.replace(/\\n/g, '\n')) : '';
            aggregated.push({
              id: `${idx}-${i}-${item.url || item.title || 'result'}`,
              title: item.title || 'Untitled',
              summary: item.summary || '',
              url: item.url || '',
              bibtex,
              citeKey
            });
          });
          appendLog(setWebsearchLog, `完成: ${q} (${results.length})`);
        })
      );
      const deduped: WebsearchItem[] = [];
      aggregated.forEach((item) => {
        if (!deduped.find((d) => d.url && item.url && d.url === item.url) && !deduped.find((d) => d.title === item.title)) {
          deduped.push(item);
        }
      });
      setWebsearchResults(deduped);
      appendLog(setWebsearchLog, `聚合结果: ${deduped.length} 条`);
      if (deduped.length === 0) {
        setWebsearchBusy(false);
        return;
      }
      appendLog(setWebsearchLog, '生成逐条总结...');
      const summariesRes = await callLLM({
        llmConfig: searchLlmConfig,
        messages: [
          {
            role: 'system',
            content:
              '你是论文检索助手。请为每篇论文写一条简短总结（1-2 句）。返回 JSON：{"summaries":[{"id":"","summary":""}]}.'
          },
          {
            role: 'user',
            content: JSON.stringify({
              papers: deduped.map((p) => ({
                id: p.id,
                title: p.title,
                summary: p.summary,
                url: p.url,
                citeKey: p.citeKey
              }))
            })
          }
        ]
      });
      if (summariesRes.ok && summariesRes.content) {
        const summaryBlock = extractJsonBlock(summariesRes.content);
        const parsedSummaries = summaryBlock
          ? safeJsonParse<{ summaries?: { id: string; summary: string }[] }>(summaryBlock)
          : null;
        if (parsedSummaries?.summaries?.length) {
          const notes: Record<string, string> = {};
          parsedSummaries.summaries.forEach((item) => {
            if (item.id && item.summary) {
              notes[item.id] = item.summary.trim();
            }
          });
          setWebsearchItemNotes(notes);
          appendLog(setWebsearchLog, '逐条总结已生成。');
        } else {
          appendLog(setWebsearchLog, '逐条总结解析失败。');
        }
      } else {
        appendLog(setWebsearchLog, '逐条总结生成失败。');
      }

      appendLog(setWebsearchLog, '生成综合总结...');
      const citeKeys = deduped.map((item) => item.citeKey).filter(Boolean);
      const paragraphRes = await callLLM({
        llmConfig: searchLlmConfig,
        messages: [
          {
            role: 'system',
            content:
              '请根据提供论文生成 3-5 句中文综合总结（不要分条）。可以使用 \\cite{...} 引用。只返回总结文本。'
          },
          {
            role: 'user',
            content: JSON.stringify({ query, papers: deduped.map((p) => ({ title: p.title, summary: p.summary, url: p.url })), citeKeys })
          }
        ]
      });
      if (paragraphRes.ok && paragraphRes.content) {
        setWebsearchParagraph(paragraphRes.content.trim());
        appendLog(setWebsearchLog, '段落已生成。');
      } else {
        appendLog(setWebsearchLog, '段落生成失败。');
      }
    } catch (err) {
      appendLog(setWebsearchLog, `错误: ${String(err)}`);
    } finally {
      setWebsearchBusy(false);
    }
  };

  const applyWebsearchInsert = async () => {
    if (!projectId) return;
    let targetBib = websearchTargetBib;
    if (!targetBib) {
      const created = await createBibFile();
      if (created) targetBib = created;
    }
    if (!targetBib) {
      setWebsearchLog((prev) => [...prev, '缺少 Bib 文件。']);
      return;
    }
    let content = await ensureFileContent(targetBib);
    const keys: string[] = [];
    const selectedItems = websearchResults.filter((item) => websearchSelected[item.id]);
    if (selectedItems.length === 0) {
      appendLog(setWebsearchLog, '请选择至少一条结果。');
      return;
    }
    const perItemLines = selectedItems.map((item) => {
      const note = websearchItemNotes[item.id] || item.summary || item.title;
      const cite = item.citeKey ? ` \\cite{${item.citeKey}}` : '';
      return `  \\item ${note}${cite}`;
    });
    selectedItems.forEach((item) => {
      if (!item.bibtex) return;
      const normalized = item.bibtex.replace(/\\n/g, '\n');
      const key = extractBibKey(normalized);
      if (!key) return;
      if (new RegExp(`@\\w+\\s*{\\s*${key}\\s*,`, 'i').test(content)) {
        keys.push(key);
        return;
      }
      keys.push(key);
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${normalized.trim()}\n`;
    });
    await writeFile(projectId, targetBib, content);
    setFiles((prev) => ({ ...prev, [targetBib]: content }));
    appendLog(setWebsearchLog, `Bib 写入完成: ${targetBib}`);

    const targetFile = websearchTargetFile || mainFile || activePath;
    const perItemBlock = perItemLines.length
      ? `\\paragraph{逐条总结}\n\\begin{itemize}\n${perItemLines.join('\n')}\n\\end{itemize}\n\n`
      : '';
    const finalBlock = websearchParagraph ? `\\paragraph{综合总结}\n${websearchParagraph}\n` : '';
    const insertBlock = `${perItemBlock}${finalBlock}`.trim();
    if (!insertBlock) {
      appendLog(setWebsearchLog, '没有可插入的总结内容。');
      return;
    }
    if (targetFile && targetFile.toLowerCase().endsWith('.tex')) {
      const targetContent = await ensureFileContent(targetFile);
      const insertText = insertBlock ? `\n${insertBlock}\n` : '\n';
      const nextContent = `${targetContent}\n${insertText}`.replace(/\n{3,}/g, '\n\n');
      await writeFile(projectId, targetFile, nextContent);
      setFiles((prev) => ({ ...prev, [targetFile]: nextContent }));
      if (activePath === targetFile) {
        setEditorValue(nextContent);
        setEditorDoc(nextContent);
      }
      appendLog(setWebsearchLog, `段落已插入 ${targetFile}`);
    } else if (activePath && activePath.toLowerCase().endsWith('.tex')) {
      if (insertBlock) {
        insertAtCursor(insertBlock, { block: true });
      }
      appendLog(setWebsearchLog, '段落已插入光标位置。');
    }
  };

  const handleUpload = async (fileList: FileList | null, basePath = '') => {
    if (!projectId || !fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    await uploadFiles(projectId, files, basePath);
    await refreshTree();
  };

  const handleVisionSubmit = async () => {
    if (!projectId) return;
    if (!visionFile) {
      setStatus('请先选择图片。');
      return;
    }
    setVisionBusy(true);
    setVisionResult('');
    try {
      let extraPrompt = visionPrompt.trim();
      if (!extraPrompt) {
        if (visionMode === 'table') {
          extraPrompt = '只输出表格的 LaTeX（tabular 或 table），不要包含文档结构。';
        } else if (visionMode === 'algorithm') {
          extraPrompt = '只输出 algorithm/algorithmic 环境，不要包含文档结构。';
        } else if (visionMode === 'equation') {
          extraPrompt = '只输出 equation 环境，不要包含文档结构。';
        }
      }
      const res = await visionToLatex({
        projectId,
        file: visionFile,
        mode: visionMode,
        prompt: extraPrompt,
        llmConfig: visionLlmConfig
      });
      if (!res.ok) {
        throw new Error(res.error || '识别失败');
      }
      setVisionResult(res.latex || '');
    } catch (err) {
      setStatus(`识别失败: ${String(err)}`);
    } finally {
      setVisionBusy(false);
    }
  };

  const handleVisionInsert = () => {
    if (!visionResult) return;
    insertAtCursor(visionResult, { block: true });
  };

  const beginInlineCreate = (kind: 'new-file' | 'new-folder') => {
    if (!projectId) return;
    const selectedIsDir = selectedPath && tree.find((item) => item.path === selectedPath && item.type === 'dir');
    const parent = selectedIsDir ? selectedPath : getParentPath(selectedPath || activePath || '');
    setInlineEdit({ kind, parent, value: '' });
    if (parent) {
      setOpenFolders((prev) => ({ ...prev, [parent]: true }));
    }
  };

  const beginInlineRename = () => {
    if (!projectId) return;
    const target = selectedPath || activePath;
    if (!target) return;
    const name = target.split('/').pop() || target;
    setInlineEdit({ kind: 'rename', path: target, value: name });
  };

  const confirmInlineEdit = async () => {
    if (!projectId || !inlineEdit) return;
    const value = inlineEdit.value.trim();
    if (!value) {
      setInlineEdit(null);
      return;
    }
    if (inlineEdit.kind === 'rename') {
      const from = inlineEdit.path;
      const parent = getParentPath(from);
      const to = parent ? `${parent}/${value}` : value;
      const entry = tree.find((item) => item.path === from);
      const fromName = from.split('/').pop() || '';
      await renamePath(projectId, from, to);
      if (activePath === from) {
        setActivePath(to);
        activePathRef.current = to;
      }
      setSelectedPath(to);
      if (parent && fromName && fileOrder[parent]) {
        const nextOrder = fileOrder[parent].map((name) => (name === fromName ? value : name));
        await persistFileOrder(parent, nextOrder);
      }
      if (entry?.type === 'dir' && fileOrder[from]) {
        await persistFileOrder(to, fileOrder[from]);
        await persistFileOrder(from, []);
      }
      await refreshTree();
      setInlineEdit(null);
      return;
    }

    const parent = inlineEdit.parent;
    const target = parent ? `${parent}/${value}` : value;
    if (inlineEdit.kind === 'new-folder') {
      await createFolderApi(projectId, target);
      if (fileOrder[parent]) {
        await persistFileOrder(parent, [...fileOrder[parent], value]);
      }
    } else {
      await writeFile(projectId, target, '');
      if (isTextFile(target)) {
        await openFile(target);
      }
      if (fileOrder[parent]) {
        await persistFileOrder(parent, [...fileOrder[parent], value]);
      }
    }
    await refreshTree();
    setInlineEdit(null);
  };

  const cancelInlineEdit = () => setInlineEdit(null);

  const moveFileWithOrder = async (fromPath: string, folderPath: string, beforeName?: string) => {
    if (!projectId || !fromPath) return;
    const fileName = fromPath.split('/').pop();
    if (!fileName) return;
    const target = folderPath ? `${folderPath}/${fileName}` : fileName;
    if (target === fromPath) return;
    await renamePath(projectId, fromPath, target);
    if (activePath === fromPath) {
      setActivePath(target);
      activePathRef.current = target;
    }
    setSelectedPath(target);

    const fromParent = getParentPath(fromPath);
    if (fromParent && fileOrder[fromParent]) {
      await persistFileOrder(fromParent, fileOrder[fromParent].filter((name) => name !== fileName));
    }

    const targetNode = folderPath ? findTreeNode(treeRoot, folderPath) : treeRoot;
    const childNames = targetNode ? targetNode.children.map((child) => child.name) : [];
    const baseOrder = (fileOrder[folderPath] || []).filter((name) => childNames.includes(name) && name !== fileName);
    childNames.forEach((name) => {
      if (!baseOrder.includes(name) && name !== fileName) baseOrder.push(name);
    });
    const insertIndex = beforeName && baseOrder.includes(beforeName) ? baseOrder.indexOf(beforeName) : baseOrder.length;
    const nextOrder = [...baseOrder];
    nextOrder.splice(insertIndex, 0, fileName);
    await persistFileOrder(folderPath, nextOrder);

    await refreshTree();
  };

  const updateDragHint = useCallback((text: string, event: DragEvent) => {
    const host = fileTreeRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const x = Math.min(rect.width - 12, Math.max(8, event.clientX - rect.left));
    const y = Math.min(rect.height - 12, Math.max(8, event.clientY - rect.top));
    setDragHint({ text, x, y });
  }, []);

  const persistFileOrder = useCallback(
    async (folder: string, order: string[]) => {
      if (!projectId) return;
      setFileOrder((prev) => ({ ...prev, [folder]: order }));
      try {
        await updateFileOrder(projectId, folder, order);
      } catch (err) {
        setStatus(`保存排序失败: ${String(err)}`);
      }
    },
    [projectId]
  );

  const filteredTreeItems = useMemo(() => {
    const term = fileFilter.trim().toLowerCase();
    if (!term) return tree;
    return tree.filter((item) => item.path.toLowerCase().includes(term));
  }, [tree, fileFilter]);

  const treeRoot = useMemo(() => buildTree(filteredTreeItems, fileOrder), [filteredTreeItems, fileOrder]);

  const reorderWithinFolder = useCallback(
    async (fromPath: string, targetPath: string) => {
      if (fileFilter.trim()) return false;
      const fromParent = getParentPath(fromPath);
      const targetParent = getParentPath(targetPath);
      if (fromParent !== targetParent) return false;
      const fromName = fromPath.split('/').pop();
      const targetName = targetPath.split('/').pop();
      if (!fromName || !targetName || fromName === targetName) return false;
      const node = findTreeNode(treeRoot, fromParent);
      if (!node) return false;
      const currentNames = node.children.map((child) => child.name);
      const baseOrder = (fileOrder[fromParent] || []).filter((name) => currentNames.includes(name));
      currentNames.forEach((name) => {
        if (!baseOrder.includes(name)) baseOrder.push(name);
      });
      const nextOrder = baseOrder.filter((name) => name !== fromName);
      const targetIndex = nextOrder.indexOf(targetName);
      const insertIndex = targetIndex === -1 ? nextOrder.length : targetIndex;
      nextOrder.splice(insertIndex, 0, fromName);
      await persistFileOrder(fromParent, nextOrder);
      return true;
    },
    [fileOrder, persistFileOrder, treeRoot]
  );

  const texFiles = useMemo(
    () => tree.filter((item) => item.type === 'file' && item.path.toLowerCase().endsWith('.tex')).map((item) => item.path),
    [tree]
  );

  const bibFiles = useMemo(
    () => tree.filter((item) => item.type === 'file' && item.path.toLowerCase().endsWith('.bib')).map((item) => item.path),
    [tree]
  );

  const outlineItems = useMemo(() => {
    if (!outlineText || !mainFile || !mainFile.toLowerCase().endsWith('.tex')) return [];
    return parseOutline(outlineText);
  }, [outlineText, mainFile]);

  useEffect(() => {
    if (!mainFile) {
      setOutlineText('');
      return;
    }
    if (activePath === mainFile) {
      setOutlineText(editorValue);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const content = await ensureFileContent(mainFile);
        if (!cancelled) setOutlineText(content);
      } catch {
        if (!cancelled) setOutlineText('');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [activePath, editorValue, ensureFileContent, mainFile]);

  useEffect(() => {
    if (!visionFile) {
      setVisionPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(visionFile);
    setVisionPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [visionFile]);

  useEffect(() => {
    if (texFiles.length === 0) return;
    if (!texFiles.includes(mainFile)) {
      const preferred = texFiles.find((path) => path.endsWith('main.tex')) || texFiles[0];
      setMainFile(preferred);
    }
  }, [texFiles, mainFile]);

  useEffect(() => {
    if (citeTargetFile) return;
    if (mainFile) {
      setCiteTargetFile(mainFile);
    } else if (texFiles.length > 0) {
      setCiteTargetFile(texFiles[0]);
    }
  }, [citeTargetFile, mainFile, texFiles]);

  useEffect(() => {
    if (websearchTargetFile) return;
    if (mainFile) {
      setWebsearchTargetFile(mainFile);
    } else if (texFiles.length > 0) {
      setWebsearchTargetFile(texFiles[0]);
    }
  }, [websearchTargetFile, mainFile, texFiles]);

  useEffect(() => {
    if (websearchTargetBib) return;
    if (bibFiles.length > 0) {
      setWebsearchTargetBib(bibFiles[0]);
    }
  }, [bibFiles, websearchTargetBib]);

  useEffect(() => {
    if (!bibTarget && bibFiles.length > 0) {
      setBibTarget(bibFiles[0]);
    }
  }, [bibFiles, bibTarget]);

  const setAllFolders = useCallback(
    (open: boolean) => {
      const next: Record<string, boolean> = {};
      const walk = (nodes: TreeNode[]) => {
        nodes.forEach((node) => {
          if (node.type === 'dir') {
            next[node.path] = open;
            walk(node.children);
          }
        });
      };
      walk(treeRoot.children);
      setOpenFolders(next);
    },
    [treeRoot]
  );

  const toggleFolder = (path: string) => {
    setOpenFolders((prev) => ({ ...prev, [path]: !prev[path] }));
    setSelectedPath(path);
  };

  const handleFileSelect = async (path: string) => {
    setSelectedPath(path);
    if (isFigureFile(path)) {
      setSelectedFigure(path);
      setRightView('figures');
      return;
    }
    if (!isTextFile(path)) {
      setStatus('该文件为二进制文件，暂不支持直接编辑。');
      return;
    }
    await openFile(path);
  };

  const inlineInputRow = (depth: number) => {
    if (!inlineEdit) return null;
    const paddingLeft = 8 + depth * 14;
    const isFolder = inlineEdit.kind === 'new-folder';
    return (
      <div className="tree-node">
        <div className={`tree-row ${isFolder ? 'folder' : 'file'} inline`} style={{ paddingLeft: paddingLeft + 14 }}>
          <input
            className="inline-input"
            autoFocus
            value={inlineEdit.value}
            onChange={(event) => setInlineEdit({ ...inlineEdit, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                confirmInlineEdit().catch((err) => setStatus(`操作失败: ${String(err)}`));
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelInlineEdit();
              }
            }}
            onBlur={() => cancelInlineEdit()}
            placeholder={isFolder ? '新建文件夹' : '新建文件'}
          />
        </div>
      </div>
    );
  };

  const jumpToError = async (error: CompileError) => {
    const view = cmViewRef.current;
    const targetFile = error.file && isTextFile(error.file) ? error.file : activePath;
    if (!targetFile) return;
    let content = '';
    try {
      content = targetFile === activePath ? editorValue : await openFile(targetFile);
    } catch {
      return;
    }
    if (!content || !view) return;
    if (error.line) {
      const offset = findLineOffset(content, error.line);
      view.dispatch({
        selection: { anchor: offset, head: offset },
        scrollIntoView: true
      });
      view.focus();
    }
  };

  const renderTree = (nodes: TreeNode[], depth = 0) =>
    nodes.map((node) => {
      const isDir = node.type === 'dir';
      const isOpen = openFolders[node.path] ?? depth < 1;
      const isActive = activePath === node.path;
      const isSelected = selectedPath === node.path;
      const isDragOver = dragOverPath === node.path;
      const paddingLeft = 8 + depth * 14;

      if (isDir) {
        return (
          <div key={node.path} className="tree-node">
            <button
              className={`tree-row folder ${isOpen ? 'open' : ''} ${isSelected ? 'selected' : ''} ${isDragOver ? 'drag-over' : ''}`}
              style={{ paddingLeft }}
              onClick={() => toggleFolder(node.path)}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverPath(node.path);
                setDragOverKind('folder');
                if (draggingPath) {
                  updateDragHint(`移动到 ${node.name} 文件夹`, event);
                }
              }}
              onDragLeave={() => {
                setDragOverPath('');
                setDragOverKind('');
                setDragHint(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                  handleUpload(event.dataTransfer.files, node.path).catch((err) => setStatus(`上传失败: ${String(err)}`));
                  setDragOverPath('');
                  setDragOverKind('');
                  setDragHint(null);
                  return;
                }
                const from = event.dataTransfer.getData('text/plain');
                setDragOverPath('');
                setDragOverKind('');
                setDragHint(null);
                if (from) {
                  if (fileFilter.trim()) {
                    setStatus('搜索过滤中无法拖拽移动。');
                    return;
                  }
                  moveFileWithOrder(from, node.path).catch((err) => setStatus(`移动失败: ${String(err)}`));
                }
              }}
            >
              <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="tree-icon folder" />
              {inlineEdit?.kind === 'rename' && inlineEdit.path === node.path ? (
                <input
                  className="inline-input"
                  autoFocus
                  value={inlineEdit.value}
                  onChange={(event) => setInlineEdit({ ...inlineEdit, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      confirmInlineEdit().catch((err) => setStatus(`操作失败: ${String(err)}`));
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelInlineEdit();
                    }
                  }}
                  onBlur={() => cancelInlineEdit()}
                />
              ) : (
                <span className="tree-label">{node.name}</span>
              )}
            </button>
            {isOpen && (
              <div className="tree-children">
                {renderTree(node.children, depth + 1)}
                {inlineEdit && inlineEdit.kind !== 'rename' && inlineEdit.parent === node.path && inlineInputRow(depth + 1)}
              </div>
            )}
          </div>
        );
      }

      return (
        <button
          key={node.path}
          className={`tree-row file ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${isDragOver ? (dragOverKind === 'file' ? 'drag-over-file' : 'drag-over') : ''} ${draggingPath === node.path ? 'dragging' : ''}`}
          style={{ paddingLeft: paddingLeft + 14 }}
          onClick={() => handleFileSelect(node.path)}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData('text/plain', node.path);
            setDraggingPath(node.path);
          }}
          onDragEnd={() => {
            setDraggingPath('');
            setDragHint(null);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOverPath(node.path);
            setDragOverKind('file');
            if (draggingPath) {
              const targetParent = getParentPath(node.path);
              const fromParent = getParentPath(draggingPath);
              const parentLabel = targetParent || '根目录';
              const hint =
                fromParent === targetParent
                  ? `插入到 ${node.name} 前`
                  : `移动到 ${parentLabel} 并插入到 ${node.name} 前`;
              updateDragHint(hint, event);
            }
          }}
          onDragLeave={() => {
            setDragOverPath('');
            setDragOverKind('');
            setDragHint(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const from = event.dataTransfer.getData('text/plain');
            setDragOverPath('');
            setDragOverKind('');
            setDragHint(null);
            if (!from) return;
            if (fileFilter.trim()) {
              setStatus('搜索过滤中无法拖拽排序。');
              return;
            }
            const targetParent = getParentPath(node.path);
            const fromParent = getParentPath(from);
            if (fromParent === targetParent) {
              reorderWithinFolder(from, node.path).catch((err) => setStatus(`排序失败: ${String(err)}`));
              return;
            }
            moveFileWithOrder(from, targetParent, node.name).catch((err) => setStatus(`移动失败: ${String(err)}`));
          }}
        >
          <span className={`tree-icon file ext-${getFileTypeLabel(node.path).toLowerCase()}`}>{getFileTypeLabel(node.path)}</span>
          {inlineEdit?.kind === 'rename' && inlineEdit.path === node.path ? (
            <input
              className="inline-input"
              autoFocus
              value={inlineEdit.value}
              onChange={(event) => setInlineEdit({ ...inlineEdit, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  confirmInlineEdit().catch((err) => setStatus(`操作失败: ${String(err)}`));
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelInlineEdit();
                }
              }}
              onBlur={() => cancelInlineEdit()}
            />
          ) : (
            <span className="tree-label">{node.name}</span>
          )}
          {isFigureFile(node.path) && <span className="tree-tag">FIG</span>}
          {node.path.endsWith('.bib') && <span className="tree-tag">BIB</span>}
        </button>
      );
    });

    const compile = async () => {
    if (!projectId) return;
    setIsCompiling(true);
    setStatus('编译中...');
    try {
      const { files: serverFiles } = await getAllFiles(projectId);
      const fileMap: Record<string, string | Uint8Array> = {};
      for (const file of serverFiles) {
        if (file.encoding === 'base64') {
          const binary = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
          fileMap[file.path] = binary;
        } else {
          fileMap[file.path] = files[file.path] ?? file.content;
        }
      }
      if (activePath) {
        fileMap[activePath] = editorValue;
      }
      if (!fileMap[mainFile]) {
        throw new Error(`主文件不存在: ${mainFile}`);
      }
      const compileWithSwift = async () => {
        const engine = engineRef.current || await createLatexEngine(texliveEndpoint);
        engineRef.current = engine;
        setEngineName(engine.name);
        const result = await engine.compile(fileMap, mainFile);
        if (!result.pdf || result.pdf.length === 0) {
          throw new Error(`编译未生成 PDF 文件 (status: ${result.status})`);
        }
        return result;
      };

      const compileWithBackend = async () => {
        const res = await compileProject({ projectId, mainFile, engine: 'tectonic' });
        if (!res.ok || !res.pdf) {
          const detail = [res.error, res.log].filter(Boolean).join('\n');
          throw new Error(detail || '后端编译失败');
        }
        const binary = Uint8Array.from(atob(res.pdf), (c) => c.charCodeAt(0));
        return {
          pdf: binary,
          log: res.log || '',
          status: res.status ?? 0,
          engine: 'tectonic' as const
        };
      };

      let result: CompileOutcome;
      if (compileEngine === 'tectonic') {
        result = await compileWithBackend();
      } else if (compileEngine === 'swiftlatex') {
        result = await compileWithSwift();
      } else {
        try {
          result = await compileWithSwift();
        } catch (err) {
          setStatus('SwiftLaTeX 失败，尝试 Tectonic...');
          result = await compileWithBackend();
        }
      }

      const meta = [
        `Engine: ${result.engine}`,
        `Main file: ${mainFile}`,
        result.engine === 'swiftlatex' ? `TexLive: ${texliveEndpoint}` : ''
      ].filter(Boolean).join('\n');
      setEngineName(result.engine);
      setCompileLog(`${meta}\n\n${result.log || 'No log'}`.trim());

      const blob = new Blob([result.pdf], { type: 'application/pdf' });
      const nextUrl = URL.createObjectURL(blob);
      if (pdfUrl) {
        URL.revokeObjectURL(pdfUrl);
      }
      setPdfUrl(nextUrl);
      setRightView('pdf');
      setStatus(`编译完成 (${result.engine})`);
    } catch (err) {
      console.error('Compilation error:', err);
      setCompileLog(`编译错误: ${String(err)}\n${(err as Error).stack || ''}`);
      setStatus(`编译失败: ${String(err)}`);
    } finally {
      setIsCompiling(false);
    }
  };

  const selectionText = useMemo(() => {
    const [start, end] = selectionRange;
    if (start === end) return '';
    return editorValue.slice(start, end);
  }, [selectionRange, editorValue]);

  const compileErrors = useMemo(() => parseCompileErrors(compileLog), [compileLog]);
  const pendingGrouped = useMemo(() => {
    const map = new Map<string, PendingChange>();
    pendingChanges.forEach((item) => {
      map.set(item.filePath, item);
    });
    return Array.from(map.values());
  }, [pendingChanges]);

  const figureFiles = useMemo(
    () =>
      tree.filter(
        (item) =>
          item.type === 'file' &&
          FIGURE_EXTS.some((ext) => item.path.toLowerCase().endsWith(ext))
      ),
    [tree]
  );

  useEffect(() => {
    if (!selectedFigure && figureFiles.length > 0) {
      setSelectedFigure(figureFiles[0].path);
    }
  }, [figureFiles, selectedFigure]);

  useEffect(() => {
    setPdfAnnotations([]);
    setPdfOutline([]);
  }, [pdfUrl]);

  const pdfScaleLabel = useMemo(() => {
    if (pdfFitWidth) {
      const fitValue = pdfFitScale ?? pdfScale;
      return `Fit · ${Math.round(fitValue * 100)}%`;
    }
    return `${Math.round(pdfScale * 100)}%`;
  }, [pdfFitScale, pdfFitWidth, pdfScale]);

  const breadcrumbParts = useMemo(() => (activePath ? activePath.split('/').filter(Boolean) : []), [activePath]);

  const clampPdfScale = useCallback((value: number) => Math.min(2.5, Math.max(0.6, value)), []);

  const zoomPdf = useCallback(
    (delta: number) => {
      const base = pdfFitScale ?? pdfScale;
      setPdfFitWidth(false);
      setPdfScale(clampPdfScale(base + delta));
    },
    [clampPdfScale, pdfFitScale, pdfScale]
  );

  const scrollToPdfPage = useCallback((page: number) => {
    const container = pdfContainerRef.current;
    if (!container || !page) return;
    const target = container.querySelector(`.pdf-page[data-page-number="${page}"]`) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const handlePdfOutline = useCallback((items: { title: string; page?: number; level: number }[]) => {
    setPdfOutline(items);
  }, []);

  const addPdfAnnotation = useCallback((page: number, x: number, y: number) => {
    const text = window.prompt('输入注释内容')?.trim();
    if (!text) return;
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    setPdfAnnotations((prev) => [...prev, { id, page, x, y, text }]);
  }, []);

  const downloadPdf = useCallback(() => {
    if (!pdfUrl) return;
    const name = projectName ? projectName.replace(/\s+/g, '-') : projectId || 'openprism';
    const link = document.createElement('a');
    link.href = pdfUrl;
    link.download = `${name}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [pdfUrl, projectId, projectName]);

  const handleFitScale = useCallback((value: number | null) => {
    if (value == null) {
      setPdfFitScale(null);
      return;
    }
    setPdfFitScale((prev) => (prev && Math.abs(prev - value) < 0.005 ? prev : value));
  }, []);

  const startTypewriter = useCallback((setHistory: Dispatch<SetStateAction<Message[]>>, text: string) => {
    if (typewriterTimerRef.current) {
      window.clearTimeout(typewriterTimerRef.current);
      typewriterTimerRef.current = null;
    }
    if (!text) {
      setHistory((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const last = next[next.length - 1];
        if (last.role === 'assistant') {
          next[next.length - 1] = { ...last, content: '' };
        }
        return next;
      });
      return;
    }
    let idx = 0;
    const step = () => {
      idx = Math.min(text.length, idx + 2);
      const slice = text.slice(0, idx);
      setHistory((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const last = next[next.length - 1];
        if (last.role !== 'assistant') return prev;
        next[next.length - 1] = { ...last, content: slice };
        return next;
      });
      if (idx < text.length) {
        typewriterTimerRef.current = window.setTimeout(step, 16);
      }
    };
    step();
  }, []);

  useEffect(() => {
    return () => {
      if (typewriterTimerRef.current) {
        window.clearTimeout(typewriterTimerRef.current);
      }
    };
  }, []);

  const sendPrompt = async () => {
    const isChat = assistantMode === 'chat';
    if (!activePath && !isChat) return;
    if (isChat === false && task === 'translate') {
      if (translateScope === 'selection' && !selectionText) {
        setStatus('请选择要翻译的文本。');
        return;
      }
    }
    const userMsg: Message = { role: 'user', content: prompt || '(empty)' };
    const setHistory = isChat ? setChatMessages : setAgentMessages;
    const history = isChat ? chatMessages : agentMessages;
    const nextHistory = [...history, userMsg];
    setHistory(nextHistory);
    try {
      let effectivePrompt = prompt;
      let effectiveSelection = selectionText;
      let effectiveContent = editorValue;
      let effectiveMode = mode;
      let effectiveTask = task;

      if (!isChat && task === 'translate') {
        const note = prompt ? `\nUser note: ${prompt}` : '';
        if (translateScope === 'project') {
          effectiveMode = 'tools';
          effectiveSelection = '';
          effectiveContent = '';
          effectivePrompt = `Translate all .tex files in the project to ${translateTarget}. Preserve LaTeX commands and structure.${note}`;
        } else if (translateScope === 'file') {
          effectiveSelection = '';
          effectivePrompt = `Translate the current file to ${translateTarget}. Preserve LaTeX commands and structure.${note}`;
        } else {
          effectivePrompt = `Translate the selected text to ${translateTarget}. Preserve LaTeX commands and structure.${note}`;
        }
        effectiveTask = 'translate';
      }

      if (!isChat && task === 'websearch') {
        effectiveMode = 'tools';
        effectiveSelection = '';
        effectiveContent = '';
        effectivePrompt = prompt
          ? `Search arXiv and return 3-5 relevant papers with BibTeX entries. User query: ${prompt}`
          : 'Search arXiv and return 3-5 relevant papers with BibTeX entries.';
        effectiveTask = 'websearch';
      }

      if (!isChat && effectiveTask !== 'websearch') {
        const context = await buildProjectContext();
        if (context) {
          effectivePrompt = `${effectivePrompt}\n\n[Project Context]\n${context}`;
        }
      }

      const effectiveLlmConfig = !isChat && effectiveTask === 'websearch' ? searchLlmConfig : llmConfig;
      const res = await runAgent({
        task: effectiveTask,
        prompt: effectivePrompt,
        selection: effectiveSelection,
        content: effectiveContent,
        mode: isChat ? 'direct' : effectiveMode,
        projectId,
        activePath,
        compileLog,
        llmConfig: effectiveLlmConfig,
        interaction: isChat ? 'chat' : 'agent',
        history: nextHistory.slice(-8)
      });
      const replyText = res.reply || '已生成建议。';
      setHistory((prev) => [...prev, { role: 'assistant', content: '' }]);
      window.setTimeout(() => startTypewriter(setHistory, replyText), 0);

      if (!isChat && res.patches && res.patches.length > 0) {
        const nextPending = res.patches.map((patch) => ({
          filePath: patch.path,
          original: files[patch.path] ?? '',
          proposed: patch.content,
          diff: patch.diff
        }));
        setPendingChanges(nextPending);
        setRightView('diff');
      } else if (!isChat && res.suggestion) {
        const proposed = selectionText
          ? replaceSelection(editorValue, selectionRange[0], selectionRange[1], res.suggestion)
          : res.suggestion;
        const diff = createTwoFilesPatch(activePath, activePath, editorValue, proposed, 'current', 'suggested');
        setPendingChanges([{ filePath: activePath, original: editorValue, proposed, diff }]);
        setRightView('diff');
      }
    } catch (err) {
      setHistory((prev) => [...prev, { role: 'assistant', content: `请求失败: ${String(err)}` }]);
    }
  };

  const diagnoseCompile = async () => {
    if (!compileLog) {
      setStatus('暂无编译日志可诊断。');
      return;
    }
    if (!activePath) return;
    setDiagnoseBusy(true);
    const userMsg: Message = { role: 'user', content: '诊断并修复编译错误' };
    const nextHistory = [...agentMessages, userMsg];
    setAgentMessages(nextHistory);
    try {
      const res = await runAgent({
        task: 'debug_compile',
        prompt: '基于编译日志诊断并修复错误，给出可应用的 diff。',
        selection: compileLog,
        content: editorValue,
        mode: 'tools',
        projectId,
        activePath,
        compileLog,
        llmConfig,
        interaction: 'agent',
        history: nextHistory.slice(-8)
      });
      const assistant: Message = {
        role: 'assistant',
        content: res.reply || '已生成编译修复建议。'
      };
      setAgentMessages((prev) => [...prev, assistant]);
      if (res.patches && res.patches.length > 0) {
        const nextPending = res.patches.map((patch) => ({
          filePath: patch.path,
          original: files[patch.path] ?? '',
          proposed: patch.content,
          diff: patch.diff
        }));
        setPendingChanges(nextPending);
        setRightView('diff');
      }
    } catch (err) {
      setAgentMessages((prev) => [...prev, { role: 'assistant', content: `请求失败: ${String(err)}` }]);
    } finally {
      setDiagnoseBusy(false);
    }
  };

  const applyPending = async (change?: PendingChange) => {
    const list = change ? [change] : pendingChanges;
    for (const item of list) {
      await writeFile(projectId, item.filePath, item.proposed);
      setFiles((prev) => ({ ...prev, [item.filePath]: item.proposed }));
      if (activePath === item.filePath) {
        setEditorDoc(item.proposed);
      }
    }
    if (change) {
      setPendingChanges((prev) => prev.filter((item) => item.filePath !== change.filePath));
      if (diffFocus?.filePath === change.filePath) {
        setDiffFocus(null);
      }
    } else {
      setPendingChanges([]);
      setDiffFocus(null);
    }
    setStatus('已应用修改');
  };

  const discardPending = (change?: PendingChange) => {
    if (change) {
      setPendingChanges((prev) => prev.filter((item) => item.filePath !== change.filePath));
      if (diffFocus?.filePath === change.filePath) {
        setDiffFocus(null);
      }
    } else {
      setPendingChanges([]);
      setDiffFocus(null);
    }
  };

  const startColumnDrag = useCallback(
    (side: 'left' | 'right', event: MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const { sidebar, editor, right } = columnSizes;
      const minSidebar = 220;
      const minEditor = 360;
      const minRight = 320;

      const onMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        if (side === 'left') {
          const nextSidebar = Math.max(minSidebar, sidebar + dx);
          const nextEditor = Math.max(minEditor, editor - dx);
          setColumnSizes({ sidebar: nextSidebar, editor: nextEditor, right });
        } else {
          const nextEditor = Math.max(minEditor, editor + dx);
          const nextRight = Math.max(minRight, right - dx);
          setColumnSizes({ sidebar, editor: nextEditor, right: nextRight });
        }
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [columnSizes]
  );

  const startEditorSplitDrag = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      const container = editorSplitRef.current;
      if (!container) return;

      const onMove = (moveEvent: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const offsetY = moveEvent.clientY - rect.top;
        const ratio = Math.min(0.85, Math.max(0.35, offsetY / rect.height));
        setEditorSplit(ratio);
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    []
  );

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-title">OpenPrism</div>
          <div className="brand-sub">{projectName || 'Editor Workspace'}</div>
        </div>
        <div className="toolbar">
          <Link to="/projects" className="btn ghost">Projects</Link>
          <button className="btn ghost" onClick={() => setSidebarOpen((prev) => !prev)}>
            {sidebarOpen ? '隐藏侧栏' : '显示侧栏'}
          </button>
          <select
            value={mainFile}
            onChange={(e) => setMainFile(e.target.value)}
            className="select"
          >
            {texFiles.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
            {texFiles.length === 0 && <option value="main.tex">main.tex</option>}
          </select>
          <select
            value={compileEngine}
            onChange={(e) => setSettings((prev) => ({ ...prev, compileEngine: e.target.value as CompileEngine }))}
            className="select"
          >
            <option value="swiftlatex">SwiftLaTeX</option>
            <option value="tectonic">Tectonic</option>
            <option value="auto">Auto</option>
          </select>
          <button onClick={saveActiveFile} className="btn ghost">保存</button>
          <button onClick={compile} className="btn" disabled={isCompiling}>
            {isCompiling ? '编译中...' : '编译 PDF'}
          </button>
          <button className="btn ghost" onClick={() => setSettingsOpen(true)}>设置</button>
        </div>
      </header>

      <div className="status-bar">
        <div className="status-left">
          <div>{status}</div>
          <div className={`save-indicator ${isSaving ? 'saving' : isDirty ? 'dirty' : 'saved'} ${savePulse ? 'pulse' : ''}`}>
            <span className="dot" />
            <span>{isSaving ? '保存中...' : isDirty ? '未保存' : '已保存'}</span>
          </div>
        </div>
        <div className="status-right">
          Compile: {compileEngine} · Engine: {engineName || '未初始化'}
        </div>
      </div>

      <main
        className="workspace"
        ref={gridRef}
        style={{
          '--col-sidebar': sidebarOpen ? `${columnSizes.sidebar}px` : '0px',
          '--col-sidebar-gap': sidebarOpen ? '10px' : '0px',
          '--col-editor': `${columnSizes.editor}px`,
          '--col-right': `${columnSizes.right}px`
        } as CSSProperties}
      >
        {sidebarOpen && (
          <aside className="panel side-panel">
            <div className="sidebar-tabs">
              <div className="tab-group">
                <button
                  className={`tab-btn ${activeSidebar === 'files' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('files')}
                  title="Files"
                >
                  <span className="tab-icon">📁</span>
                  <span className="tab-text">Files</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'agent' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('agent')}
                  title="Agent"
                >
                  <span className="tab-icon">🤖</span>
                  <span className="tab-text">Agent</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'vision' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('vision')}
                  title="图像识别"
                >
                  <span className="tab-icon">🔍</span>
                  <span className="tab-text">图像识别</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'search' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('search')}
                  title="论文检索"
                >
                  <span className="tab-icon">📄</span>
                  <span className="tab-text">论文检索</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'websearch' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('websearch')}
                  title="Websearch"
                >
                  <span className="tab-icon">🧭</span>
                  <span className="tab-text">Websearch</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'plot' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('plot')}
                  title="绘图"
                >
                  <span className="tab-icon">📊</span>
                  <span className="tab-text">绘图</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'review' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('review')}
                  title="Review"
                >
                  <span className="tab-icon">✅</span>
                  <span className="tab-text">Review</span>
                </button>
              </div>
              <button className="icon-btn" onClick={() => setSidebarOpen(false)}>✕</button>
            </div>
            {activeSidebar === 'files' ? (
              <>
                <div className="panel-header">
                  <div>Project Files</div>
                  <button
                    className="icon-btn"
                    onClick={() => setFileActionsExpanded(!fileActionsExpanded)}
                    title={fileActionsExpanded ? "收起功能" : "展开功能"}
                  >
                    {fileActionsExpanded ? '▲' : '▼'}
                  </button>
                </div>
                {fileActionsExpanded && (
                  <div className="file-actions">
                  <div className="action-group">
                    <div className="action-group-title">创建</div>
                    <button className="btn ghost small" onClick={() => beginInlineCreate('new-file')}>新建文件</button>
                    <button className="btn ghost small" onClick={() => beginInlineCreate('new-folder')}>新建文件夹</button>
                    <button className="btn ghost small" onClick={createBibFile}>新建 Bib</button>
                  </div>
                  <div className="action-group">
                    <div className="action-group-title">上传</div>
                    <button className="btn ghost small" onClick={() => fileInputRef.current?.click()}>上传文件</button>
                    <button className="btn ghost small" onClick={() => folderInputRef.current?.click()}>上传文件夹</button>
                  </div>
                  <div className="action-group">
                    <div className="action-group-title">操作</div>
                    <button className="btn ghost small" onClick={() => setAllFolders(true)}>展开全部</button>
                    <button className="btn ghost small" onClick={() => setAllFolders(false)}>收起全部</button>
                    <button className="btn ghost small" onClick={beginInlineRename}>重命名</button>
                    <button className="btn ghost small" onClick={() => refreshTree()}>刷新</button>
                  </div>
                </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    handleUpload(event.target.files).catch((err) => setStatus(`上传失败: ${String(err)}`));
                    if (event.target) {
                      event.target.value = '';
                    }
                  }}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)}
                  onChange={(event) => {
                    handleUpload(event.target.files).catch((err) => setStatus(`上传失败: ${String(err)}`));
                    if (event.target) {
                      event.target.value = '';
                    }
                  }}
                />
                <div className="panel-search">
                  <input
                    className="input"
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                    placeholder="搜索文件..."
                  />
                </div>
                <div className="drag-hint muted">拖拽文件：同级排序 / 跨文件夹移动</div>
                <div
                  className="file-tree-body"
                  ref={fileTreeRef}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverPath('');
                    setDragOverKind('');
                    if (draggingPath) {
                      updateDragHint('移动到 根目录', event);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                      handleUpload(event.dataTransfer.files).catch((err) => setStatus(`上传失败: ${String(err)}`));
                      return;
                    }
                    const from = event.dataTransfer.getData('text/plain');
                    if (from) {
                      if (fileFilter.trim()) {
                        setStatus('搜索过滤中无法拖拽移动。');
                        return;
                      }
                      moveFileWithOrder(from, '').catch((err) => setStatus(`移动失败: ${String(err)}`));
                    }
                    setDragHint(null);
                  }}
                >
                  {dragHint && draggingPath && (
                    <div className="drag-hint-overlay" style={{ left: dragHint.x, top: dragHint.y }}>
                      {dragHint.text}
                    </div>
                  )}
                  {inlineEdit && inlineEdit.kind !== 'rename' && inlineEdit.parent === '' && inlineInputRow(0)}
                  {renderTree(treeRoot.children)}
                </div>
                <div className="outline-panel">
                  <div className="outline-header">
                    <div>Outline</div>
                    <div className="muted">{mainFile || 'main.tex'}</div>
                  </div>
                  {mainFile && mainFile.toLowerCase().endsWith('.tex') ? (
                    outlineItems.length > 0 ? (
                      <div className="outline-list">
                        {outlineItems.map((item, idx) => (
                          <button
                            key={`${item.pos}-${idx}`}
                            className={`outline-item level-${item.level}`}
                            onClick={() => {
                              const go = async () => {
                                if (mainFile && activePath !== mainFile) {
                                  await openFile(mainFile);
                                }
                                const view = cmViewRef.current;
                                if (!view) return;
                                const pos = Math.min(item.pos, view.state.doc.length);
                                view.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
                                view.focus();
                              };
                              go();
                            }}
                          >
                            <span className="outline-title">{item.title}</span>
                            <span className="outline-line">L{item.line}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="muted outline-empty">未发现 Section 标题。</div>
                    )
                  ) : (
                    <div className="muted outline-empty">打开 .tex 文件以显示 Outline。</div>
                  )}
                </div>
              </>
            ) : activeSidebar === 'agent' ? (
              <>
                <div className="panel-header">
                  <div>{assistantMode === 'chat' ? 'Chat' : 'Agent'}</div>
                  <div className="panel-actions">
                    <div className="mode-toggle">
                      <button
                        className={`mode-btn ${assistantMode === 'chat' ? 'active' : ''}`}
                        onClick={() => setAssistantMode('chat')}
                      >
                        Chat
                      </button>
                      <button
                        className={`mode-btn ${assistantMode === 'agent' ? 'active' : ''}`}
                        onClick={() => setAssistantMode('agent')}
                      >
                        Agent
                      </button>
                    </div>
                  </div>
                </div>
                {assistantMode === 'chat' && (
                  <div className="context-tags">
                    <span className="context-tag">只读当前文件</span>
                    {selectionText && <span className="context-tag">只读选区</span>}
                    {compileLog && <span className="context-tag">只读编译日志</span>}
                  </div>
                )}
                <div className="chat-messages">
                  {assistantMode === 'chat' && chatMessages.length === 0 && (
                    <div className="muted">输入问题，进行只读对话。</div>
                  )}
                  {assistantMode === 'agent' && agentMessages.length === 0 && (
                    <div className="muted">输入任务描述，生成修改建议。</div>
                  )}
                  {(assistantMode === 'chat' ? chatMessages : agentMessages).map((msg, idx) => (
                    <div key={idx} className={`chat-msg ${msg.role}`}>
                      <div className="role">{msg.role}</div>
                      <div className="content">{msg.content}</div>
                    </div>
                  ))}
                </div>
                <div className="chat-controls">
                  <div className="row">
                    {assistantMode === 'agent' ? (
                      <>
                        <div className="ios-select-wrapper">
                          <button
                            className="ios-select-trigger"
                            onClick={() => {
                              setTaskDropdownOpen(!taskDropdownOpen);
                              setModeDropdownOpen(false);
                            }}
                          >
                            <span>{DEFAULT_TASKS.find((item) => item.value === task)?.label || '选择任务'}</span>
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={taskDropdownOpen ? 'rotate' : ''}>
                              <path d="M3 7L6 4L9 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </button>
                          {taskDropdownOpen && (
                            <div className="ios-dropdown">
                              {DEFAULT_TASKS.map((item) => (
                                <div
                                  key={item.value}
                                  className={`ios-dropdown-item ${task === item.value ? 'active' : ''}`}
                                  onClick={() => {
                                    setTask(item.value);
                                    setTaskDropdownOpen(false);
                                  }}
                                >
                                  {item.label}
                                  {task === item.value && (
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                      <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <div className="ios-select-wrapper">
                            <button
                              className="ios-select-trigger"
                              onClick={() => {
                                setModeDropdownOpen(!modeDropdownOpen);
                                setTaskDropdownOpen(false);
                              }}
                            >
                              <span>{mode === 'direct' ? 'Direct' : 'Tools'}</span>
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={modeDropdownOpen ? 'rotate' : ''}>
                                <path d="M3 7L6 4L9 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </button>
                            {modeDropdownOpen && (
                              <div className="ios-dropdown">
                                <div
                                  className={`ios-dropdown-item ${mode === 'direct' ? 'active' : ''}`}
                                  onClick={() => {
                                    setMode('direct');
                                    setModeDropdownOpen(false);
                                  }}
                                >
                                  Direct
                                  {mode === 'direct' && (
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                      <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  )}
                                </div>
                                <div
                                  className={`ios-dropdown-item ${mode === 'tools' ? 'active' : ''}`}
                                  onClick={() => {
                                    setMode('tools');
                                    setModeDropdownOpen(false);
                                  }}
                                >
                                  Tools
                                  {mode === 'tools' && (
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                      <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                          <span className="info-icon">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                              <path d="M8 7V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                              <circle cx="8" cy="5" r="0.5" fill="currentColor"/>
                            </svg>
                            <span className="tooltip">Direct: 单轮生成 · Tools: 多轮工具调用/多文件修改</span>
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="muted">Chat 模式仅对话，不会改动文件。</div>
                    )}
                  </div>
                  {assistantMode === 'agent' && task === 'translate' && (
                    <div className="row">
                      <div className="ios-select-wrapper">
                        <button
                          className="ios-select-trigger"
                          onClick={() => {
                            setTranslateScopeDropdownOpen(!translateScopeDropdownOpen);
                            setTranslateTargetDropdownOpen(false);
                          }}
                        >
                          <span>
                            {translateScope === 'selection' ? '选区' : translateScope === 'file' ? '当前文件' : '整个项目'}
                          </span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={translateScopeDropdownOpen ? 'rotate' : ''}>
                            <path d="M3 7L6 4L9 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        {translateScopeDropdownOpen && (
                          <div className="ios-dropdown">
                            {[
                              { value: 'selection', label: '选区' },
                              { value: 'file', label: '当前文件' },
                              { value: 'project', label: '整个项目' }
                            ].map((item) => (
                              <div
                                key={item.value}
                                className={`ios-dropdown-item ${translateScope === item.value ? 'active' : ''}`}
                                onClick={() => {
                                  setTranslateScope(item.value as 'selection' | 'file' | 'project');
                                  setTranslateScopeDropdownOpen(false);
                                }}
                              >
                                {item.label}
                                {translateScope === item.value && (
                                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                    <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                  </svg>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="ios-select-wrapper">
                        <button
                          className="ios-select-trigger"
                          onClick={() => {
                            setTranslateTargetDropdownOpen(!translateTargetDropdownOpen);
                            setTranslateScopeDropdownOpen(false);
                          }}
                        >
                          <span>{translateTarget}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={translateTargetDropdownOpen ? 'rotate' : ''}>
                            <path d="M3 7L6 4L9 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        {translateTargetDropdownOpen && (
                          <div className="ios-dropdown">
                            {['English', '中文', '日本語', '한국어', 'Français', 'Deutsch', 'Español'].map((lang) => (
                              <div
                                key={lang}
                                className={`ios-dropdown-item ${translateTarget === lang ? 'active' : ''}`}
                                onClick={() => {
                                  setTranslateTarget(lang);
                                  setTranslateTargetDropdownOpen(false);
                                }}
                              >
                                {lang}
                                {translateTarget === lang && (
                                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                    <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                  </svg>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <textarea
                    className="chat-input"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={assistantMode === 'chat' ? '例如：帮我解释这一段的实验设计。' : '例如：润色这个段落，使其更符合 ACL 风格。'}
                  />
                  <button onClick={sendPrompt} className="btn full">
                    {assistantMode === 'chat' ? '发送' : '生成建议'}
                  </button>
                  {selectionText && assistantMode === 'agent' && (
                    <div className="muted">已选择 {selectionText.length} 字符，将用于任务输入</div>
                  )}
                  {assistantMode === 'agent' && task === 'translate' && translateScope === 'selection' && !selectionText && (
                    <div className="muted">翻译选区前请先选择文本。</div>
                  )}
                </div>
              </>
            ) : activeSidebar === 'vision' ? (
              <>
                <div className="panel-header">
                  <div>图像识别</div>
                  <div className="panel-actions">
                    <button className="btn ghost" onClick={() => setVisionResult('')}>清空结果</button>
                  </div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">图像转 LaTeX</div>
                    <div className="field">
                      <label>识别类型</label>
                      <select
                        className="select"
                        value={visionMode}
                        onChange={(event) => {
                          setVisionMode(event.target.value as 'equation' | 'table' | 'figure' | 'algorithm' | 'ocr');
                          setVisionResult('');
                        }}
                      >
                        <option value="equation">公式</option>
                        <option value="table">表格</option>
                        <option value="figure">图像 + 图注</option>
                        <option value="algorithm">算法</option>
                        <option value="ocr">仅提取文字</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>上传图片</label>
                      <div
                        className={`image-drop-zone ${visionFile ? 'has-file' : ''}`}
                        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
                        onDragLeave={(e) => { e.currentTarget.classList.remove('drag-over'); }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.currentTarget.classList.remove('drag-over');
                          const file = e.dataTransfer.files?.[0];
                          if (file && file.type.startsWith('image/')) {
                            setVisionFile(file);
                            setVisionResult('');
                          }
                        }}
                        onPaste={(e) => {
                          const items = e.clipboardData?.items;
                          if (!items) return;
                          for (const item of items) {
                            if (item.type.startsWith('image/')) {
                              const file = item.getAsFile();
                              if (file) {
                                setVisionFile(file);
                                setVisionResult('');
                              }
                              break;
                            }
                          }
                        }}
                        tabIndex={0}
                      >
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            const file = e.target.files?.[0] || null;
                            setVisionFile(file);
                            setVisionResult('');
                          }}
                          style={{ display: 'none' }}
                          id="vision-file-input"
                        />
                        {visionFile ? (
                          <div className="drop-zone-preview">
                            <span className="file-name">{visionFile.name}</span>
                            <button className="remove-btn" onClick={(e) => { e.stopPropagation(); setVisionFile(null); setVisionPreviewUrl(''); }}>✕</button>
                          </div>
                        ) : (
                          <label htmlFor="vision-file-input" className="drop-zone-content">
                            <span className="drop-icon">📷</span>
                            <span className="drop-text">点击选择、拖拽或粘贴图片</span>
                          </label>
                        )}
                      </div>
                    </div>
                    {visionPreviewUrl && (
                      <div className="vision-preview">
                        <img src={visionPreviewUrl} alt="preview" />
                      </div>
                    )}
                    <div className="field">
                      <label>附加约束 (可选)</label>
                      <textarea
                        className="input"
                        value={visionPrompt}
                        onChange={(event) => setVisionPrompt(event.target.value)}
                        placeholder="例如：只输出 tabular，不要表格标题"
                        rows={2}
                      />
                    </div>
                    <div className="vision-actions">
                      <button className="ios-btn secondary" onClick={handleVisionSubmit} disabled={visionBusy}>
                        {visionBusy ? '识别中...' : '开始识别'}
                      </button>
                      <button className="ios-btn primary" onClick={handleVisionInsert} disabled={!visionResult}>插入到光标</button>
                    </div>
                    {visionResult && (
                      <div className="vision-result">
                        <div className="muted">识别结果 (可编辑)：</div>
                        <textarea
                          className="input"
                          value={visionResult}
                          onChange={(event) => setVisionResult(event.target.value)}
                          rows={6}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : activeSidebar === 'search' ? (
              <>
                <div className="panel-header">
                  <div>论文检索</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">arXiv 检索</div>
                    <div className="field">
                      <label>关键词</label>
                      <input
                        className="input"
                        value={arxivQuery}
                        onChange={(event) => setArxivQuery(event.target.value)}
                        placeholder="例如: diffusion transformer compression"
                      />
                    </div>
                    <div className="row">
                      <input
                        className="input small"
                        type="number"
                        min={1}
                        max={10}
                        value={arxivMaxResults}
                        onChange={(event) => setArxivMaxResults(Number(event.target.value) || 5)}
                      />
                      <button className="btn ghost" onClick={handleArxivSearch} disabled={arxivBusy}>
                        {arxivBusy ? '检索中...' : useLlmSearch ? 'LLM 检索' : '检索'}
                      </button>
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={useLlmSearch}
                        onChange={(event) => setUseLlmSearch(event.target.checked)}
                      />
                      使用 Websearch 模型
                    </label>
                    {arxivStatus && <div className="muted">{arxivStatus}</div>}
                    {llmSearchOutput && (
                      <div className="vision-result">
                        <div className="muted">LLM 原始输出</div>
                        <textarea
                          className="input"
                          value={llmSearchOutput}
                          onChange={(event) => setLlmSearchOutput(event.target.value)}
                          rows={5}
                        />
                      </div>
                    )}
                    {arxivResults.length > 0 && (
                      <div className="tool-list">
                        {arxivResults.map((paper) => (
                          <label key={paper.arxivId} className="tool-item">
                            <input
                              type="checkbox"
                              checked={Boolean(arxivSelected[paper.arxivId])}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setArxivSelected((prev) => ({ ...prev, [paper.arxivId]: checked }));
                              }}
                            />
                            <div>
                              <div className="tool-item-title">{paper.title}</div>
                              <div className="muted">{paper.authors?.join(', ') || 'Unknown authors'}</div>
                              <div className="muted">{paper.arxivId}</div>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="field">
                      <label>Bib 文件</label>
                      <select
                        className="select"
                        value={bibTarget}
                        onChange={(event) => setBibTarget(event.target.value)}
                      >
                        <option value="">(新建/选择 Bib 文件)</option>
                        {bibFiles.map((path) => (
                          <option key={path} value={path}>{path}</option>
                        ))}
                      </select>
                      <button className="btn ghost" onClick={async () => {
                        const created = await createBibFile();
                        if (created) setBibTarget(created);
                      }}>新建 Bib</button>
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={autoInsertCite}
                        onChange={(event) => setAutoInsertCite(event.target.checked)}
                      />
                      自动插入引用到当前 TeX
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={autoInsertToMain}
                        onChange={(event) => setAutoInsertToMain(event.target.checked)}
                      />
                      AI 插入引用到指定 TeX
                    </label>
                    {autoInsertToMain && (
                      <div className="field">
                        <label>引用插入目标</label>
                        <select
                          className="select"
                          value={citeTargetFile}
                          onChange={(event) => setCiteTargetFile(event.target.value)}
                        >
                          {texFiles.map((path) => (
                            <option key={path} value={path}>{path}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="row">
                      <button className="btn" onClick={handleArxivApply} disabled={arxivBusy}>
                        写入 Bib / 插入引用
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : activeSidebar === 'websearch' ? (
              <>
                <div className="panel-header">
                  <div>Websearch</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">多点检索</div>
                    <div className="field">
                      <label>Query</label>
                      <input
                        className="input"
                        value={websearchQuery}
                        onChange={(event) => setWebsearchQuery(event.target.value)}
                        placeholder="例如: diffusion editing for safety"
                      />
                    </div>
                    <div className="row">
                      <button className="btn" onClick={runWebsearch} disabled={websearchBusy}>
                        {websearchBusy ? '检索中...' : '开始检索'}
                      </button>
                    </div>
                    <div className="websearch-log">
                      {websearchLog.length === 0 ? (
                        <div className="muted">等待查询...</div>
                      ) : (
                        websearchLog.map((line, idx) => (
                          <div key={idx} className="websearch-line">{line}</div>
                        ))
                      )}
                    </div>
                    {websearchResults.length > 0 && (
                      <>
                        <div className="row">
                          <label className="checkbox-row">
                            <input
                              type="checkbox"
                              checked={websearchSelectedAll}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setWebsearchSelectedAll(checked);
                                const next: Record<string, boolean> = {};
                                websearchResults.forEach((item) => {
                                  next[item.id] = checked;
                                });
                                setWebsearchSelected(next);
                              }}
                            />
                            全选
                          </label>
                          <button
                            className="btn ghost small"
                            onClick={() => {
                              const keys = websearchResults
                                .filter((item) => websearchSelected[item.id])
                                .map((item) => item.citeKey)
                                .filter(Boolean);
                              if (keys.length > 0) {
                                insertAtCursor(`\\cite{${keys.join(',')}}`);
                                appendLog(setWebsearchLog, '已插入选中引用到光标。');
                              }
                            }}
                          >
                            插入选中引用
                          </button>
                        </div>
                        <div className="tool-list">
                          {websearchResults.map((paper) => (
                            <label key={paper.id} className="tool-item">
                              <input
                                type="checkbox"
                                checked={Boolean(websearchSelected[paper.id])}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setWebsearchSelected((prev) => ({ ...prev, [paper.id]: checked }));
                                }}
                              />
                              <div>
                                <div className="tool-item-title">{paper.title}</div>
                                {paper.summary && <div className="muted">{paper.summary}</div>}
                                {paper.url && <div className="muted">{paper.url}</div>}
                                {paper.citeKey && <div className="muted">cite: {paper.citeKey}</div>}
                              </div>
                              <button
                                className="btn ghost small"
                                onClick={() => {
                                  if (paper.citeKey) {
                                    insertAtCursor(`\\cite{${paper.citeKey}}`);
                                    appendLog(setWebsearchLog, `已插入: ${paper.citeKey}`);
                                  }
                                }}
                              >
                                插入引用
                              </button>
                            </label>
                          ))}
                        </div>
                        <div className="vision-result">
                          <div className="muted">逐条总结</div>
                          <div className="tool-list">
                            {websearchResults.map((paper) => (
                              <div key={paper.id} className="tool-item summary-item">
                                <div>
                                  <div className="tool-item-title">{paper.title}</div>
                                  {paper.citeKey && <div className="muted">cite: {paper.citeKey}</div>}
                                </div>
                                <textarea
                                  className="input"
                                  value={websearchItemNotes[paper.id] ?? paper.summary ?? ''}
                                  onChange={(event) =>
                                    setWebsearchItemNotes((prev) => ({ ...prev, [paper.id]: event.target.value }))
                                  }
                                  rows={3}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                    {websearchParagraph && (
                      <div className="vision-result">
                        <div className="muted">综合总结</div>
                        <textarea
                          className="input"
                          value={websearchParagraph}
                          onChange={(event) => setWebsearchParagraph(event.target.value)}
                          rows={6}
                        />
                      </div>
                    )}
                    <div className="field">
                      <label>Bib 文件</label>
                      <select
                        className="select"
                        value={websearchTargetBib}
                        onChange={(event) => setWebsearchTargetBib(event.target.value)}
                      >
                        <option value="">(新建/选择 Bib 文件)</option>
                        {bibFiles.map((path) => (
                          <option key={path} value={path}>{path}</option>
                        ))}
                      </select>
                      <button className="btn ghost small" onClick={async () => {
                        const created = await createBibFile();
                        if (created) setWebsearchTargetBib(created);
                      }}>新建 Bib</button>
                    </div>
                    <div className="field">
                      <label>插入目标 TeX</label>
                      <select
                        className="select"
                        value={websearchTargetFile}
                        onChange={(event) => setWebsearchTargetFile(event.target.value)}
                      >
                        {texFiles.map((path) => (
                          <option key={path} value={path}>{path}</option>
                        ))}
                      </select>
                    </div>
                    <div className="row">
                      <button className="btn" onClick={applyWebsearchInsert} disabled={websearchBusy}>
                        一键写入 Bib + 插入总结
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : activeSidebar === 'plot' ? (
              <>
                <div className="panel-header">
                  <div>绘图</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">表格 → 图表</div>
                    <div className="muted">从选区表格生成图表（seaborn）</div>
                    <div className="field">
                      <label>图表类型</label>
                      <select
                        className="select"
                        value={plotType}
                        onChange={(event) => setPlotType(event.target.value as 'bar' | 'line' | 'heatmap')}
                      >
                        <option value="bar">Bar</option>
                        <option value="line">Line</option>
                        <option value="heatmap">Heatmap</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>标题 (可选)</label>
                      <input
                        className="input"
                        value={plotTitle}
                        onChange={(event) => setPlotTitle(event.target.value)}
                        placeholder="Chart title"
                      />
                    </div>
                    <div className="field">
                      <label>文件名 (可选)</label>
                      <input
                        className="input"
                        value={plotFilename}
                        onChange={(event) => setPlotFilename(event.target.value)}
                        placeholder="plot.png"
                      />
                    </div>
                    <div className="field">
                      <label>补充提示 (可选)</label>
                      <textarea
                        className="input"
                        value={plotPrompt}
                        onChange={(event) => setPlotPrompt(event.target.value)}
                        placeholder="例如：使用折线图，突出 Method A；加上 legend；设置 y 轴为 Accuracy"
                        rows={2}
                      />
                    </div>
                    <div className="field">
                      <label>Debug 重试次数</label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={5}
                        value={plotRetries}
                        onChange={(event) => setPlotRetries(Math.max(0, Math.min(5, Number(event.target.value) || 0)))}
                      />
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={plotAutoInsert}
                        onChange={(event) => setPlotAutoInsert(event.target.checked)}
                      />
                      生成后插入 Figure
                    </label>
                    <div className="row">
                      <button className="btn" onClick={handlePlotGenerate} disabled={plotBusy}>
                        {plotBusy ? '生成中...' : '生成图表'}
                      </button>
                    </div>
                    {plotStatus && <div className="muted">{plotStatus}</div>}
                    {plotAssetPath && (
                      <div className="vision-result">
                        <div className="muted">预览</div>
                        <img
                          src={`/api/projects/${projectId}/blob?path=${encodeURIComponent(plotAssetPath)}`}
                          alt={plotAssetPath}
                          style={{ width: '100%', borderRadius: '8px' }}
                        />
                        <div className="row">
                          <button className="btn ghost" onClick={() => insertFigureSnippet(plotAssetPath)}>插入图模板</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : activeSidebar === 'review' ? (
              <>
                <div className="panel-header">
                  <div>Review</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">质量检查</div>
                    <div className="tool-desc">AI 辅助检查论文质量，发现潜在问题</div>
                    <div className="review-buttons">
                      <button
                        className="review-btn"
                        onClick={async () => {
                          const res = await runAgent({
                            task: 'consistency_check',
                            prompt: 'Check terminology, notation, and consistency across the project. Return concise findings.',
                            selection: '',
                            content: '',
                            mode: 'tools',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: '一致性检查', content: res.reply || '无结果' }, ...prev]);
                          if (res.patches && res.patches.length > 0) {
                            const nextPending = res.patches.map((patch) => ({
                              filePath: patch.path,
                              original: files[patch.path] ?? '',
                              proposed: patch.content,
                              diff: patch.diff
                            }));
                            setPendingChanges(nextPending);
                            setRightView('diff');
                          }
                        }}
                      >
                        <span className="review-btn-icon">🔍</span>
                        <span className="review-btn-label">一致性检查</span>
                        <span className="review-btn-desc">检查术语、符号一致性</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={async () => {
                          const res = await runAgent({
                            task: 'missing_citations',
                            prompt: 'Find claims that likely need citations and list them.',
                            selection: '',
                            content: '',
                            mode: 'tools',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: '引用缺失', content: res.reply || '无结果' }, ...prev]);
                        }}
                      >
                        <span className="review-btn-icon">📚</span>
                        <span className="review-btn-label">引用缺失</span>
                        <span className="review-btn-desc">查找需要引用的论述</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={async () => {
                          const res = await runAgent({
                            task: 'compile_summary',
                            prompt: 'Summarize compile log errors and suggested fixes.',
                            selection: compileLog,
                            content: '',
                            mode: 'direct',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: '编译日志总结', content: res.reply || '无结果' }, ...prev]);
                        }}
                      >
                        <span className="review-btn-icon">📋</span>
                        <span className="review-btn-label">编译日志总结</span>
                        <span className="review-btn-desc">总结错误并给出修复建议</span>
                      </button>
                    </div>
                  </div>
                  {reviewNotes.length > 0 && (
                    <div className="tool-section">
                      <div className="tool-title">结果</div>
                      {reviewNotes.map((note, idx) => (
                        <div key={`${note.title}-${idx}`} className="review-item">
                          <div className="review-title">{note.title}</div>
                          <div className="review-content">{note.content}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </aside>
        )}

        {sidebarOpen && (
          <div
            className="drag-handle vertical sidebar-handle"
            onMouseDown={(e) => startColumnDrag('left', e)}
          />
        )}

        <section className="panel editor-panel">
          <div className="panel-header">Editor</div>
          <div className="breadcrumb-bar">
            <span className="breadcrumb-item">{projectName || 'Project'}</span>
            {breadcrumbParts.map((part, idx) => (
              <span key={`${part}-${idx}`} className="breadcrumb-item">{part}</span>
            ))}
            {currentHeading && (
              <span className="breadcrumb-item heading">{currentHeading.title}</span>
            )}
          </div>
          <div className="editor-toolbar">
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertSectionSnippet}>Section</button>
              <button className="toolbar-btn" onClick={insertSubsectionSnippet}>Subsection</button>
              <button className="toolbar-btn" onClick={insertSubsubsectionSnippet}>Subsubsection</button>
            </div>
            <div className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertItemizeSnippet}>Itemize</button>
              <button className="toolbar-btn" onClick={insertEnumerateSnippet}>Enumerate</button>
              <button className="toolbar-btn" onClick={insertEquationSnippet}>Equation</button>
              <button className="toolbar-btn" onClick={insertAlgorithmSnippet}>Algorithm</button>
            </div>
            <div className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertFigureTemplate}>Figure</button>
              <button className="toolbar-btn" onClick={insertTableSnippet}>Table</button>
              <button className="toolbar-btn" onClick={insertListingSnippet}>Listing</button>
            </div>
            <div className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertCiteSnippet}>Cite</button>
              <button className="toolbar-btn" onClick={insertRefSnippet}>Ref</button>
              <button className="toolbar-btn" onClick={insertLabelSnippet}>Label</button>
            </div>
          </div>
          <div
            className="editor-split"
            ref={editorSplitRef}
          >
            <div className="editor-area" ref={editorAreaRef}>
              <div ref={editorHostRef} className="editor-host" />
              <div className="editor-hint muted">快捷键: Option/Alt + / 或 Cmd/Ctrl + Space 补全；Cmd/Ctrl + / 注释；Cmd/Ctrl + F 搜索；Cmd/Ctrl + S 保存</div>
              {(inlineSuggestionText || isSuggesting) && suggestionPos && (
                <div
                  className={`suggestion-popover ${isSuggesting && !inlineSuggestionText ? 'loading' : ''}`}
                  style={{ left: suggestionPos.left, top: suggestionPos.top }}
                >
                  {isSuggesting && !inlineSuggestionText ? (
                    <div className="suggestion-loading">
                      <span className="spinner" />
                      AI 补全中...
                    </div>
                  ) : (
                    <>
                      <div className="suggestion-preview">{inlineSuggestionText}</div>
                      <div className="row">
                        <button className="btn" onClick={() => acceptSuggestionRef.current()}>接受</button>
                        <button className="btn ghost" onClick={() => clearSuggestionRef.current()}>拒绝</button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        <div
          className="drag-handle vertical main-handle"
          onMouseDown={(e) => startColumnDrag('right', e)}
        />

        <section className="panel pdf-panel">
          <div className="panel-header">
            <div>Preview</div>
            <div className="header-controls">
              <select
                className="select"
                value={rightView}
                onChange={(event) => setRightView(event.target.value as 'pdf' | 'figures' | 'diff' | 'log' | 'toc')}
              >
                <option value="pdf">PDF</option>
                <option value="toc">目录</option>
                <option value="figures">FIG</option>
                <option value="diff">DIFF</option>
                <option value="log">LOG</option>
              </select>
            </div>
          </div>
          <div className="right-body">
            <div className="view-content">
              {rightView === 'pdf' && (
                <>
                  <div className="pdf-toolbar">
                    <div className="toolbar-group">
                      <button className="icon-btn" onClick={() => zoomPdf(-0.1)} disabled={!pdfUrl}>−</button>
                      <div className="zoom-label">{pdfScaleLabel}</div>
                      <button className="icon-btn" onClick={() => zoomPdf(0.1)} disabled={!pdfUrl}>＋</button>
                      <button className="btn ghost small" onClick={() => setPdfFitWidth(true)} disabled={!pdfUrl}>适合宽度</button>
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          setPdfFitWidth(false);
                          setPdfScale(1);
                        }}
                        disabled={!pdfUrl}
                      >
                        100%
                      </button>
                    </div>
                    <div className="toolbar-group">
                      <button className="btn ghost small" onClick={downloadPdf} disabled={!pdfUrl}>下载 PDF</button>
                      <button
                        className={`btn ghost small ${pdfSpread ? 'active' : ''}`}
                        onClick={() => setPdfSpread((prev) => !prev)}
                        disabled={!pdfUrl}
                      >
                        双页
                      </button>
                      <button
                        className={`btn ghost small ${pdfAnnotateMode ? 'active' : ''}`}
                        onClick={() => setPdfAnnotateMode((prev) => !prev)}
                        disabled={!pdfUrl}
                      >
                        注释
                      </button>
                    </div>
                  </div>
                  {pdfUrl ? (
                    <PdfPreview
                      pdfUrl={pdfUrl}
                      scale={pdfScale}
                      fitWidth={pdfFitWidth}
                      spread={pdfSpread}
                      onFitScale={handleFitScale}
                      onOutline={handlePdfOutline}
                      annotations={pdfAnnotations}
                      annotateMode={pdfAnnotateMode}
                      onAddAnnotation={addPdfAnnotation}
                      containerRef={pdfContainerRef}
                      onTextClick={(text) => {
                        const view = cmViewRef.current;
                        if (!view) return;
                        const docText = view.state.doc.toString();
                        const needle = text.replace(/\s+/g, ' ').trim();
                        if (!needle) return;
                        const idx = docText.indexOf(needle);
                        if (idx >= 0) {
                          view.dispatch({
                            selection: { anchor: idx, head: idx + needle.length },
                            scrollIntoView: true
                          });
                          view.focus();
                        }
                      }}
                    />
                  ) : (
                    <div className="muted pdf-empty-message">尚未生成 PDF</div>
                  )}
                  {pdfAnnotations.length > 0 && (
                    <div className="pdf-annotations">
                      <div className="muted">注释</div>
                      <div className="annotation-list">
                        {pdfAnnotations.map((note) => (
                          <div key={note.id} className="annotation-item">
                            <button
                              className="annotation-link"
                              onClick={() => scrollToPdfPage(note.page)}
                            >
                              P{note.page}
                            </button>
                            <div className="annotation-text">{note.text}</div>
                            <button
                              className="annotation-remove"
                              onClick={() =>
                                setPdfAnnotations((prev) => prev.filter((item) => item.id !== note.id))
                              }
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              {rightView === 'toc' && (
                <div className="toc-panel">
                  <div className="toc-title">目录</div>
                  {pdfOutline.length === 0 ? (
                    <div className="muted">暂无目录信息。</div>
                  ) : (
                    <div className="toc-list">
                      {pdfOutline.map((item, idx) => (
                        <button
                          key={`${item.title}-${idx}`}
                          className={`toc-item level-${item.level}`}
                          onClick={() => {
                            if (item.page) {
                              setRightView('pdf');
                              scrollToPdfPage(item.page);
                            }
                          }}
                        >
                          <span className="toc-title-text">{item.title}</span>
                          {item.page && <span className="toc-page">P{item.page}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {rightView === 'figures' && (
                <div className="figure-panel">
                  <div className="figure-list">
                    {figureFiles.map((item) => (
                      <button
                        key={item.path}
                        className={`figure-item ${selectedFigure === item.path ? 'active' : ''}`}
                        onClick={() => setSelectedFigure(item.path)}
                      >
                        {item.path}
                      </button>
                    ))}
                    {figureFiles.length === 0 && (
                      <div className="muted">暂无图片文件。</div>
                    )}
                  </div>
                  <div className="figure-preview">
                    {selectedFigure ? (
                      selectedFigure.toLowerCase().endsWith('.pdf') ? (
                        <object data={`/api/projects/${projectId}/blob?path=${encodeURIComponent(selectedFigure)}`} type="application/pdf" />
                      ) : (
                        <img src={`/api/projects/${projectId}/blob?path=${encodeURIComponent(selectedFigure)}`} alt={selectedFigure} />
                      )
                    ) : (
                      <div className="muted">选择图片进行预览。</div>
                    )}
                  </div>
                  {selectedFigure && (
                    <div className="figure-actions">
                      <button className="btn ghost" onClick={() => insertFigureSnippet(selectedFigure)}>插入图模板</button>
                    </div>
                  )}
                </div>
              )}
              {rightView === 'diff' && (
                <div className="diff-panel">
                  <div className="diff-title">Diff Preview ({pendingGrouped.length})</div>
                  {pendingGrouped.length === 0 && <div className="muted">暂无待确认修改。</div>}
                  {pendingGrouped.map((change) => (
                    (() => {
                      const rows = buildSplitDiff(change.original, change.proposed);
                      return (
                        <div key={change.filePath} className="diff-item">
                          <div className="diff-header">
                            <div className="diff-path">{change.filePath}</div>
                            <button className="btn ghost" onClick={() => setDiffFocus(change)}>放大</button>
                          </div>
                          <SplitDiffView rows={rows} />
                          <div className="row">
                            <button className="btn" onClick={() => applyPending(change)}>应用此修改</button>
                            <button className="btn ghost" onClick={() => discardPending(change)}>放弃</button>
                          </div>
                        </div>
                      );
                    })()
                  ))}
                  {pendingGrouped.length > 1 && (
                    <div className="row">
                      <button className="btn" onClick={() => applyPending()}>应用全部</button>
                      <button className="btn ghost" onClick={() => discardPending()}>全部放弃</button>
                    </div>
                  )}
                </div>
              )}
              {rightView === 'log' && (
                <div className="log-panel">
                  <div className="log-title">
                    Compile Log
                    {assistantMode === 'agent' && (
                      <button className="btn ghost log-action" onClick={diagnoseCompile} disabled={diagnoseBusy}>
                        {diagnoseBusy ? (
                          <span className="suggestion-loading">
                            <span className="spinner" />
                            诊断中...
                          </span>
                        ) : (
                          '一键诊断'
                        )}
                      </button>
                    )}
                  </div>
                  {compileErrors.length > 0 && (
                    <div className="log-errors">
                      {compileErrors.map((error, idx) => (
                        <button
                          key={`${error.message}-${idx}`}
                          className="error-item"
                          onClick={() => jumpToError(error)}
                        >
                          <span className="error-tag">!</span>
                          <span className="error-text">{error.message}</span>
                          {error.line && <span className="error-line">L{error.line}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  <pre className="log-content">{compileLog || '暂无编译日志'}</pre>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>Workspace Settings</div>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>TexLive Endpoint</label>
                <input
                  className="input"
                  value={texliveEndpoint}
                  onChange={(e) => setSettings((prev) => ({ ...prev, texliveEndpoint: e.target.value }))}
                  placeholder="https://texlive.swiftlatex.com"
                />
              </div>
              <div className="field">
                <label>LLM Endpoint</label>
                <input
                  className="input"
                  value={llmEndpoint}
                  onChange={(e) => setSettings((prev) => ({ ...prev, llmEndpoint: e.target.value }))}
                  placeholder="https://api.openai.com/v1/chat/completions"
                />
                <div className="muted">支持 OpenAI 兼容的 base_url，例如 https://api.apiyi.com/v1</div>
              </div>
              <div className="field">
                <label>LLM Model</label>
                <input
                  className="input"
                  value={llmModel}
                  onChange={(e) => setSettings((prev) => ({ ...prev, llmModel: e.target.value }))}
                  placeholder="gpt-4o-mini"
                />
              </div>
              <div className="field">
                <label>LLM API Key</label>
                <input
                  className="input"
                  value={llmApiKey}
                  onChange={(e) => setSettings((prev) => ({ ...prev, llmApiKey: e.target.value }))}
                  placeholder="sk-..."
                  type="password"
                />
                {!llmApiKey && (
                  <div className="muted">未配置 API Key 时将使用后端环境变量。</div>
                )}
              </div>
              <div className="field">
                <label>Search LLM Endpoint (可选)</label>
                <input
                  className="input"
                  value={searchEndpoint}
                  onChange={(e) => setSettings((prev) => ({ ...prev, searchEndpoint: e.target.value }))}
                  placeholder="https://api.apiyi.com/v1"
                />
                <div className="muted">仅用于“检索/websearch”任务，留空则复用 LLM Endpoint。</div>
              </div>
              <div className="field">
                <label>Search LLM Model (可选)</label>
                <input
                  className="input"
                  value={searchModel}
                  onChange={(e) => setSettings((prev) => ({ ...prev, searchModel: e.target.value }))}
                  placeholder="claude-sonnet-4-5-20250929-all"
                />
              </div>
              <div className="field">
                <label>Search LLM API Key (可选)</label>
                <input
                  className="input"
                  value={searchApiKey}
                  onChange={(e) => setSettings((prev) => ({ ...prev, searchApiKey: e.target.value }))}
                  placeholder="sk-..."
                  type="password"
                />
              </div>
              <div className="field">
                <label>VLM Endpoint (可选)</label>
                <input
                  className="input"
                  value={visionEndpoint}
                  onChange={(e) => setSettings((prev) => ({ ...prev, visionEndpoint: e.target.value }))}
                  placeholder="https://api.apiyi.com/v1"
                />
                <div className="muted">仅用于图像识别，留空则复用 LLM Endpoint。</div>
              </div>
              <div className="field">
                <label>VLM Model (可选)</label>
                <input
                  className="input"
                  value={visionModel}
                  onChange={(e) => setSettings((prev) => ({ ...prev, visionModel: e.target.value }))}
                  placeholder="gpt-4o"
                />
              </div>
              <div className="field">
                <label>VLM API Key (可选)</label>
                <input
                  className="input"
                  value={visionApiKey}
                  onChange={(e) => setSettings((prev) => ({ ...prev, visionApiKey: e.target.value }))}
                  placeholder="sk-..."
                  type="password"
                />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setSettingsOpen(false)}>关闭</button>
              <button className="btn" onClick={() => setSettingsOpen(false)}>完成</button>
            </div>
          </div>
        </div>
      )}
      {diffFocus && (
        <div className="modal-backdrop" onClick={() => setDiffFocus(null)}>
          <div className="modal diff-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>Diff · {diffFocus.filePath}</div>
              <button className="icon-btn" onClick={() => setDiffFocus(null)}>✕</button>
            </div>
            <div className="modal-body diff-modal-body">
              <SplitDiffView rows={buildSplitDiff(diffFocus.original, diffFocus.proposed)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
