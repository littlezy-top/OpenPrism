import path from 'path';
import { parsePdfWithMineru as callMineru } from '../../mineruService.js';
import { ensureDir } from '../../../utils/fsUtils.js';
import { getProjectRoot } from '../../projectService.js';

/**
 * parsePdfWithMineru node — calls MinerU API to parse the source PDF
 * into Markdown + images.
 */
export async function parsePdfWithMineru(state) {
  const targetProjectRoot = state.targetProjectRoot || await getProjectRoot(state.targetProjectId);
  const outputDir = path.join(targetProjectRoot, '_mineru_output');
  await ensureDir(outputDir);

  const result = await callMineru(
    state.sourcePdfPath,
    state.mineruConfig,
    outputDir,
  );

  const mdLen = (result.markdownContent || '').length;
  const imgCount = (result.images || []).length;

  return {
    sourceMarkdown: result.markdownContent,
    sourceImages: result.images || [],
    targetProjectRoot,
    mineruOutputDir: outputDir,
    progressLog: `[parsePdfWithMineru] Parsed PDF: ${mdLen} chars markdown, ${imgCount} images.`,
  };
}
