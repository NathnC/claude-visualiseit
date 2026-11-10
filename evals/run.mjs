#!/usr/bin/env node
// Measures auto mode's judgement with real Claude runs: does it draw for the "draw" prompts and
// stay quiet for the "skip" prompts? This costs real tokens, so it isn't part of `node --test`.
//   node evals/run.mjs [--level medium] [--model sonnet] [--runs 1] [--jobs 4]
// A case can override what's expected at a level, for example "high": "draw". "either" isn't scored.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const level = option('--level', 'medium');
const model = option('--model', 'sonnet');
const runs = Number(option('--runs', 1));
const jobs = Number(option('--jobs', 4));

const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visualiseit-eval-'));
const workDir = path.join(stateDir, 'work');
fs.mkdirSync(workDir);
fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ auto: true, level }));

function runCase(prompt) {
  return new Promise((resolve) => {
    // Project-only settings keep the user's own plugins and CLAUDE.md out of the measurement.
    const args = ['-p', '--plugin-dir', root, '--model', model, '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local', '--strict-mcp-config', '--max-turns', '8', '--allowedTools', 'Skill(visualiseit:visualiseit)'];
    const line = ['claude', ...args.map((arg) => `"${arg}"`)].join(' ');
    const child = spawn(line, {
      cwd: workDir,
      shell: true, // claude is a .cmd shim on Windows. The arguments are this file's own.
      env: { ...process.env, VISUALISEIT_HOME: stateDir, VISUALISEIT_ALLOW_HEADLESS: '1', VISUALISEIT_NO_OPEN: '1' },
    });
    let out = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill(), 240000);
    child.on('close', () => {
      clearTimeout(timer);
      let asked = false; // called the skill or the script, even if that then failed
      let rendered = false; // the script really produced a diagram
      let cost = 0;
      let reply = '';
      let finished = false;
      for (const raw of out.split('\n')) {
        let entry;
        try { entry = JSON.parse(raw); } catch { continue; }
        if (entry.type === 'result') {
          finished = true;
          cost = entry.total_cost_usd || 0;
          reply = entry.result || '';
        }
        const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
        for (const block of blocks) {
          if (block.type === 'tool_use') {
            if (block.name === 'Skill' && /visualiseit/.test(block.input?.skill || '')) asked = true;
            if (/visualiseit\.mjs.*render/s.test(block.input?.command || '')) asked = true;
          }
          if (block.type === 'tool_result' && !block.is_error && /^surface: (?:terminal|page)/m.test(JSON.stringify(block.content ?? '').replace(/\\n/g, '\n').replace(/^"/, ''))) {
            rendered = true;
          }
        }
      }
      // Drawing means the diagram reached the reply: a fenced block, or the path to a page.
      const shown = rendered && (/```/.test(reply) || /vis-\d{8}-\d{6}-[0-9a-f]{8}\.html/.test(reply));
      const words = reply.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
      resolve({ asked, rendered, drew: shown, onPage: /vis-\d{8}-\d{6}-[0-9a-f]{8}\.html/.test(reply), words, finished, cost, reply });
    });
    child.stdin.end(prompt);
  });
}

const queue = [];
for (const [expected, list] of Object.entries(cases)) {
  for (const item of list) for (let i = 0; i < runs; i += 1) queue.push({ ...item, expected: item[level] ?? expected });
}

const results = [];
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    const result = await runCase(item.prompt);
    // Staying quiet means not even trying, so a failed attempt still counts against a skip case.
    const pass = item.expected === 'either' ? result.finished : result.finished && (item.expected === 'draw' ? result.drew : !result.asked);
    results.push({ ...item, ...result, pass });
    process.stdout.write(`${pass ? 'pass' : 'FAIL'}  ${item.expected}  ${item.id}  asked=${result.asked} rendered=${result.rendered} shown=${result.drew} finished=${result.finished}\n`);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));

const score = (expected) => {
  const list = results.filter((r) => r.expected === expected);
  return `${list.filter((r) => r.pass).length}/${list.length}`;
};
const cost = results.reduce((sum, r) => sum + r.cost, 0);
const drawn = results.filter((r) => r.drew);
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;
process.stdout.write(`\nLevel ${level}. Drew on ${results.filter((r) => r.drew).length} of ${results.length} prompts.\n`);
process.stdout.write(`Model ${model}. Drew when it should: ${score('draw')}. Stayed quiet when it should: ${score('skip')}. Cost $${cost.toFixed(2)}.\n`);
process.stdout.write(`Of ${drawn.length} drawn: ${drawn.filter((r) => r.onPage).length} on a page, ${drawn.filter((r) => !r.onPage).length} in the terminal, median ${median(drawn.map((r) => r.words))} words outside the diagram.\n`);
const outDir = path.join(here, 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${model}-${level}-${Date.now()}.json`), JSON.stringify(results, null, 2));
fs.rmSync(stateDir, { recursive: true, force: true });
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
