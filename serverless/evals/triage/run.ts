/**
 * Offline evaluation: the keyword fallback plus the emergency rule, with no AI
 * and no network. This is what triage does when Gemini is unavailable.
 *   npm run eval:triage
 */
import { readFileSync } from 'node:fs';
import { finalizeTriage } from '../../lib/complaints/triage.js';
import { formatReport, score, type Dataset } from './evaluate.js';

export const dataset = JSON.parse(readFileSync(new URL('./dataset.json', import.meta.url), 'utf8')) as Dataset;

export function offlineReport() {
  return score(
    dataset.cases,
    dataset.cases.map((c) => finalizeTriage(c.text, null)),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(formatReport(offlineReport(), 'Triage without AI (keyword rules + emergency rule)'));
}
