# Plan: deeper discovery + more efficient cleaning & archiving

Goal: find and act on older data even when it hides in subfolders or outside
the scanned roots, and make both scanning and archiving faster. Written
2026-07-10; based on `lib/scan.js` @ dc634e6. Extended 2026-09-24 with
robustness fixes (Phase 0), dashboard UX (Phase 4) and visibility/goal-driven
cleanup (Phase 5), based on `main` @ ac6e586.

## Why the current scanner misses old data

1. **Projects are scanned one level deep.** `listDirs(root)` only takes the
   top level of each project root. A folder like `~/claude-projects/systemtools`
   is one item — one recently touched file anywhere inside marks the whole
   group "active", hiding stale sibling projects inside it.
2. **Staleness is all-or-nothing per project.** `activeWithin()` stops at the
   first fresh file. An active 5 GB project with a 3 GB subfolder untouched
   since 2024 offers nothing to archive.
3. **Only `node_modules` counts as a regenerable build artifact.** Python
   `.venv`/`__pycache__`, Rust `target/`, `dist`/`build`/`.next`/`.turbo`, and
   macOS dev sinks (Xcode DerivedData, CoreSimulator caches) are invisible or
   lumped into project sizes.
4. **Old user data outside project roots is never seen.** `~/Documents`,
   `~/Desktop`, `~/Downloads` are protected as direct targets (correctly), but
   their old subfolders — often the biggest forgotten data — are never listed
   as archive candidates.

## Phase 1 — More detailed discovery (the "subfolders" part)

- **Recursive project discovery.** Walk project roots to a configurable depth
  (`config.projectDepth`, default 3), splitting at directories that contain a
  project marker (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`).
  Each real project becomes its own item with its own staleness.
- **Stale-subfolder detection inside active projects.** For active projects
  above a size threshold, run one `du -xk -d 1` plus a newest-mtime check per
  subfolder; emit subfolders ≥ `staleSubfolderMinMB` untouched for
  `staleDays`+ as `projects` archive candidates
  ("stale subfolder of active project"). Archive-only, same as projects today.
- **Generalize build artifacts.** Extend the `node_modules` step to a
  configurable `regenDirs` list (`.venv`, `venv`, `__pycache__`,
  `.pytest_cache`, `target`, `dist`, `build`, `.next`, `.turbo`, `.gradle`) —
  same `rm` action space, sizes subtracted from project net size like
  `node_modules` already is. Add macOS dev sinks (Xcode DerivedData,
  CoreSimulator caches, old iOS DeviceSupport) as `cache` items.
- **Age tiers on every item.** Record `newestMtime`; suggest `archive` at
  `staleDays` (60) and `archive+rm` at a new `veryStaleDays` (default 180) —
  checksum-verified removal for truly dead data. Dashboard/CLI get an
  "oldest first" sort.
- **Old user-folder subfolders (opt-in).** New `config.userDirScan` listing
  e.g. `~/Downloads`, `~/Documents` — top-level subfolders untouched for
  `veryStaleDays`+ become **archive-only** candidates (never `rm`; the roots
  themselves stay refused).

## Phase 2 — Faster scanning

- Replace per-directory `du -sk` calls with one `du -xk -d 2` per root (one
  filesystem traversal instead of dozens); raise the worker pool from 4 to
  CPU count. Should cut the 1–3 min scan substantially even though Phase 1
  scans more.
- Optional `scan --fast`: size cache (`data/sizecache.json`) keyed by path,
  skipping `du` for subtrees whose recursive newest-mtime hasn't changed
  since the last scan.

## Phase 3 — Smarter archiving

- **Archive manifest** (`data/archive-manifest.json`): record what was
  archived where, when, and that checksums passed. Unchanged already-archived
  items show an "archived ✓" badge — making `archive+rm` a safe one-click for
  anything already on the Jetson, and preventing re-uploads of unchanged
  projects.
- **Batch rsync**: one invocation with `--relative` over multiple sources
  instead of one rsync per item (keep the portable openrsync flags), plus an
  optional `-z` compression toggle for the Tailscale link.

## Phase 0 — Robustness fixes (added 2026-09-24, do these first)

Found during a real cleanup session; both are small and block safe use.

- **0.1 Scan hangs on privacy-protected folders.** `run()` in `lib/util.js` has
  no timeout. `du` over other apps' `~/Library/Containers` /
  `Group Containers` blocks forever under macOS privacy protection (0 % CPU,
  never exits) — a scan ran for over an hour. Add an optional
  `timeoutMs` to `run()` (kill the child, resolve `{code: -1, timedOut: true}`),
  use `config.duTimeoutSec` (default 60) in `duKB()`, and record timed-out or
  `Operation not permitted` paths in `scan.blocked[]` with the reason
  (`"needs Full Disk Access"`) instead of silently dropping them.
- **0.2 Remote target must be a mounted drive.** ✅ done 2026-09-30 (`checkRemoteDrive()`, `remote.uuid`; dashboard disable still open). `testRemote()` reports
  "reachable" even when the archive disk is unplugged and the mount point is
  just an empty directory on the remote's system disk; `archive()` never
  checks. Add optional `remote.uuid` and verify before any rsync (test, dry-run
  and real): `findmnt -n -o UUID -T <path>` matches (or at least
  `mountpoint -q <mount root>`), and remote free space ≥ item size + margin.
  `testRemote()` returns `{ok, reachable, mounted, freeKB, msg}`; the dashboard
  shows "archive drive not mounted" and disables archive actions.
- **0.3 Host fallback.** SSH to a tailnet short name can time out while the
  node's IP works. Support `remote.hostFallback` (IP) and say in the test
  result which one answered.

## Phase 4 — Dashboard UX: lifecycle, selection, less noise

Problems seen in real use: executed items still offer "Approve"; the table
rebuilds every 2.5 s (open dropdowns close); three buttons plus a select per
row; the scan age isn't obvious; the only preview is an archive dry-run.

- **Item lifecycle.** States: `proposed → selected → done | failed`, plus
  `skipped`. A `done` item leaves the actionable list and shows its result
  ("✓ Deleted 17:43 · freed 1.2 GB") with no Approve/Skip controls. `failed`
  shows the reason and a **Retry** button. Totals (reclaimable, capacity bar,
  presets) exclude done items.
- **Done is valid until the next scan.** When a scan completes, `done`
  entries become `proposed` again with a `lastDone: {ts, action, kb}` history
  field, so a regrown cache reappears with the note "cleaned on …, regrew
  X GB" instead of being hidden forever. Do this in one place (a
  `reconcilePlan(scan)` step called at the end of `runScan`) so CLI and
  dashboard agree.
- **Tabs instead of a status column:** To do · Selected · Done · Skipped,
  each with a count and GB total.
- **Checkbox selection** (plus select-all for the visible rows) replaces the
  per-row Approve button. A **sticky action bar** appears when anything is
  selected: "N selected · X GB · Preview · Free up X GB…". The confirm modal
  groups items by effect ("Delete permanently", "Archive to remote",
  "Archive then remove local") and keeps the FREE confirmation word.
- **General preview.** `POST /api/execute/dry-run` mirroring the CLI's
  `execute --dry-run` for all action types, not just archives.
- **Review items inline.** For `appdata`/`models`, the checkbox is disabled
  with "Review to unlock"; one click marks it reviewed and reveals keep/rm.
- **One filter control.** Clicking a category bar filters the table (drop
  the duplicate chip row); add a path search box and sort by size / age;
  replace the 80-row cap with "Show all".
- **Render only on change.** Keep polling, but re-render only when a
  signature of `{scan.ts, plan, executing, scanning}` changes; update the log
  box and progress separately.
- **Scan freshness.** Show "Scanned 25 days ago — rescan recommended" when the
  scan is older than N days, live progress with the current path, and a
  Cancel button.
- Toasts for plan changes; `Esc` closes the modal; focus states on all
  controls.

## Phase 5 — See everything, decide by goal

- **Coverage bar ("where is my disk").** Compare the used space reported by
  the OS with what the scan measured, and show the gap as its own
  segment: blocked (with the fix, e.g. grant Full Disk Access), unmeasured
  system data, and measured. In practice the OS's own storage view showed
  large Documents and Mail buckets that the scanner could not read at all.
- **Free-space goal.** "I want +30 GB": fill the selection lowest-risk first
  (package caches → caches → regenerable build dirs → reviewed app data →
  archives), largest first within a tier, with a running total against the
  goal; the user can untick anything before confirming.
- **Known space-hog catalog** (`lib/sinks.json`, data not code), each entry
  with category, why it's safe, and how it comes back:
  - macOS aerial wallpaper/screen-saver videos
    (`~/Library/Application Support/com.apple.wallpaper/aerials/videos`, can
    reach 10 GB+; the active one lives in a system location)
  - headless browser downloads (Playwright, Puppeteer, chrome-devtools-mcp)
  - **version leaks**: sibling semver directories in plugin/tool caches —
    keep the newest (or the version the tool's manifest says is active),
    offer the rest
  - **orphaned app data**: `Application Support` / `Containers` folders whose
    app bundle is no longer installed (match bundle ids / names against
    `/Applications`)
  - Trash, iOS device backups, Xcode DerivedData / simulators / DeviceSupport
- **Guide-only cards** for things the tool must not delete itself: Mail
  attachments, Messages attachments, Photos library, iCloud "Optimize
  storage". Show the measured size (when readable) and the exact settings
  path to change it.
- **History and regrowth.** Keep each scan's summary in `data/history/`;
  add a "grew since last scan" column and a small per-item trend, to answer
  "why does the disk keep filling up".

## Safety (unchanged — do not weaken)

Everything new flows through the existing gates: stale subfolders and
user-dir folders are category `projects` (archive-only), `regenDirs` behave
like `node_modules`, protected roots and the `extraCaches` carve-out stay
exactly as they are, execution still requires approve + FREE.

## Suggested order (updated 2026-09-24)

1. Phase 0 robustness fixes (scan timeout, mounted-drive check, host fallback)
2. Phase 4 lifecycle + selection UX (done items stop asking for approval)
3. Phase 5 known-sinks catalog + free-space goal, then the coverage bar
4. Phase 1 recursive discovery + stale subfolders (where hidden old data lives)
5. Phase 3 archive manifest (makes the resulting candidates cheap to offload)
6. Phase 2 scan speed; Phase 5 history/regrowth
7. Phase 1 extras (user-dir scan, dev sinks) alongside as small follow-ups

## Config additions (summary)

```json
{
  "projectDepth": 3,
  "veryStaleDays": 180,
  "staleSubfolderMinMB": 200,
  "regenDirs": [".venv", "venv", "__pycache__", ".pytest_cache", "target", "dist", "build", ".next", ".turbo", ".gradle"],
  "userDirScan": ["~/Downloads", "~/Documents"]
}
```
