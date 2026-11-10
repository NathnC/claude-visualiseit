import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { GATE, command, gateFor, handleHook, isIncognito, lastReply, loadConfig, pagesDir, previousReply, prunePages, render } from '../scripts/lib.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'visualiseit.mjs');
const hookScript = path.join(path.dirname(cli), 'hook.mjs');

let home;
let env;
const SESSION = 'test-session';

const small = { title: 'Small', kind: 'flow', edges: [{ from: 'a', to: 'b' }] };
const toPath = (lines) => lines.find((line) => line.startsWith('path: ')).slice(6);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'visualiseit-test-'));
  env = { CLAUDE_CONFIG_DIR: home, VISUALISEIT_NO_OPEN: '1' };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const hook = (hook_event_name, extra = {}, environment = env) => handleHook({ hook_event_name, session_id: SESSION, ...extra }, environment);
const context = (result) => JSON.parse(result.stdout).hookSpecificOutput.additionalContext;

test('auto mode is off until asked for', () => {
  assert.equal(loadConfig(env).auto, false);
  assert.deepEqual(hook('SessionStart'), {});
  assert.deepEqual(hook('UserPromptSubmit', { prompt: 'hi' }), {});
});

test('on persists, and the hooks then add the check', () => {
  command('on', env);
  assert.equal(loadConfig(env).auto, true);
  assert.equal(context(hook('SessionStart', { source: 'startup' })), GATE);
  assert.equal(context(hook('SessionStart', { source: 'compact' })), GATE);
  assert.match(context(hook('UserPromptSubmit', { prompt: 'hi' })), /auto mode is on/);
  assert.equal(JSON.parse(hook('UserPromptSubmit', { prompt: 'hi' }).stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

test('off stops the hooks and says to stop checking', () => {
  command('on', env);
  const output = command('off', env).join('\n');
  assert.match(output, /stop applying/);
  assert.deepEqual(hook('SessionStart'), {});
});

test('the check names the skill the way a plugin skill has to be called', () => {
  // A bare "visualiseit" fails in the Skill tool, and Claude quietly falls back to drawing by hand.
  assert.match(GATE, /skill "visualiseit:visualiseit"/);
});

test('turning on prints the check, so it applies in the session it was turned on', () => {
  assert.ok(command('on', env).includes(GATE));
});

test('on and off keep other settings', () => {
  fs.mkdirSync(path.join(home, 'visualiseit'), { recursive: true });
  fs.writeFileSync(path.join(home, 'visualiseit', 'config.json'), JSON.stringify({ width: 100, mine: 'kept' }));
  command('on', env);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'visualiseit', 'config.json'), 'utf8'));
  assert.deepEqual(saved, { width: 100, mine: 'kept', auto: true });
});

test('medium is the default, and its check is the one the evals were tuned on', () => {
  assert.equal(loadConfig(env).level, 'medium');
  assert.equal(GATE, gateFor('medium'));
  assert.match(GATE, /^visualiseit auto mode is on\. /);
  assert.match(GATE, /3\+ components/);
  assert.match(GATE, /Most replies don't need one, and if in doubt, don't\./);
});

test('a level saves, turns auto mode on and prints its check', () => {
  for (const level of ['low', 'medium', 'high']) {
    command('off', env);
    const output = command(level, env);
    assert.equal(loadConfig(env).level, level);
    assert.equal(loadConfig(env).auto, true);
    assert.match(output[0], new RegExp(`Auto mode: on, ${level}`));
    assert.ok(output.includes(gateFor(level)));
  }
});

test('med is short for medium', () => {
  command('high', env);
  command('med', env);
  assert.equal(loadConfig(env).level, 'medium');
});

test('the hooks use the chosen level', () => {
  command('low', env);
  assert.equal(context(hook('SessionStart')), gateFor('low'));
  assert.match(context(hook('UserPromptSubmit', { prompt: 'hi' })), /Almost no replies/);
  command('high', env);
  assert.equal(context(hook('SessionStart')), gateFor('high'));
  assert.match(context(hook('UserPromptSubmit', { prompt: 'hi' })), /If in doubt, draw/);
});

test('off and on keep the level', () => {
  command('high', env);
  command('off', env);
  assert.deepEqual(hook('SessionStart'), {});
  assert.ok(command('on', env).includes(gateFor('high')));
});

test('every level names the skill properly and keeps the same exclusions', () => {
  for (const level of ['low', 'medium', 'high']) {
    assert.match(gateFor(level), /skill "visualiseit:visualiseit"/);
    assert.match(gateFor(level), /Don't draw one for: short answers/);
  }
});

test('scripted runs get no auto mode', () => {
  command('on', env);
  assert.deepEqual(hook('SessionStart', {}, { ...env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), {});
  assert.deepEqual(hook('UserPromptSubmit', { prompt: 'hi' }, { ...env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }), {});
  assert.notDeepEqual(hook('SessionStart', {}, { ...env, CLAUDE_CODE_ENTRYPOINT: 'cli' }), {});
});

test('the reminder stays out of /visualiseit itself', () => {
  command('on', env);
  for (const prompt of ['/visualiseit', '/visualiseit off', ' /visualiseit:visualiseit page']) {
    assert.deepEqual(hook('UserPromptSubmit', { prompt }), {});
  }
  assert.notDeepEqual(hook('UserPromptSubmit', { prompt: '/visualiseitfoo' }), {});
});

test('a broken config means defaults, not a crash', () => {
  fs.mkdirSync(path.join(home, 'visualiseit'), { recursive: true });
  for (const bad of ['{not json', '[]', 'null', '{"auto":"yes","level":"loud","surface":"nope","width":-1,"keepDays":"x"}']) {
    fs.writeFileSync(path.join(home, 'visualiseit', 'config.json'), bad);
    assert.deepEqual(loadConfig(env), { auto: false, level: 'medium', surface: 'auto', open: true, keepDays: 14, width: 78 });
  }
});

test('the hook script stays silent on bad input', () => {
  for (const input of ['', 'not json', '{}', '{"hook_event_name":"Other"}']) {
    const run = spawnSync(process.execPath, [hookScript], { input, env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, '');
  }
});

const assistant = (...blocks) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const said = (text) => assistant({ type: 'text', text });
const person = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const toolUse = assistant({ type: 'tool_use', id: '1', name: 'Bash', input: {} });
const toolResult = person([{ type: 'tool_result', tool_use_id: '1', content: 'output' }]);
const meta = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill' }] } });
const blob = JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'text', text: 'system stuff' }] } });

test('the previous reply is what came before the current prompt', () => {
  const lines = [person('first'), blob, said('old answer'), person('second'), said('the answer'), person('/visualiseit')];
  assert.equal(previousReply(lines), 'the answer');
});

test('it ignores what the /visualiseit turn itself has done so far', () => {
  const lines = [person('q'), said('the answer'), person('/visualiseit'), blob, assistant({ type: 'tool_use', id: '1', name: 'Skill', input: {} }), toolResult, meta, toolUse];
  assert.equal(previousReply(lines), 'the answer');
});

test('it keeps the final answer and drops narration from before the last tool call', () => {
  const lines = [person('q'), said('let me check'), toolUse, toolResult, said('part one'), said('part two'), person('/visualiseit')];
  assert.equal(previousReply(lines), 'part one\n\npart two');
});

test('it leaves out subagents, API errors and thinking', () => {
  const side = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } });
  const failed = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error' }] } });
  const thinking = assistant({ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'real' });
  assert.equal(previousReply([person('q'), thinking, side, failed, person('/visualiseit')]), 'real');
});

test('a local command between the reply and /visualiseit is skipped over', () => {
  const lines = [
    person('q'),
    said('the answer'),
    person('<command-name>/status</command-name>'),
    person('<local-command-stdout>ok</local-command-stdout>'),
    person('<command-name>/visualiseit</command-name>'),
  ];
  assert.equal(previousReply(lines), 'the answer');
});

test('with no earlier reply it returns null, and survives a half-written line', () => {
  assert.equal(previousReply([person('/visualiseit')]), null);
  assert.equal(previousReply([]), null);
  assert.equal(previousReply(['{broken', said('a'), person('/visualiseit'), '{"type":"ass']), 'a');
});

test('lastReply finds the session file, and refuses ids that could escape the folder', () => {
  const dir = path.join(home, 'projects', 'some-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), [person('q'), said('stored answer'), person('/visualiseit')].join('\n'));
  assert.equal(lastReply(env, SESSION), 'stored answer');
  assert.equal(lastReply(env, 'other-session'), null);
  fs.writeFileSync(path.join(home, 'secret.jsonl'), [person('q'), said('private'), person('x')].join('\n'));
  for (const bad of ['../../secret', '..\\..\\secret', '../secret', '', undefined, 'a/b', 'a b']) {
    assert.equal(lastReply(env, bad), null);
  }
});

test('lastReply caps a huge reply', () => {
  const dir = path.join(home, 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), [person('q'), said('x'.repeat(50000)), person('/visualiseit')].join('\n'));
  const reply = lastReply(env, SESSION);
  assert.ok(reply.length < 41000);
  assert.match(reply, /cut off/);
});

test('a small spec lands in the terminal, fenced and with no page written', async () => {
  const lines = await render(small, {}, env);
  assert.equal(lines[0], 'surface: terminal');
  assert.ok(lines.includes('```text'));
  assert.equal(lines[lines.length - 1], '```');
  assert.equal(fs.existsSync(pagesDir(env)), false);
});

test('a big spec lands on a page', async () => {
  const lines = await render({ title: 'Big', sections: [small, small, small] }, {}, env);
  assert.equal(lines[0], 'surface: page');
  const file = toPath(lines);
  assert.match(path.basename(file), /^vis-\d{8}-\d{6}-[0-9a-f]{8}\.html$/);
  assert.match(fs.readFileSync(file, 'utf8'), /<h1>Big<\/h1>/);
  assert.match(lines.join('\n'), /opened: no/);
});

test('forcing a surface wins over the size check', async () => {
  assert.equal((await render(small, { surface: 'page' }, env))[0], 'surface: page');
  const big = { title: 'B', kind: 'flow', edges: Array.from({ length: 12 }, (_, i) => ({ from: 'hub', to: `Destination number ${i}` })) };
  assert.equal((await render(big, {}, env))[0], 'surface: page');
  const forced = await render(big, { surface: 'terminal' }, env);
  assert.equal(forced[0], 'surface: terminal');
  assert.match(forced.join('\n'), /drawn as a list/);
});

test('custom html always needs a page', async () => {
  assert.equal((await render({ kind: 'html', html: '<b>x</b>' }, {}, env))[0], 'surface: page');
});

test('the page name comes from the clock, never the spec', async () => {
  const file = toPath(await render({ title: '../../../evil', kind: 'bars', items: [{ label: 'a', value: 1 }] }, { surface: 'page' }, env));
  assert.equal(path.dirname(file), pagesDir(env));
  assert.doesNotMatch(path.basename(file), /evil/);
});

test('an incognito session never writes a page', async () => {
  const dir = path.join(home, 'incognito', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.json`), '{}');
  assert.equal(isIncognito(env, SESSION), true);
  assert.equal(isIncognito(env, '../sessions/test-session'), false);
  const lines = await render({ title: 'Big', sections: [small, small, small, { kind: 'html', html: 'x' }] }, { surface: 'page', sessionId: SESSION }, env);
  assert.equal(lines[0], 'surface: terminal');
  assert.match(lines.join('\n'), /incognito/);
  assert.equal(fs.existsSync(pagesDir(env)), false);
});

test('masked secrets are reported and absent from the page', async () => {
  const spec = { title: 'x', kind: 'flow', edges: [{ from: 'a', to: 'b', label: `ghp_${'a'.repeat(36)}` }] };
  const lines = await render(spec, { surface: 'page' }, env);
  assert.match(lines.join('\n'), /masked 1/);
  assert.doesNotMatch(fs.readFileSync(toPath(lines), 'utf8'), /ghp_/);
});

test('pruning removes only old files with our own name format', () => {
  const dir = pagesDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const old = 'vis-20200101-000000-abcdef12.html';
  const fresh = 'vis-20200101-000000-abcdef13.html';
  const notOurs = 'report.html';
  for (const name of [old, fresh, notOurs]) fs.writeFileSync(path.join(dir, name), 'x');
  const longAgo = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(path.join(dir, old), longAgo, longAgo);
  fs.utimesSync(path.join(dir, notOurs), longAgo, longAgo);
  assert.equal(prunePages(env, 14), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), [fresh, notOurs].sort());
});

const runCli = (args, input = '') => spawnSync(process.execPath, [cli, ...args], { input, env: { ...process.env, ...env }, encoding: 'utf8' });

test('the command line reports bad specs with exit code 2', () => {
  for (const [input, message] of [['', /No spec/], ['{nope', /not valid JSON/], ['{"kind":"pie"}', /must be one of/], ['x'.repeat(600000), /limit is/]]) {
    const run = runCli(['render'], input);
    assert.equal(run.status, 2);
    assert.match(run.stderr, message);
    assert.doesNotMatch(run.stderr, /\n\s+at /); // an error Claude can act on, not a stack trace
  }
  assert.equal(runCli(['nonsense']).status, 2);
});

test('the command line handles a UTF-8 BOM, on, off and status', () => {
  const run = runCli(['render'], `﻿${JSON.stringify(small)}`);
  assert.equal(run.status, 0);
  assert.match(runCli(['status']).stdout, /Auto mode: off/);
  assert.match(runCli(['on']).stdout, /Auto mode: on/);
  assert.match(runCli(['status']).stdout, /Auto mode: on, medium/);
  assert.match(runCli(['high']).stdout, /Auto mode: on, high/);
  assert.match(runCli(['status']).stdout, /Auto mode: on, high/);
  assert.match(runCli(['off']).stdout, /Auto mode: off/);
  assert.match(runCli(['last', '--session', 'missing']).stdout, /No previous reply/);
});
