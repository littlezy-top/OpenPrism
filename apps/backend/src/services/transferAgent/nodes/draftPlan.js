import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';

/**
 * Strip markdown code fences from LLM output.
 */
function stripCodeFences(text) {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

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

  const response = await llm.invoke([{ role: 'user', content: prompt }]);
  const raw = response.content;

  let plan;
  try {
    plan = JSON.parse(stripCodeFences(raw));
  } catch {
    plan = { raw, parseError: true, sectionMapping: [], assetStrategy: {}, notes: '' };
  }

  return {
    transferPlan: plan,
    progressLog: `[draftPlan] Generated migration plan with ${plan.sectionMapping?.length || 0} section mappings.`,
  };
}
