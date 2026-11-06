// offload / fetch: iCloud-style switch between a local file and a verified copy on
// the remote archive drive. No daemon anywhere: every step runs
// inside one command over on-demand ssh/rsync. Design + invariants:
// docs/offload-strategy.md. The rule that matters most: the local file is only
// unlinked after the remote copy's sha256 matches AND the local file is unchanged.
import { createHash } from 'node:crypto';
import {
  createReadStream, lstatSync, statSync, realpathSync, readdirSync, readFileSync, existsSync,
  unlinkSync, renameSync, utimesSync, statfsSync,
} from 'node:fs';
import path from 'node:path';
import {
  HOME, DATA_DIR, loadConfig, readJson, writeJson, writeFileAtomic, run, ensureDataDir, expandHome,
} from './util.js';
import { checkRemoteDrive, sshOpts, log } from './actions.js';

export const STUB_EXT = '.cloud';
const INDEX_FILE = path.join(DATA_DIR, 'offloaded.json');
const CANDIDATES_FILE = path.join(DATA_DIR, 'offload-candidates.json');
const LOCK_FILE = path.join(DATA_DIR, 'offload.lock');

// Never offload from here: app data, libraries other software owns, VCS internals.
const NEVER_SEGMENTS = new Set(['.git', 'node_modules', '.Trash', '.venv']);
const NEVER_SUFFIXES = ['.photoslibrary', '.fcpbundle', '.imovielibrary', '.musiclibrary', '.tvlibrary', '.app'];
const MEDIA_EXT = new Set([
  'mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'mts', 'm2ts', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'braw', 'r3d',
  'wav', 'aif', 'aiff', 'flac', 'm4a', 'caf',
  'dmg', 'iso', 'img', 'zip', 'tar', 'gz', 'tgz', 'xz', 'bz2', '7z', 'rar',
  'psd', 'psb', 'tif', 'tiff', 'cr2', 'cr3', 'nef', 'arw', 'dng',
]);
const DEFAULT_ROOTS = ['~/Movies', '~/Documents', '~/Desktop', '~/Downloads', '~/Pictures'];

// ---------- small helpers ----------

const opt = (cfg) => ({ retries: 5, timeoutSec: 120, ...(cfg.offload || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const short = (p) => p.replace(HOME, '~');

export function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function remoteBase(cfg) {
  const rpath = cfg.remote?.path;
  if (!cfg.remote?.host || !rpath) throw new Error('remote not configured (config.remote.host/path)');
  return rpath.replace(/\/$/, '') + '/offload';
}
const objectRel = (sha) => `objects/${sha.slice(0, 2)}/${sha}`;
const remoteDest = (cfg) => `${cfg.remote.user ? cfg.remote.user + '@' : ''}${cfg.remote.host}`;
// Keepalives make a hung Tailscale link fail fast instead of blocking forever.
const sshBase = (cfg) => ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', ...sshOpts(cfg)];

function ssh(cfg, cmd) {
  return run('ssh', [...sshBase(cfg), remoteDest(cfg), cmd]);
}

function rsyncArgs(cfg) {
  return ['--partial', `--timeout=${opt(cfg).timeoutSec}`, '-e', ['ssh', ...sshBase(cfg)].join(' ')];
}

async function withRetry(cfg, label, fn, onData) {
  const n = Math.max(1, opt(cfg).retries);
  let last;
  for (let i = 1; i <= n; i++) {
    last = await fn();
    if (last.code === 0) return last;
    const why = (last.err || last.out || '').trim().split('\n').pop();
    onData?.(`  ${label}: attempt ${i}/${n} failed (exit ${last.code}) ${why}\n`);
    if (i < n) await sleep(Math.min(60000, 5000 * 2 ** (i - 1)));
  }
  return last;
}

async function remoteSha(cfg, rel) {
  const r = await ssh(cfg, `test -f ${q(remoteBase(cfg) + '/' + rel)} && sha256sum -- ${q(remoteBase(cfg) + '/' + rel)}`);
  if (r.code === 255) throw new Error('remote unreachable: ' + (r.err || '').trim().split('\n').pop());
  if (r.code !== 0) return null; // missing
  return r.out.trim().split(/\s+/)[0] || null;
}

// ---------- index + pins ----------

export function loadIndex() {
  return readJson(INDEX_FILE, { version: 1, files: {}, pins: [] });
}
function saveIndex(idx) {
  ensureDataDir();
  writeJson(INDEX_FILE, idx);
}

export function setPin(p, pinned) {
  const abs = path.resolve(expandHome(p));
  const idx = loadIndex();
  idx.pins = (idx.pins || []).filter((x) => x !== abs);
  if (pinned) idx.pins.push(abs);
  saveIndex(idx);
  return abs;
}

const isPinned = (abs, pins) => pins.some((pp) => abs === pp || abs.startsWith(pp + path.sep));

// ---------- lock: one offload/fetch run at a time ----------

function acquireLock() {
  ensureDataDir();
  const cur = readJson(LOCK_FILE);
  if (cur?.pid && cur.pid !== process.pid) {
    let alive = true;
    try { process.kill(cur.pid, 0); } catch { alive = false; }
    if (alive) throw new Error(`another offload/fetch run is active (pid ${cur.pid})`);
  }
  writeJson(LOCK_FILE, { pid: process.pid, ts: new Date().toISOString() });
}
function releaseLock() {
  const cur = readJson(LOCK_FILE);
  if (cur?.pid === process.pid) { try { unlinkSync(LOCK_FILE); } catch { /* gone */ } }
}
async function locked(fn) {
  acquireLock();
  try { return await fn(); } finally { releaseLock(); }
}

// ---------- validation ----------

function protectedPaths(cfg) {
  return (cfg.protected || []).map((x) => path.resolve(expandHome(x)));
}

// Throws with a human reason if `abs` must not be offloaded. Returns lstat.
export function validateSource(abs, cfg, pins = []) {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) throw new Error('is a symlink');
  if (!st.isFile()) throw new Error('not a regular file');
  const real = realpathSync(abs);
  if (!real.startsWith(HOME + path.sep)) throw new Error(`outside ${HOME}`);
  if (abs.endsWith(STUB_EXT)) throw new Error('is already an offload stub');
  if (st.nlink > 1) throw new Error('has hard links — removing it would not free space');
  if (real.startsWith(path.join(HOME, 'Library') + path.sep)) throw new Error('inside ~/Library (app data)');
  if (real.startsWith(DATA_DIR + path.sep)) throw new Error("is cleandrive's own data");
  const segs = real.split(path.sep);
  if (segs.some((s) => NEVER_SEGMENTS.has(s))) throw new Error('inside .git/node_modules/.venv/.Trash');
  if (segs.some((s) => NEVER_SUFFIXES.some((x) => s.endsWith(x)))) throw new Error('inside an app/media library package');
  if (protectedPaths(cfg).some((pp) => real === pp || real.startsWith(pp + path.sep))) throw new Error('user-protected (config.protected)');
  if (isPinned(real, pins)) throw new Error('pinned (keep local)');
  return st;
}

async function inUse(abs) {
  const r = await run('lsof', ['-t', '--', abs]);
  return r.code === 0 && r.out.trim().length > 0;
}

// Expand dirs to files >= minMB (recursive, pruned like validateSource).
function expandPaths(inputs, minMB) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (NEVER_SEGMENTS.has(e.name) || NEVER_SUFFIXES.some((x) => e.name.endsWith(x))) continue;
        walk(p);
      } else if (e.isFile() && !e.name.endsWith(STUB_EXT)) {
        try { if (statSync(p).size >= minMB * 1048576) out.push(p); } catch { /* vanished */ }
      }
    }
  };
  for (const raw of inputs) {
    const abs = path.resolve(expandHome(raw));
    let st;
    try { st = lstatSync(abs); } catch { out.push(abs); continue; } // reported later as missing
    if (st.isDirectory()) walk(abs); else out.push(abs);
  }
  return [...new Set(out)];
}

// ---------- stub ----------

export function readStub(stubPath) {
  let j;
  try { j = JSON.parse(readFileSync(stubPath, 'utf8')); } catch { return null; }
  return j && j.cleandrive === 'offload-stub' && /^[0-9a-f]{64}$/.test(j.sha256 || '') ? j : null;
}

function writeStub(abs, meta, cfg) {
  const base = remoteBase(cfg);
  const stub = {
    cleandrive: 'offload-stub',
    v: 1,
    name: path.basename(abs),
    path: abs,
    size: meta.size,
    sha256: meta.sha256,
    mtimeMs: meta.mtimeMs,
    object: objectRel(meta.sha256),
    remote: { host: cfg.remote.host, user: cfg.remote.user, path: base, uuid: cfg.remote.uuid },
    offloadedAt: new Date().toISOString(),
    howToRestore: `cleandrive fetch ${q(abs + STUB_EXT)}   — or by hand: rsync ${remoteDest(cfg)}:${base}/${objectRel(meta.sha256)} ${q(abs)}`,
  };
  writeFileAtomic(abs + STUB_EXT, JSON.stringify(stub, null, 2) + '\n');
  return stub;
}

// ---------- offload ----------

async function offloadOne(abs, cfg, idx, { dryRun, onData }) {
  const st = validateSource(abs, cfg, idx.pins || []);
  if (await inUse(abs)) throw new Error('open in another process (lsof) — close it first');
  onData?.(`  hashing ${short(abs)} (${(st.size / 1048576).toFixed(0)} MB)…\n`);
  const sha = await sha256File(abs);
  const rel = objectRel(sha);
  const base = remoteBase(cfg);

  // Always prove the UUID-pinned drive is mounted first: an unmounted drive
  // leaves an empty mount point on the remote's root fs that must never be used.
  const drive = await checkRemoteDrive(cfg, Math.ceil(st.size / 1024));
  if (!drive.ok) throw new Error(`refusing: ${drive.msg}`);
  const existing = await remoteSha(cfg, rel);
  const dedupe = existing === sha;
  if (existing && !dedupe) onData?.(`  ⚠ remote object ${rel} is corrupt (hash ${existing.slice(0, 12)}…) — re-uploading\n`);
  if (dryRun) return { path: abs, sha256: sha, size: st.size, dryRun: true, upload: !dedupe };

  if (!dedupe) {
    const mk = await ssh(cfg, `mkdir -p ${q(path.posix.dirname(base + '/' + rel))}`);
    if (mk.code !== 0) throw new Error('remote mkdir failed: ' + mk.err.trim());
    const part = `${base}/${rel}.part`;
    onData?.(`  ↑ uploading to ${cfg.remote.host}…\n`);
    const up = await withRetry(cfg, 'upload', () => run('rsync', [...rsyncArgs(cfg), abs, `${remoteDest(cfg)}:${part}`]), onData);
    if (up.code !== 0) throw new Error(`upload failed after ${opt(cfg).retries} attempts — local file kept`);
    const got = await remoteSha(cfg, `${rel}.part`);
    if (got !== sha) {
      await ssh(cfg, `rm -f -- ${q(part)}`);
      throw new Error(`remote checksum mismatch (${(got || 'missing').slice(0, 12)}…) — local file kept`);
    }
    const mv = await ssh(cfg, `mv -f -- ${q(part)} ${q(base + '/' + rel)}`);
    if (mv.code !== 0) throw new Error('remote rename failed: ' + mv.err.trim());
  }

  // The file must not have changed while we hashed/uploaded.
  const now = lstatSync(abs);
  if (now.size !== st.size || now.mtimeMs !== st.mtimeMs) throw new Error('file changed during offload — local file kept');

  const stub = writeStub(abs, { size: st.size, sha256: sha, mtimeMs: st.mtimeMs }, cfg);
  const entry = { path: abs, size: st.size, sha256: sha, mtimeMs: st.mtimeMs, object: rel, state: 'offloaded', offloadedAt: stub.offloadedAt };
  const line = Buffer.from(JSON.stringify({ event: 'offload', ...entry, mac: process.env.USER }) + '\n').toString('base64');
  const man = await ssh(cfg, `echo ${line} | base64 -d >> ${q(base + '/manifest.jsonl')}`);
  if (man.code !== 0) onData?.('  ⚠ remote manifest append failed (stub + local index still hold the record)\n');
  idx.files[abs] = entry;
  saveIndex(idx);
  unlinkSync(abs);
  log({ event: 'offload', path: abs, sha256: sha, kb: Math.round(st.size / 1024), dedupe, ok: true, verified: true });
  return { path: abs, sha256: sha, size: st.size, dedupe, ok: true };
}

export async function offloadPaths(inputs, { dryRun = false, minMB = 50, onData } = {}) {
  const cfg = loadConfig();
  const files = expandPaths(inputs, minMB);
  const run1 = async () => {
    const idx = loadIndex();
    const results = [];
    for (const abs of files) {
      onData?.(`${dryRun ? '[dry-run] ' : '▶ '}offload ${short(abs)}\n`);
      try {
        const r = await offloadOne(abs, cfg, idx, { dryRun, onData });
        onData?.(dryRun
          ? `  would ${r.upload ? 'upload' : 'reuse existing remote copy of'} ${(r.size / 1048576).toFixed(0)} MB\n`
          : `  ✓ offloaded${r.dedupe ? ' (already on remote — dedupe)' : ''}, stub ${path.basename(abs)}${STUB_EXT}\n`);
        results.push({ ...r, ok: true });
      } catch (e) {
        onData?.(`  ✗ ${e.message}\n`);
        if (!dryRun) log({ event: 'offload', path: abs, ok: false, error: e.message });
        results.push({ path: abs, ok: false, error: e.message });
      }
    }
    return results;
  };
  return dryRun ? run1() : locked(run1);
}

// ---------- fetch ----------

function stubFor(p) {
  const abs = path.resolve(expandHome(p));
  return abs.endsWith(STUB_EXT) ? abs : abs + STUB_EXT;
}

function expandStubs(inputs) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(STUB_EXT)) out.push(p);
    }
  };
  for (const raw of inputs) {
    const abs = path.resolve(expandHome(raw));
    try { if (lstatSync(abs).isDirectory()) { walk(abs); continue; } } catch { /* not a dir */ }
    out.push(stubFor(abs));
  }
  return [...new Set(out)];
}

async function fetchOne(stubPath, cfg, idx, { dryRun, onData }) {
  const stub = readStub(stubPath);
  if (!stub) throw new Error(`${short(stubPath)} is not a cleandrive stub`);
  const target = stubPath.slice(0, -STUB_EXT.length);
  if (!target.startsWith(HOME + path.sep)) throw new Error(`outside ${HOME}`);

  if (existsSync(target)) {
    // Crash between "stub written" and "original unlinked", or fetched by hand.
    const h = await sha256File(target);
    if (h !== stub.sha256) throw new Error(`${short(target)} exists with different content — resolve by hand, nothing changed`);
    if (!dryRun) unlinkSync(stubPath);
    return { path: target, ok: true, already: true };
  }
  const free = statfsSync(path.dirname(target));
  const freeBytes = free.bavail * free.bsize;
  if (freeBytes < stub.size + 1073741824) throw new Error(`not enough local space: ${(freeBytes / 1073741824).toFixed(1)} GB free, need ${(stub.size / 1073741824 + 1).toFixed(1)} GB`);
  const drive = await checkRemoteDrive(cfg);
  if (!drive.ok) throw new Error(drive.msg);
  const remoteHash = await remoteSha(cfg, stub.object);
  if (!remoteHash) throw new Error(`remote object ${stub.object} missing — see ${remoteBase(cfg)}/manifest.jsonl`);
  if (remoteHash !== stub.sha256) throw new Error(`remote copy corrupt (hash ${remoteHash.slice(0, 12)}…) — stub kept`);
  if (dryRun) return { path: target, size: stub.size, dryRun: true };

  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.cleandrive-fetch`);
  onData?.(`  ↓ downloading ${(stub.size / 1048576).toFixed(0)} MB…\n`);
  const dl = await withRetry(cfg, 'download', () => run('rsync', [...rsyncArgs(cfg), `${remoteDest(cfg)}:${remoteBase(cfg)}/${stub.object}`, tmp]), onData);
  if (dl.code !== 0) throw new Error(`download failed after ${opt(cfg).retries} attempts — stub kept (partial ${path.basename(tmp)} resumes next time)`);
  const h = await sha256File(tmp);
  if (h !== stub.sha256) {
    unlinkSync(tmp);
    throw new Error('downloaded file checksum mismatch — discarded, stub kept');
  }
  renameSync(tmp, target);
  if (stub.mtimeMs) { const t = new Date(stub.mtimeMs); utimesSync(target, t, t); }
  unlinkSync(stubPath);
  const prev = idx.files[target] || {};
  idx.files[target] = { ...prev, path: target, size: stub.size, sha256: stub.sha256, object: stub.object, state: 'local', fetchedAt: new Date().toISOString() };
  saveIndex(idx);
  log({ event: 'fetch', path: target, sha256: stub.sha256, kb: Math.round(stub.size / 1024), ok: true, verified: true });
  return { path: target, size: stub.size, ok: true };
}

export async function fetchPaths(inputs, { dryRun = false, onData } = {}) {
  const cfg = loadConfig();
  const stubs = expandStubs(inputs);
  const run1 = async () => {
    const idx = loadIndex();
    const results = [];
    for (const s of stubs) {
      onData?.(`${dryRun ? '[dry-run] ' : '▶ '}fetch ${short(s.slice(0, -STUB_EXT.length))}\n`);
      try {
        const r = await fetchOne(s, cfg, idx, { dryRun, onData });
        onData?.(r.already ? '  ✓ already local (same content) — stub removed\n' : dryRun ? '  would download, remote copy verified\n' : '  ✓ fetched and verified\n');
        results.push({ ...r, ok: true });
      } catch (e) {
        onData?.(`  ✗ ${e.message}\n`);
        if (!dryRun) log({ event: 'fetch', path: s, ok: false, error: e.message });
        results.push({ path: s, ok: false, error: e.message });
      }
    }
    return results;
  };
  return dryRun ? run1() : locked(run1);
}

// ---------- list / verify ----------

// Index entries, reconciled with what is actually on disk right now.
export function listOffloaded() {
  const idx = loadIndex();
  const files = Object.values(idx.files).map((f) => {
    const stub = existsSync(f.path + STUB_EXT);
    const local = existsSync(f.path);
    return { ...f, state: stub && !local ? 'offloaded' : local ? 'local' : 'missing' };
  }).sort((a, b) => b.size - a.size);
  return { files, pins: idx.pins || [] };
}

export async function verifyRemote({ onData } = {}) {
  const cfg = loadConfig();
  const drive = await checkRemoteDrive(cfg);
  if (!drive.ok) throw new Error(drive.msg);
  const { files } = listOffloaded();
  const objs = new Map();
  for (const f of files) if (f.object) objs.set(f.object, f);
  const bad = [];
  for (const [rel, f] of objs) {
    const h = await remoteSha(cfg, rel);
    const ok = h === f.sha256;
    onData?.(`${ok ? '✓' : '✗'} ${short(f.path)}${ok ? '' : h ? ' — CORRUPT on remote' : ' — MISSING on remote'}\n`);
    if (!ok) bad.push({ ...f, remoteSha: h });
  }
  log({ event: 'offload-verify', checked: objs.size, bad: bad.length, ok: bad.length === 0 });
  return { checked: objs.size, bad };
}

// ---------- candidates (read-only strategy) ----------

// mtime + Spotlight's "last opened". Not atime: hashing, Quick Look and
// Spotlight indexing all bump it, so a candidate would never look idle again.
async function lastUsedMs(p, st) {
  let t = st.mtimeMs;
  const r = await run('mdls', ['-raw', '-name', 'kMDItemLastUsedDate', p]);
  const d = Date.parse(r.out.trim());
  if (Number.isFinite(d)) t = Math.max(t, d);
  return t;
}

export async function findCandidates({ minMB = 200, days = 30, allTypes = false, dupes = true, onData } = {}) {
  const cfg = loadConfig();
  const idx = loadIndex();
  const pins = idx.pins || [];
  const roots = [...DEFAULT_ROOTS, ...(cfg.extraDirs || []), ...(cfg.offload?.roots || [])]
    .map((r) => path.resolve(expandHome(r))).filter(existsSync);
  const found = new Map();
  let unreadable = 0;
  for (const root of roots) {
    onData?.(`  searching ${short(root)}…\n`);
    const prune = ['(', '-name', 'Library', '-o', '-name', '.git', '-o', '-name', 'node_modules', '-o', '-name', '.venv', '-o', '-name', '.Trash',
      ...NEVER_SUFFIXES.flatMap((s) => ['-o', '-name', `*${s}`]), ')', '-prune'];
    const r = await run('find', [root, ...prune, '-o', '-type', 'f', '-size', `+${minMB}M`, '-print0']);
    unreadable += (r.err.match(/Operation not permitted|Permission denied/g) || []).length;
    for (const p of r.out.split('\0').filter(Boolean)) found.set(p, true);
  }
  const cutoff = Date.now() - days * 864e5;
  const all = [];
  for (const p of found.keys()) {
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!allTypes && !MEDIA_EXT.has(ext)) continue;
    let st;
    try { st = validateSource(p, cfg, pins); } catch { continue; }
    all.push({ path: p, size: st.size, kb: Math.round(st.size / 1024), lastUsed: await lastUsedMs(p, st), st });
  }
  // duplicates: same size → sha256
  if (dupes) {
    const bySize = new Map();
    for (const c of all) bySize.set(c.size, [...(bySize.get(c.size) || []), c]);
    for (const group of bySize.values()) {
      if (group.length < 2) continue;
      for (const c of group) { onData?.(`  hashing possible duplicate ${short(c.path)}…\n`); c.sha256 = await sha256File(c.path); }
      const byHash = new Map();
      for (const c of group) byHash.set(c.sha256, [...(byHash.get(c.sha256) || []), c]);
      for (const same of byHash.values()) {
        if (same.length < 2) continue;
        same.sort((a, b) => b.lastUsed - a.lastUsed);
        for (const c of same.slice(1)) c.duplicateOf = same[0].path;
      }
    }
  }
  const out = all
    .filter((c) => c.duplicateOf || c.lastUsed < cutoff)
    .map(({ st, ...c }) => ({ ...c, idleDays: Math.floor((Date.now() - c.lastUsed) / 864e5) }))
    .sort((a, b) => (!!b.duplicateOf - !!a.duplicateOf) || b.size - a.size);
  const res = { ts: new Date().toISOString(), minMB, days, roots: roots.map(short), unreadable, candidates: out };
  ensureDataDir();
  writeJson(CANDIDATES_FILE, res);
  return res;
}

export function loadCandidates() {
  return readJson(CANDIDATES_FILE);
}
