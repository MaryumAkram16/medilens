/**
 * Runs the voice agent scenarios and prints the report.
 *   npm run eval:voice
 */
import { formatResults, runScenario } from './runner.js';
import { SCENARIOS } from './scenarios.js';

const results = [];
for (const s of SCENARIOS) results.push(await runScenario(s));
console.log(formatResults(results));
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
