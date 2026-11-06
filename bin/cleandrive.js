#!/usr/bin/env node
// cleandrive — scan disk, plan cleanup, clean caches, archive to remote over SSH/Tailscale.
// This CLI is also the Claude Code connector: every command supports --json where useful.
import path from 'node:path';
import { DATA_DIR, readJson, fmtGB, loadConfig } from '../lib/util.js';
import { runScan, CATEGORIES } from '../lib/scan.js';
import { serve } from '../lib/server.js';
import { loadPlan, setPlanItem, approvedItems, executeItem, testRemote, archive } from '../lib/actions.js';
import { offloadPaths, fetchPaths, listOffloaded, findCandidates, verifyRemote, setPin } from '../lib/offload.js';

const [, , cmd, ...args] = process.argv;
const flag = (f) => args.includes(f);
const num = (name, dflt) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
const positional = () => args.filter((a) => !a.startsWith('--'));
const out = (d) => process.stderr.write(d);

function latest() {
  const scan = readJson(path.join(DATA_DIR, 'latest.json'));
  if (!scan) {
    console.error('no scan yet — run: cleandrive scan');
    process.exit(1);
  }
  return scan;
}

function printState() {
  const scan = latest();
  const plan = loadPlan();
  if (flag('--json')) {
    console.log(JSON.stringify({ scan, plan }, null, 2));
    return;
  }
  const d = scan.disk;
  console.log(`scan: ${scan.ts}`);
  console.log(`disk: ${fmtGB(d.usedKB)} used of ${fmtGB(d.sizeKB)} (${d.pct}%), ${fmtGB(d.availKB)} free\n`);
  if (scan.blocked?.length) {
    const timedOut = scan.blocked.filter((b) => /timed out/.test(b.reason));
    const partial = scan.blocked.length - timedOut.length;
    for (const b of timedOut) console.log(`⚠ not measured: ${b.path.replace(process.env.HOME, '~')} — ${b.reason}`);
    if (partial) console.log(`ℹ ${partial} folder(s) partly unreadable (macOS privacy). Sizes may be low; grant your terminal Full Disk Access for full numbers.`);
    console.log('');
  }
  for (const [key, meta] of Object.entries(CATEGORIES)) {
    const items = scan.items.filter((i) => i.category === key);
    if (!items.length) continue;
    const total = items.reduce((s, i) => s + i.kb, 0);
    console.log(`## ${meta.label} — ${fmtGB(total)} (risk: ${meta.risk})`);
    for (const i of items.slice(0, 15)) {
      const st = plan.items[i.id]?.status || '·';
      console.log(`  [${st.padEnd(8)}] ${i.id}  ${fmtGB(i.kb).padStart(8)}  ${i.suggest.padEnd(10)} ${i.path.replace(process.env.HOME, '~')}`);
    }
    if (items.length > 15) console.log(`  … ${items.length - 15} more`);
  }
}

switch (cmd) {
  case 'scan': {
    console.error('scanning…');
    const scan = await runScan((s) => console.error('  ' + s));
    if (flag('--json')) console.log(JSON.stringify(scan, null, 2));
    else console.log(`done: ${scan.items.length} items, disk at ${scan.disk.pct}%`);
    break;
  }
  case 'state':
    printState();
    break;
  case 'serve':
    serve();
    break;
  case 'approve': {
    const ids = args.filter((a) => !a.startsWith('--'));
    const action = (args.find((a) => a.startsWith('--action=')) || '').split('=')[1];
    for (const id of ids) {
      setPlanItem(id, { status: 'approved', ...(action && { action }) });
      console.log(`approved ${id}${action ? ' → ' + action : ''}`);
    }
    break;
  }
  case 'skip':
    for (const id of args.filter((a) => !a.startsWith('--'))) {
      setPlanItem(id, { status: 'skipped' });
      console.log(`skipped ${id}`);
    }
    break;
  case 'review':
    for (const id of args.filter((a) => !a.startsWith('--'))) {
      setPlanItem(id, { status: 'reviewed', reviewed: true });
      console.log(`reviewed ${id}`);
    }
    break;
  case 'execute': {
    const items = approvedItems();
    if (!items.length) { console.log('nothing approved'); break; }
    const dry = flag('--dry-run');
    for (const item of items) {
      console.log(`${dry ? '[dry-run] would' : '▶'} ${item.plannedAction}: ${item.path} (${fmtGB(item.kb)})`);
      if (dry) continue;
      try {
        const r = await executeItem(item, { onData: (d) => process.stderr.write(d) });
        console.log(r.ok ? '  ✓ done' : `  ✗ failed: ${r.output.split('\n').pop()}`);
      } catch (e) {
        console.log(`  ✗ refused: ${e.message}`);
      }
    }
    break;
  }
  case 'offload-dryrun': {
    const items = approvedItems().filter((i) => (i.plannedAction || '').startsWith('archive'));
    for (const item of items) {
      console.log(`dry-run: ${item.path}`);
      const r = await archive(item, { dryRun: true, onData: (d) => process.stderr.write(d) });
      console.log(r.ok ? '  ✓ ok' : `  ✗ ${r.output}`);
    }
    break;
  }
  case 'offload': {
    const ps = positional();
    if (!ps.length) { console.error('usage: cleandrive offload <file|dir…> [--dry-run] [--min=MB]'); process.exit(2); }
    const r = await offloadPaths(ps, { dryRun: flag('--dry-run'), minMB: num('min', 50), onData: out });
    const ok = r.filter((x) => x.ok);
    console.log(`${flag('--dry-run') ? 'dry-run: ' : ''}${ok.length}/${r.length} ok, ${fmtGB(ok.reduce((s, x) => s + (x.size || 0), 0) / 1024)}`);
    process.exit(r.every((x) => x.ok) ? 0 : 1);
    break;
  }
  case 'fetch': {
    const ps = positional();
    if (!ps.length) { console.error('usage: cleandrive fetch <file|file.cloud|dir…> [--dry-run]'); process.exit(2); }
    const r = await fetchPaths(ps, { dryRun: flag('--dry-run'), onData: out });
    console.log(`${flag('--dry-run') ? 'dry-run: ' : ''}${r.filter((x) => x.ok).length}/${r.length} ok`);
    process.exit(r.every((x) => x.ok) ? 0 : 1);
    break;
  }
  case 'offloaded': {
    const l = listOffloaded();
    if (flag('--json')) { console.log(JSON.stringify(l, null, 2)); break; }
    const off = l.files.filter((f) => f.state === 'offloaded');
    console.log(`offloaded: ${off.length} files, ${fmtGB(off.reduce((s, f) => s + f.size, 0) / 1024)} on the remote`);
    for (const f of l.files) console.log(`  [${f.state.padEnd(9)}] ${fmtGB(f.size / 1024).padStart(8)}  ${f.path.replace(process.env.HOME, '~')}`);
    if (l.pins.length) console.log(`pinned (keep local): ${l.pins.map((p) => p.replace(process.env.HOME, '~')).join(', ')}`);
    break;
  }
  case 'offload-candidates': {
    const r = await findCandidates({ minMB: num('min', 200), days: num('days', 30), allTypes: flag('--all-types'), dupes: !flag('--no-dupes'), onData: out });
    if (flag('--json')) { console.log(JSON.stringify(r, null, 2)); break; }
    const tot = r.candidates.reduce((s, c) => s + c.kb, 0);
    console.log(`${r.candidates.length} candidates, ${fmtGB(tot)} (≥${r.minMB} MB, idle ≥${r.days}d)`);
    for (const c of r.candidates.slice(0, 40)) {
      console.log(`  ${fmtGB(c.kb).padStart(8)}  ${String(c.idleDays).padStart(4)}d  ${c.path.replace(process.env.HOME, '~')}${c.duplicateOf ? `  ⧉ duplicate of ${c.duplicateOf.replace(process.env.HOME, '~')}` : ''}`);
    }
    if (r.unreadable) console.log(`⚠ ${r.unreadable} paths not readable (macOS privacy / Full Disk Access)`);
    break;
  }
  case 'offload-verify': {
    const r = await verifyRemote({ onData: out });
    console.log(r.bad.length ? `✗ ${r.bad.length} of ${r.checked} remote copies bad` : `✓ all ${r.checked} remote copies verified`);
    process.exit(r.bad.length ? 1 : 0);
    break;
  }
  case 'pin':
  case 'unpin':
    for (const p of positional()) console.log(`${cmd === 'pin' ? 'pinned' : 'unpinned'} ${setPin(p, cmd === 'pin')}`);
    break;
  case 'remote-test': {
    const r = await testRemote();
    console.log((r.ok ? '✓ ' : '✗ ') + r.msg);
    process.exit(r.ok ? 0 : 1);
    break;
  }
  default:
    console.log(`cleandrive — disk cleanup planner & executor

usage:
  cleandrive scan [--json]          scan disk, categorize, write data/latest.json
  cleandrive state [--json]         show latest scan + plan status
  cleandrive serve                  start dashboard on http://localhost:${loadConfig().port || 4499}
  cleandrive approve <id…> [--action=rm|clean|archive|archive+rm]
  cleandrive skip <id…>
  cleandrive review <id…>           mark reviewed (unlocks rm for appdata/models)
  cleandrive execute [--dry-run]    run all approved actions
  cleandrive offload-dryrun         rsync -n approved archive items to remote
  cleandrive remote-test            check SSH reachability of configured remote

offload (iCloud-style switch to the remote drive, see docs/offload-strategy.md):
  cleandrive offload <file|dir…> [--dry-run] [--min=MB]   verified upload, leaves <name>.cloud
  cleandrive fetch <file|stub|dir…> [--dry-run]           verified download, removes the stub
  cleandrive offloaded [--json]                           what is offloaded / back local
  cleandrive offload-candidates [--min=200] [--days=30] [--all-types] [--no-dupes] [--json]
  cleandrive offload-verify                               re-hash remote copies (scrub)
  cleandrive pin|unpin <path…>                            keep local / never propose`);
}
