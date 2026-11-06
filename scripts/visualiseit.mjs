#!/usr/bin/env node
// Command line used by the skill:
//   visualiseit.mjs render [--surface auto|terminal|page] [--session <id>] [--no-open]   (spec on stdin)
//   visualiseit.mjs last --session <id>
//   visualiseit.mjs on|off|status
import fs from 'node:fs';
import { command, lastReply, render } from './lib.mjs';
import { parseSpec } from './parse.mjs';
import { SpecError } from './spec.mjs';

const MAX_SPEC_BYTES = 512 * 1024;

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readSpec() {
  const raw = fs.readFileSync(0);
  if (raw.length > MAX_SPEC_BYTES) throw new SpecError(`The spec is ${raw.length} bytes, the limit is ${MAX_SPEC_BYTES}.`);
  const text = raw.toString('utf8').replace(/^﻿/, '');
  if (!text.trim()) throw new SpecError('No spec on stdin.');
  if (!text.trimStart().startsWith('{')) return parseSpec(text);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SpecError(`The spec is not valid JSON: ${error.message}`);
  }
}

async function main() {
  const [action = 'status', ...args] = process.argv.slice(2);
  const env = process.env;
  switch (action) {
    case 'render': {
      const lines = await render(readSpec(), {
        surface: option(args, '--surface'),
        sessionId: option(args, '--session'),
        noOpen: args.includes('--no-open'),
      }, env);
      process.stdout.write(`${lines.join('\n')}\n`);
      break;
    }
    case 'last': {
      const reply = lastReply(env, option(args, '--session'));
      process.stdout.write(reply ? `${reply}\n` : 'No previous reply found.\n');
      break;
    }
    case 'on':
    case 'off':
    case 'status':
      process.stdout.write(`${command(action, env).join('\n')}\n`);
      break;
    default:
      throw new SpecError(`Unknown command "${action}". Use render, last, on, off or status.`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof SpecError ? error.message : error.stack || error}\n`);
  process.exitCode = 2;
});
