import { promises as fs } from 'fs';
import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { safeJoin } from '../../../utils/pathUtils.js';
import { writeFileWithSnapshot } from '../utils.js';

/**
 * Strip markdown code fences from LLM output.
 */
function stripCodeFences(text) {
  return text.replace(/^```(?:latex|tex)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

/**
 * Build the LLM prompt for content migration.
 */
function buildTransferPrompt(state) {
  const planJson = JSON.stringify(state.transferPlan, null, 2);
  return `You are a LaTeX template migration expert.

TASK: Migrate the source paper content into the target template structure.

MIGRATION PLAN:
${planJson}

TARGET TEMPLATE (full):
${state.targetTemplateContent}

SOURCE CONTENT (full):
${state.sourceFullContent}

RULES:
1. Keep the target preamble (everything before \\begin{document}) EXACTLY as-is
2. Only modify content between \\begin{document} and \\end{document}
3. Follow the section mapping in the migration plan
4. Preserve ALL \\cite{}, \\ref{}, \\label{} commands from the source
5. Preserve ALL figure, table, algorithm environments from the source
6. Adapt section/subsection commands to match the target template style
7. Do NOT add any content that doesn't exist in the source
8. Do NOT remove any substantive content from the source
9. If the source uses \\bibliography{} but target uses \\addbibresource{}, adapt accordingly
10. Output the COMPLETE .tex file content, not just the body

Output ONLY the complete LaTeX file content. No explanations, no markdown fences.`;
}

/**
 * applyTransfer node — LLM migrates source content into target template,
 * preserving target preamble and adapting content structure.
 */
export async function applyTransfer(state) {
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  const prompt = buildTransferPrompt(state);
  const response = await llm.invoke([{ role: 'user', content: prompt }]);
  const newContent = stripCodeFences(response.content);

  // Write the migrated content to the target main file
  await writeFileWithSnapshot(
    state.targetProjectRoot,
    state.targetMainFile,
    newContent,
    state.jobId
  );

  return {
    progressLog: `[applyTransfer] Wrote migrated content to ${state.targetMainFile} (${newContent.length} chars).`,
  };
}
