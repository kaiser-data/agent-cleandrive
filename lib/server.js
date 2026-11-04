import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR, loadConfig, saveConfig, readJson, fmtGB, run } from './util.js';
import { runScan } from './scan.js';
import { loadPlan, setPlanItem, setPlanItems, approvedItems, executeItem, testRemote, archive, log } from './actions.js';
import { offloadPaths, fetchPaths, listOffloaded, findCandidates, loadCandidates, setPin } from './offload.js';

const state = {
  scanning: false,
  scanStep: '',
  executing: false,
  current: null,
  liveLog: [],
};

function pushLog(line) {
  for (const l of String(line).split('\n')) {
    if (l.trim()) state.liveLog.push(l.trimEnd());
  }
  if (state.liveLog.length > 400) state.liveLog = state.liveLog.slice(-300);
}

async function dfNow() {
  const r = await run('df', ['-k', '/System/Volumes/Data']);
  const f = r.out.trim().split('\n').pop().split(/\s+/);
  // APFS: df's "used" counts only the Data volume, but "size" is the whole shared
  // container — so used = size - avail, else used/size/free contradict each other
  const sizeKB = +f[1], availKB = +f[3], usedKB = sizeKB - availKB;
  return { sizeKB, usedKB, availKB, pct: Math.round((usedKB / sizeKB) * 100) };
}

async function handleApi(req, res, url, body) {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const scan = readJson(path.join(DATA_DIR, 'latest.json'));
    return send(200, {
      scan,
      plan: loadPlan(),
      config: loadConfig(),
      disk: await dfNow(),
      scanning: state.scanning,
      scanStep: state.scanStep,
      executing: state.executing,
      current: state.current,
      log: state.liveLog.slice(-120),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/scan') {
    if (state.scanning) return send(409, { error: 'scan already running' });
    state.scanning = true;
    state.scanStep = 'starting';
    runScan((step) => { state.scanStep = step; })
      .catch((e) => pushLog('scan error: ' + e.message))
      .finally(() => { state.scanning = false; });
    return send(202, { started: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/plan') {
    const { id, status, action, reviewed } = body || {};
    if (!id) return send(400, { error: 'id required' });
    return send(200, setPlanItem(id, {
      ...(status && { status }),
      ...(action && { action }),
      ...(typeof reviewed === 'boolean' && { reviewed }),
    }));
  }

  if (req.method === 'POST' && url.pathname === '/api/plan/bulk') {
    const changes = Array.isArray(body?.changes) ? body.changes : [];
    if (!changes.length) return send(400, { error: 'changes required' });
    return send(200, setPlanItems(changes));
  }

  if (req.method === 'POST' && url.pathname === '/api/execute') {
    if (state.executing) return send(409, { error: 'already executing' });
    if ((body?.confirm || '') !== 'FREE') return send(400, { error: 'confirmation word missing' });
    const items = approvedItems();
    const wanted = body?.ids ? items.filter((i) => body.ids.includes(i.id)) : items;
    if (!wanted.length) return send(400, { error: 'no approved items' });
    state.executing = true;
    (async () => {
      for (const item of wanted) {
        state.current = { id: item.id, path: item.path, action: item.plannedAction };
        pushLog(`▶ ${item.plannedAction}: ${item.path} (${fmtGB(item.kb)})`);
        try {
          const r = await executeItem(item, { onData: pushLog });
          pushLog(r.ok ? `✓ done: ${item.path}` : `✗ failed: ${item.path} — ${r.output.split('\n').pop()}`);
        } catch (e) {
          pushLog(`✗ refused: ${e.message}`);
          setPlanItem(item.id, { status: 'failed', lastOutput: e.message });
        }
      }
      state.current = null;
      state.executing = false;
      pushLog('— run complete —');
    })();
    return send(202, { started: true, count: wanted.length });
  }

  if (req.method === 'POST' && url.pathname === '/api/remote/test') {
    return send(200, await testRemote());
  }

  if (req.method === 'POST' && url.pathname === '/api/remote/config') {
    const cfg = loadConfig();
    cfg.remote = { ...cfg.remote, ...body, enabled: !!body.host };
    saveConfig(cfg);
    log({ event: 'remote-config', host: body.host, path: body.path });
    return send(200, cfg.remote);
  }

  if (req.method === 'POST' && url.pathname === '/api/offload/dryrun') {
    const items = approvedItems().filter((i) => (i.plannedAction || '').startsWith('archive'));
    if (!items.length) return send(400, { error: 'no approved archive items' });
    state.executing = true;
    (async () => {
      for (const item of items) {
        pushLog(`▶ dry-run archive: ${item.path}`);
        try {
          const r = await archive(item, { dryRun: true, onData: pushLog });
          pushLog(r.ok ? '✓ dry-run ok' : `✗ ${r.output.split('\n').pop()}`);
        } catch (e) { pushLog(`✗ ${e.message}`); }
      }
      state.executing = false;
      pushLog('— dry-run complete —');
    })();
    return send(202, { started: true, count: items.length });
  }

  // ---- offload / fetch (docs/offload-strategy.md) ----
  if (req.method === 'GET' && url.pathname === '/api/offload') {
    const l = listOffloaded();
    const c = loadCandidates();
    const pinned = (p) => l.pins.some((pp) => p === pp || p.startsWith(pp + '/'));
    if (c) c.candidates = c.candidates.filter((x) => !pinned(x.path));
    return send(200, { ...l, candidates: c, finding: state.finding || false });
  }

  if (req.method === 'POST' && url.pathname === '/api/offload/candidates') {
    if (state.finding) return send(409, { error: 'already searching' });
    state.finding = true;
    pushLog('▶ searching offload candidates…');
    findCandidates({ minMB: Number(body?.minMB) || 200, days: Number(body?.days) || 30, onData: pushLog })
      .then((r) => pushLog(`✓ ${r.candidates.length} offload candidate(s)${r.unreadable ? ` — ${r.unreadable} paths unreadable (Full Disk Access)` : ''}`))
      .catch((e) => pushLog('✗ candidates: ' + e.message))
      .finally(() => { state.finding = false; });
    return send(202, { started: true });
  }

  if (req.method === 'POST' && (url.pathname === '/api/offload/run' || url.pathname === '/api/offload/fetch')) {
    const isFetch = url.pathname.endsWith('/fetch');
    if (state.executing) return send(409, { error: 'already executing' });
    const paths = Array.isArray(body?.paths) ? body.paths.filter((p) => typeof p === 'string') : [];
    if (!paths.length) return send(400, { error: 'paths required' });
    if (!isFetch && body?.confirm !== 'OFFLOAD') return send(400, { error: 'confirmation word missing' });
    state.executing = true;
    (isFetch ? fetchPaths : offloadPaths)(paths, { onData: pushLog })
      .then((r) => pushLog(`— ${isFetch ? 'fetch' : 'offload'} complete: ${r.filter((x) => x.ok).length}/${r.length} ok —`))
      .catch((e) => pushLog('✗ ' + e.message))
      .finally(() => { state.executing = false; });
    return send(202, { started: true, count: paths.length });
  }

  if (req.method === 'POST' && url.pathname === '/api/offload/pin') {
    if (typeof body?.path !== 'string') return send(400, { error: 'path required' });
    return send(200, { path: setPin(body.path, body.pinned !== false) });
  }

  send(404, { error: 'not found' });
}

export function serve() {
  const cfg = loadConfig();
  const port = cfg.port || 4499;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
        handleApi(req, res, url, body).catch((e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
      });
      return;
    }
    const ui = path.join(ROOT, 'ui', 'index.html');
    if (url.pathname === '/' && existsSync(ui)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(ui));
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`cleandrive dashboard → http://localhost:${port}`);
  });
  return server;
}
