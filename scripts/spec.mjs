// Turns the JSON Claude writes into a checked, cleaned spec. Everything that reaches a
// renderer has been through here, so renderers can trust the shape but must still escape.

export const KINDS = ['flow', 'sequence', 'compare', 'bars', 'timeline', 'tree', 'html'];
export const TONES = ['good', 'bad', 'warn', 'info', 'muted'];

const MAX_SECTIONS = 8;
const MAX_ITEMS = 60;

export class SpecError extends Error {}

// Terminal escapes, control characters and bidi overrides have no place in a label: the first
// two can rewrite the terminal, the last can make text read differently from what it says.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export function cleanText(value) {
  return String(value ?? '')
    .replace(ANSI, '')
    .replace(CONTROL, '')
    .normalize('NFC')
    .replace(/```+/g, "'''") // a stray fence would end the code block the diagram sits in
    .replace(/\s+/g, ' ')
    .trim();
}

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[masked private key]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[masked]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[masked]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[masked]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[masked]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[masked]'],
  [/\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g, '[masked]'],
  [/\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g, '[masked]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[masked]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[masked]'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, '$1 [masked]'],
  [/(:\/\/[^\s/:@]+:)[^\s/@]+(@)/g, '$1[masked]$2'],
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[masked]'],
];

/** Masks anything that looks like a credential. Returns the text and how many were hit. */
export function maskSecrets(text) {
  let count = 0;
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, (...match) => {
      count += 1;
      return replacement.replace(/\$(\d)/g, (_, n) => match[Number(n)]);
    });
  }
  return { text: out, count };
}

/** Walks every string in a value, masking secrets and, except in html, cleaning the text. */
function scrub(value, tally, key = '') {
  if (typeof value === 'string') {
    const { text, count } = maskSecrets(value);
    tally.masked += count;
    return key === 'html' ? text : cleanText(text);
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, tally, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, tally, k)]));
  }
  return value;
}

const tone = (value) => (TONES.includes(value) ? value : undefined);
const text = (value) => (value === undefined || value === null ? '' : String(value));

function limit(list, name, where) {
  if (!Array.isArray(list) || list.length === 0) throw new SpecError(`${where}: "${name}" must be a non-empty array.`);
  if (list.length > MAX_ITEMS) throw new SpecError(`${where}: "${name}" has ${list.length} entries, the limit is ${MAX_ITEMS}. Split it into sections.`);
  return list;
}

function flow(section, where) {
  const nodes = new Map();
  const add = (raw) => {
    const node = typeof raw === 'string' ? { id: raw } : raw;
    if (!node || node.id === undefined || text(node.id) === '') throw new SpecError(`${where}: every node needs an "id".`);
    const id = text(node.id);
    if (nodes.has(id)) return;
    nodes.set(id, { id, label: text(node.label) || id, detail: text(node.detail), group: text(node.group), tone: tone(node.tone) });
  };
  (section.nodes || []).forEach(add);
  const edges = limit(section.edges, 'edges', where).map((edge) => {
    if (edge?.from === undefined || edge?.to === undefined) throw new SpecError(`${where}: every edge needs "from" and "to".`);
    add(text(edge.from));
    add(text(edge.to));
    return { from: text(edge.from), to: text(edge.to), label: text(edge.label), dashed: Boolean(edge.dashed) };
  });
  limit([...nodes.values()], 'nodes', where);
  return { nodes: [...nodes.values()], edges, direction: section.direction === 'right' ? 'right' : 'down' };
}

function sequence(section, where) {
  const messages = limit(section.messages, 'messages', where).map((m) => {
    if (m?.from === undefined || m?.to === undefined) throw new SpecError(`${where}: every message needs "from" and "to".`);
    return { from: text(m.from), to: text(m.to), label: text(m.label), reply: Boolean(m.reply) };
  });
  const actors = (section.actors || []).map(text);
  for (const m of messages) for (const name of [m.from, m.to]) if (!actors.includes(name)) actors.push(name);
  return { actors, messages };
}

function compare(section, where) {
  const columns = limit(section.columns, 'columns', where).map(text);
  const rows = limit(section.rows, 'rows', where).map((row) => {
    if (!Array.isArray(row?.cells)) throw new SpecError(`${where}: every row needs "label" and a "cells" array.`);
    if (row.cells.length > columns.length) throw new SpecError(`${where}: row "${text(row.label)}" has ${row.cells.length} cells for ${columns.length} columns.`);
    const cells = columns.map((_, i) => {
      const cell = row.cells[i];
      return cell && typeof cell === 'object' ? { text: text(cell.text), tone: tone(cell.tone) } : { text: text(cell) };
    });
    return { label: text(row.label), cells, best: Boolean(row.best) };
  });
  return { columns, rows };
}

function bars(section, where) {
  const items = limit(section.items, 'items', where).map((item) => {
    const value = Number(item?.value);
    if (!Number.isFinite(value)) throw new SpecError(`${where}: "${text(item?.label)}" needs a numeric "value".`);
    return { label: text(item.label), value, display: text(item.display), tone: tone(item.tone) };
  });
  return { items, unit: text(section.unit) };
}

function timeline(section, where) {
  const items = limit(section.items, 'items', where).map((item) => ({
    when: text(item?.when),
    label: text(item?.label),
    detail: text(item?.detail),
    tone: tone(item?.tone),
  }));
  return { items };
}

function treeNode(raw, depth, where, count) {
  if (depth > 12) throw new SpecError(`${where}: the tree is nested deeper than 12 levels.`);
  count.n += 1;
  if (count.n > MAX_ITEMS) throw new SpecError(`${where}: the tree has more than ${MAX_ITEMS} nodes.`);
  const node = typeof raw === 'string' ? { label: raw } : raw;
  return {
    label: text(node?.label),
    detail: text(node?.detail),
    tone: tone(node?.tone),
    children: (node?.children || []).map((child) => treeNode(child, depth + 1, where, count)),
  };
}

function html(section, where) {
  if (typeof section.html !== 'string' || !section.html.trim()) throw new SpecError(`${where}: "html" must be a non-empty string.`);
  return { html: section.html };
}

const SHAPES = {
  flow,
  sequence,
  compare,
  bars,
  timeline,
  tree: (section, where) => ({ root: treeNode(section.root, 0, where, { n: 0 }) }),
  html,
};

/** Checks a spec and returns the cleaned form plus how many secrets were masked. */
export function normalise(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SpecError('The spec must be a JSON object.');
  const { title, summary, ...only } = input;
  const raw = input.sections ? input : { title, summary, sections: [only] };
  limit(raw.sections, 'sections', 'spec');
  if (raw.sections.length > MAX_SECTIONS) throw new SpecError(`The spec has ${raw.sections.length} sections, the limit is ${MAX_SECTIONS}.`);

  const tally = { masked: 0 };
  const clean = scrub(raw, tally);
  const sections = clean.sections.map((section, index) => {
    const where = `section ${index + 1}`;
    if (!KINDS.includes(section?.kind)) throw new SpecError(`${where}: "kind" must be one of ${KINDS.join(', ')}.`);
    return {
      kind: section.kind,
      heading: text(section.heading),
      note: text(section.note),
      ...SHAPES[section.kind](section, where),
    };
  });
  return {
    title: text(clean.title) || 'Visualisation',
    summary: text(clean.summary),
    sections,
    masked: tally.masked,
  };
}
