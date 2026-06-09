#!/bin/bash
PID_FILE="$HOME/.codeflicker/signal-light-sim/.claude-active"

# Hook event type is passed as first argument by Claude Code
# Or we detect from stdin
EVENT="${1:-}"

case "$EVENT" in
  PreToolUse|PostToolUse|SubagentStop)
    echo "$(date +%s%3N)" > "$PID_FILE"
    ;;
  Stop|Notification)
    echo "$(date +%s%3N)" > "$PID_FILE"
    ;;
  *)
    # On any event while claude is running, refresh the PID file
    echo "$(date +%s%3N)" > "$PID_FILE"
    ;;
esac
