#!/usr/bin/env bash
# PostToolUse guard: if index.html or sw.js changed vs HEAD but the PWA
# CACHE_VERSION in sw.js was NOT bumped, remind Claude to bump it — otherwise
# installed clients keep serving the stale app shell. Non-blocking (exit 2 just
# feeds the reminder back to Claude; the edit already happened).
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[ -n "$file" ] || exit 0

case "$(basename "$file")" in
  index.html|sw.js) ;;
  *) exit 0 ;;
esac

dir=$(dirname "$file")
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root"

# No divergence from HEAD in either shared file → nothing to warn about.
if git diff --quiet HEAD -- index.html sw.js 2>/dev/null; then
  exit 0
fi

cur=$(grep -m1 'const CACHE_VERSION' sw.js 2>/dev/null || true)
old=$(git show HEAD:sw.js 2>/dev/null | grep -m1 'const CACHE_VERSION' || true)

if [ -n "$old" ] && [ "$cur" = "$old" ]; then
  ver=$(printf '%s' "$cur" | sed -E "s/.*'([^']*)'.*/\1/")
  echo "PWA reminder: index.html and/or sw.js changed since the last commit, but CACHE_VERSION in sw.js is still unchanged (${ver}). Bump CACHE_VERSION in sw.js so installed PWA clients re-cache the app shell instead of serving the stale one." >&2
  exit 2
fi

exit 0
