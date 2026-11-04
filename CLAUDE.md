# cleandrive

Disk cleanup planner for this Mac: scans disk usage, categorizes items by risk,
lets the user approve actions in a web dashboard, then executes them (cache
cleans, deletes of regenerable data, rsync archives to a remote drive over
SSH/Tailscale with checksum verification).

Zero npm dependencies on purpose — do not add packages.

## How Claude Code should drive it (the connector)

The CLI and the JSON files in `data/` are the integration surface:

```
node bin/cleandrive.js scan            # rescan (~1–3 min), writes data/latest.json
node bin/cleandrive.js state [--json]  # current scan + plan, with item ids
node bin/cleandrive.js approve <id…> [--action=rm|clean|archive|archive+rm]
node bin/cleandrive.js skip <id…>
node bin/cleandrive.js execute [--dry-run]
node bin/cleandrive.js offload-dryrun  # rsync -n approved archive items
node bin/cleandrive.js remote-test     # SSH reachability of configured remote
node bin/cleandrive.js offload-candidates [--min=200] [--days=30]  # read-only
node bin/cleandrive.js offload <file|dir…> [--dry-run]   # verified upload → .cloud stub
node bin/cleandrive.js fetch <file|stub|dir…> [--dry-run]
node bin/cleandrive.js offloaded | offload-verify | pin <path>
node bin/cleandrive.js serve           # dashboard at http://localhost:4499
```

Typical planned-cleanup flow for a Claude session:
1. `state --json` → read items (id, path, kb, category, suggest, note).
2. Propose a plan to the user in chat (group by category, sum sizes).
3. On the user's explicit approval, `approve` the agreed ids, then
   `execute --dry-run`, show the output, then `execute`.
4. Never approve/execute without the user confirming the specific items.

Files:
- `data/latest.json` — last scan: `{ts, disk, items[]}`
- `data/plan.json` — approval state per item id
- `data/actions.log` — JSONL audit log of everything executed
- `config.json` — project roots, thresholds, remote `{host, user, path}`

## Safety model (do not weaken)

- Only paths produced by the scan are actionable; everything else is refused.
- `rm` is allowed only for categories `pkgcache`, `cache`, `node_modules`
  (regenerable data). `projects` can only be archived; local removal happens
  solely via `archive+rm` after an rsync checksum verification passes.
- `appdata` and `models` are review-only by default: `rm` is refused unless the
  user has explicitly marked the item reviewed (dashboard "Mark reviewed" or
  `cleandrive review <id>`), and even then it still requires approve + FREE.
  `apps` is always manual — the tool never deletes applications.
- `config.protected` paths are hard-locked: flagged 🔒 in the scan, forced to
  `keep`, non-actionable in the UI, and refused at execution even if an action is
  forged. Currently protects Claude agent/vibe-coding history: the Claude desktop
  app data, `~/.claude` (Claude Code sessions), and `~/.claude-mem` (memory).
- `config.extraCaches` carves exact paths back out of a protected root as
  regenerable `cache` items (e.g. the Claude desktop VM images in `vm_bundles`
  and its Electron caches). Only the listed path itself is exempt — subpaths and
  everything else under the protected root stay locked.
- Protected roots (~, ~/Documents, ~/Desktop, ~/Downloads, ~/Pictures,
  ~/Library) are refused as direct targets regardless of plan content.
- Every archive (test, dry-run, real) first checks over SSH that `remote.path`
  sits on the drive with `remote.uuid` (or at least not on the remote root fs)
  and has room for the item + 5%; otherwise it is refused.
- The dashboard binds to 127.0.0.1 only, and execution requires typing FREE.
- Offload (docs/offload-strategy.md): the local file is unlinked only after the
  remote object's sha256 equals the local hash AND the file is unchanged since
  hashing. Refused: symlinks, hard links, open files (lsof), `~/Library`,
  `.git`/`node_modules`/`.venv`, app/media library packages, protected paths,
  pins. Remote objects are never deleted by offload/fetch. No daemons — ever.

## Categories

| key | risk | action space |
|---|---|---|
| pkgcache | low | official clean command (uv/npm/brew/pnpm/bun), or rm |
| cache | low | rm (apps rebuild) |
| node_modules | low | rm (reinstall per project) |
| projects | medium | archive / archive+rm / keep — stale = no file touched in `staleDays` |
| appdata | review | rm only after explicit review (`cleandrive review <id>`) |
| models | review | rm only after explicit review, or via the owning tool (e.g. `ollama rm`) |
