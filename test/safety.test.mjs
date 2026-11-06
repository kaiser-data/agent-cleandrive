// Safety-model tests. Everything runs inside a throwaway fake $HOME, so no real
// file is ever at risk. Run: npm test   (node:test, zero dependencies)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, linkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FAKE_HOME = realpathSync(mkdtempSync(path.join(tmpdir(), 'cleandrive-test-')));
process.env.HOME = FAKE_HOME;
process.env.CLEANDRIVE_HOME = path.join(FAKE_HOME, '.config', 'cleandrive');

const h = (...p) => path.join(FAKE_HOME, ...p);
let A, O, U;

before(async () => {
  mkdirSync(process.env.CLEANDRIVE_HOME, { recursive: true });
  writeFileSync(path.join(process.env.CLEANDRIVE_HOME, 'config.json'), JSON.stringify({
    protected: ['~/.claude', '~/Library/Application Support/Claude'],
    extraCaches: ['~/Library/Application Support/Claude/Cache'],
    remote: { host: '', path: '' },
  }));
  U = await import('../lib/util.js');
  A = await import('../lib/actions.js');
  O = await import('../lib/offload.js');
});

after(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

const dir = (...p) => { const d = h(...p); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'f'), 'x'); return d; };
const item = (p, category, action) => ({ id: 't', path: p, category, plannedAction: action, kb: 1 });

test('fake HOME is in effect (tests never see the real home)', () => {
  assert.equal(U.HOME, FAKE_HOME);
  assert.equal(U.DATA_DIR, path.join(process.env.CLEANDRIVE_HOME, 'data'));
});

test('rm deletes a regenerable cache', async () => {
  const d = dir('Library', 'Caches', 'some-app');
  const r = await A.executeItem(item(d, 'cache', 'rm'));
  assert.equal(r.ok, true);
  assert.equal(existsSync(d), false);
});

test('rm deletes node_modules', async () => {
  const d = dir('code', 'app', 'node_modules');
  assert.equal((await A.executeItem(item(d, 'node_modules', 'rm'))).ok, true);
  assert.equal(existsSync(d), false);
});

test('a project can never be rm-ed, even with a forged action', async () => {
  const d = dir('code', 'my-project');
  await assert.rejects(A.executeItem(item(d, 'projects', 'rm')), /not deletable/);
  assert.equal(existsSync(d), true);
});

test('appdata rm is refused until reviewed', async () => {
  const d = dir('Library', 'Application Support', 'BigApp');
  await assert.rejects(A.executeItem(item(d, 'appdata', 'rm')), /mark it reviewed/);
  assert.equal(existsSync(d), true);
  const r = await A.executeItem({ ...item(d, 'appdata', 'rm'), reviewed: true });
  assert.equal(r.ok, true);
});

test('apps are never deletable', async () => {
  const d = dir('Applications', 'Some.app');
  await assert.rejects(A.executeItem(item(d, 'apps', 'rm')), /not deletable/);
  assert.equal(existsSync(d), true);
});

test('protected paths are refused even as a cache rm', async () => {
  const d = dir('.claude', 'projects');
  await assert.rejects(A.executeItem(item(d, 'cache', 'rm')), /user-protected/);
  await assert.rejects(A.executeItem(item(h('.claude'), 'cache', 'rm')), /user-protected/);
  assert.equal(existsSync(d), true);
});

test('extraCaches carve out exactly one path from a protected root', async () => {
  const cache = dir('Library', 'Application Support', 'Claude', 'Cache');
  const sub = dir('Library', 'Application Support', 'Claude', 'Cache', 'sub');
  await assert.rejects(A.executeItem(item(sub, 'cache', 'rm')), /user-protected/);
  assert.equal((await A.executeItem(item(cache, 'cache', 'rm'))).ok, true);
  const sessions = dir('Library', 'Application Support', 'Claude', 'sessions');
  await assert.rejects(A.executeItem(item(sessions, 'cache', 'rm')), /user-protected/);
});

test('protected roots (~, ~/Documents, ~/Library, …) are refused as targets', async () => {
  for (const p of ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Library']) {
    mkdirSync(h(p), { recursive: true });
    await assert.rejects(A.executeItem(item(h(p), 'cache', 'rm')), /protected directory/, p);
  }
  await assert.rejects(A.executeItem(item(FAKE_HOME, 'cache', 'rm')), /outside|protected/);
});

test('paths outside $HOME are refused', async () => {
  await assert.rejects(A.executeItem(item('/usr/local/lib', 'cache', 'rm')), /outside/);
});

test('unknown actions do nothing', async () => {
  const d = dir('code', 'other');
  const r = await A.executeItem(item(d, 'projects', 'keep'));
  assert.equal(r.ok, false);
  assert.equal(existsSync(d), true);
});

test('archive+rm keeps the local copy when the remote is not configured', async () => {
  const d = dir('code', 'stale-project');
  await assert.rejects(A.executeItem(item(d, 'projects', 'archive+rm')), /remote not configured/);
  assert.equal(existsSync(d), true);
});

test('only approved scan items are executable (allowlist by construction)', () => {
  const data = U.DATA_DIR;
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, 'latest.json'), JSON.stringify({ items: [
    { id: 'a', path: h('x'), category: 'cache', suggest: 'rm' },
    { id: 'b', path: h('y'), category: 'cache', suggest: 'rm' },
  ] }));
  writeFileSync(path.join(data, 'plan.json'), JSON.stringify({ items: {
    a: { status: 'approved' }, b: { status: 'skipped' }, forged: { status: 'approved', action: 'rm' },
  } }));
  assert.deepEqual(A.approvedItems().map((i) => i.id), ['a']);
});

test('offload refuses symlinks, hard links, stubs, .git, node_modules, ~/Library, protected, pinned', () => {
  const cfg = { protected: ['~/.claude'] };
  const f = (rel) => { const p = h(rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, 'data'); return p; };
  const ok = f('Movies/clip.mov');
  assert.ok(O.validateSource(ok, cfg));

  symlinkSync(ok, h('Movies/link.mov'));
  assert.throws(() => O.validateSource(h('Movies/link.mov'), cfg), /symlink/);
  const hl = f('Movies/hard.mov'); linkSync(hl, h('Movies/hard2.mov'));
  assert.throws(() => O.validateSource(hl, cfg), /hard links/);
  assert.throws(() => O.validateSource(f('Movies/old.mov.cloud'), cfg), /stub/);
  assert.throws(() => O.validateSource(f('code/p/.git/pack.bin'), cfg), /\.git/);
  assert.throws(() => O.validateSource(f('code/p/node_modules/big.bin'), cfg), /node_modules/);
  assert.throws(() => O.validateSource(f('Library/Mail/big.bin'), cfg), /Library/);
  assert.throws(() => O.validateSource(f('Pictures/Photos Library.photoslibrary/a.heic'), cfg), /library package/);
  assert.throws(() => O.validateSource(f('.claude/history.jsonl'), cfg), /protected/);
  assert.throws(() => O.validateSource(ok, cfg, [h('Movies')]), /pinned/);
});

test('run() kills a hung command at its timeout instead of blocking the scan', async () => {
  const t0 = Date.now();
  const r = await U.run('sleep', ['10'], { timeoutMs: 200 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, -1);
  assert.ok(Date.now() - t0 < 2000);
  const ok = await U.run('echo', ['hi'], { timeoutMs: 2000 });
  assert.deepEqual([ok.code, ok.out.trim(), ok.timedOut], [0, 'hi', undefined]);
});
