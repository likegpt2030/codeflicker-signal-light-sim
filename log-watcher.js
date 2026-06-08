#!/usr/bin/env node
// CodeFlicker Signal Light Log Watcher (Polling Edition)
// Monitors CLI debug/info logs via polling and sends state changes to the simulator.
// Uses polling because macOS kqueue doesn't detect changes in buffered log files.

const http = require("http");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const SIM_PORT = 9876;
const LOG_DIR = path.join(process.env.HOME, ".codeflicker/cli/logs");
const POLL_INTERVAL_MS = 400;
const CF_PID_FILE = path.join(process.env.HOME, ".codeflicker/signal-light-sim/.cf-active");

let currentSignal = "idle";
let lastEventTime = 0;
let debounceTimer = null;
let agentActive = false; // Track if agent is currently processing

// Track file positions for incremental reading
const filePositions = new Map();

const TOOL_NAMES = new Set([
  "bash", "readFile", "writeFile", "editFile", "glob", "grep",
  "fetch", "search_web", "use_skill", "todoWrite", "todoRead",
  "askUserQuestion", "memory_read", "memory_write", "memory_edit",
  "memory_delete", "blankAgent",
]);

function postToSim(signal, event, detail) {
  const SIGNAL_INFO = {
    idle:          { summary: "空闲",       attention: "不需要关注" },
    thinking:      { summary: "正在思考…",   attention: "不用处理" },
    working:       { summary: "正在执行…",   attention: "不用处理" },
    tool_done:     { summary: "工具完成",    attention: "继续工作" },
    attention:     { summary: "等你查看",    attention: "需要你看一眼" },
    permission:    { summary: "请求授权",    attention: "需要立即关注" },
    blocked:       { summary: "遇到阻塞",    attention: "需要你处理" },
    done:          { summary: "任务完成",    attention: "建议查看结果" },
    session_start: { summary: "会话开始",    attention: "不用处理" },
    session_end:   { summary: "会话结束",    attention: "回到空闲" },
  };

  const info = SIGNAL_INFO[signal] || SIGNAL_INFO.attention;
  const payload = { event: event || signal, signal, summary: info.summary, attention: info.attention, detail: detail || "", ts: Date.now() };

  const data = JSON.stringify(payload);
  const req = http.request(
    { hostname: "127.0.0.1", port: SIM_PORT, path: "/hook", method: "POST", timeout: 2000 },
    () => {}
  );
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.write(data);
  req.end();
}

function setSignal(signal, event, detail) {
  if (signal === currentSignal) return;
  const prev = currentSignal;
  currentSignal = signal;
  lastEventTime = Date.now();
  if (debounceTimer) clearTimeout(debounceTimer);
  console.log(`  ${prev} → ${signal}  (${event}: ${detail})`);

  // Write/remove PID file for SignalLight app to detect cf activity
  const activeSignals = ["thinking", "working", "tool_done", "attention", "permission", "blocked", "session_start"];
  if (activeSignals.includes(signal)) {
    try { fs.writeFileSync(CF_PID_FILE, Date.now().toString()); } catch {}
  } else {
    try { fs.unlinkSync(CF_PID_FILE); } catch {}
  }

  postToSim(signal, event, detail);
}

function scheduleIdle(timeout = 8000) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (Date.now() - lastEventTime >= timeout - 500) {
      setSignal("idle", "IdleTimeout", "no activity");
    }
  }, timeout);
}

function scheduleThinkingAfterTool(timeout = 3000) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (currentSignal === "tool_done" && agentActive) {
      setSignal("thinking", "ThinkingAfterTool", "agent thinking after tool result");
    }
  }, timeout);
}

// Debounce: after "done", schedule return to "idle" after inactivity
function scheduleDoneToIdle(timeout = 10000) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (currentSignal === "done") {
      setSignal("idle", "IdleAfterDone", "idle after task completion");
      agentActive = false;
    }
  }, timeout);
}

function parseLine(line, source) {
  if (!line) return;

  // Detect user prompt submit (ONLY from info log)
  if (source === "info" && line.includes("[submitHandler]") && line.includes("return key pressed")) {
    agentActive = true;
    setSignal("thinking", "UserPromptSubmit", "user submitted prompt");
    return;
  }

  // Detect tool call from agent chunk
  if (line.includes("[agent] chunk") && line.includes('"type":"tool"')) {
    const toolMatch = line.match(/"name":"(\w+)"/);
    if (toolMatch && TOOL_NAMES.has(toolMatch[1])) {
      agentActive = true;
      setSignal("working", "PreToolUse", `tool: ${toolMatch[1]}`);
      return;
    }
  }

  // Detect tool execution start
  if (line.includes("[TaskManager]") && line.includes("start to run command")) {
    setSignal("working", "ToolExecuting", "executing command");
    return;
  }

  // Detect tool result returning (isComplete:true in agent chunk)
  if (line.includes("[agent] chunk") && line.includes('"isComplete":true') && line.includes('"type":"tool"')) {
    setSignal("tool_done", "PostToolUse", "tool completed");
    scheduleThinkingAfterTool();
    return;
  }

  // Detect reasoning chunks
  if (line.includes("[agent] chunk") && line.includes('"type":"reasoning"')) {
    if (currentSignal !== "working" && agentActive) {
      setSignal("thinking", "Reasoning", "agent reasoning");
    }
    return;
  }

  // Detect text response generation (agent writing final answer)
  if (line.includes("[agent] chunk") && line.includes('"type":"text"') && line.includes('"isComplete":true')) {
    // Agent completed text output - this is a strong "done" signal
    setSignal("done", "Stop", "agent finished text response");
    scheduleDoneToIdle(15000);
    return;
  }

  // Detect API-level finish (finish_reason in SSE data)
  if (line.includes('"finish_reason":"stop"') || line.includes('"finish_reason":"end_turn"')) {
    // Only if we're currently active (not from log replay)
    if (agentActive) {
      setSignal("done", "Stop", "agent finished response");
      scheduleDoneToIdle(15000);
    }
    return;
  }

  // Detect compact
  if (line.includes("[CompactService]") && line.includes("Starting compact")) {
    setSignal("working", "PreCompact", "compacting context");
    return;
  }
  if (line.includes("[CompactService]") && line.includes("Compact completed")) {
    setSignal("tool_done", "PostCompact", "compact done");
    scheduleThinkingAfterTool();
    return;
  }

  // Detect session creation
  if (line.includes("[useAgentInstance]") && line.includes("creating agent:")) {
    agentActive = true;
    setSignal("session_start", "SessionStart", "new session");
    return;
  }

  // Detect API errors
  if (line.includes("[error]") && (line.includes("streaming error") || line.includes("rate") || line.includes("busy"))) {
    if (agentActive) {
      setSignal("blocked", "APIError", "API error detected");
    }
    return;
  }
}

function resolveLogPath(logPath) {
  // Follow symlinks and return the actual file path
  try {
    return fs.realpathSync(logPath);
  } catch {
    return logPath;
  }
}

function pollFile(logPath, source) {
  const realPath = resolveLogPath(logPath);
  let lastPos = 0;

  try {
    const stat = fs.statSync(realPath);
    lastPos = stat.size; // Start from current end (only new lines)
  } catch {
    lastPos = 0;
  }

  filePositions.set(logPath, { lastPos, lastRealPath: realPath });

  const poll = () => {
    try {
      const currentRealPath = resolveLogPath(logPath);
      const posInfo = filePositions.get(logPath);

      // If the real path changed (log rotation), reset position
      if (currentRealPath !== posInfo.lastRealPath) {
        posInfo.lastRealPath = currentRealPath;
        posInfo.lastPos = 0;
        lastPos = 0;
      }

      const stat = fs.statSync(currentRealPath);
      if (stat.size > lastPos) {
        const fd = fs.openSync(currentRealPath, "r");
        const buf = Buffer.alloc(stat.size - lastPos);
        fs.readSync(fd, buf, 0, buf.length, lastPos);
        fs.closeSync(fd);
        lastPos = stat.size;
        posInfo.lastPos = lastPos;

        // Parse the new content line by line
        const content = buf.toString("utf-8");
        const lines = content.split("\n");
        for (const line of lines) {
          // Skip lines that are clearly command output (echo feedback)
          // These are typically short lines without the standard log prefix
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Only parse lines that look like actual log entries (start with [date])
          // or lines from info log (which always have the [info] prefix)
          if (source === "debug" && !trimmed.startsWith("[202") && !trimmed.startsWith("data:")) continue;
          parseLine(trimmed, source);
        }
      } else if (stat.size < lastPos) {
        // File was truncated or rotated
        lastPos = 0;
        posInfo.lastPos = 0;
      }
    } catch {}
  };

  return poll;
}

// Main
const debugLogPath = path.join(LOG_DIR, "debug.log");
const infoLogPath = path.join(LOG_DIR, "info.log");

let debugExists = false;
let infoExists = false;
try { fs.accessSync(debugLogPath, fs.constants.R_OK); debugExists = true; } catch {}
try { fs.accessSync(infoLogPath, fs.constants.R_OK); infoExists = true; } catch {}

if (!debugExists && !infoExists) {
  console.error("Cannot find CodeFlicker CLI log files");
  process.exit(1);
}

console.log(`🚦 Signal Light Log Watcher started (polling mode)`);
if (debugExists) console.log(`   Debug log: ${debugLogPath}`);
if (infoExists) console.log(`   Info log:  ${infoLogPath}`);
console.log(`   Simulator:  http://127.0.0.1:${SIM_PORT}`);
console.log(`   Poll rate:  ${POLL_INTERVAL_MS}ms`);

postToSim("session_start", "WatcherStart", "log watcher started");

const pollers = [];
if (debugExists) pollers.push(pollFile(debugLogPath, "debug"));
if (infoExists) pollers.push(pollFile(infoLogPath, "info"));

const pollTimer = setInterval(() => {
  for (const poll of pollers) poll();
}, POLL_INTERVAL_MS);

process.on("SIGINT", () => {
  clearInterval(pollTimer);
  postToSim("session_end", "WatcherStop", "log watcher stopped");
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGTERM", () => {
  clearInterval(pollTimer);
  process.exit(0);
});
