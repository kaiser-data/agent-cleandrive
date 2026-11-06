#!/bin/bash
# Read-only disk report: sizes the privacy-protected folders the cleandrive scan
# cannot see (Documents, Downloads, iCloud Drive, Mail, app containers, ...).
# Never deletes anything. Output has folder names and sizes only — safe to share.
#
# Usage:  bin/disk-report.sh            (prints report)
#         bin/disk-report.sh | pbcopy   (copies it to the clipboard)
#
# Needs Full Disk Access for the terminal app (System Settings → Privacy &
# Security → Full Disk Access), otherwise protected folders read as near-empty.

H="$HOME"
row() { awk -F'\t' '{ printf "%7.1f GB  %s\n", $1/1048576, $2 }'; }

{
echo "== access =="
ls "$H/Library/Mail" >/dev/null 2>&1 && echo "Full Disk Access: OK" || echo "Full Disk Access: MISSING (numbers below will be low)"

echo; echo "== disk =="
df -h /System/Volumes/Data | tail -1

echo; echo "== protected folders =="
for p in Documents Downloads Desktop Pictures Music Movies "Library/Mobile Documents" Library/Mail Library/Messages Library/Containers "Library/Group Containers" Library/Photos "Library/Application Support/MobileSync"; do
  [ -e "$H/$p" ] && du -skx "$H/$p" 2>/dev/null
done | sort -rn | row

echo; echo "== top 20 inside those =="
for p in Documents Downloads Desktop "Library/Mobile Documents" Library/Containers "Library/Group Containers"; do
  [ -d "$H/$p" ] && du -skx "$H/$p"/* "$H/$p"/.[!.]* 2>/dev/null
done | sort -rn | head -20 | row

echo; echo "== files over 1 GB =="
find "$H" -xdev -type f -size +1G -print0 2>/dev/null | xargs -0 du -sk 2>/dev/null | sort -rn | head -15 | row

echo; echo "== snapshots / dev =="
echo "local snapshots: $(tmutil listlocalsnapshots / 2>/dev/null | grep -c com.apple)"
du -sh "$H/Library/Developer" "$H/Library/Containers/com.docker.docker" 2>/dev/null
} 2>/dev/null | sed "s|$H|~|g"
