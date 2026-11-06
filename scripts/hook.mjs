#!/usr/bin/env node
// Entry point for the hooks. A hint must never break the session, so any failure here exits 0
// and says nothing.
import fs from 'node:fs';
import { handleHook } from './lib.mjs';

try {
  const result = handleHook(JSON.parse(fs.readFileSync(0, 'utf8')), process.env);
  if (result.stdout) process.stdout.write(result.stdout);
} catch {
  process.exitCode = 0;
}
