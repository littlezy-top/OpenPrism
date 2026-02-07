import { promises as fs } from 'fs';
import path from 'path';
import { TEMPLATE_MANIFEST } from '../config/constants.js';
import { ensureDir, readJson } from '../utils/fsUtils.js';

export async function readTemplateManifest() {
  try {
    const data = await readJson(TEMPLATE_MANIFEST);
    const templates = Array.isArray(data?.templates) ? data.templates : [];
    const categories = Array.isArray(data?.categories) ? data.categories : [];
    return { templates, categories };
  } catch {
    return { templates: [], categories: [] };
  }
}

export async function copyTemplateIntoProject(templateRoot, projectRoot) {
  const changed = [];
  const walk = async (rel = '') => {
    const dirPath = path.join(templateRoot, rel);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const nextRel = path.join(rel, entry.name);
      if (entry.name === 'main.tex') continue;
      const srcPath = path.join(templateRoot, nextRel);
      const destPath = path.join(projectRoot, nextRel);
      if (entry.isDirectory()) {
        await ensureDir(destPath);
        await walk(nextRel);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        const shouldOverwrite = ext && ext !== '.tex';
        try {
          await fs.access(destPath);
          if (!shouldOverwrite) continue;
        } catch {
          // file missing; proceed to copy
        }
        await ensureDir(path.dirname(destPath));
        await fs.copyFile(srcPath, destPath);
        changed.push(nextRel);
      }
    }
  };
  await walk('');
  return changed;
}
