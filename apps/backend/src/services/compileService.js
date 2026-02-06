import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { ensureDir } from '../utils/fsUtils.js';
import { safeJoin } from '../utils/pathUtils.js';
import { getProjectRoot } from './projectService.js';

const SUPPORTED_ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'];

function buildCommand(engine, outDir, mainFile) {
  switch (engine) {
    case 'pdflatex':
    case 'xelatex':
    case 'lualatex':
      return { cmd: engine, args: ['-interaction=nonstopmode', `-output-directory=${outDir}`, mainFile] };
    case 'latexmk':
      return { cmd: 'latexmk', args: ['-pdf', '-interaction=nonstopmode', `-outdir=${outDir}`, mainFile] };
    case 'tectonic':
      return { cmd: 'tectonic', args: ['--outdir', outDir, mainFile] };
    default:
      return null;
  }
}

export { SUPPORTED_ENGINES };

export async function runCompile({ projectId, mainFile, engine = 'pdflatex' }) {
  if (!SUPPORTED_ENGINES.includes(engine)) {
    return { ok: false, error: `Unsupported engine: ${engine}` };
  }

  const projectRoot = await getProjectRoot(projectId);
  const absMain = safeJoin(projectRoot, mainFile);
  await fs.access(absMain);

  const buildRoot = path.join(projectRoot, '.compile');
  await ensureDir(buildRoot);
  const runId = crypto.randomUUID();
  const outDir = path.join(buildRoot, runId);
  await ensureDir(outDir);

  const logChunks = [];
  const MAX_LOG_BYTES = 200_000;
  const pushLog = (chunk) => {
    if (!chunk) return;
    const next = chunk.toString();
    const currentSize = logChunks.reduce((sum, item) => sum + item.length, 0);
    if (currentSize >= MAX_LOG_BYTES) return;
    const remaining = MAX_LOG_BYTES - currentSize;
    logChunks.push(next.slice(0, remaining));
  };

  const { cmd, args } = buildCommand(engine, outDir, mainFile);

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: projectRoot });
    child.stdout.on('data', pushLog);
    child.stderr.on('data', pushLog);
    child.on('error', async (err) => {
      await fs.rm(outDir, { recursive: true, force: true });
      resolve({ ok: false, error: `${engine} not available: ${err.message}` });
    });
    child.on('close', async (code) => {
      const base = path.basename(mainFile, path.extname(mainFile));
      const pdfPath = path.join(outDir, `${base}.pdf`);
      let pdfBase64 = '';
      try {
        const buffer = await fs.readFile(pdfPath);
        pdfBase64 = buffer.toString('base64');
      } catch {
        pdfBase64 = '';
      }
      const log = logChunks.join('');
      await fs.rm(outDir, { recursive: true, force: true });
      if (!pdfBase64) {
        resolve({
          ok: false,
          error: 'No PDF generated.',
          log,
          status: code ?? -1
        });
        return;
      }
      resolve({
        ok: true,
        pdf: pdfBase64,
        log,
        status: code ?? 0
      });
    });
  });
}
