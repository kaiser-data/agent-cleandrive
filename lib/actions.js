import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  HOME, DATA_DIR, loadConfig, readJson, writeJson, run, runShell, ensureDataDir,
} from './util.js';

const PLAN_FILE = path.join(DATA_DIR, 'plan.json');
const LOG_FILE = path.join(DATA_DIR, 'actions.log');

// Categories whose items may be deleted directly (regenerable data only).
const RM_ALLOWED = new Set(['pkgcache', 'cache', 'node_modules']);
// Review-only categories where rm unlocks only after an explicit human review
// (plan.reviewed === true). Apps stay manual: outside $HOME, often root-owned.
const REVIEW_RM_UNLOCK = new Set(['appdata', 'models']);
// Never touch these paths or anything above them, whatever the plan says.
const DENY = ['~', '~/Documents', '~/Desktop', '~/Downloads', '~/Pictures', '~/Library']
  .map((p) => (p === '~' ? HOME : path.join(HOME, p.slice(2))));

export function loadPlan() {
  return readJson(PLAN_FILE, { items: {} });
}

export function savePlan(plan) {
  ensureDataDir();
  writeJson(PLAN_FILE, plan);
}

export function setPlanItem(id, patch) {
  const plan = loadPlan();
  plan.items[id] = { ...(plan.items[id] || {}), ...patch, updated: new Date().toISOString() };
  savePlan(plan);
  return plan.items[id];
}

// Apply many plan changes in one read/write (dashboard one-click presets).
export function setPlanItems(changes) {
  const plan = loadPlan();
  const updated = new Date().toISOString();
  for (const { id, ...patch } of changes) {
    if (!id) continue;
    plan.items[id] = { ...(plan.items[id] || {}), ...patch, updated };
  }
  savePlan(plan);
  return plan;
}

export function log(entry) {
  ensureDataDir();
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

function latestScan() {
  return readJson(path.join(DATA_DIR, 'latest.json'));
}

// A path is only actionable if it came out of the scan (allowlist by construction),
// lives under $HOME, and is not a protected root.
function validateTarget(item) {
  const p = path.resolve(item.path);
  if (!p.startsWith(HOME + path.sep)) throw new Error(`refusing: ${p} is outside ${HOME}`);
  if (p.includes('..')) throw new Error('refusing: path traversal');
  if (DENY.includes(p)) throw new Error(`refusing: ${p} is a protected directory`);
  const cfg = loadConfig();
  const protectedPaths = (cfg.protected || []).map((x) => path.resolve(x.replace(/^~/, HOME)));
  // Exact config.extraCaches entries are user-declared regenerable and exempt
  // from the protected lock (subpaths of them are NOT — only the listed dir).
  const extraCaches = new Set((cfg.extraCaches || []).map((x) => path.resolve(x.replace(/^~/, HOME))));
  for (const pp of protectedPaths) {
    if ((p === pp || p.startsWith(pp + path.sep)) && !extraCaches.has(p)) {
      throw new Error(`refusing: ${p} is user-protected (config.protected)`);
    }
  }
  return p;
}

function remoteTarget(cfg) {
  const { host, user, path: rpath } = cfg.remote || {};
  if (!host || !rpath) throw new Error('remote not configured (set remote.host and remote.path in config.json)');
  return `${user ? user + '@' : ''}${host}:${rpath.replace(/\/$/, '')}/`;
}

// Extra ssh flags from config.remote (custom identity file / non-22 port).
// sshKey is expanded from ~ and validated to exist so a typo fails loudly.
export function sshOpts(cfg) {
  const { sshKey, sshPort } = cfg.remote || {};
  const opts = [];
  if (sshPort && Number(sshPort) !== 22) opts.push('-p', String(Number(sshPort)));
  if (sshKey) {
    const keyPath = path.resolve(sshKey.replace(/^~/, HOME));
    if (!existsSync(keyPath)) throw new Error(`remote.sshKey not found: ${keyPath}`);
    opts.push('-i', keyPath);
  }
  return opts;
}

// The `-e` transport string rsync uses to invoke ssh, mirroring sshOpts().
function rsyncShell(cfg) {
  const opts = sshOpts(cfg);
  return opts.length ? ['-e', ['ssh', ...opts].join(' ')] : [];
}

// The archive path must live on the real archive drive, not on an empty mount
// point of the remote's system disk (drive unplugged / not mounted). With
// remote.uuid set, the filesystem holding remote.path must have that UUID;
// without it, it must at least not be the remote's root filesystem.
// needKB (+5% margin) is checked against the drive's free space.
export async function checkRemoteDrive(cfg, needKB = 0) {
  const { host, user, path: rpath, uuid } = cfg.remote || {};
  const dest = `${user ? user + '@' : ''}${host}`;
  const base = ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', ...sshOpts(cfg)];
  const q = `'${rpath.replace(/'/g, `'\\''`)}'`;
  const r = await run('ssh', [...base, dest, `findmnt -n -b -o UUID,TARGET,AVAIL -T ${q}`]);
  if (r.code === 255) return { ok: false, reachable: false, mounted: false, msg: (r.err || 'unreachable').trim().split('\n').pop() };
  const [fsUuid, target, avail] = r.out.trim().split(/\s+/);
  if (r.code !== 0 || !target) return { ok: false, reachable: true, mounted: false, msg: `archive path ${rpath} not found — is the archive drive mounted?` };
  const freeKB = Math.floor(Number(avail) / 1024);
  const mounted = uuid ? fsUuid === uuid : target !== '/';
  if (!mounted) {
    return { ok: false, reachable: true, mounted, freeKB, msg: `archive drive not mounted: ${rpath} is on ${target} (uuid ${fsUuid || '?'})${uuid ? `, expected uuid ${uuid}` : ''}` };
  }
  if (needKB && freeKB < needKB * 1.05) {
    return { ok: false, reachable: true, mounted, freeKB, msg: `not enough space on archive drive: ${Math.round(freeKB / 1024)} MB free, need ~${Math.round(needKB * 1.05 / 1024)} MB` };
  }
  return { ok: true, reachable: true, mounted, freeKB, msg: `archive drive mounted at ${target} — ${(freeKB / 1048576).toFixed(0)} GB free` };
}

export async function testRemote() {
  const cfg = loadConfig();
  const { host, path: rpath } = cfg.remote || {};
  if (!host || !rpath) return { ok: false, reachable: false, mounted: false, msg: 'remote not configured (set remote.host and remote.path in config.json)' };
  try { return await checkRemoteDrive(cfg); } catch (e) { return { ok: false, reachable: false, mounted: false, msg: e.message }; }
}

// rsync src into remote archive, preserving the path relative to $HOME.
// Returns { ok, verified, output }.
export async function archive(item, { dryRun = false, onData } = {}) {
  const cfg = loadConfig();
  const src = validateTarget(item);
  const rel = './' + path.relative(HOME, src);
  const dest = remoteTarget(cfg);
  const transport = rsyncShell(cfg);
  const drive = await checkRemoteDrive(cfg, item.kb || 0);
  if (!drive.ok) return { ok: false, verified: false, output: `refusing archive: ${drive.msg}` };
  // Portable flags only: macOS ships openrsync ("2.6.9 compatible"), which
  // rejects rsync 3.x options like --info=. --stats/--partial work everywhere.
  const args = ['-aHR', '--partial', '--stats', ...transport];
  if (dryRun) args.push('-n');
  const r = await run('rsync', [...args, rel, dest], { cwd: HOME, onData });
  if (r.code !== 0) return { ok: false, verified: false, output: r.err || r.out };
  if (dryRun) return { ok: true, verified: false, output: r.out };
  // Verify: checksum dry-run must report no differing files. Metadata-only
  // lines (times/perms/owner, e.g. symlink perms unrepresentable on ext4) are
  // ignored; content differences always carry a 'c' (checksum), 's' (size) or
  // '+' (missing on remote) flag, or a non-'.' update type (*deleting, >f…).
  const v = await run('rsync', ['-aHRnc', '--itemize-changes', ...transport, rel, dest], { cwd: HOME });
  const changes = v.out.trim().split('\n').filter(Boolean).filter((l) => {
    const flags = l.split(' ')[0];
    return flags[0] !== '.' || flags.includes('c') || flags.includes('s') || flags.includes('+');
  }).length;
  const verified = v.code === 0 && changes === 0;
  return { ok: true, verified, output: r.out + (verified ? '\nVERIFIED: checksums match' : `\nVERIFY FAILED: ${changes} differences`) };
}

export async function executeItem(item, { onData = () => {} } = {}) {
  const p = validateTarget(item);
  const action = item.plannedAction || item.suggest;
  log({ event: 'start', id: item.id, path: p, action });

  let result;
  if (action === 'clean' && item.cleanCmd) {
    result = await runShell(item.cleanCmd, { onData });
    // Some caches keep residue after the official clean (e.g. npm _cacache logs) — that's fine.
    result = { ok: result.code === 0, output: (result.out + result.err).slice(-4000) };
  } else if (action === 'rm') {
    const reviewUnlocked = REVIEW_RM_UNLOCK.has(item.category) && item.reviewed === true;
    if (!RM_ALLOWED.has(item.category) && !reviewUnlocked) {
      const hint = REVIEW_RM_UNLOCK.has(item.category) ? ' (mark it reviewed first)' : '';
      throw new Error(`refusing rm: category '${item.category}' is not deletable${hint}`);
    }
    const r = await run('rm', ['-rf', p], { onData });
    result = { ok: r.code === 0, output: r.err || 'removed' };
  } else if (action === 'archive' || action === 'archive+rm') {
    const a = await archive(item, { onData });
    result = { ok: a.ok, verified: a.verified, output: a.output.slice(-4000) };
    if (action === 'archive+rm') {
      if (!a.ok || !a.verified) {
        result.output += '\nlocal copy KEPT (transfer not verified)';
      } else {
        const r = await run('rm', ['-rf', p]);
        result.output += r.code === 0 ? '\nlocal copy removed after verification' : `\nrm failed: ${r.err}`;
        result.ok = r.code === 0;
      }
    }
  } else {
    result = { ok: false, output: `no executable action for '${action}' (review items are manual)` };
  }

  log({ event: 'done', id: item.id, path: p, action, ok: result.ok, verified: result.verified });
  setPlanItem(item.id, { status: result.ok ? 'done' : 'failed', lastOutput: result.output.slice(-2000) });
  return result;
}

// Merge scan + plan into actionable approved items
export function approvedItems() {
  const scan = latestScan();
  const plan = loadPlan();
  if (!scan) return [];
  return scan.items
    .filter((it) => plan.items[it.id]?.status === 'approved')
    .map((it) => ({
      ...it,
      plannedAction: plan.items[it.id].action || it.suggest,
      reviewed: plan.items[it.id].reviewed === true,
    }));
}
