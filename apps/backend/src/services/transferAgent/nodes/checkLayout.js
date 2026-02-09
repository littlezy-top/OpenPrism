import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';

/**
 * Strip markdown code fences from LLM output.
 */
function stripCodeFences(text) {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

/**
 * checkLayout node — sends page screenshots to VLM
 * for layout quality assessment.
 */
export async function checkLayout(state) {
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);
  const images = state.pageImages || [];

  if (!images.length) {
    return {
      layoutCheckResult: { ok: true, issues: [] },
      layoutAttempt: (state.layoutAttempt || 0) + 1,
      progressLog: '[checkLayout] No page images provided, skipping layout check.',
    };
  }

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  const contentParts = [
    { type: 'text', text: buildLayoutPrompt() },
  ];

  // Add each page image
  for (const img of images) {
    contentParts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mime || 'image/png'};base64,${img.base64}` },
    });
  }

  const message = new HumanMessage({ content: contentParts });
  const response = await llm.invoke([message]);

  let result;
  try {
    result = JSON.parse(stripCodeFences(response.content));
  } catch {
    result = { ok: true, issues: [], raw: response.content };
  }

  const hasIssues = (result.issues || []).some(i => i.severity === 'high');

  return {
    layoutCheckResult: { ok: !hasIssues, ...result },
    layoutAttempt: (state.layoutAttempt || 0) + 1,
    progressLog: `[checkLayout] Found ${(result.issues || []).length} issues, ${hasIssues ? 'needs fix' : 'acceptable'}.`,
  };
}

function buildLayoutPrompt() {
  return `You are a LaTeX document layout reviewer.

Examine the PDF page screenshots and identify layout issues.

Return a JSON object:
{
  "summary": "brief overall assessment",
  "issues": [
    {
      "page": 1,
      "severity": "high|medium|low",
      "type": "overflow|overlap|spacing|alignment|missing_content",
      "description": "what is wrong",
      "suggestion": "how to fix in LaTeX"
    }
  ]
}

Focus on:
- Text overflow (content going beyond margins)
- Overlapping elements (figures/tables overlapping text)
- Missing content (blank pages, cut-off text)
- Severely broken formatting

Ignore minor aesthetic differences. Only flag issues that affect readability.
Output ONLY valid JSON.`;
}
