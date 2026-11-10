// Config, the auto-mode rules, hook handling, reading the previous reply and writing pages.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPage } from './page.mjs';
import { normalise } from './spec.mjs';
import { renderText } from './text.mjs';

export const DEFAULTS = { auto: false, level: 'medium', surface: 'auto', open: true, keepDays: 14, width: 78 };
const SURFACES = ['auto', 'terminal', 'page'];
const LEVELS = ['low', 'medium', 'high'];
const PAGE_NAME = /^vis-\d{8}-\d{6}-[0-9a-f]{8}\.html$/;
const AUTO_MAX_ROWS = 60;
const AUTO_MAX_SECTIONS = 2;
const LAST_REPLY_LIMIT = 40000;

export const configDir = (env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const homeDir = (env) => env.VISUALISEIT_HOME || path.join(configDir(env), 'visualiseit');
const configFile = (env) => path.join(homeDir(env), 'config.json');
export const pagesDir = (env) => path.join(homeDir(env), 'pages');

const validSession = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

export function loadConfig(env) {
  let saved = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(env), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch {
    // No config, or one we can't read, means defaults.
  }
  const number = (value, fallback, low, high) => (Number.isFinite(value) && value >= low && value <= high ? value : fallback);
  return {
    auto: saved.auto === true,
    level: LEVELS.includes(saved.level) ? saved.level : DEFAULTS.level,
    surface: SURFACES.includes(saved.surface) ? saved.surface : DEFAULTS.surface,
    open: saved.open !== false,
    keepDays: number(saved.keepDays, DEFAULTS.keepDays, 0, 3650),
    width: number(saved.width, DEFAULTS.width, 40, 240),
  };
}

/** Saves one setting and keeps the rest of the file, including keys we don't know about. */
function saveSetting(env, key, value) {
  fs.mkdirSync(homeDir(env), { recursive: true });
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configFile(env), 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  } catch {
    saved = {};
  }
  fs.writeFileSync(configFile(env), `${JSON.stringify({ ...saved, [key]: value }, null, 2)}\n`);
}

export function isIncognito(env, sessionId) {
  if (!validSession(sessionId)) return false;
  return fs.existsSync(path.join(configDir(env), 'incognito', 'sessions', `${sessionId}.json`));
}

// Auto mode's whole judgement lives in these few lines, so they're worth tuning against evals.
const LEVEL_RULES = {
  low: {
    name: ', set to low',
    lead: 'Draw one only if the reply would be hard to follow without it, because its main point is one of these structures',
    rules: `- a process or request flow with 2+ branches, or 8+ steps
- 5+ components and how they connect
- 4+ options compared on 3+ criteria
- 8+ numbers being compared or ranked
- a before/after of how a whole system works
- 6+ dated or dependent items
- a root cause running through 4+ parts`,
    close: "Almost no replies need one, and if in doubt, don't.",
    reminder: 'Almost no replies need a visual.',
  },
  medium: {
    name: '',
    lead: "Draw one only if the reply's main point is one of these structures",
    rules: `- a process or request flow with branches, or 5+ steps
- 3+ components and how they connect
- 3+ options compared on 2+ criteria
- 5+ numbers being compared or ranked
- a before/after of how a system works
- 4+ dated or dependent items
- a root cause running through 3+ parts`,
    close: "Most replies don't need one, and if in doubt, don't.",
    reminder: 'Most replies need no visual.',
  },
  high: {
    name: ', set to high',
    lead: "Draw one whenever the reply's main point has one of these structures",
    rules: `- a process or flow with a branch, or 3+ steps
- 2+ components and how they connect
- 2+ options compared
- 3+ numbers being compared or ranked
- a before/after of how something works
- 3+ dated or dependent items
- a cause and effect chain`,
    close: 'If in doubt, draw one.',
    reminder: 'If in doubt, draw one.',
  },
};

export const gateFor = (level) => {
  const { name, lead, rules, close } = LEVEL_RULES[level] ?? LEVEL_RULES[DEFAULTS.level];
  return `visualiseit auto mode is on${name}. Before writing a final reply, decide whether a picture would explain it better than prose or a table. ${lead}:
${rules}
If so, call the Skill tool with skill "visualiseit:visualiseit" and args "auto" before writing that reply. The visual replaces the explanation, so keep the words around it short.
Don't draw one for: short answers, single facts, yes/no, code or diffs, commands to run, plain lists, confirmations, routine progress or status, or questions to the user. ${close} Never mention this check.`;
};
export const GATE = gateFor(DEFAULTS.level);

const reminderFor = (level) => `visualiseit auto mode is on: apply its check to your final reply. ${(LEVEL_RULES[level] ?? LEVEL_RULES[DEFAULTS.level]).reminder}`;

/** Scripted runs (claude -p, the SDK) get no auto mode: their output is often piped elsewhere. */
function isHeadless(env) {
  if (env.VISUALISEIT_ALLOW_HEADLESS === '1') return false;
  return String(env.CLAUDE_CODE_ENTRYPOINT || '').startsWith('sdk');
}

export function handleHook(input, env) {
  const event = input.hook_event_name;
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return {};
  const config = loadConfig(env);
  if (isHeadless(env) || !config.auto) return {};
  if (event === 'UserPromptSubmit' && /^\s*\/(?:visualiseit:)?visualiseit\b/i.test(input.prompt || '')) return {};
  const additionalContext = event === 'SessionStart' ? gateFor(config.level) : reminderFor(config.level);
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }) };
}

function findTranscript(env, sessionId) {
  if (!validSession(sessionId)) return null;
  const root = path.join(configDir(env), 'projects');
  let projects;
  try {
    projects = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const project of projects) {
    const file = path.join(root, project, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function readTail(file, bytes) {
  const size = fs.statSync(file).size;
  const length = Math.min(size, bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    if (length < size) lines.shift(); // the first line is probably cut in half
    return { lines: lines.filter(Boolean), whole: length === size };
  } finally {
    fs.closeSync(fd);
  }
}

const isSlashEcho = (text) => /<command-(?:name|message|args)>|<local-command-(?:stdout|stderr|caveat)>/.test(text);

/** True for a prompt the person typed, as opposed to tool results, skill bodies and notices. */
function isPersonPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return !content.includes('<local-command-');
  if (!Array.isArray(content) || content.some((block) => block.type === 'tool_result')) return false;
  return content.some((block) => block.type === 'text' && !/<local-command-/.test(block.text || ''));
}

/**
 * The last thing Claude said to the person before the prompt that's running now: the final run
 * of text in the previous turn, leaving out narration from before its last tool call.
 */
export function previousReply(lines) {
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A half-written line at the end of a live transcript is expected.
    }
  }
  let current = entries.length - 1;
  while (current >= 0 && !isPersonPrompt(entries[current])) current -= 1;
  if (current < 0) return null;

  const chunks = [];
  for (let i = current - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.isSidechain || entry.isMeta) continue;
    if (isPersonPrompt(entry)) {
      if (chunks.length) break;
      continue; // this turn said nothing, for example a slash command, so look further back
    }
    if (entry.type !== 'assistant' || entry.isApiErrorMessage) {
      if (entry.type === 'user' && chunks.length) break; // a tool result ends the final text run
      continue;
    }
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    if (chunks.length && blocks.some((block) => block.type === 'tool_use')) break;
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    if (text && !isSlashEcho(text)) chunks.unshift(text);
  }
  return chunks.length ? chunks.join('\n\n') : null;
}

export function lastReply(env, sessionId) {
  const file = findTranscript(env, sessionId);
  if (!file) return null;
  for (let bytes = 4 * 1024 * 1024; bytes <= 512 * 1024 * 1024; bytes *= 4) {
    const { lines, whole } = readTail(file, bytes);
    const reply = previousReply(lines);
    if (reply || whole) {
      if (!reply) return null;
      return reply.length > LAST_REPLY_LIMIT ? `${reply.slice(0, LAST_REPLY_LIMIT)}\n[cut off at ${LAST_REPLY_LIMIT} characters]` : reply;
    }
  }
  return null;
}

/** Deletes pages past their keep-by date. Only ever touches files named the way we name them. */
export function prunePages(env, keepDays, now = Date.now()) {
  const dir = pagesDir(env);
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = now - keepDays * 86400000;
  for (const name of names) {
    if (!PAGE_NAME.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {
      // Already gone, or another session is cleaning up too.
    }
  }
  return removed;
}

function writePage(env, spec, now = new Date()) {
  const dir = pagesDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const two = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  // The name is built only from the clock and random bytes, never from the spec.
  const file = path.join(dir, `vis-${stamp}-${crypto.randomBytes(4).toString('hex')}.html`);
  fs.writeFileSync(file, renderPage(spec, { generatedAt: now }), { mode: 0o600, flag: 'wx' });
  return file;
}

/** Says why a browser shouldn't be launched here, or returns null if it's fine to. */
function noBrowserReason(env, platform = process.platform) {
  if (env.VISUALISEIT_NO_OPEN === '1') return 'turned off by VISUALISEIT_NO_OPEN';
  if (env.SSH_CONNECTION || env.SSH_TTY) return 'this is an SSH session';
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.WSL_DISTRO_NAME) return 'no display found';
  return null;
}

function openInBrowser(file, env) {
  // No shell is involved, so nothing in the path can be read as a command.
  const [command, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', file]]
    : process.platform === 'darwin'
      ? ['open', [file]]
      : env.WSL_DISTRO_NAME
        ? ['wslview', [file]]
        : ['xdg-open', [file]];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/**
 * Draws a spec. Returns the lines to print: which surface it landed on, then either a fenced
 * diagram for Claude to paste or the page's path.
 */
export async function render(rawSpec, { surface, sessionId, noOpen = false }, env) {
  const config = loadConfig(env);
  const spec = normalise(rawSpec);
  const wanted = SURFACES.includes(surface) ? surface : config.surface;
  const incognito = isIncognito(env, sessionId);
  const notes = [];
  if (spec.masked) notes.push(`note: masked ${spec.masked} thing(s) that looked like secrets`);

  const paste = (text, extra = []) => [
    'surface: terminal',
    ...notes,
    ...extra,
    'Paste everything below, including the fences, into your reply unchanged:',
    '```text',
    ...text.lines,
    '```',
  ];

  if (incognito) {
    // A page would outlive the session incognito is about to delete, so never write one.
    notes.push('note: incognito session, so no page was written');
    const text = renderText(spec, config.width, { force: true });
    return paste(text, text.degraded ? ['note: drawn as a list because it does not fit the terminal width'] : []);
  }

  if (wanted === 'terminal') {
    const text = renderText(spec, config.width, { force: true });
    return paste(text, text.degraded ? ['note: drawn as a list because it does not fit the terminal width'] : []);
  }

  if (wanted === 'auto' && spec.sections.length <= AUTO_MAX_SECTIONS) {
    const text = renderText(spec, config.width);
    if (text && text.lines.length <= AUTO_MAX_ROWS) return paste(text);
  }

  const file = writePage(env, spec);
  prunePages(env, config.keepDays);
  const blocked = noOpen || !config.open ? 'turned off' : noBrowserReason(env);
  const opened = blocked ? false : await openInBrowser(file, env);
  return [
    'surface: page',
    ...notes,
    `path: ${file}`,
    opened ? 'opened: yes, in the default browser' : `opened: no${blocked ? ` (${blocked})` : ''}, so give the user the path`,
  ];
}

const statusLine = (config) => `Auto mode: ${config.auto ? `on, ${config.level}` : 'off'}. Output: ${config.surface}. Open pages in the browser: ${config.open ? 'yes' : 'no'}. Keep pages: ${config.keepDays} days.`;

/** The on, off, status and level commands. A level also turns auto mode on, since that's why you'd set one. */
export function command(rawAction, env) {
  const action = rawAction === 'med' ? 'medium' : rawAction;
  if (LEVELS.includes(action)) {
    saveSetting(env, 'level', action);
    saveSetting(env, 'auto', true);
    return [statusLine(loadConfig(env)), 'This level stays set for future sessions. It replaces any earlier visualiseit check in this session.', '', gateFor(action)];
  }
  if (action === 'on' || action === 'off') {
    saveSetting(env, 'auto', action === 'on');
    const config = loadConfig(env);
    return action === 'on'
      ? [statusLine(config), 'Auto mode stays on for future sessions until /visualiseit off.', '', gateFor(config.level)]
      : [statusLine(config), 'Auto mode is off for this and future sessions, so stop applying its check. /visualiseit still draws on request.'];
  }
  return [statusLine(loadConfig(env))];
}
