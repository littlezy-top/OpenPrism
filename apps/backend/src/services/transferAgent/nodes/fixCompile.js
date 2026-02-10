import { promises as fs } from 'fs';
import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { safeJoin } from '../../../utils/pathUtils.js';
import { writeFileWithSnapshot, stripCodeFences } from '../utils.js';

const MAX_LOG_TAIL = 8000;

/**
 * fixCompile node — LLM reads current main.tex + compile log,
 * fixes compilation errors, writes back the corrected file.
 */
export async function fixCompile(state) {
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);
  const absMain = safeJoin(state.targetProjectRoot, state.targetMainFile);
  const currentTex = await fs.readFile(absMain, 'utf8');

  const log = (state.compileResult?.log || '').slice(-MAX_LOG_TAIL);

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  const prompt = `You are a LaTeX compilation error fixer.

The following LaTeX file failed to compile. Fix the errors and return the corrected COMPLETE file.

COMPILE LOG (last ${MAX_LOG_TAIL} chars):
${log}

CURRENT FILE (${state.targetMainFile}):
${currentTex}

Common fixes:
- Missing packages: add \\usepackage{...} in preamble
- Undefined commands: replace with standard alternatives or define them
- Mismatched braces: fix bracket/brace pairing
- Missing files: comment out or remove references to missing files
- Encoding issues: ensure UTF-8 compatibility

Output ONLY the complete corrected LaTeX file. No explanations, no markdown fences.`;

  const response = await llm.invoke([{ role: 'user', content: prompt }]);
  const fixed = stripCodeFences(response.content);

  await writeFileWithSnapshot(
    state.targetProjectRoot,
    state.targetMainFile,
    fixed,
    state.jobId
  );

  return {
    progressLog: `[fixCompile] Applied LLM fix for compile attempt ${state.compileAttempt}.`,
  };
}
