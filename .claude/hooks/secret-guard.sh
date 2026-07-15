#!/usr/bin/env bash
# PreToolUse guard: block any Write/Edit/MultiEdit that would put a real-looking
# Anthropic API key (sk-ant-...) into a file. The key must live ONLY in the
# Worker secret (wrangler secret put ANTHROPIC_API_KEY) or the gitignored
# worker/.dev.vars — never in tracked source. Exit 2 blocks the tool call.
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

# The real key legitimately lives only in the gitignored local dev file.
case "$(basename "$file")" in
  .dev.vars) exit 0 ;;
esac

# Concatenate every place an edit can introduce content.
payload=$(printf '%s' "$input" | jq -r '
  [ .tool_input.content,
    .tool_input.new_string,
    (.tool_input.edits[]?.new_string) ]
  | map(select(. != null)) | join("\n")')

# Real keys are long; the "sk-ant-your-key-here" placeholder is short and won't match.
if printf '%s' "$payload" | grep -Eq 'sk-ant-[A-Za-z0-9_-]{20,}'; then
  echo "Blocked: this edit writes what looks like a real Anthropic API key (sk-ant-…) into ${file:-a file}. The key must live ONLY in the Cloudflare Worker secret ('wrangler secret put ANTHROPIC_API_KEY') or the gitignored worker/.dev.vars — never in index.html, the Worker source, or any tracked file." >&2
  exit 2
fi

exit 0
