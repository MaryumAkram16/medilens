/**
 * Live evaluation: every case through Gemini plus the safety rules, exactly as
 * POST /api/complaints triages. Needs GEMINI_API_KEY; refuses to run without
 * it, so a score never comes from a stub. Paced for the free tier.
 *   GEMINI_API_KEY=... npm run eval:triage:live
 * Prints Markdown and writes reports/triage-live-YYYY-MM-DD.md (git-ignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_GEMINI_MODEL, geminiClassifier } from '../../lib/complaints/gemini.js';
import { finalizeTriage, type TriageResult } from '../../lib/complaints/triage.js';
import { formatReport, score } from './evaluate.js';
import { dataset } from './run.js';

const apiKey = (process.env.GEMINI_API_KEY || '').trim();
if (!apiKey) {
  console.error('GEMINI_API_KEY is not set: the live evaluation needs the real model, so it will not run.');
  process.exit(2);
}
const model = (process.env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL;
const gapMs = Number(process.env.EVAL_GAP_MS || 4500); // stays under free-tier requests per minute

const failures: string[] = [];
const classify = geminiClassifier({ apiKey, model, timeoutMs: 30_000, onFailure: (r) => failures.push(r) });

const results: TriageResult[] = [];
for (const c of dataset.cases) {
  results.push(finalizeTriage(c.text, await classify(c.text)));
  console.error(`[live] ${c.id} done`);
  await new Promise((r) => setTimeout(r, gapMs));
}

const date = new Date().toISOString().slice(0, 10);
const report = score(dataset.cases, results);
const markdown = [
  formatReport(report, `Live triage — ${date} — ${model}`),
  '',
  failures.length ? `AI calls that failed and fell back to keyword rules: ${failures.length} (${[...new Set(failures)].join(', ')})` : 'AI calls that failed: 0',
].join('\n');
console.log(markdown);
mkdirSync('reports', { recursive: true });
writeFileSync(
  `reports/triage-live-${date}.md`,
  `${markdown}\n\n<details><summary>Per-case results</summary>\n\n\`\`\`json\n${JSON.stringify(
    dataset.cases.map((c, i) => ({ id: c.id, expected: [c.expected_priority, c.expected_department], got: results[i] })),
    null,
    2,
  )}\n\`\`\`\n</details>\n`,
);
