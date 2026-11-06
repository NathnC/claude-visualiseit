// Terminal rendering. Claude pastes this output into its reply, so everything has to line up in
// a monospace font without colour. A renderer returns null when a section won't fit the width.
import { layoutGraph } from './layout.mjs';

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|\p{Emoji_Presentation}|️/u;
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

const glyphWidth = (glyph) => {
  if (ZERO.test(glyph)) return 0;
  return WIDE.test(glyph) ? 2 : 1;
};
const glyphs = (text) => [...segmenter.segment(text)].map((part) => part.segment);

export function displayWidth(text) {
  return glyphs(text).reduce((sum, glyph) => sum + glyphWidth(glyph), 0);
}

const pad = (text, width) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));
const center = (text, width) => {
  const left = Math.floor((width - displayWidth(text)) / 2);
  return pad(' '.repeat(Math.max(0, left)) + text, width);
};

/** Word-wraps to a display width, breaking words only when one alone is too long. */
export function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    if (line && displayWidth(`${line} ${rest}`) <= width) {
      line += ` ${rest}`;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    while (displayWidth(rest) > width) {
      let head = '';
      const parts = glyphs(rest);
      let i = 0;
      while (i < parts.length && displayWidth(head + parts[i]) <= width) head += parts[i++];
      if (!head) { head = parts[0]; i = 1; } // a glyph wider than the column still has to go somewhere
      lines.push(head);
      rest = parts.slice(i).join('');
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const TONE_MARK = { good: '✓ ', bad: '✗ ', warn: '! ' };
const marked = (text, tone) => (TONE_MARK[tone] || '') + text;

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;
const LINE = {
  [UP]: '│', [DOWN]: '│', [UP | DOWN]: '│',
  [LEFT]: '─', [RIGHT]: '─', [LEFT | RIGHT]: '─',
  [DOWN | RIGHT]: '┌', [DOWN | LEFT]: '┐', [UP | RIGHT]: '└', [UP | LEFT]: '┘',
  [UP | DOWN | RIGHT]: '├', [UP | DOWN | LEFT]: '┤',
  [LEFT | RIGHT | DOWN]: '┬', [LEFT | RIGHT | UP]: '┴',
  [UP | DOWN | LEFT | RIGHT]: '┼',
};

/** A character grid where lines merge into the right junction and text sits on top. */
class Canvas {
  constructor() {
    this.masks = new Map();
    this.dashed = new Map();
    this.solid = new Set();
    this.literals = new Map();
  }

  key(x, y) { return `${x},${y}`; }

  mark(x, y, bits, dashed) {
    const key = this.key(x, y);
    this.masks.set(key, (this.masks.get(key) || 0) | bits);
    if (dashed) this.dashed.set(key, true);
    else this.solid.add(key);
  }

  link(x1, y1, x2, y2, dashed) {
    if (x1 === x2) {
      const [top, bottom] = y1 < y2 ? [y1, y2] : [y2, y1];
      for (let y = top; y < bottom; y += 1) {
        this.mark(x1, y, DOWN, dashed);
        this.mark(x1, y + 1, UP, dashed);
      }
    } else {
      const [low, high] = x1 < x2 ? [x1, x2] : [x2, x1];
      for (let x = low; x < high; x += 1) {
        this.mark(x, y1, RIGHT, dashed);
        this.mark(x + 1, y1, LEFT, dashed);
      }
    }
  }

  put(x, y, char) { this.literals.set(this.key(x, y), char); }

  write(x, y, text) {
    let at = x;
    for (const glyph of glyphs(text)) {
      this.put(at, y, glyph);
      for (let i = 1; i < glyphWidth(glyph); i += 1) this.put(at + i, y, '');
      at += glyphWidth(glyph);
    }
  }

  isEmpty(x, y) {
    const key = this.key(x, y);
    return !this.masks.has(key) && !this.literals.has(key);
  }

  charAt(x, y) {
    const key = this.key(x, y);
    if (this.literals.has(key)) return this.literals.get(key);
    const mask = this.masks.get(key);
    if (!mask) return ' ';
    const dashed = this.dashed.get(key) && !this.solid.has(key);
    if (dashed && (mask & (UP | DOWN)) && !(mask & (LEFT | RIGHT))) return '┆';
    if (dashed && (mask & (LEFT | RIGHT)) && !(mask & (UP | DOWN))) return '┄';
    return LINE[mask] || '┼';
  }

  lines(width, height) {
    const out = [];
    for (let y = 0; y < height; y += 1) {
      let row = '';
      for (let x = 0; x < width; x += 1) row += this.charAt(x, y);
      out.push(row.trimEnd());
    }
    return out;
  }
}

function boxLines(node, inner) {
  const label = wrap(marked(node.label, node.tone), inner);
  const detail = node.detail ? wrap(node.detail, inner) : [];
  return [...label, ...detail];
}

function assignTracks(segments) {
  const bending = segments.filter((s) => s.x1 !== s.x2).sort((a, b) => Math.min(a.x1, a.x2) - Math.min(b.x1, b.x2));
  const tracks = [];
  for (const segment of bending) {
    const low = Math.min(segment.x1, segment.x2);
    const high = Math.max(segment.x1, segment.x2);
    const fits = (other) => {
      if (other.x1 === segment.x1 || other.x2 === segment.x2) return true; // merges read as a fan
      return Math.max(other.x1, other.x2) + 1 < low || high + 1 < Math.min(other.x1, other.x2);
    };
    let track = tracks.find((list) => list.every(fits));
    if (!track) {
      track = [];
      tracks.push(track);
    }
    track.push(segment);
    segment.track = tracks.indexOf(track);
  }
  // A line leaving a column above where another line enters it would read as one line, so run
  // tracks that leave a column before tracks that enter it.
  const order = tracks.map((_, i) => i);
  const conflicts = (a, b) => tracks[a].some((s) => tracks[b].some((o) => s.x2 === o.x1 && s.x2 !== s.x1));
  order.sort((a, b) => (conflicts(a, b) ? 1 : conflicts(b, a) ? -1 : a - b));
  const position = new Map(order.map((track, i) => [track, i]));
  for (const segment of bending) segment.track = position.get(segment.track);
  return tracks.length;
}

function placeLabel(canvas, chain, channels, width) {
  const text = chain.edge.label;
  const needed = displayWidth(text);
  for (const segment of chain.segments) {
    const channel = channels.get(segment);
    const trackRow = segment.x1 === segment.x2 ? channel.top + channel.height : channel.top + 1 + segment.track;
    const spots = [];
    for (let y = channel.top; y < trackRow; y += 1) spots.push([segment.x1, y]);
    for (let y = trackRow + 1; y < channel.top + channel.height; y += 1) spots.push([segment.x2, y]);
    for (const [x, y] of spots) {
      for (const start of [x + 2, x - 1 - needed]) {
        if (start < 0 || start + needed > width) continue;
        let free = true;
        for (let at = start - 1; at <= start + needed; at += 1) if (!canvas.isEmpty(at, y)) free = false;
        if (free) {
          canvas.write(start, y, text);
          return true;
        }
      }
    }
  }
  return false;
}

function drawFlow(section, width, labelMax) {
  const lines = new Map(section.nodes.map((node) => [node.id, boxLines(node, labelMax)]));
  const graph = layoutGraph(section.nodes, section.edges, {
    sizeOf: (node) => {
      const inner = Math.max(...lines.get(node.id).map(displayWidth));
      return { w: inner + 4, h: lines.get(node.id).length + 2 };
    },
    gapX: 2,
    dummyWidth: 1,
    inset: 2,
    snap: true,
  });
  const total = Math.ceil(graph.width) + 1;
  if (total > width) return null;

  const canvas = new Canvas();
  const channels = new Map();
  const unplaced = [];
  let y = 0;
  graph.ranks.forEach((rank, r) => {
    const rowHeight = Math.max(1, ...rank.map((v) => v.h));
    for (const v of rank) {
      v.top = y;
      v.bottom = y + rowHeight - 1;
    }
    y += rowHeight;
    const here = graph.segments.filter((s) => s.from.rank === r);
    if (r === graph.ranks.length - 1) return;
    const tracks = assignTracks(here);
    const labelled = here.some((s) => s.chain.edge.label && s.chain.segments[0] === s);
    // A straight unlabelled arrow only needs its arrowhead, which keeps long chains on screen.
    const height = 1 + (tracks ? tracks + 1 : 0) + (labelled ? 1 : 0);
    for (const segment of here) channels.set(segment, { top: y, height, tracks });
    y += height;
  });

  // Lines first, so box borders and labels can sit over them.
  for (const segment of graph.segments) {
    const channel = channels.get(segment);
    const dashed = segment.chain.edge.dashed;
    const startY = segment.from.dummy ? segment.from.top : segment.from.top + segment.from.h - 1;
    const end = channel.top + channel.height - 1;
    const endY = segment.to.dummy ? segment.to.top : end;
    if (segment.x1 === segment.x2) {
      canvas.link(segment.x1, startY, segment.x1, endY, dashed);
    } else {
      const trackY = channel.top + 1 + segment.track;
      canvas.link(segment.x1, startY, segment.x1, trackY, dashed);
      canvas.link(segment.x1, trackY, segment.x2, trackY, dashed);
      canvas.link(segment.x2, trackY, segment.x2, endY, dashed);
    }
    if (segment.to.dummy) canvas.link(segment.x2, segment.to.top, segment.x2, segment.to.bottom + 1, dashed);
  }

  for (const rank of graph.ranks) {
    for (const v of rank) {
      if (v.dummy) continue;
      const left = Math.round(v.x - (v.w - 1) / 2);
      const inner = v.w - 4;
      canvas.write(left, v.top, `┌${'─'.repeat(v.w - 2)}┐`);
      lines.get(v.id).forEach((text, i) => canvas.write(left, v.top + 1 + i, `│ ${center(text, inner)} │`));
      canvas.write(left, v.top + v.h - 1, `└${'─'.repeat(v.w - 2)}┘`);
    }
  }

  for (const chain of graph.chains) {
    const first = chain.segments[0];
    const last = chain.segments[chain.segments.length - 1];
    const firstChannel = channels.get(first);
    const lastChannel = channels.get(last);
    canvas.put(first.x1, first.from.top + first.from.h - 1, chain.reversed ? '─' : '┬');
    if (chain.reversed) {
      canvas.put(first.x1, firstChannel.top, '▲');
      canvas.put(last.x2, last.to.top, '┴');
    } else {
      canvas.put(last.x2, lastChannel.top + lastChannel.height - 1, '▼');
    }
  }

  for (const chain of graph.chains) {
    if (!chain.edge.label) continue;
    if (!placeLabel(canvas, chain, channels, width)) unplaced.push(chain.edge);
  }

  const names = new Map(section.nodes.map((node) => [node.id, node.label]));
  const output = canvas.lines(width, y); // labels can run past the boxes, so never crop to them
  const footnotes = [...unplaced, ...graph.selfLoops].map((edge) => {
    const line = `${names.get(edge.from)} → ${names.get(edge.to)}${edge.label ? `: ${edge.label}` : ''}`;
    return wrap(line, width).join('\n');
  });
  return footnotes.length ? [...output, '', ...footnotes.join('\n').split('\n')] : output;
}

const MAX_CROSSINGS = 2;

function flowText(section, width, force) {
  for (const labelMax of [26, 20, 14]) {
    const lines = drawFlow(section, width, labelMax);
    if (!lines) continue;
    // Text can't separate lines that cross much, so a page reads better unless text was demanded.
    const crossings = lines.join('').split('┼').length - 1;
    return force || crossings <= MAX_CROSSINGS ? lines : null;
  }
  return null;
}

function flowFallback(section, width) {
  const names = new Map(section.nodes.map((node) => [node.id, node.label]));
  return section.edges.flatMap((edge) => wrap(
    `${names.get(edge.from)} ${edge.dashed ? '┄┄' : '──'}${edge.label ? ` ${edge.label} ` : ''}► ${names.get(edge.to)}`,
    width,
  ));
}

function sequenceText(section, width) {
  const { actors, messages } = section;
  const index = new Map(actors.map((name, i) => [name, i]));
  const LABEL_MAX = 34;
  const labels = messages.map((m) => wrap(m.label || ' ', LABEL_MAX));
  const widest = (lines) => Math.max(...lines.map(displayWidth));

  const gaps = actors.slice(0, -1).map((name, i) => Math.max(8, Math.ceil((displayWidth(name) + displayWidth(actors[i + 1])) / 2) + 2));
  messages.forEach((m, i) => {
    const a = index.get(m.from);
    const b = index.get(m.to);
    if (a === b) {
      if (a < gaps.length) gaps[a] = Math.max(gaps[a], widest(labels[i]) + 7);
      return;
    }
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const need = widest(labels[i]) + 4;
    const have = gaps.slice(low, high).reduce((sum, gap) => sum + gap, 0);
    if (have < need) gaps[low] += need - have;
  });

  const leftPad = Math.ceil(displayWidth(actors[0]) / 2);
  const columns = [leftPad];
  gaps.forEach((gap) => columns.push(columns[columns.length - 1] + gap));
  const lastName = actors[actors.length - 1];
  const lastLabelPad = Math.max(0, ...messages.map((m, i) => (index.get(m.from) === actors.length - 1 && m.from === m.to ? widest(labels[i]) + 5 : 0)));
  const total = columns[columns.length - 1] + Math.max(Math.ceil(displayWidth(lastName) / 2), lastLabelPad) + 1;
  if (total > width) return null;

  const canvas = new Canvas();
  let y = 0;
  actors.forEach((name, i) => canvas.write(columns[i] - Math.floor(displayWidth(name) / 2), y, name));
  y += 1;
  const lifeline = (row) => columns.forEach((x) => canvas.mark(x, row, UP | DOWN));
  lifeline(y);
  y += 1;
  messages.forEach((m, i) => {
    const a = index.get(m.from);
    const b = index.get(m.to);
    const low = Math.min(columns[a], columns[b]);
    const high = Math.max(columns[a], columns[b]);
    labels[i].forEach((line) => {
      lifeline(y);
      if (a === b) canvas.write(columns[a] + 5, y + 1, line);
      else canvas.write(low + 2, y, ` ${line} `.trimEnd());
      y += 1;
    });
    if (a === b) {
      lifeline(y);
      canvas.put(columns[a], y, '├');
      canvas.write(columns[a] + 1, y, '──┐');
      y += 1;
      lifeline(y);
      canvas.write(columns[a], y, '◄──┘');
      y += 1;
    } else {
      lifeline(y);
      const dash = m.reply ? '┄' : '─';
      const body = dash.repeat(high - low - 1);
      canvas.write(low, y, a < b ? `├${body}►` : `◄${body}┤`);
      y += 1;
    }
  });
  lifeline(y);
  y += 1;
  return canvas.lines(total + 1, y);
}

function sequenceFallback(section, width) {
  return section.messages.flatMap((m, i) => wrap(`${i + 1}. ${m.from} ${m.reply ? '┄┄►' : '──►'} ${m.to}${m.label ? `: ${m.label}` : ''}`, width));
}

function compareText(section, width) {
  const { columns, rows } = section;
  const header = ['', ...columns];
  const body = rows.map((row) => [
    (row.best ? '★ ' : '') + row.label,
    ...row.cells.map((cell) => marked(cell.text, cell.tone)),
  ]);
  const longest = (text) => Math.max(0, ...text.split(/\s+/).map(displayWidth));
  const natural = header.map((_, c) => Math.max(displayWidth(header[c]), ...body.map((row) => displayWidth(row[c]))));
  const minimum = header.map((_, c) => Math.max(longest(header[c]), ...body.map((row) => longest(row[c])), 3));
  const frame = 3 * header.length + 1;
  const budget = width - frame;
  if (minimum.reduce((a, b) => a + b, 0) > budget) return null;

  const widths = [...natural];
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const shrinkable = widths.map((w, i) => [w, i]).filter(([w, i]) => w > minimum[i]).sort((a, b) => b[0] - a[0]);
    widths[shrinkable[0][1]] -= 1;
  }
  const border = (l, m, r) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const emit = (cells) => {
    const wrapped = cells.map((cell, c) => wrap(cell, widths[c]));
    const height = Math.max(...wrapped.map((list) => list.length));
    return Array.from({ length: height }, (_, h) => `│ ${wrapped.map((list, c) => pad(list[h] || '', widths[c])).join(' │ ')} │`);
  };
  const lines = [border('┌', '┬', '┐'), ...emit(header), border('├', '┼', '┤')];
  body.forEach((row, i) => {
    lines.push(...emit(row));
    if (i < body.length - 1) lines.push(border('├', '┼', '┤'));
  });
  lines.push(border('└', '┴', '┘'));
  return lines;
}

function compareFallback(section, width) {
  const out = [];
  for (const row of section.rows) {
    out.push(...wrap(`${row.best ? '★ ' : ''}${row.label}`, width));
    row.cells.forEach((cell, c) => out.push(...wrap(`  ${section.columns[c]}: ${marked(cell.text, cell.tone)}`, width)));
  }
  return out;
}

export function formatNumber(value) {
  return Number.isInteger(value) ? value.toLocaleString('en-GB') : value.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

export const barValue = (item, unit) => item.display || `${formatNumber(item.value)}${unit ? ` ${unit}` : ''}`;

function barsText(section, width) {
  const { items, unit } = section;
  const labels = items.map((item) => marked(item.label, item.tone));
  const values = items.map((item) => barValue(item, unit));
  const labelWidth = Math.min(Math.max(...labels.map(displayWidth)), Math.floor(width * 0.4));
  const valueWidth = Math.max(...values.map(displayWidth));
  const room = Math.max(4, width - labelWidth - valueWidth - 2);
  const top = Math.max(...items.map((item) => Math.abs(item.value))) || 1;
  const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
  return items.flatMap((item, i) => {
    const size = (Math.abs(item.value) / top) * room;
    let cells = Math.floor(size);
    let part = Math.round((size - cells) * 8);
    if (part === 8) { cells += 1; part = 0; }
    const bar = '█'.repeat(cells) + (item.value !== 0 && cells === 0 && part === 0 ? '▏' : EIGHTHS[part]);
    const name = wrap(labels[i], labelWidth);
    const first = `${pad(name[0], labelWidth)} ${bar} ${values[i]}`;
    return [first, ...name.slice(1).map((line) => line)];
  });
}

function timelineText(section, width) {
  const whenWidth = Math.min(Math.max(...section.items.map((item) => displayWidth(item.when))), Math.floor(width * 0.3));
  const textWidth = Math.max(10, width - whenWidth - 5);
  const out = [];
  section.items.forEach((item, i) => {
    const body = wrap(marked(item.label, item.tone), textWidth);
    const when = wrap(item.when, whenWidth);
    const detail = item.detail ? wrap(item.detail, textWidth - 2).map((line) => `  ${line}`) : [];
    const lines = [...body, ...detail];
    const last = i === section.items.length - 1;
    lines.forEach((line, row) => {
      const stamp = pad(when[row] || '', whenWidth);
      out.push(`${stamp} ${row === 0 ? '●' : last ? ' ' : '│'} ${line}`.trimEnd());
    });
    if (!last) out.push(`${' '.repeat(whenWidth)} │`);
  });
  return out;
}

function treeText(section, width) {
  const out = [];
  const walk = (node, prefix, childPrefix) => {
    const text = marked(node.label, node.tone) + (node.detail ? ` (${node.detail})` : '');
    const room = Math.max(10, width - displayWidth(prefix));
    wrap(text, room).forEach((line, i) => out.push((i === 0 ? prefix : childPrefix + (node.children.length ? '│  ' : '   ')) + line));
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      walk(child, `${childPrefix}${last ? '└─ ' : '├─ '}`, `${childPrefix}${last ? '   ' : '│  '}`);
    });
  };
  walk(section.root, '', '');
  return out;
}

const DRAW = {
  flow: flowText,
  sequence: sequenceText,
  compare: compareText,
  bars: barsText,
  timeline: timelineText,
  tree: treeText,
  html: () => null,
};

const FALLBACK = {
  flow: flowFallback,
  sequence: sequenceFallback,
  compare: compareFallback,
  html: (_, width) => wrap('(This section is drawn as custom HTML, so it only appears on a page.)', width),
};

/**
 * Draws the spec as text. With `force` off, returns null if any section won't fit so the caller
 * can use a page instead. With it on, sections that won't fit become plain lists.
 */
export function renderText(spec, width, { force = false } = {}) {
  const blocks = [];
  const heading = wrap(spec.title, width);
  const lines = [...heading];
  if (spec.summary) lines.push(...wrap(spec.summary, width));
  let degraded = false;
  for (const section of spec.sections) {
    let drawn = DRAW[section.kind](section, width, force);
    if (!drawn) {
      if (!force) return null;
      degraded = true;
      drawn = FALLBACK[section.kind](section, width);
    }
    const block = [];
    if (section.heading) block.push(...wrap(section.heading, width));
    block.push(...drawn);
    if (section.note) block.push(...wrap(section.note, width));
    blocks.push(block);
  }
  for (const block of blocks) lines.push('', ...block);
  return { lines, degraded };
}
