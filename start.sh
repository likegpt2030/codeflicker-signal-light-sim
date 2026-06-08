#!/bin/bash
# CodeFlicker Signal Light - Start both server and log watcher
SIM_DIR="$HOME/.codeflicker/signal-light-sim"

# Kill any existing instances
pkill -f "signal-light-sim/server.js" 2>/dev/null
pkill -f "signal-light-sim/log-watcher.js" 2>/dev/null
sleep 1

# Start the simulator server
node "$SIM_DIR/server.js" &
SERVER_PID=$!
echo "🚦 Simulator server started (PID: $SERVER_PID)"

# Wait for server to be ready
sleep 1

# Start the log watcher
node "$SIM_DIR/log-watcher.js" &
WATCHER_PID=$!
echo "📡 Log watcher started (PID: $WATCHER_PID)"

echo ""
echo "🟢 Signal Light is running!"
echo "   Browser:  http://localhost:9876"
echo "   Server:   PID $SERVER_PID"
echo "   Watcher:  PID $WATCHER_PID"
echo ""
echo "Press Ctrl+C to stop both processes"

# Handle cleanup
cleanup() {
  echo ""
  echo "🛑 Stopping Signal Light..."
  kill $SERVER_PID $WATCHER_PID 2>/dev/null
  wait 2>/dev/null
  echo "Stopped."
  exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for either process to exit
wait -n 2>/dev/null || wait
