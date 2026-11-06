---
name: cleandrive
description: Free disk space on a Mac safely with the cleandrive CLI — scan, propose a risk-tiered cleanup plan, clean caches and node_modules, archive stale projects to a remote drive over SSH with checksum verification, offload big videos iCloud-style (.cloud placeholder) and fetch them back. Use when the disk is full or nearly full, when asked "what can I clean", "free up space", "why is my Mac full", "archive old projects", "offload this video", when a .cloud file needs restoring, or when a cleandrive archive, offload or fetch fails.
---

# cleandrive

The user's disk is full. Your job: find space, **propose** a plan, and act only
on the items the user confirms. cleandrive enforces the safety model itself —
never try to work around a refusal.

## Running it

Use `cleandrive` if it is on PATH (`npm i -g cleandrive`). Otherwise run
`node <plugin root>/bin/cleandrive.js` — the plugin root is two directories
above this SKILL.md. Config and data live in `~/.config/cleandrive/`
(created on first run; edit `projectRoots` and `remote` there).

## 1. Look

```bash
df -h /System/Volumes/Data                 # APFS: the Data volume is the real number
cleandrive state --json                     # last scan: items {id, path, kb, category, suggest, note}
cleandrive scan                             # rescan if the scan is older than ~3 days (1–3 min)
```

## 2. Propose — never act yet

Group by category with sizes, lowest risk first:

| category | risk | what cleandrive allows |
|---|---|---|
| `pkgcache` | low | official clean command (npm/uv/brew/pnpm/bun) or rm |
| `cache` | low | rm — apps rebuild it |
| `node_modules` | low | rm — reinstall per project |
| `projects` | medium | archive / archive+rm only — **never a bare rm** |
| `appdata`, `models` | review | rm only after `cleandrive review <id>` + approve |
| `apps` | manual | never deleted by the tool — list idle ones for the user |

Items marked 🔒 are user-protected (`config.protected`, e.g. `~/.claude`) and
are refused at execution. Do not suggest deleting them by hand either.

## 3. Act on explicit approval only

```bash
cleandrive approve <id…>                          # default action = item's suggest
cleandrive approve <id…> --action=archive+rm      # projects: copy, verify, then remove
cleandrive execute --dry-run                      # show the user exactly what happens
cleandrive execute                                # only after they confirm
```

- **zsh**: `IDS="a b"; cleandrive approve $IDS` does not word-split and records one
  bogus id. Write ids to a file and pass `$(cat ids.txt)`.
- A running app makes its cache rm fail (browsers, VS Code). Ask the user to quit it,
  then re-approve the failed id.
- If your harness blocks irreversible deletes, don't fight it: do `approve` and
  `--dry-run` yourself, then give the user the exact `execute` command to run.

## 4. Offload big media (iCloud-style)

```bash
cleandrive offload-candidates                  # read-only: big idle media, duplicates first
cleandrive offload <file|dir…> --dry-run       # hashes + checks the drive, changes nothing
cleandrive offload <file|dir…>                 # verified upload, leaves <name>.cloud
cleandrive fetch <file|file.cloud|dir…>        # restore byte-for-byte (only adds data)
cleandrive offloaded | offload-verify | pin <path>
```

The local file is unlinked only after the remote sha256 equals the local hash and
the file is unchanged since hashing. Never offload files the user hasn't named or confirmed.

## Where space usually hides (check when the scan finds little)

| sink | handling |
|---|---|
| Aerial wallpaper / screen saver videos (`~/Library/Application Support/com.apple.wallpaper/aerials/videos`, 2–15 GB) | add to `config.extraCaches`; they re-download unless the user switches the **screen saver and lock screen** away from Aerials too |
| Old versions in tool/plugin caches (sibling semver dirs, ~0.5–1 GB each) | keep the version the tool's manifest says is active; the rest is dead |
| Old CLI binaries (`~/.local/share/<tool>/versions/*`) | `readlink` the active one, delete the others |
| `.venv`, `.next`, `dist`, `target` in inactive projects | ask which projects are active first; needs a reinstall later |
| Downloads / Documents / Desktop / Trash | macOS privacy (TCC) hides them from the scan: ask the user to grant Full Disk Access to the terminal, or to empty Trash |
| Disk refills within days | usually dependency churn (`node_modules`, `.venv`, package caches), not a leak — rescan and compare |

## Troubleshooting

- `archive drive not mounted` — `remote.path` is an empty mount point on the remote's
  system disk. The user must mount the drive; archive/offload refuse until then.
- SSH to a Tailscale short name times out → use the node's `100.x` IP as `remote.host`.
- `upload failed after 5 attempts` → network; rerun the same command, `--partial` resumes.
- `open in another process` → quit the app holding the file (QuickTime, Finder preview).

Finish with `df -h /System/Volumes/Data`, check the audit log
(`~/.config/cleandrive/data/actions.log`, filter today's date for `"ok":false`) and
report freed space and anything that failed.
