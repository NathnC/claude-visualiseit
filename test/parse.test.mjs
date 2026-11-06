import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseSpec } from '../scripts/parse.mjs';
import { SpecError, normalise } from '../scripts/spec.mjs';
import { renderText } from '../scripts/text.mjs';

const read = (text) => normalise(parseSpec(text));
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'visualiseit.mjs');

test('a flow with title, summary, nodes and every edge form', () => {
  const spec = read(`
title: The title
summary: The summary

flow: The heading
App -> Database | SQL
App --> Queue | async
Queue -> App
node: Database | Main DB | detail=primary | group=Data | tone=good
direction: right
note: The caption
`);
  assert.equal(spec.title, 'The title');
  assert.equal(spec.summary, 'The summary');
  const [flow] = spec.sections;
  assert.equal(flow.kind, 'flow');
  assert.equal(flow.heading, 'The heading');
  assert.equal(flow.note, 'The caption');
  assert.equal(flow.direction, 'right');
  assert.deepEqual(flow.edges[0], { from: 'App', to: 'Database', label: 'SQL', dashed: false });
  assert.equal(flow.edges[1].dashed, true);
  assert.deepEqual(flow.nodes.find((node) => node.id === 'Database'), { id: 'Database', label: 'Main DB', detail: 'primary', group: 'Data', tone: 'good' });
  assert.equal(flow.nodes.find((node) => node.id === 'Queue').label, 'Queue');
});

test('sequence, with dashed arrows as replies', () => {
  const [section] = read(`
sequence:
actors: Browser | API | DB
Browser -> API | POST /login
API --> Browser | token
`).sections;
  assert.deepEqual(section.actors, ['Browser', 'API', 'DB']);
  assert.deepEqual(section.messages[1], { from: 'API', to: 'Browser', label: 'token', reply: true });
});

test('compare, with best rows and tones on cells', () => {
  const [section] = read(`
compare: Options
columns: Cost | Speed
best: Queue | Low | Fast ~good
row: Cron | Low | Slow ~bad
`).sections;
  assert.deepEqual(section.columns, ['Cost', 'Speed']);
  assert.equal(section.rows[0].best, true);
  assert.equal(section.rows[1].best, false);
  assert.deepEqual(section.rows[0].cells[1], { text: 'Fast', tone: 'good' });
  assert.deepEqual(section.rows[1].cells[0], { text: 'Low' });
});

test('bars, with thousands separators, negatives and options', () => {
  const [section] = read(`
bars: Latency
unit: ms
bar: Before | 4,100 | tone=bad
bar: After | -90.5 | display=about 90
`).sections;
  assert.equal(section.unit, 'ms');
  assert.deepEqual(section.items[0], { label: 'Before', value: 4100, display: '', tone: 'bad' });
  assert.equal(section.items[1].value, -90.5);
  assert.equal(section.items[1].display, 'about 90');
});

test('timeline', () => {
  const [section] = read(`
timeline: Plan
at: Mon 9 | Deploy | detail=at 10:00 | tone=warn
at: Tue 10 | Review
`).sections;
  assert.deepEqual(section.items[0], { when: 'Mon 9', label: 'Deploy', detail: 'at 10:00', tone: 'warn' });
  assert.equal(section.items[1].label, 'Review');
});

test('tree nests by indent, and a colon in a label is just text', () => {
  const [section] = read(`
tree: Files
- src
  - app | detail=code | tone=good
    - Http: controllers
  - routes
`).sections;
  assert.equal(section.root.label, 'src');
  assert.equal(section.root.children.length, 2);
  assert.equal(section.root.children[0].detail, 'code');
  assert.equal(section.root.children[0].children[0].label, 'Http: controllers');
});

test('html keeps its lines, colons, blank lines and braces', () => {
  const [section, next] = read(`
html: Custom
<style>
rect { fill: red }

</style>
<svg></svg>
bars: After
bar: a | 1
`).sections;
  assert.match(section.html, /rect \{ fill: red \}\n\n<\/style>/);
  assert.equal(next.kind, 'bars');
});

test('a literal pipe can be escaped', () => {
  const [section] = read(`
flow:
A -> B | one \\| two
`).sections;
  assert.equal(section.edges[0].label, 'one | two');
});

test('labels with colons, apostrophes and arrows survive', () => {
  const [section] = read(`
flow: Who's first: A -> B?
User's browser -> API: v2 | GET /users/:id
`).sections;
  assert.equal(section.heading, "Who's first: A -> B?");
  assert.equal(section.edges[0].from, "User's browser");
  assert.equal(section.edges[0].to, 'API: v2');
  assert.equal(section.edges[0].label, 'GET /users/:id');
});

test('windows line endings parse the same', () => {
  const spec = read('title: T\r\nflow:\r\nA -> B | x\r\n');
  assert.equal(spec.title, 'T');
  assert.equal(spec.sections[0].edges[0].label, 'x');
});

test('mistakes name the line so Claude can fix them', () => {
  const cases = [
    ['hello', /line 1: expected "title:"/],
    ['title: x', /No sections/],
    ['flow:\nnot an edge', /line 2: expected an edge/],
    ['flow:', /non-empty/],
    ['sequence:\nA to B', /line 2: expected a message/],
    ['compare:\ncolumns: a\nsomething', /line 3: expected "columns:"/],
    ['bars:\nbar: x', /line 2: a bar needs a number/],
    ['bars:\nbar: x | lots', /a bar needs a number/],
    ['bars:\nnonsense', /line 2: expected "unit:"/],
    ['timeline:\nMonday', /line 2: expected "at:/],
    ['tree:', /tree section has no lines/],
    ['tree:\n- a\n- b', /line 3: a tree has one root/],
    ['timeline:\nat: a | tone=good | late', /comes after an option/],
    ['flow:\nnode: | x\nA -> B', /a node needs an id/],
  ];
  for (const [text, message] of cases) {
    assert.throws(() => read(text), (error) => error instanceof SpecError && message.test(error.message), text);
  }
});

test('secrets and terminal escapes are still caught, since parsed specs go through normalise', () => {
  const spec = read(`
title: password=hunter2hunter
flow:
A\u001b[2J -> B | ghp_${'a'.repeat(36)}
`);
  assert.equal(spec.masked, 2);
  assert.doesNotMatch(JSON.stringify(spec), /hunter2|ghp_|\\u001b/);
});

test('the command line takes the text format and still takes JSON', () => {
  const text = spawnSync(process.execPath, [cli, 'render', '--surface', 'terminal'], { input: 'title: T\nflow:\nAlpha -> Beta\n', encoding: 'utf8' });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /Alpha/);
  const json = spawnSync(process.execPath, [cli, 'render', '--surface', 'terminal'], { input: '{"kind":"flow","edges":[{"from":"Alpha","to":"Beta"}]}', encoding: 'utf8' });
  assert.equal(json.status, 0);
  assert.match(json.stdout, /Beta/);
});

test('the examples in the skill file all parse and draw', async () => {
  const fs = await import('node:fs');
  const skill = fs.readFileSync(path.join(path.dirname(cli), '..', 'skills', 'visualiseit', 'SKILL.md'), 'utf8');
  const heredoc = skill.match(/<<'VISUALISEIT'\n([\s\S]*?)\nVISUALISEIT/)[1];
  assert.ok(renderText(read(heredoc), 78));
  const reference = skill.match(/```text\n([\s\S]*?)```/)[1];
  const spec = read(reference);
  assert.deepEqual(spec.sections.map((section) => section.kind), ['flow', 'sequence', 'compare', 'bars', 'timeline', 'tree', 'html']);
  assert.ok(renderText(spec, 78, { force: true }));
});

test('the skill never needs braces next to quotes outside the html example', async () => {
  const fs = await import('node:fs');
  const skill = fs.readFileSync(path.join(path.dirname(cli), '..', 'skills', 'visualiseit', 'SKILL.md'), 'utf8');
  const heredoc = skill.match(/<<'VISUALISEIT'\n([\s\S]*?)\nVISUALISEIT/)[1];
  assert.doesNotMatch(heredoc, /[{}]/);
});
