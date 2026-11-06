// Page rendering: one self-contained HTML file with no scripts and nothing fetched from the
// network. The Content-Security-Policy is the main safety net, and it comes first in <head> so
// nothing in the body can get ahead of it. sanitiseHtml is the second layer, and it also catches
// what CSP doesn't cover (a meta refresh can still navigate).
import { layoutGraph } from './layout.mjs';
import { barValue, displayWidth, wrap } from './text.mjs';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const REMOVE_WITH_CONTENT = 'script|iframe|frame|frameset|object|embed|applet|noscript|template|audio|video|portal|noembed|noframes|plaintext|xmp';
const REMOVE_TAG = 'meta|base|link|form|input|button|textarea|select|option|source|track|set|animate|animatemotion|animatetransform|html|head|body|title';
const URL_ATTRS = 'href|xlink:href|src|srcset|srcdoc|action|formaction|ping|background|poster|data|cite|longdesc|lowsrc|usemap|manifest';

/** Strips active content from custom HTML, repeating until a pass changes nothing. */
export function sanitiseHtml(html) {
  let out = String(html).replace(/\u0000/g, '');
  let previous;
  do {
    previous = out;
    out = out
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '')
      .replace(/<\?[\s\S]*?(?:\?>|$)/g, '')
      .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, (block) => (/url\s*\(|@import|\\/i.test(block) ? '' : block))
      .replace(new RegExp(`<(${REMOVE_WITH_CONTENT})\\b[^>]*>[\\s\\S]*?(?:</\\1\\s*>|$)`, 'gi'), '')
      .replace(new RegExp(`</?(?:${REMOVE_WITH_CONTENT}|${REMOVE_TAG})\\b[^>]*>?`, 'gi'), '')
      .replace(/(<[^>]*?)[\s/]on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '$1')
      .replace(new RegExp(`(<[^>]*?[\\s/])(?:${URL_ATTRS})\\s*=\\s*(?:"(?!#|data:image/(?:png|jpeg|gif|webp)[;,])[^"]*"|'(?!#|data:image/(?:png|jpeg|gif|webp)[;,])[^']*'|(?!["'#]|data:image/(?:png|jpeg|gif|webp)[;,])[^\\s>]*)`, 'gi'), '$1')
      .replace(/(<[^>]*?)\sstyle\s*=\s*(?:"[^"]*(?:url\(|expression\(|@import)[^"]*"|'[^']*(?:url\(|expression\(|@import)[^']*')/gi, '$1');
  } while (out !== previous);
  return out;
}

const NODE_CHARS = 24;
const CHAR_PX = 7.6; // a little over the average for the system sans at 14px, so text never spills
const LINE_PX = 19;
const textWidth = (text) => displayWidth(text) * CHAR_PX;

const groupClass = (groups, node) => {
  if (node.tone) return `t-${node.tone}`;
  const index = groups.indexOf(node.group);
  return index >= 0 ? `g${index % 6}` : 'g-none';
};

/** Cubic segments forming the edge in layout coordinates, in the edge's real direction. */
function chainCurves(chain) {
  const curves = [];
  chain.segments.forEach((segment, i) => {
    const y1 = segment.from.bottom;
    const y2 = segment.to.top;
    const bend = (y2 - y1) * 0.5;
    curves.push([[segment.x1, y1], [segment.x1, y1 + bend], [segment.x2, y2 - bend], [segment.x2, y2]]);
    if (segment.to.dummy && i < chain.segments.length - 1) {
      const x = segment.x2;
      curves.push([[x, segment.to.top], [x, segment.to.top], [x, segment.to.bottom], [x, segment.to.bottom]]);
    }
  });
  if (!chain.reversed) return curves;
  return curves.reverse().map((curve) => [...curve].reverse());
}

const pointOn = ([a, b, c, d], t) => {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * d[k]);
};

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function flowSvg(section) {
  const horizontal = section.direction === 'right';
  const groups = [...new Set(section.nodes.map((node) => node.group).filter(Boolean))];
  const content = new Map(section.nodes.map((node) => {
    const label = wrap(node.label, NODE_CHARS);
    const detail = node.detail ? wrap(node.detail, NODE_CHARS + 6) : [];
    const w = Math.max(96, ...label.map(textWidth), ...detail.map((line) => textWidth(line) * 0.88)) + 28;
    const h = (label.length + detail.length) * LINE_PX + 22;
    return [node.id, { label, detail, w, h }];
  }));

  const graph = layoutGraph(section.nodes, section.edges, {
    sizeOf: (node) => {
      const { w, h } = content.get(node.id);
      return horizontal ? { w: h, h: w } : { w, h };
    },
    gapX: horizontal ? 30 : 44,
    dummyWidth: 18,
    inset: horizontal ? 8 : 14,
  });

  const labelled = (r) => graph.segments.some((s) => s.from.rank === r && s.chain.edge.label);
  let y = 0;
  graph.ranks.forEach((rank, r) => {
    const height = Math.max(0, ...rank.map((v) => v.h));
    const middle = y + height / 2;
    for (const v of rank) {
      v.top = v.dummy ? y : middle - v.h / 2;
      v.bottom = v.dummy ? y + height : middle + v.h / 2;
    }
    y += height + (labelled(r) ? (horizontal ? 130 : 76) : 52);
  });
  const longSide = y;
  const shortSide = graph.width;

  // The layout always runs top to bottom. For a sideways diagram, swap the axes when drawing.
  const P = horizontal ? ([a, b]) => [b, a] : (point) => point;
  const boxes = graph.ranks.flat().filter((v) => !v.dummy).map((v) => {
    const [cx, cy] = P([v.x, (v.top + v.bottom) / 2]);
    const { w, h, label, detail } = content.get(v.id);
    return { node: v.node, label, detail, x: cx - w / 2, y: cy - h / 2, w, h };
  });

  const placed = [...boxes];
  const paths = [];
  const pills = [];
  for (const chain of graph.chains) {
    const curves = chainCurves(chain).map((curve) => curve.map(P));
    const d = `M${curves[0][0].map(n).join(' ')}${curves.map((c) => `C${c.slice(1).map((p) => p.map(n).join(' ')).join(' ')}`).join('')}`;
    paths.push(`<path class="edge${chain.edge.dashed ? ' dashed' : ''}${chain.reversed ? ' back' : ''}" d="${d}" marker-end="url(#arrow)"/>`);
    if (!chain.edge.label) continue;
    const lines = wrap(chain.edge.label, 26);
    const w = Math.max(...lines.map((line) => textWidth(line) * 0.86)) + 14;
    const h = lines.length * 15 + 6;
    const real = curves.filter((c) => Math.hypot(c[0][0] - c[3][0], c[0][1] - c[3][1]) > 1);
    const spots = real.flatMap((curve) => [0.5, 0.32, 0.68, 0.18, 0.82].map((t) => pointOn(curve, t)));
    const rectAt = ([px, py]) => ({ x: px - w / 2, y: py - h / 2, w, h });
    let rect = spots.map(rectAt).find((candidate) => !placed.some((other) => overlaps(candidate, other)));
    if (!rect) {
      // Everything on the line is taken, so slide sideways off it rather than cover a label.
      rect = rectAt(spots[0] || curves[0][0]);
      for (let shift = 1; shift < 12 && placed.some((other) => overlaps(rect, other)); shift += 1) {
        rect = { ...rect, x: rect.x + (shift % 2 ? shift : -shift) * (horizontal ? 8 : 22) };
      }
    }
    placed.push(rect);
    pills.push({ rect, lines });
  }

  const allBoxes = [...boxes, ...pills.map((p) => p.rect)];
  const pad = 14;
  const minX = Math.min(0, ...allBoxes.map((b) => b.x));
  const minY = Math.min(0, ...allBoxes.map((b) => b.y));
  const maxX = Math.max(horizontal ? longSide : shortSide, ...allBoxes.map((b) => b.x + b.w));
  const maxY = Math.max(0, ...allBoxes.map((b) => b.y + b.h));
  const width = Math.ceil(maxX - minX + pad * 2);
  const height = Math.ceil(maxY - minY + pad * 2);

  const boxSvg = boxes.map((box) => {
    const lines = [
      ...box.label.map((line) => `<tspan x="${n(box.x + box.w / 2)}" dy="${LINE_PX}">${esc(line)}</tspan>`),
      ...box.detail.map((line) => `<tspan class="detail" x="${n(box.x + box.w / 2)}" dy="${LINE_PX}">${esc(line)}</tspan>`),
    ].join('');
    return `<g class="node ${groupClass(groups, box.node)}"><rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" rx="9"/><text y="${n(box.y + 8)}">${lines}</text></g>`;
  }).join('');

  const pillSvg = pills.map(({ rect, lines }) => {
    const spans = lines.map((line, i) => `<tspan x="${n(rect.x + rect.w / 2)}" y="${n(rect.y + 15 + i * 15)}">${esc(line)}</tspan>`).join('');
    return `<g class="pill"><rect x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.w)}" height="${n(rect.h)}" rx="5"/><text>${spans}</text></g>`;
  }).join('');

  const svg = `<svg class="diagram" role="img" aria-label="${esc(section.heading || 'Flow diagram')}" style="min-width:${Math.round(width * 0.7)}px" width="${width}" height="${height}" viewBox="${n(minX - pad)} ${n(minY - pad)} ${width} ${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0L10 5L0 10z"/></marker></defs>${paths.join('')}${boxSvg}${pillSvg}</svg>`;

  const legend = groups.length > 1
    ? `<ul class="legend">${groups.map((group, i) => `<li class="g${i % 6}"><span></span>${esc(group)}</li>`).join('')}</ul>`
    : '';
  const names = new Map(section.nodes.map((node) => [node.id, node.label]));
  const loops = graph.selfLoops.length
    ? `<ul class="loops">${graph.selfLoops.map((edge) => `<li>${esc(names.get(edge.from))} loops back to itself${edge.label ? `: ${esc(edge.label)}` : ''}</li>`).join('')}</ul>`
    : '';
  return `<div class="scroll">${svg}</div>${legend}${loops}`;
}

const n = (value) => Math.round(value * 10) / 10;

function sequenceSvg(section) {
  const { actors, messages } = section;
  const index = new Map(actors.map((name, i) => [name, i]));
  const labels = messages.map((m) => wrap(m.label || ' ', 40));
  const headW = actors.map((name) => Math.max(84, textWidth(name) + 26));
  const gaps = actors.slice(0, -1).map((_, i) => (headW[i] + headW[i + 1]) / 2 + 26);
  messages.forEach((m, i) => {
    const a = index.get(m.from);
    const b = index.get(m.to);
    const need = Math.max(...labels[i].map(textWidth)) + 24;
    if (a === b) {
      if (a < gaps.length) gaps[a] = Math.max(gaps[a], need + 46);
      return;
    }
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const have = gaps.slice(low, high).reduce((sum, gap) => sum + gap, 0);
    if (have < need) gaps[low] += need - have;
  });

  const xs = [headW[0] / 2 + 8];
  gaps.forEach((gap) => xs.push(xs[xs.length - 1] + gap));
  const headH = 38;
  let y = headH + 26;
  const parts = [];
  messages.forEach((m, i) => {
    const a = xs[index.get(m.from)];
    const b = xs[index.get(m.to)];
    const lineCount = labels[i].length;
    const klass = `edge${m.reply ? ' dashed' : ''}`;
    if (a === b) {
      const text = labels[i].map((line, l) => `<tspan x="${n(a + 46)}" y="${n(y + 12 + l * 17)}">${esc(line)}</tspan>`).join('');
      parts.push(`<path class="${klass}" d="M${n(a)} ${n(y)}h34v26h-32" marker-end="url(#seq-arrow)"/><text class="msg start">${text}</text>`);
      y += Math.max(44, lineCount * 17 + 16) + 12;
    } else {
      const mid = (a + b) / 2;
      const text = labels[i].map((line, l) => `<tspan x="${n(mid)}" y="${n(y + l * 17)}">${esc(line)}</tspan>`).join('');
      y += (lineCount - 1) * 17;
      const lineY = y + 9;
      const tip = b > a ? b - 2 : b + 2;
      parts.push(`<text class="msg">${text}</text><path class="${klass}" d="M${n(a)} ${n(lineY)}L${n(tip)} ${n(lineY)}" marker-end="url(#seq-arrow)"/>`);
      y += 46;
    }
  });
  const bottom = y;
  const lifelines = xs.map((x) => `<path class="lifeline" d="M${n(x)} ${headH}V${n(bottom)}"/>`).join('');
  const heads = actors.map((name, i) => `<g class="node g-none"><rect x="${n(xs[i] - headW[i] / 2)}" y="0" width="${n(headW[i])}" height="${headH}" rx="8"/><text x="${n(xs[i])}" y="24" class="head">${esc(name)}</text></g>`).join('');
  const selfRoom = Math.max(0, ...messages.map((m, i) => (m.from === m.to ? Math.max(...labels[i].map(textWidth)) + 58 : 0)));
  const width = Math.ceil(Math.max(xs[xs.length - 1] + headW[headW.length - 1] / 2 + 8, xs[xs.length - 1] + selfRoom));
  return `<div class="scroll"><svg class="diagram" role="img" aria-label="${esc(section.heading || 'Sequence diagram')}" style="min-width:${Math.round(width * 0.7)}px" width="${width}" height="${Math.ceil(bottom + 4)}" viewBox="0 0 ${width} ${Math.ceil(bottom + 4)}"><defs><marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="arrowhead" d="M0 0L10 5L0 10z"/></marker></defs>${lifelines}${heads}${parts.join('')}</svg></div>`;
}

const toneDot = (tone) => (['good', 'bad', 'warn', 'info'].includes(tone) ? `<i class="dot t-${tone}" aria-label="${tone}"></i>` : '');

function compareHtml(section) {
  const head = `<tr><th></th>${section.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr>`;
  const rows = section.rows.map((row) => `<tr${row.best ? ' class="best"' : ''}><th scope="row">${esc(row.label)}${row.best ? '<span class="badge">Best fit</span>' : ''}</th>${row.cells.map((cell) => `<td>${toneDot(cell.tone)}${esc(cell.text)}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function barsHtml(section) {
  const top = Math.max(...section.items.map((item) => Math.abs(item.value))) || 1;
  // Bars share the room left after the longest value, so their lengths stay in true proportion
  // at any width.
  const reserve = Math.max(...section.items.map((item) => displayWidth(barValue(item, section.unit)))) + 3;
  const rows = section.items.map((item) => {
    const share = Math.abs(item.value) / top;
    const klass = item.tone ? ` t-${item.tone}` : '';
    const fill = item.value === 0 ? '' : `<div class="bar-fill${klass}" style="width:calc((100% - ${reserve}ch)*${share.toFixed(4)})"></div>`;
    return `<div class="bar-row"><div class="bar-label">${esc(item.label)}</div><div class="bar-track">${fill}<div class="bar-value">${esc(barValue(item, section.unit))}</div></div></div>`;
  }).join('');
  return `<div class="bars">${rows}</div>`;
}

function timelineHtml(section) {
  const items = section.items.map((item) => `<li class="${item.tone ? `t-${item.tone}` : ''}"><div class="when">${esc(item.when)}</div><div class="what"><strong>${esc(item.label)}</strong>${item.detail ? `<p>${esc(item.detail)}</p>` : ''}</div></li>`).join('');
  return `<ol class="timeline">${items}</ol>`;
}

function treeHtml(section) {
  const walk = (node) => `<li><span class="leaf${node.tone ? ` t-${node.tone}` : ''}">${esc(node.label)}${node.detail ? `<small>${esc(node.detail)}</small>` : ''}</span>${node.children.length ? `<ul>${node.children.map(walk).join('')}</ul>` : ''}</li>`;
  return `<div class="scroll"><ul class="tree">${walk(section.root)}</ul></div>`;
}

const SECTIONS = {
  flow: flowSvg,
  sequence: sequenceSvg,
  compare: compareHtml,
  bars: barsHtml,
  timeline: timelineHtml,
  tree: treeHtml,
  html: (section) => `<div class="scroll">${sanitiseHtml(section.html)}</div>`,
};

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--surface:#fff;--ink:#1d1f24;--muted:#5d636e;--line:#d5d7dc;--edge:#6b7280;
--good:#15803d;--bad:#b91c1c;--warn:#b45309;--info:#1d4ed8;
--c0:#2563eb;--c1:#0f766e;--c2:#9333ea;--c3:#c2410c;--c4:#be185d;--c5:#4d7c0f}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--surface:#1f2228;--ink:#eceef1;--muted:#a3a9b4;--line:#3a3f49;--edge:#8f96a3;
--good:#4ade80;--bad:#f87171;--warn:#fbbf24;--info:#93c5fd;
--c0:#60a5fa;--c1:#2dd4bf;--c2:#c084fc;--c3:#fb923c;--c4:#f472b6;--c5:#a3e635}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 16px 48px}
h1{font-size:26px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em}
.summary{color:var(--muted);margin:0 0 24px;font-size:16px;max-width:72ch}
section{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 18px}
h2{font-size:16px;margin:0 0 14px}
.note{color:var(--muted);margin:14px 0 0;max-width:80ch}
.scroll{overflow-x:auto}
footer{color:var(--muted);font-size:12px;margin-top:20px}
svg.diagram{display:block;margin:0 auto;max-width:100%;height:auto}
svg text{font:14px system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:var(--ink);text-anchor:middle}
.node rect{fill:color-mix(in srgb,var(--n,var(--muted)) 12%,var(--surface));stroke:var(--n,var(--muted));stroke-width:1.4}
.node .detail{fill:var(--muted);font-size:12px}
.g0{--n:var(--c0)}.g1{--n:var(--c1)}.g2{--n:var(--c2)}.g3{--n:var(--c3)}.g4{--n:var(--c4)}.g5{--n:var(--c5)}
.t-good{--n:var(--good)}.t-bad{--n:var(--bad)}.t-warn{--n:var(--warn)}.t-info{--n:var(--info)}.t-muted{--n:var(--muted)}
.edge{fill:none;stroke:var(--edge);stroke-width:1.5}
.edge.dashed,.edge.back{stroke-dasharray:5 4}
.arrowhead{fill:var(--edge)}
.pill rect{fill:var(--surface);stroke:var(--line)}
.pill text{font-size:12px;fill:var(--muted)}
.lifeline{stroke:var(--line);stroke-width:1.2;stroke-dasharray:3 4}
.head{font-weight:600}
.msg{font-size:13px}.msg.start{text-anchor:start}
.legend,.loops{list-style:none;display:flex;flex-wrap:wrap;gap:6px 16px;padding:0;margin:14px 0 0;font-size:13px;color:var(--muted)}
.legend span{display:inline-block;width:11px;height:11px;border-radius:3px;background:var(--n);margin-right:6px;vertical-align:-1px}
table{border-collapse:collapse;width:100%;min-width:480px}
th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
thead th{font-size:13px;color:var(--muted);font-weight:600}
tbody tr:last-child>*{border-bottom:0}
tbody th{font-weight:600}
tr.best>*{background:color-mix(in srgb,var(--good) 9%,transparent)}
.badge{display:inline-block;margin-left:8px;padding:0 7px;border-radius:9px;font-size:11px;font-weight:600;color:var(--good);border:1px solid var(--good)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--n);margin-right:7px}
.bars{display:grid;gap:9px}
.bar-row{display:grid;grid-template-columns:minmax(90px,26%) 1fr;gap:12px;align-items:center}
.bar-label{font-size:14px;text-align:right;overflow-wrap:anywhere}
.bar-track{display:flex;align-items:center;gap:9px;min-width:0}
.bar-fill{height:20px;border-radius:0 4px 4px 0;background:var(--n,var(--c0));min-width:2px;flex:0 0 auto}
.bar-value{font-size:13px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{display:grid;grid-template-columns:minmax(70px,18%) 1fr;gap:22px;position:relative;padding-bottom:18px}
.timeline li:last-child{padding-bottom:0}
.when{text-align:right;color:var(--muted);font-size:14px}
.what{border-left:2px solid var(--line);padding-left:18px;position:relative;margin-left:-6px}
.what:before{content:"";position:absolute;left:-7px;top:6px;width:12px;height:12px;border-radius:50%;background:var(--n,var(--c0));border:2px solid var(--surface)}
.timeline li{padding-bottom:0}.what{padding-bottom:18px}
.what p{margin:2px 0 0;color:var(--muted)}
.tree,.tree ul{list-style:none;margin:0;padding:0}
.tree ul{margin-left:12px;border-left:1.5px solid var(--line);padding-left:18px}
.tree li{margin:7px 0;position:relative}
.tree ul>li:before{content:"";position:absolute;left:-18px;top:16px;width:14px;border-top:1.5px solid var(--line)}
.leaf{display:inline-block;padding:4px 10px;border:1.4px solid var(--n,var(--line));border-radius:7px;background:color-mix(in srgb,var(--n,var(--line)) 10%,var(--surface))}
.leaf small{display:block;color:var(--muted);font-size:12px}
`;

export function renderPage(spec, { generatedAt = new Date() } = {}) {
  const stamp = generatedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const sections = spec.sections.map((section) => `<section>${section.heading ? `<h2>${esc(section.heading)}</h2>` : ''}${SECTIONS[section.kind](section)}${section.note ? `<p class="note">${esc(section.note)}</p>` : ''}</section>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta http-equiv="x-dns-prefetch-control" content="off">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${esc(spec.title)}</h1>
${spec.summary ? `<p class="summary">${esc(spec.summary)}</p>` : ''}
${sections}
<footer>Drawn by visualiseit, ${esc(stamp)}. This page runs no scripts and loads nothing from the network.</footer>
</main>
</body>
</html>
`;
}
