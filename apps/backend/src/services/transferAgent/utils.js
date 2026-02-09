import { promises as fs } from 'fs';
import path from 'path';
import { ensureDir } from '../../utils/fsUtils.js';
import { safeJoin } from '../../utils/pathUtils.js';

/**
 * Write file with snapshot backup.
 * Saves old content to .agent_runs/<jobId>/snapshots/ before overwriting.
 */
export async function writeFileWithSnapshot(projectRoot, relPath, content, jobId) {
  const absPath = safeJoin(projectRoot, relPath);

  // Save snapshot of old content if file exists
  if (jobId) {
    try {
      const old = await fs.readFile(absPath, 'utf8');
      const snapshotDir = path.join(projectRoot, '.agent_runs', jobId, 'snapshots');
      await ensureDir(snapshotDir);
      const ts = Date.now();
      const snapshotPath = path.join(snapshotDir, `${relPath.replace(/\//g, '_')}.${ts}.bak`);
      await fs.writeFile(snapshotPath, old, 'utf8');
    } catch {
      // File doesn't exist yet, no snapshot needed
    }
  }

  await ensureDir(path.dirname(absPath));
  await fs.writeFile(absPath, content, 'utf8');
}
