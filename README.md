<div align="center">

# 🧹 CleanDrive

### Your Mac is full. Your cleanup tool shouldn't be able to delete your work.

**A disk-cleanup planner that treats deletion as a plan you approve — not a button you regret.**
Scan → categorize by risk → approve in a dashboard → clean caches, or archive real work to an
external drive over Tailscale SSH with checksum verification before a single local byte is removed.

<br>

![CleanDrive demo](media/demo.gif)

<br>

`zero npm dependencies` · `node ≥ 20` · `macOS / APFS` · `drives itself from Claude Code`

</div>

---

## Why this exists

Every "disk cleaner" on the Mac falls into one of two camps: **dumb** (blindly nukes
`~/Library/Caches` and prays) or **dangerous** (one-click "free up 200 GB" that also eats
the project you shipped last week). CleanDrive is neither.

It starts from a hard rule: **nothing gets deleted that can't be regenerated or hasn't been
verified onto another disk first.** Your caches? Delete freely — they rebuild. Your actual
projects? They can only leave this machine by being *copied to an external drive, checksum-verified,
and only then* removed locally. And the things you never want touched — your Claude agent history,
your coding sessions — are **hard-locked** and refused even if something tries to force the action.

<table>
<tr>
<td width="50%" valign="top">

**Light**

![Dashboard, light mode](media/dashboard-light.png)

</td>
<td width="50%" valign="top">

**Dark**

![Dashboard, dark mode](media/dashboard-dark.png)

</td>
</tr>
</table>

---

## What makes it different

|  | |
|---|---|
| 🧠 **Risk-tiered, not size-sorted** | Every item is classified — *regenerable cache*, *reinstallable `node_modules`*, *irreplaceable project*, *review-only app data*. The action space is a function of the risk, so you literally **cannot** `rm` a project. |
| 🔒 **Hard-locked paths** | Your Claude Code history (`~/.claude`), memory (`~/.claude-mem`), and desktop-app data are flagged 🔒, forced to `keep`, made non-selectable in the UI, and **refused at execution even if the action is forged**. Add your own paths in one line of config. |
| 📦 **Archive, verify, *then* delete** | Projects don't get deleted — they get `rsync`'d to a remote drive preserving their path, **checksum-verified** with a second `rsync -c` pass, and only removed locally if verification reports zero differences. |
| 🌐 **Remote over Tailscale SSH** | Point it at any device on your tailnet (a Raspberry Pi, an old laptop, a NAS) with an external drive attached. No cloud, no account, no upload — it's your data going to your disk over your network. |
| 📊 **A dashboard that explains itself** | Capacity bar, per-category breakdown, and a sortable item table — built to a validated, colorblind-safe palette that adapts to light/dark. Approving an action is a click; executing requires typing `FREE`. |
| 🤖 **Claude Code is a first-class driver** | The CLI + JSON state files are a documented connector. Claude reads your scan, proposes a plan in chat, and — only on your explicit approval — approves and executes it, with a full audit log. |
| 🍏 **Understands APFS** | Free space is shared across volumes, so "56% full" from `df` is a lie. CleanDrive computes real capacity as `used / (used + available)`. |
| 🕵️ **App usage analysis** | Correlates every `.app` bundle's size with its **last-used date** *and* its app-support data footprint — so a 700 MB app dragging 9 GB of data, or a 800 MB app you haven't opened in 5 months, surfaces instantly. |

---

## Quickstart

```bash
git clone https://github.com/kaiser-data/cleandrive.git
cd cleandrive
cp config.example.json config.json     # point projectRoots at your code folders

node bin/cleandrive.js scan            # ~1–3 min; writes data/latest.json
node bin/cleandrive.js serve           # dashboard → http://localhost:4499
```

Open the dashboard, approve what you want gone, type `FREE`, watch it work. That's it.

> **No dependencies to install.** CleanDrive is pure Node stdlib + your system's `du`, `find`,
> `rsync`, and `ssh`. `node_modules/` never appears in this repo.

---

## The safety model (the whole point)

```
                         ┌─────────────────────────────────────────────┐
   scan produces  ─────▶ │  every actionable path is an allowlist entry │
   the ONLY               └─────────────────────────────────────────────┘
   actionable set                        │
                                          ▼
   ┌──────────────┬───────────────────────────────────────────────────────┐
   │ category      │ what's allowed                                        │
   ├──────────────┼───────────────────────────────────────────────────────┤
   │ pkgcache      │ official clean cmd (uv/npm/brew/pnpm/bun) — or rm      │
   │ cache         │ rm  (the app rebuilds it)                             │
   │ node_modules  │ rm  (reinstall per project)                          │
   │ projects      │ archive / archive+rm / keep  — NEVER a bare rm        │
   │ appdata       │ rm only after explicit "mark reviewed" + approve      │
   │ apps          │ review only — surfaced with size + last-used         │
   │ models        │ rm after review — or remove via the owning tool      │
   └──────────────┴───────────────────────────────────────────────────────┘
```

Enforced at every layer, not just the UI:

- **Allowlist by construction** — only paths that came out of the scan are actionable; anything else is refused.
- **`rm` is category-gated** — permitted *only* for `pkgcache`, `cache`, `node_modules`. A project can leave solely via `archive+rm`, and only after checksum verification passes.
- **Protected paths are hard-locked** — listed in `config.protected`, refused at the executor even if a forged action reaches it. Ships protecting your Claude/agent history.
- **Protected roots** — `~`, `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Pictures`, `~/Library` are refused as direct targets regardless of plan content.
- **Localhost only** — the dashboard binds to `127.0.0.1`, and execution requires typing the word `FREE`.
- **Full audit trail** — every start/finish lands in `data/actions.log` as JSONL.

---

## Claude Code as the connector

CleanDrive was built to be driven by an agent. The CLI speaks `--json`, and the state lives in
flat files, so a Claude Code session can run the whole loop — *and never act without your say-so*:

```bash
node bin/cleandrive.js state --json          # items: {id, path, kb, category, suggest, note}
node bin/cleandrive.js approve <id…> --action=archive+rm
node bin/cleandrive.js execute --dry-run     # show exactly what would happen
node bin/cleandrive.js execute               # do it — logged to data/actions.log
```

> A typical session: Claude reads your scan, groups it by category, proposes *"here's 33 GB of
> package caches and 14 GB of `node_modules`, all regenerable — clean them?"*, and only after you
> confirm the specific items does it approve and execute. The plan is always yours.

---

## CLI reference

| command | what it does |
|---|---|
| `scan [--json]` | Rescan disk, categorize, write `data/latest.json` |
| `state [--json]` | Current scan + plan status, with item ids |
| `serve` | Dashboard at `http://localhost:4499` |
| `approve <id…> [--action=rm\|clean\|archive\|archive+rm]` | Mark items approved |
| `skip <id…>` | Mark items skipped |
| `execute [--dry-run]` | Run all approved actions |
| `offload-dryrun` | `rsync -n` approved archive items to the remote |
| `remote-test` | Check SSH reachability of the configured remote drive |
| `offload <file\|dir…>` | iCloud-style: verified copy to the remote, leaves `<name>.cloud` ([strategy](docs/offload-strategy.md)) |
| `fetch <file\|stub\|dir…>` | Bring offloaded files back (sha256-verified), removes the stub |
| `offloaded` | List offloaded / fetched files |
| `offload-candidates` | Big idle media + duplicates worth offloading (read-only) |
| `offload-verify` | Re-hash every remote copy (scrub) |
| `pin` / `unpin` | Keep a file or folder local, never propose it |

---

## Remote archive setup

1. Attach an external drive to any machine on your Tailscale network.
2. In the dashboard's **Remote archive target** card (or `config.json`), set the device's Tailscale
   name, the SSH user, and a destination path.
3. Hit **Test connection** — it verifies SSH reachability and shows the remote's free space.
4. Set a project's action to `archive` (copy only) or `archive+rm` (copy, verify, then reclaim locally).

Files are `rsync`'d with `-aHR` so the path relative to your home folder is preserved on the remote —
your archive mirrors your Mac's layout, making restores obvious.

---

## Architecture

```
bin/cleandrive.js     CLI + agent connector (every command is scriptable)
lib/scan.js           the scanner — categorization, sizing, staleness, app usage
lib/actions.js        the executor — validation, rm/clean/archive, verification, audit log
lib/server.js         zero-dep HTTP API + static host for the dashboard
lib/util.js           shell helpers, hashing, concurrency pool
ui/index.html         the single-file dashboard (validated colorblind-safe palette)
config.json           your roots, thresholds, protected paths, remote target
data/                 latest.json (scan) · plan.json (approvals) · actions.log (audit)
```

---

## Built with Claude Code

CleanDrive — the scanner, the safety model, the dashboard, the Playwright capture pipeline that
produced the demo above — was designed and implemented in a [Claude Code](https://claude.com/claude-code)
session. Which is exactly why protecting agent history is a first-class feature: **the tool knows
what it must never delete.**

---

<div align="center">

**MIT licensed.** Clean fearlessly.

</div>
