import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { invokeLLMForJSON } from '../utils.js';

/**
 * draftPlan node — LLM generates a structured transfer plan
 * mapping source sections to target template sections.
 */
export async function draftPlan(state) {
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  const prompt = `You are a LaTeX template migration planner.

Given a SOURCE paper outline and a TARGET template outline, produce a JSON migration plan.

SOURCE OUTLINE:
${JSON.stringify(state.sourceOutline, null, 2)}

TARGET OUTLINE:
${JSON.stringify(state.targetOutline, null, 2)}

SOURCE ASSETS:
${JSON.stringify(state.sourceAssets, null, 2)}

TARGET PREAMBLE (first 2000 chars):
${(state.targetPreamble || '').slice(0, 2000)}

Produce a JSON object with this structure:
{
  "sectionMapping": [
    { "sourceSection": "...", "targetSection": "...", "action": "map|merge|create|drop" }
  ],
  "assetStrategy": {
    "bibFiles": ["copy list"],
    "images": ["copy list"],
    "bibCommand": "bibliography|addbibresource"
  },
  "notes": "any special instructions for the migration"
}

Rules:
- Map each source section to the closest target section
- If target has no matching section, use action "create"
- If source section has no place in target, use action "drop" (rare)
- Preserve all citations, references, labels, and figure/table environments
- Keep the target preamble unchanged
- Output ONLY valid JSON, no markdown fences`;

  const planSchema = {
    sectionMapping: { type: 'array', required: true },
    assetStrategy:  { type: 'object', required: true },
    notes:          { type: 'string', required: false },
  };

  const { parsed, raw, retries } = await invokeLLMForJSON(
    llm,
    [{ role: 'user', content: prompt }],
    { schema: planSchema, maxRetries: 2, nodeName: 'draftPlan' },
  );

  const plan = parsed || { raw, parseError: true, sectionMapping: [], assetStrategy: {}, notes: '' };
  const retryNote = retries > 0 ? ` (after ${retries} retries)` : '';

  return {
    transferPlan: plan,
    progressLog: `[draftPlan] Generated migration plan with ${plan.sectionMapping?.length || 0} section mappings${retryNote}.`,
  };
}
