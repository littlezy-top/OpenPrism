import { promises as fs } from 'fs';
import path from 'path';
import { ensureDir } from '../../utils/fsUtils.js';
import { safeJoin } from '../../utils/pathUtils.js';

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences (```json, ```latex, ```tex, etc.) from LLM output.
 */
export function stripCodeFences(text) {
  return text
    .replace(/^```(?:json|latex|tex)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/**
 * Extract the first JSON object or array from a string that may contain
 * surrounding prose. Handles cases where the LLM outputs explanatory text
 * before/after the JSON.
 */
export function extractJSON(text) {
  const cleaned = stripCodeFences(text);

  // Fast path: the whole string is valid JSON
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through */ }

  // Slow path: find the first { ... } or [ ... ] block
  const startObj = cleaned.indexOf('{');
  const startArr = cleaned.indexOf('[');
  const start = startObj === -1 ? startArr
    : startArr === -1 ? startObj
    : Math.min(startObj, startArr);

  if (start === -1) return null;

  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON object against a simple schema definition.
 *
 * Schema format:
 *   { fieldName: { type: 'string'|'array'|'object', required: true|false } }
 *
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
export function validateSchema(obj, schema) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['Value is not an object'] };
  }
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const val = obj[field];
    if (val === undefined || val === null) {
      if (rule.required) errors.push(`Missing required field "${field}"`);
      continue;
    }
    if (rule.type === 'array' && !Array.isArray(val)) {
      errors.push(`Field "${field}" should be an array`);
    } else if (rule.type === 'object' && (typeof val !== 'object' || Array.isArray(val))) {
      errors.push(`Field "${field}" should be an object`);
    } else if (rule.type === 'string' && typeof val !== 'string') {
      errors.push(`Field "${field}" should be a string`);
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}

// ---------------------------------------------------------------------------
// Retryable LLM JSON call
// ---------------------------------------------------------------------------

/**
 * Invoke an LLM and parse the response as JSON, with retry + schema validation.
 *
 * @param {object}   llm        - LangChain ChatOpenAI instance
 * @param {Array}    messages   - Messages to send
 * @param {object}   opts
 * @param {object}   [opts.schema]     - Schema to validate against (optional)
 * @param {number}   [opts.maxRetries] - Max retry attempts (default 2)
 * @param {string}   [opts.nodeName]   - Node name for logging
 * @returns {{ parsed: object|null, raw: string, retries: number }}
 */
export async function invokeLLMForJSON(llm, messages, opts = {}) {
  const { schema, maxRetries = 2, nodeName = 'unknown' } = opts;
  let lastRaw = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await llm.invoke(messages);
    lastRaw = typeof response.content === 'string' ? response.content : '';

    const parsed = extractJSON(lastRaw);
    if (parsed === null) {
      // JSON extraction failed — build a retry prompt
      if (attempt < maxRetries) {
        messages = [
          ...messages,
          { role: 'assistant', content: lastRaw },
          { role: 'user', content:
            'Your previous response could not be parsed as valid JSON. '
            + 'Please output ONLY a valid JSON object with no extra text.' },
        ];
        continue;
      }
      break;
    }

    // Schema validation (if provided)
    if (schema) {
      const { valid, errors } = validateSchema(parsed, schema);
      if (!valid && attempt < maxRetries) {
        messages = [
          ...messages,
          { role: 'assistant', content: lastRaw },
          { role: 'user', content:
            `The JSON was parsed but has schema issues: ${errors.join('; ')}. `
            + 'Please fix and output ONLY the corrected JSON object.' },
        ];
        continue;
      }
    }

    return { parsed, raw: lastRaw, retries: attempt };
  }

  return { parsed: null, raw: lastRaw, retries: maxRetries };
}

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
