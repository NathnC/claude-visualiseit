import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esc, renderPage, sanitiseHtml } from '../scripts/page.mjs';
import { SpecError, cleanText, maskSecrets, normalise } from '../scripts/spec.mjs';
import { displayWidth, renderText, wrap } from '../scripts/text.mjs';

const flow = (edges, nodes) => normalise({ title: 'T', kind: 'flow', edges, nodes });
const text = (spec, width = 78, options) => renderText(spec, width, options);

test('every line stays inside the width', () => {
  const spec = flow(
    [
      { from: 'a', to: 'b', label: 'first' },
      { from: 'a', to: 'c', label: 'second' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd', dashed: true },
      { from: 'd', to: 'a', label: 'again' },
      { from: 'a', to: 'd' },
    ],
    [{ id: 'a', label: 'A fairly long node label that has to wrap' }, { id: 'b', label: 'B', detail: 'with detail' }],
  );
  const { lines, degraded } = text(spec);
  assert.equal(degraded, false);
  for (const line of lines) assert.ok(displayWidth(line) <= 78, `too wide: ${line}`);
});

test('a flow draws every node and an arrow for every edge', () => {
  const { lines } = text(flow([{ from: 'Alpha', to: 'Beta' }, { from: 'Beta', to: 'Gamma' }, { from: 'Alpha', to: 'Gamma' }]));
  const joined = lines.join('\n');
  for (const name of ['Alpha', 'Beta', 'Gamma']) assert.match(joined, new RegExp(name));
  assert.equal(joined.match(/▼/g).length, 3);
});

test('a cycle points back up instead of looping forever', () => {
  const { lines } = text(flow([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]));
  assert.equal(lines.join('\n').match(/▲/g).length, 1);
  assert.equal(lines.join('\n').match(/▼/g).length, 1);
});

test('box sides line up, even with wide characters', () => {
  const { lines } = text(flow([{ from: 'a', to: 'b' }], [{ id: 'a', label: '日本語 🚀 box' }, { id: 'b', label: 'plain' }]));
  const row = lines.findIndex((line) => line.includes('日本語'));
  const widths = new Set([lines[row - 1], lines[row], lines[row + 1]].map(displayWidth));
  assert.equal(widths.size, 1);
  assert.match(lines[row - 1], /┌─+┐/);
  assert.match(lines[row], /│ .* │/);
});

test('edge labels are never cropped, even when they run past the boxes', () => {
  const label = 'a long label that runs well past the narrow boxes';
  const { lines } = text(flow([{ from: 'a', to: 'b', label }]));
  assert.ok(lines.join('\n').includes(label), lines.join('\n'));
});

test('every edge label appears in full, in the diagram or listed under it', () => {
  const spec = flow([
    { from: 'Client', to: 'Load balancer', label: 'HTTPS on port 443 via DNS' },
    { from: 'Load balancer', to: 'Node port', label: 'forwards to a node port' },
    { from: 'Load balancer', to: 'Other node', label: 'or forwards to another node' },
    { from: 'Node port', to: 'Ingress', label: 'kube-proxy rules route it' },
    { from: 'Other node', to: 'Ingress', label: 'kube-proxy rules here too' },
    { from: 'Ingress', to: 'Pod', label: 'host and path matched' },
  ]);
  const joined = text(spec).lines.join('\n');
  for (const edge of spec.sections[0].edges) assert.ok(joined.includes(edge.label), `${edge.label} missing from:\n${joined}`);
});

test('a heavily crossed flow goes to a page unless the terminal was demanded', () => {
  const tops = ['a', 'b', 'c', 'd'];
  const bottoms = ['w', 'x', 'y', 'z'];
  const edges = tops.flatMap((from) => bottoms.map((to) => ({ from, to })));
  const spec = flow(edges);
  assert.equal(text(spec), null);
  const forced = text(spec, 78, { force: true });
  assert.equal(forced.degraded, false);
  assert.match(forced.lines.join('\n'), /┼/);
});

test('a self-loop is listed under the diagram', () => {
  const { lines } = text(flow([{ from: 'a', to: 'a', label: 'retry' }, { from: 'a', to: 'b' }]));
  assert.match(lines.join('\n'), /a → a: retry/);
});

test('a flow too wide for the terminal gives up, then becomes a list when forced', () => {
  const edges = Array.from({ length: 12 }, (_, i) => ({ from: 'hub', to: `Destination number ${i}` }));
  const spec = flow(edges);
  assert.equal(text(spec), null);
  const forced = text(spec, 78, { force: true });
  assert.equal(forced.degraded, true);
  assert.match(forced.lines.join('\n'), /hub ──► Destination number 11/);
});

test('sequence diagrams keep arrows on the lifelines', () => {
  const spec = normalise({
    kind: 'sequence',
    messages: [
      { from: 'Browser', to: 'API', label: 'POST /login' },
      { from: 'API', to: 'API', label: 'check' },
      { from: 'API', to: 'Browser', label: 'token', reply: true },
    ],
  });
  const joined = text(spec).lines.join('\n');
  assert.match(joined, /├─+►/);
  assert.match(joined, /◄┄+┤/);
  assert.match(joined, /check/);
});

test('compare wraps cells to fit and marks the best row', () => {
  const spec = normalise({
    kind: 'compare',
    columns: ['Cost', 'Notes'],
    rows: [{ label: 'A', best: true, cells: ['Low', 'word '.repeat(40)] }, { label: 'B', cells: [{ text: 'High', tone: 'bad' }, 'short'] }],
  });
  const { lines } = text(spec);
  const widths = new Set(lines.filter((line) => /^[┌│├└]/.test(line)).map(displayWidth));
  assert.equal(widths.size, 1);
  assert.ok([...widths][0] <= 78);
  assert.match(lines.join('\n'), /★ A/);
  assert.match(lines.join('\n'), /✗ High/);
});

test('bars scale to the largest value, and handle zero and negatives', () => {
  const spec = normalise({ kind: 'bars', unit: 'ms', items: [{ label: 'big', value: 100 }, { label: 'half', value: 50 }, { label: 'none', value: 0 }, { label: 'neg', value: -100 }] });
  const { lines } = text(spec, 60);
  const bar = (name) => (lines.find((line) => line.startsWith(name)).match(/█/g) || []).length;
  assert.ok(bar('big') > 0);
  assert.ok(Math.abs(bar('half') - bar('big') / 2) <= 1);
  assert.equal(bar('none'), 0);
  assert.equal(bar('neg'), bar('big'));
  assert.match(lines.join('\n'), /-100 ms/);
});

test('all-zero bars do not divide by zero', () => {
  const page = renderPage(normalise({ kind: 'bars', items: [{ label: 'a', value: 0 }] }));
  assert.doesNotMatch(page, /NaN|Infinity/);
  assert.doesNotMatch(text(normalise({ kind: 'bars', items: [{ label: 'a', value: 0 }] })).lines.join(''), /NaN/);
});

test('page bars stay in true proportion and a zero has no bar', () => {
  const page = renderPage(normalise({ kind: 'bars', items: [{ label: 'a', value: 4100 }, { label: 'b', value: 2340 }, { label: 'c', value: 0 }] }));
  const shares = [...page.matchAll(/\)\*([\d.]+)\)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(shares, [1, 0.5707]);
  assert.doesNotMatch(page, /max-width:calc/);
});

test('timeline and tree draw every entry', () => {
  const spec = normalise({
    sections: [
      { kind: 'timeline', items: [{ when: 'Mon', label: 'One', detail: 'more' }, { when: 'Tue', label: 'Two', tone: 'good' }] },
      { kind: 'tree', root: { label: 'root', children: [{ label: 'kid', children: ['grandkid'] }, 'other'] } },
    ],
  });
  const joined = text(spec).lines.join('\n');
  for (const word of ['Mon', 'One', 'more', '✓ Two', 'root', '├─ kid', '│  └─ grandkid', '└─ other']) assert.ok(joined.includes(word), word);
});

test('wrap breaks an over-long word rather than overflowing', () => {
  for (const line of wrap('a'.repeat(50), 10)) assert.ok(displayWidth(line) <= 10);
});

test('specs with mistakes get an error Claude can act on', () => {
  assert.throws(() => normalise(null), SpecError);
  assert.throws(() => normalise({ kind: 'pie' }), /must be one of/);
  assert.throws(() => normalise({ kind: 'flow', edges: [] }), /non-empty/);
  assert.throws(() => normalise({ kind: 'flow', edges: [{ from: 'a' }] }), /"from" and "to"/);
  assert.throws(() => normalise({ kind: 'bars', items: [{ label: 'x', value: 'many' }] }), /numeric/);
  assert.throws(() => normalise({ kind: 'compare', columns: ['a'], rows: [{ label: 'r', cells: ['1', '2'] }] }), /2 cells for 1 columns/);
  assert.throws(() => normalise({ sections: Array(9).fill({ kind: 'html', html: 'x' }) }), /limit is 8/);
  assert.throws(() => normalise({ kind: 'bars', items: Array(61).fill({ label: 'x', value: 1 }) }), /limit is 60/);
});

test('terminal escapes and bidi overrides are stripped from labels', () => {
  assert.equal(cleanText('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(cleanText('\u001b]0;title\u0007x'), 'x');
  assert.equal(cleanText('a‮b\u0007c'), 'abc');
  assert.equal(cleanText('close ``` fence'), "close ''' fence");
  const spec = normalise({ title: '\u001b[2Jwiped', kind: 'flow', edges: [{ from: 'a\u001b[1A', to: 'b' }] });
  assert.doesNotMatch(text(spec).lines.join('\n'), /\u001b/);
});

test('secrets are masked everywhere in a spec, keeping the words around them', () => {
  const samples = [
    'AKIAIOSFODNN7EXAMPLE',
    `ghp_${'a'.repeat(36)}`,
    `github_pat_${'b'.repeat(30)}`,
    `sk-ant-${'c'.repeat(30)}`,
    `sk_live_${'d'.repeat(24)}`,
    `xoxb-${'1'.repeat(20)}`,
    `AIza${'e'.repeat(35)}`,
    ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0In0', 'abcdefghijkl'].join('.'), // a fake, split so secret scanners don't flag it
  ];
  for (const sample of samples) {
    const { text: masked, count } = maskSecrets(`before ${sample} after`);
    assert.equal(count, 1, sample);
    assert.equal(masked, 'before [masked] after');
  }
  assert.equal(maskSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').text, 'Authorization: Bearer [masked]');
  assert.equal(maskSecrets('postgres://admin:hunter2@db:5432/app').text, 'postgres://admin:[masked]@db:5432/app');
  assert.equal(maskSecrets('password=hunter2hunter').text, 'password=[masked]');
  assert.equal(maskSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----').text, '[masked private key]');
  assert.equal(maskSecrets('a normal token bucket with 6 words').count, 0);

  const spec = normalise({ title: 'password: hunter2hunter', kind: 'flow', edges: [{ from: `ghp_${'a'.repeat(36)}`, to: 'b', label: `sk-${'x'.repeat(30)}` }] });
  assert.equal(spec.masked, 3);
  assert.doesNotMatch(JSON.stringify(spec), /hunter2|ghp_|sk-x/);
});

test('html sections are masked too', () => {
  const spec = normalise({ kind: 'html', html: `<p>sk-${'x'.repeat(30)}</p>` });
  assert.equal(spec.masked, 1);
  assert.doesNotMatch(spec.sections[0].html, /sk-x/);
});

test('every kind of label is escaped on the page', () => {
  const attack = '<script>alert(1)</script>"\'&';
  const spec = normalise({
    title: attack,
    summary: attack,
    sections: [
      { kind: 'flow', heading: attack, note: attack, nodes: [{ id: 'a', label: attack, detail: attack, group: attack }, { id: 'b', group: 'other' }], edges: [{ from: 'a', to: 'b', label: attack }, { from: 'a', to: 'a', label: attack }] },
      { kind: 'sequence', heading: attack, actors: [attack], messages: [{ from: attack, to: 'x', label: attack }, { from: 'x', to: 'x', label: attack }] },
      { kind: 'compare', columns: [attack], rows: [{ label: attack, cells: [{ text: attack, tone: attack }] }] },
      { kind: 'bars', unit: attack, items: [{ label: attack, value: 1, display: attack, tone: attack }] },
      { kind: 'timeline', items: [{ when: attack, label: attack, detail: attack, tone: attack }] },
      { kind: 'tree', root: { label: attack, detail: attack, tone: attack, children: [attack] } },
    ],
  });
  const page = renderPage(spec);
  assert.doesNotMatch(page, /<script/i);
  assert.match(page, /&lt;script&gt;/);
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('the CSP comes before anything the body can influence, and allows no scripts', () => {
  const page = renderPage(normalise({ title: 'x', kind: 'bars', items: [{ label: 'a', value: 1 }] }));
  const head = page.slice(page.indexOf('<head>'));
  assert.match(head, /^<head>\s*<meta charset="utf-8">\s*<meta http-equiv="Content-Security-Policy"/);
  assert.match(page, /default-src 'none'/);
  assert.match(page, /base-uri 'none'/);
  assert.match(page, /form-action 'none'/);
  assert.doesNotMatch(page, /script-src|<script|https?:\/\//i);
});

test('custom HTML loses anything active', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<SCRIPT SRC=//evil>',
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<img src=x onerror=alert(1)>',
    '<img/src=x/onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<svg><animate attributeName=href values=javascript:alert(1)>',
    '<svg><set attributeName=onmouseover to=alert(1)>',
    '<iframe srcdoc="<script>x</script>"></iframe>',
    '<meta http-equiv=refresh content="0;url=https://evil.test/">',
    '<meta/http-equiv=refresh content="0;url=https://evil.test/">',
    '<base href="https://evil.test/">',
    '<link rel=stylesheet href="https://evil.test/x.css">',
    '<object data="https://evil.test/x"></object>',
    '<embed src="https://evil.test/x">',
    '<form action="https://evil.test/"><button>go</button></form>',
    '<a href="https://evil.test/?secret=1">x</a>',
    "<a href='https://evil.test/'>x</a>",
    '<a href=https://evil.test/>x</a>',
    '<img src="https://evil.test/x.png">',
    '<image href="https://evil.test/x.png"/>',
    '<video src="https://evil.test/x" autoplay></video>',
    '<div style="background:url(https://evil.test/x)">x</div>',
    '<style>@import url(https://evil.test/x.css)</style>',
    '<style>body{background:url(https://evil.test/x)}</style>',
    '<style>body{background:\\75rl(https://evil.test/x)}</style>',
    '<!--><script>alert(1)</script>-->',
    '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
  ];
  for (const attack of attacks) {
    const out = sanitiseHtml(attack);
    assert.doesNotMatch(out, /<script|<iframe|<meta|<base|<link|<object|<embed|<form|<video|\son\w+\s*=|javascript:|evil\.test|@import|<animate|<set/i, `${attack} became ${out}`);
  }
});

test('custom HTML keeps harmless drawing content', () => {
  const svg = '<svg viewBox="0 0 10 10"><rect width="5" height="5" style="fill:red"/><text x="1" y="2">ok</text><use href="#a"/></svg>';
  assert.equal(sanitiseHtml(svg), svg);
  const image = '<img src="data:image/png;base64,AAAA">';
  assert.equal(sanitiseHtml(image), image);
});
