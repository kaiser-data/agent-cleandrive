import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  HOME, DATA_DIR, expandHome, loadConfig, idFor, ensureDataDir, writeJson, run, pool,
} from './util.js';

// Categories (fixed order — drives the dashboard's categorical color slots)
export const CATEGORIES = {
  pkgcache: { label: 'Package caches', risk: 'low', desc: 'Package-manager caches with an official clean command. Fully regenerable.' },
  cache: { label: 'App & tool caches', risk: 'low', desc: 'Cache directories apps rebuild on demand. Safe to delete.' },
  node_modules: { label: 'node_modules', risk: 'low', desc: 'Reinstallable with npm/pnpm/bun install in each project.' },
  projects: { label: 'Projects', risk: 'medium', desc: 'Your work. Archive to the remote drive, verify, then optionally remove locally.' },
  appdata: { label: 'App data', risk: 'review', desc: 'Large app storage (chats, models, wallpapers). Review manually — not auto-deletable.' },
  apps: { label: 'Applications', risk: 'review', desc: 'Installed .app bundles with size and last-used date. Uninstall the ones you no longer open (review-only here).' },
  models: { label: 'AI models', risk: 'review', desc: 'Local model weights. Remove via the owning tool (e.g. ollama rm).' },
};

const APP_ROOTS = ['/Applications', '~/Applications'];

// Package caches that have a proper clean command
const PKG_CACHES = [
  { p: '~/.cache/uv', cmd: 'uv cache clean', label: 'uv package cache' },
  { p: '~/.npm', cmd: 'npm cache clean --force', label: 'npm cache' },
  { p: '~/Library/Caches/Homebrew', cmd: 'brew cleanup -s --prune=all', label: 'Homebrew downloads' },
  { p: '~/Library/pnpm', cmd: 'pnpm store prune', label: 'pnpm store' },
  { p: '~/.bun/install/cache', cmd: 'bun pm cache rm', label: 'bun cache' },
  { p: '~/.pub-cache', cmd: null, label: 'dart pub cache' },
];

const APPDATA_ROOTS = [
  '~/Library/Application Support',
  '~/Library/Group Containers',
  '~/Library/Containers',
];

// Paths the scan could not (fully) measure, reported in scan.blocked so the
// gap between `df` and the scan is explained instead of silently dropped.
let blocked = [];
let duTimeoutMs = 60000;

async function duKB(p) {
  const r = await run('du', ['-xsk', p], { timeoutMs: duTimeoutMs });
  if (r.timedOut) {
    blocked.push({ path: p, reason: `du timed out after ${duTimeoutMs / 1000}s — likely needs Full Disk Access` });
    return null;
  }
  if (/Operation not permitted/.test(r.err)) {
    blocked.push({ path: p, reason: 'partly unreadable — needs Full Disk Access' });
  }
  if (r.code !== 0 && !r.out) return null;
  const kb = parseInt(r.out.split('\t')[0], 10);
  return Number.isFinite(kb) ? kb : null;
}

async function dfData() {
  const r = await run('df', ['-k', '/System/Volumes/Data']);
  const line = r.out.trim().split('\n').pop().split(/\s+/);
  // APFS: df's "used" counts only the Data volume, but "size" is the whole shared
  // container — so used = size - avail, else used/size/free contradict each other
  const sizeKB = Number(line[1]), availKB = Number(line[3]), usedKB = sizeKB - availKB;
  return { sizeKB, usedKB, availKB, pct: Math.round((usedKB / sizeKB) * 100) };
}

// Was anything inside touched in the last N days? (cheap: stop at first hit)
async function activeWithin(p, days) {
  const r = await run('find', [p, '-type', 'f', '-mtime', `-${days}`, '-print', '-quit']);
  return r.out.trim().length > 0;
}

function safeStatMtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

function listDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
}

export async function runScan(onProgress = () => {}) {
  ensureDataDir();
  const cfg = loadConfig();
  const staleDays = cfg.staleDays ?? 60;
  blocked = [];
  duTimeoutMs = (cfg.duTimeoutSec ?? 60) * 1000;
  const minCacheKB = (cfg.minCacheMB ?? 100) * 1024;
  const minAppDataKB = (cfg.minAppDataMB ?? 500) * 1024;
  const items = [];
  const claimed = new Set();
  const scanStartedIso = new Date().toISOString();

  const add = (p, category, extra = {}) => {
    items.push({ id: idFor(p), path: p, category, ...extra });
  };

  // 1. Package caches
  onProgress('scanning package caches');
  for (const c of PKG_CACHES) {
    const p = expandHome(c.p);
    if (!existsSync(p)) continue;
    claimed.add(p);
    const kb = await duKB(p);
    if (kb) add(p, 'pkgcache', { kb, label: c.label, cleanCmd: c.cmd, suggest: c.cmd ? 'clean' : 'rm', note: c.cmd ? `runs: ${c.cmd}` : 'no clean command — removed directly, rebuilt on next use' });
  }

  // 2. Generic caches: ~/.cache/* and ~/Library/Caches/* above threshold
  onProgress('scanning cache directories');
  const cacheDirs = [...listDirs(expandHome('~/.cache')), ...listDirs(expandHome('~/Library/Caches'))]
    .filter((p) => !claimed.has(p));
  const cacheSizes = await pool(cacheDirs, 4, (p) => duKB(p));
  cacheDirs.forEach((p, i) => {
    const kb = cacheSizes[i];
    if (kb && kb >= minCacheKB) add(p, 'cache', { kb, suggest: 'rm', note: 'rebuilt automatically by the app' });
  });

  // 2b. Explicit regenerable caches from config.extraCaches — may live under a
  // protected root (e.g. Claude desktop's vm_bundles); exempted by exact path.
  for (const raw of cfg.extraCaches || []) {
    const p = expandHome(raw);
    if (!existsSync(p) || claimed.has(p)) continue;
    claimed.add(p);
    const kb = await duKB(p);
    if (kb) add(p, 'cache', { kb, suggest: 'rm', note: 'regenerable — re-downloaded/rebuilt on next use (quit the owning app first)' });
  }

  // 3. node_modules in project roots
  onProgress('finding node_modules');
  const projectRoots = [...(cfg.projectRoots || []), ...(cfg.extraDirs || [])].map(expandHome).filter(existsSync);
  const nmDirs = [];
  for (const root of projectRoots) {
    const r = await run('find', [root, '-maxdepth', '5', '-type', 'd', '-name', 'node_modules', '-prune']);
    nmDirs.push(...r.out.trim().split('\n').filter(Boolean));
  }
  const nmSizes = await pool(nmDirs, 4, (p) => duKB(p));
  const nmByPath = new Map();
  nmDirs.forEach((p, i) => { if (nmSizes[i]) nmByPath.set(p, nmSizes[i]); });
  for (const [p, kb] of nmByPath) {
    if (kb >= 50 * 1024) add(p, 'node_modules', { kb, suggest: 'rm', note: 'reinstall with the project\'s package manager' });
  }

  // 4. Project directories (top level of each project root, plus extraDirs themselves)
  onProgress('scanning projects');
  const projDirs = [];
  for (const root of (cfg.projectRoots || []).map(expandHome).filter(existsSync)) projDirs.push(...listDirs(root));
  for (const d of (cfg.extraDirs || []).map(expandHome).filter(existsSync)) projDirs.push(d);
  const projSizes = await pool(projDirs, 4, (p) => duKB(p));
  const projActive = await pool(projDirs, 4, (p) => activeWithin(p, staleDays));
  projDirs.forEach((p, i) => {
    const kb = projSizes[i];
    if (!kb || kb < 20 * 1024) return;
    // size excluding contained node_modules (those are their own line items)
    let nmKb = 0;
    for (const [nm, nkb] of nmByPath) if (nm.startsWith(p + path.sep)) nmKb += nkb;
    const netKb = Math.max(0, kb - nmKb);
    const active = projActive[i];
    add(p, 'projects', {
      kb: netKb, grossKb: kb, active, mtime: safeStatMtime(p),
      suggest: active ? 'keep' : 'archive',
      note: active ? `touched within ${staleDays} days` : `no changes in ${staleDays}+ days — archive candidate`,
    });
  });

  // 5. Large app data (review only)
  onProgress('scanning app data');
  const adDirs = APPDATA_ROOTS.flatMap((r) => listDirs(expandHome(r)));
  const adSizes = await pool(adDirs, 4, (p) => duKB(p));
  adDirs.forEach((p, i) => {
    const kb = adSizes[i];
    if (kb && kb >= minAppDataKB) add(p, 'appdata', { kb, suggest: 'review', note: 'inspect before touching — may hold chats, settings, licenses' });
  });

  // 6. Applications — bundle size + last-used date, correlated with app-support data
  onProgress('scanning applications');
  const appBundles = [];
  for (const root of APP_ROOTS) {
    const dir = expandHome(root);
    if (!existsSync(dir)) continue;
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.endsWith('.app')) appBundles.push(path.join(dir, e.name));
      }
    } catch { /* skip */ }
  }
  const appSizes = await pool(appBundles, 4, (p) => duKB(p));
  const appUsed = await pool(appBundles, 6, async (p) => {
    // Primary: Spotlight last-used date. Fallback: latest access time seen across
    // the bundle's Info.plist / executable (survives when Spotlight has no usage record).
    const r = await run('mdls', ['-raw', '-name', 'kMDItemLastUsedDate', p]);
    const v = r.out.trim();
    if (v && v !== '(null)') return v;
    const a = await run('stat', ['-f', '%a', path.join(p, 'Contents', 'Info.plist')]);
    const secs = parseInt(a.out.trim(), 10);
    return Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null;
  });
  // Index appdata sizes by lowercased basename for correlation
  const adIndex = new Map();
  for (const it of items.filter((i) => i.category === 'appdata')) {
    adIndex.set(path.basename(it.path).toLowerCase(), it.kb);
  }
  const nowMs = Date.parse(scanStartedIso);
  appBundles.forEach((p, i) => {
    const kb = appSizes[i];
    if (!kb || kb < 50 * 1024) return;
    const name = path.basename(p, '.app');
    const lastUsed = appUsed[i];
    const daysIdle = lastUsed ? Math.round((nowMs - Date.parse(lastUsed)) / 86400000) : null;
    // Correlate app-support footprint by fuzzy name match
    let dataKb = 0;
    const key = name.toLowerCase();
    for (const [adName, adKb] of adIndex) {
      if (adName.includes(key) || key.includes(adName.split('.').pop())) dataKb += adKb;
    }
    const stale = daysIdle != null && daysIdle >= 120;
    add(p, 'apps', {
      kb, lastUsed, daysIdle, dataKb,
      suggest: 'review',
      note: (daysIdle == null ? 'last-used unknown' : `last opened ${daysIdle}d ago`)
        + (dataKb ? ` · +${Math.round(dataKb / 1024)}MB app data` : '')
        + (stale ? ' · idle 120d+ — uninstall candidate' : ''),
    });
  });

  // 7. Models
  const ollama = expandHome('~/.ollama');
  if (existsSync(ollama)) {
    const kb = await duKB(ollama);
    if (kb) add(ollama, 'models', { kb, suggest: 'review', note: 'ollama list && ollama rm <model>' });
  }

  // User-protected paths (e.g. Claude agent/coding history): always keep, never actionable
  // — except exact config.extraCaches entries, which the user declared regenerable.
  const protectedPaths = (cfg.protected || []).map(expandHome);
  const extraCacheSet = new Set((cfg.extraCaches || []).map(expandHome));
  for (const it of items) {
    if (extraCacheSet.has(it.path)) continue;
    if (protectedPaths.some((pp) => it.path === pp || it.path.startsWith(pp + path.sep))) {
      it.protected = true;
      it.suggest = 'keep';
      it.note = 'protected in config.json — never touched by cleandrive';
    }
  }

  items.sort((a, b) => b.kb - a.kb);
  const disk = await dfData();
  const scan = { ts: new Date().toISOString(), disk, staleDays, items, blocked };
  writeJson(path.join(DATA_DIR, 'latest.json'), scan);
  onProgress('done');
  return scan;
}
