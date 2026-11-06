import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = homedir();
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Where config.json and data/ live:
//  1. $CLEANDRIVE_HOME if set (tests, custom setups)
//  2. the repo itself when run from a git clone that already has a config.json
//  3. ~/.config/cleandrive otherwise (npm / npx installs: the package dir is read-only)
export const APP_HOME = process.env.CLEANDRIVE_HOME
  ? path.resolve(process.env.CLEANDRIVE_HOME)
  : existsSync(path.join(ROOT, 'config.json'))
    ? ROOT
    : path.join(HOME, '.config', 'cleandrive');
export const CONFIG_FILE = path.join(APP_HOME, 'config.json');
// CLEANDRIVE_DATA_DIR lets tests run against a throwaway data dir.
export const DATA_DIR = process.env.CLEANDRIVE_DATA_DIR
  ? path.resolve(process.env.CLEANDRIVE_DATA_DIR)
  : path.join(APP_HOME, 'data');

export function expandHome(p) {
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}

// First run: seed config.json from the shipped example.
export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(APP_HOME, { recursive: true });
    writeFileSync(CONFIG_FILE, readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
    process.stderr.write(`cleandrive: created ${CONFIG_FILE} — edit projectRoots and remote there\n`);
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
}

export function saveConfig(cfg) {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

export function idFor(p) {
  return createHash('sha1').update(p).digest('hex').slice(0, 10);
}

export function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomic write: a crash mid-write leaves the old file intact, never a torn one.
export function writeJson(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}

export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

// Run a command without a shell. Resolves with {code, out, err}; never rejects.
// opts.timeoutMs kills the child and resolves {code: -1, timedOut: true}: `du`
// over another app's privacy-protected container can block forever at 0% CPU.
export function run(cmd, args = [], opts = {}) {
  const { timeoutMs, onData, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
    let out = '', err = '', timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.stdout.on('data', (d) => { out += d; onData?.(String(d)); });
    child.stderr.on('data', (d) => { err += d; onData?.(String(d)); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(timedOut ? { code: -1, out, err: `timed out after ${timeoutMs / 1000}s`, timedOut } : { code, out, err });
    });
  });
}

// Run through a login zsh so PATH includes homebrew/uv/etc.
export function runShell(cmdline, opts = {}) {
  return run('zsh', ['-lc', cmdline], opts);
}

export function fmtGB(kb) {
  const gb = kb / 1024 / 1024;
  return gb >= 10 ? gb.toFixed(0) + ' GB' : gb >= 1 ? gb.toFixed(1) + ' GB' : (kb / 1024).toFixed(0) + ' MB';
}

// Simple concurrency pool
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
