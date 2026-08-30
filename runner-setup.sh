#!/usr/bin/env bash
# orboto runner setup - one command to an autonomous agent on your project.
#
#   ./runner-setup.sh single   -> one implementation runner
#   ./runner-setup.sh duo      -> implementation runner + review runner (vision model)
#
# Everything is asked interactively on first run and stored in
# ~/.orboto-runners/config.env (chmod 600). Re-running starts the runners
# with the stored config; delete the file to reconfigure.
set -euo pipefail

MODE="${1:-}"
if [ -z "$MODE" ]; then
  echo "What do you want to run?"
  echo "  1) One worker (implements tickets)"
  echo "  2) Worker + reviewer duo (the reviewer checks finished work, with vision)"
  read -r -p "Choose 1 or 2 [1]: " choice
  case "${choice:-1}" in 2) MODE=duo;; *) MODE=single;; esac
fi
case "$MODE" in single|duo) ;; *) echo "usage: $0 [single|duo]"; exit 1;; esac

CFG_DIR="$HOME/.orboto-runners"
CFG="$CFG_DIR/config.env"
mkdir -p "$CFG_DIR"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }

# --- 1) install ------------------------------------------------------------
if ! need node; then
  echo "Node.js 20+ is required (https://nodejs.org). Install it and re-run."; exit 1
fi
if ! need orboto; then say "Installing orboto CLI ..."; npm i -g orboto; fi
if ! need pi; then say "Installing pi coding agent ..."; npm i -g @earendil-works/pi-coding-agent; fi

# --- 2) configuration ------------------------------------------------------
ask() { # ask <var> <prompt> [secret]
  local var="$1" prompt="$2" secret="${3:-}" val=""
  if [ -n "${!var:-}" ]; then return; fi
  if [ "$secret" = "secret" ]; then read -r -s -p "$prompt: " val; echo; else read -r -p "$prompt: " val; fi
  [ -n "$val" ] || { echo "Required."; exit 1; }
  printf 'export %s=%q\n' "$var" "$val" >> "$CFG"
  export "$var"="$val"
}

[ -f "$CFG" ] && . "$CFG"
say "Configuration ($CFG)"
ask ORBOTO_URL     "orboto base URL (e.g. https://your-orboto.example.com/api)"
ask ORBOTO_PROJECT "Project key the agent works on (e.g. ACME)"
echo "Mint bot API keys in your orboto under Admin -> Agents (one bot per runner)."
ask ORBOTO_TOKEN_IMPL "API key for the IMPLEMENTATION bot (orb_...)" secret
if [ "$MODE" = "duo" ]; then
  ask ORBOTO_TOKEN_REVIEW "API key for the REVIEW bot (orb_...)" secret
fi
if [ -z "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${ZAI_API_KEY:-}" ]; then
  ask ANTHROPIC_API_KEY "LLM provider key (Anthropic recommended - the review lane uses vision)" secret
fi
# Models: override via env before running, e.g. IMPL_MODEL='openai/gpt-5.2'
IMPL_MODEL="${IMPL_MODEL:-anthropic/*sonnet*}"
REVIEW_MODEL="${REVIEW_MODEL:-anthropic/*sonnet*}"   # vision-capable by default
IMPL_PROVIDER="${IMPL_MODEL%%/*}"; REVIEW_PROVIDER="${REVIEW_MODEL%%/*}"
chmod 600 "$CFG" 2>/dev/null || true

# --- 3) verify the connection ---------------------------------------------
say "Checking orboto connection ..."
ORBOTO_BASE_URL="$ORBOTO_URL" ORBOTO_TOKEN="$ORBOTO_TOKEN_IMPL" orboto whoami >/dev/null \
  || { echo "orboto whoami failed - check URL and implementation key."; exit 1; }

# --- 4) start --------------------------------------------------------------
WORKDIR="$(pwd)"
IMPL_CMD=(env ORBOTO_BASE_URL="$ORBOTO_URL" ORBOTO_TOKEN="$ORBOTO_TOKEN_IMPL" \
  orboto pi-runner --project "$ORBOTO_PROJECT" --session-name impl \
  --work-role implementation \
  --bootstrap "Run orboto session-start, then work tickets via the orboto CLI." \
  --idle-prompt "Pull your next ticket and work it end to end per the workspace rules." \
  --idle-after 5 \
  -- --provider "${IMPL_PROVIDER}" --model "${IMPL_MODEL#*/}")
REVIEW_CMD=(env ORBOTO_BASE_URL="$ORBOTO_URL" ORBOTO_TOKEN="${ORBOTO_TOKEN_REVIEW:-}" \
  orboto pi-runner --project "$ORBOTO_PROJECT" --session-name review \
  --work-role review \
  --bootstrap "Run orboto session-start. You are the review lane: review finished tickets thoroughly - read the diff, run the tests, and inspect any screenshots or UI output visually before you approve or reject." \
  --idle-prompt "Pull the next ticket waiting for review and review it end to end." \
  --idle-after 5 \
  -- --provider "${REVIEW_PROVIDER}" --model "${REVIEW_MODEL#*/}")

say "Starting in: $WORKDIR (run this script inside the repo the agent should work on)"
if [ "$MODE" = "single" ]; then
  exec "${IMPL_CMD[@]}"
fi

if need tmux; then
  tmux kill-session -t orboto-runners 2>/dev/null || true
  tmux new-session -d -s orboto-runners -n impl "${IMPL_CMD[*]}"
  tmux new-window  -t orboto-runners -n review "${REVIEW_CMD[*]}"
  say "Both runners started in tmux session 'orboto-runners'."
  say "Attach: tmux attach -t orboto-runners   (Ctrl+B, then 0/1 to switch, D to detach)"
else
  say "tmux not found - starting the review runner in the background (log: $CFG_DIR/review.log)"
  nohup "${REVIEW_CMD[@]}" > "$CFG_DIR/review.log" 2>&1 &
  echo $! > "$CFG_DIR/review.pid"
  say "Review runner PID $(cat "$CFG_DIR/review.pid"). Implementation runner starts in the foreground now."
  exec "${IMPL_CMD[@]}"
fi
