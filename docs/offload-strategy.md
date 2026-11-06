# Offload / fetch: an iCloud-style switch to your own drive

Status: v1 implemented (`lib/offload.js`), 2026-11-04. The reference setup is a
7.3 TB USB HDD on an NVIDIA Jetson reached over Tailscale; any Linux box with
SSH and a mounted drive works.

## Goal

Big, rarely used files (mostly videos) live on the remote drive. On the Mac each one leaves a small placeholder, `<name>.cloud`.
`fetch` brings the file back byte-for-byte. You can switch a file between
**local** and **offloaded** as often as you like, and switching back is cheap
because the remote copy stays.

## Hard requirements

1. **No always-on process** on the Mac or the remote. That rules out Nextcloud,
   an rclone mount, launchd/systemd units and file watchers. All work happens
   inside one `cleandrive` command over on-demand SSH and rsync.
2. **Reliability over speed.** A file is never lost, even if Wi-Fi drops,
   Tailscale hangs, the HDD is unplugged, the Mac sleeps or a command is killed
   halfway.
3. Zero npm dependencies. Reuse `checkRemoteDrive()`, the SSH options and the
   audit log.

## The switch: three states per file

```
            offload (verified)                fetch (verified)
  LOCAL  ───────────────────────►  OFFLOADED  ───────────────────►  LOCAL
  file.mp4                         file.mp4.cloud (stub)            file.mp4
                                   + remote object                  + remote object kept
```

- **local**: a normal file. If it was offloaded before, the remote copy still
  exists, so offloading it again only re-verifies and uploads nothing.
- **offloaded**: only the stub is on the Mac. The stub is self-describing JSON
  (name, size, sha256, mtime, remote host/path/object), so a fetch works even
  if `data/` is lost.
- **pinned**: `cleandrive pin <path>`. Never proposed as a candidate.

## Which files switch: candidate strategy

`cleandrive offload-candidates` (read-only) proposes files. Nothing is moved
automatically. The user picks.

| rule | default | why |
|---|---|---|
| size | ≥ 200 MB (`--min=MB`) | small files free little and cost a round-trip |
| idle | not modified **and** not opened for ≥ 30 days (`--days=N`) | don't offload what is in use |
| type | video, audio masters, disk images, archives (`--all-types` lifts this) | data that is opaque and big |
| roots | `~/Movies ~/Documents ~/Desktop ~/Downloads ~/Pictures` + `config.extraDirs` + `config.offload.roots` | where media piles up |
| never | `~/Library`, `*.photoslibrary`, `.git`, `node_modules`, protected paths, pins, hard links, open files | app data, libraries, things another process owns |
| duplicates | same size → sha256 → flagged `duplicate of …` | dupes go first; the remote stores the content once |

Order: duplicates first, then the largest idle files.
**When to switch:** when `brief.mjs` shows < 20 GB free, the skill offers
candidates next to the SAFE caches. Nothing runs on a timer.

## Reliability design

**Content-addressed remote store.** The object lives at
`<remote.path>/offload/objects/<aa>/<sha256>`. Identical files are stored
once. An object is never overwritten and never deleted by offload or fetch.

**Offload of one file, in strict order:**

1. Validate. The path is a regular file under `$HOME`, not a symlink, has
   nlink = 1, isn't under `~/Library`, protected paths, pins or `.git`, isn't a
   stub, and isn't open in any process (`lsof`).
2. Hash locally (sha256, streamed). Record size and mtime.
3. `checkRemoteDrive(size)`. The UUID-pinned drive must be mounted with room
   for size + 5%. If not, refuse.
4. If the object already exists, re-hash it on the remote. If it matches, this
   is a dedupe and nothing is uploaded.
5. Otherwise `rsync --partial --timeout=120` to `objects/aa/<sha>.part`. On any
   failure, retry with backoff (default 5 attempts). `--partial` resumes the
   transfer.
6. Remote `sha256sum <sha>.part` must equal the local hash, then `mv` to the
   final name (atomic on the same filesystem).
7. Re-stat the local file. If size or mtime changed since step 2, **abort and
   keep the file**.
8. Write the stub atomically (tmp + fsync + rename). Append to the remote
   `offload/manifest.jsonl` (the second copy of the index). Update
   `data/offloaded.json` (atomic).
9. Only now unlink the original. If a crash happens between steps 8 and 9,
   both the stub and the original exist. That is harmless: fetch sees the
   original matches and only removes the stub.

**Fetch of one stub:**

1. Read the stub. If the original path already exists with the same hash,
   just remove the stub.
2. Check local free space (size + 1 GB margin) and the remote drive.
3. `rsync --partial` the object into `.<name>.cleandrive-fetch` next to the
   stub, with retries.
4. The local sha256 must equal the stub's hash, or delete the temp file and
   fail. Then rename to the original name, restore the mtime, and remove the
   stub.
5. The remote object stays, so a later re-offload is instant.

**Concurrency:** `data/offload.lock` (pid) means only one offload or fetch run
at a time. A stale lock (dead pid) is taken over.

**Scrub:** `cleandrive offload-verify` re-hashes every remote object for
offloaded files on the remote and reports any mismatch. Run it occasionally,
since the remote has no daemon that would notice bit rot.

## Interfaces

```
cleandrive offload <file|dir…> [--dry-run] [--min=MB]   dir → files ≥ min (default 50 MB)
cleandrive fetch <file|file.cloud…> [--dry-run]
cleandrive offloaded [--json]                          index: what is offloaded / back local
cleandrive offload-candidates [--min=200] [--days=30] [--all-types] [--json]
cleandrive offload-verify                              scrub remote copies
cleandrive pin <path…> | unpin <path…>
```

The dashboard has an **Offload** card with candidates (Offload button), the
offloaded files (Fetch button) and a "Find candidates" run. Both actions ask
for confirmation and stream into the live log.

## Known limits / follow-ups

- No Finder double-click on `.cloud` yet. Run `cleandrive fetch <stub>`. A
  Quick Action is a possible follow-up.
- Remote objects of files that were fetched and later deleted locally stay on
  the remote. A `offload gc` command is a follow-up (by design: nothing on the
  remote is ever deleted automatically).
- USB drives on the remote may fail to auto-mount at boot if the fstab entry has
  a short `x-systemd.device-timeout` (10 s is too short for a spinning HDD).
  Raise it to 90 s and `sudo systemctl daemon-reload`.
