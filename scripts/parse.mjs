// The line-based format Claude writes specs in. It exists because Claude Code won't auto-approve
// a shell command whose heredoc holds braces next to quotes, which rules out piping JSON: every
// diagram would stop for a permission prompt. This has neither, and costs fewer tokens to write.
//
//   title: What this shows
//   summary: One sentence.
//
//   flow: Optional heading
//   node: app | App server | detail=second line | group=Web | tone=good
//   app -> Database | optional label
//   app --> Queue | a dashed edge
//   direction: right
//   note: Optional caption
//
// See skills/visualiseit/SKILL.md for every section type. The output has the same shape as the
// JSON spec, and normalise() in spec.mjs checks it either way.
import { KINDS, SpecError, TONES } from './spec.mjs';

const SECTION = new RegExp(`^(${KINDS.join('|')}):\\s*(.*)$`);
const ARROW = /^(.+?)\s+(-->|->)\s+(.+)$/;
const OPTION = /^(detail|group|tone|display)=(.*)$/;
const TONE_SUFFIX = new RegExp(`^(.*?)\\s*~(${TONES.join('|')})$`);

/** Splits on pipes, with \| for a literal one. */
const fields = (text) => text.split(/(?<!\\)\|/).map((part) => part.trim().replace(/\\\|/g, '|'));

function splitOptions(parts, lineNo) {
  const values = [];
  const options = {};
  for (const part of parts) {
    const match = part.match(OPTION);
    if (match) options[match[1]] = match[2].trim();
    else if (Object.keys(options).length) throw new SpecError(`line ${lineNo}: "${part}" comes after an option. Put options last, like tone=good.`);
    else values.push(part);
  }
  return { values, options };
}

function arrow(body, lineNo, shape) {
  const [first, ...rest] = fields(body);
  const match = first.match(ARROW);
  if (!match) throw new SpecError(`line ${lineNo}: expected ${shape}, got "${body}".`);
  return { from: match[1].trim(), to: match[3].trim(), dashed: match[2] === '-->', label: rest.join(' | ') };
}

const READERS = {
  flow(section, key, value, body, lineNo) {
    if (key === 'node') {
      const { values, options } = splitOptions(fields(value), lineNo);
      if (!values[0]) throw new SpecError(`line ${lineNo}: a node needs an id, like "node: app | App server".`);
      section.nodes.push({ id: values[0], label: values[1] || values[0], ...options });
    } else if (key === 'direction') {
      section.direction = value.trim();
    } else {
      const edge = arrow(body, lineNo, 'an edge like "A -> B | label"');
      section.edges.push(edge);
    }
  },
  sequence(section, key, value, body, lineNo) {
    if (key === 'actors') {
      section.actors = fields(value);
    } else {
      const { from, to, dashed, label } = arrow(body, lineNo, 'a message like "A -> B | label"');
      section.messages.push({ from, to, label, reply: dashed });
    }
  },
  compare(section, key, value, body, lineNo) {
    if (key === 'columns') {
      section.columns = fields(value);
    } else if (key === 'row' || key === 'best') {
      const [label, ...cells] = fields(value);
      section.rows.push({
        label,
        best: key === 'best',
        cells: cells.map((cell) => {
          const match = cell.match(TONE_SUFFIX);
          return match ? { text: match[1], tone: match[2] } : cell;
        }),
      });
    } else {
      throw new SpecError(`line ${lineNo}: expected "columns:", "row:" or "best:", got "${body}".`);
    }
  },
  bars(section, key, value, body, lineNo) {
    if (key === 'unit') {
      section.unit = value.trim();
    } else if (key === 'bar') {
      const { values, options } = splitOptions(fields(value), lineNo);
      const number = Number(String(values[1] ?? '').replace(/,/g, ''));
      if (values[1] === undefined || values[1] === '' || !Number.isFinite(number)) throw new SpecError(`line ${lineNo}: a bar needs a number, like "bar: Before | 840".`);
      section.items.push({ label: values[0], value: number, ...options });
    } else {
      throw new SpecError(`line ${lineNo}: expected "unit:" or "bar:", got "${body}".`);
    }
  },
  timeline(section, key, value, body, lineNo) {
    if (key !== 'at') throw new SpecError(`line ${lineNo}: expected "at: when | what", got "${body}".`);
    const { values, options } = splitOptions(fields(value), lineNo);
    section.items.push({ when: values[0], label: values[1] || '', ...options });
  },
};

const blank = (kind, heading) => ({
  kind,
  heading,
  ...(kind === 'flow' ? { nodes: [], edges: [] } : {}),
  ...(kind === 'sequence' ? { messages: [] } : {}),
  ...(kind === 'compare' ? { columns: [], rows: [] } : {}),
  ...(kind === 'bars' || kind === 'timeline' ? { items: [] } : {}),
  ...(kind === 'html' ? { html: '' } : {}),
});

function addTreeLine(section, stack, line, lineNo) {
  const indent = line.match(/^\s*/)[0].replace(/\t/g, '  ').length;
  const { values, options } = splitOptions(fields(line.trim().replace(/^-\s*/, '')), lineNo);
  const node = { label: values[0] || '', children: [], ...options };
  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
  if (stack.length) {
    stack[stack.length - 1].node.children.push(node);
  } else if (section.root) {
    throw new SpecError(`line ${lineNo}: a tree has one root, so indent "${values[0]}" under it.`);
  } else {
    section.root = node;
  }
  stack.push({ indent, node });
}

/** Parses the text format into a spec object for normalise(). */
export function parseSpec(text) {
  const spec = { sections: [] };
  let section = null;
  let treeStack = [];

  text.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    const header = trimmed.match(SECTION);

    if (header && !line.startsWith(' ')) {
      section = blank(header[1], header[2]);
      treeStack = [];
      spec.sections.push(section);
      return;
    }
    // Custom HTML runs to the next section, and its blank lines and colons are its own business.
    if (section?.kind === 'html') {
      section.html += `${line}\n`;
      return;
    }
    if (!trimmed) return;

    const keyed = trimmed.match(/^([a-z]+):\s*(.*)$/);
    const key = keyed?.[1];
    const value = keyed?.[2] ?? '';
    if (!section) {
      if (key === 'title' || key === 'summary') {
        spec[key] = value;
        return;
      }
      throw new SpecError(`line ${lineNo}: expected "title:", "summary:" or a section such as "flow:", got "${trimmed}".`);
    }
    if (key === 'note') {
      section.note = value;
    } else if (section.kind === 'tree') {
      addTreeLine(section, treeStack, line, lineNo);
    } else {
      READERS[section.kind](section, key, value, trimmed, lineNo);
    }
  });

  if (!spec.sections.length) throw new SpecError('No sections found. Start one with a line such as "flow:" or "compare:".');
  for (const section of spec.sections) {
    if (section.kind === 'tree' && !section.root) throw new SpecError('A tree section has no lines.');
  }
  return spec;
}
