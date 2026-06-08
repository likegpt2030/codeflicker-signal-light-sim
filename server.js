const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 9876;

const clients = new Set();

let currentState = {
  event: "idle",
  signal: "idle",
  summary: "Agent 空闲",
  attention: "不需要关注",
  ts: Date.now(),
};

const EVENT_TO_SIGNAL = {
  SessionStart: "session_start",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "tool_done",
  PostToolUseFailure: "blocked",
  SubagentStart: "working",
  SubagentStop: "tool_done",
  PreCompact: "working",
  PostCompact: "tool_done",
  Stop: "done",
  StopFailure: "blocked",
  SessionEnd: "session_end",
};

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

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
    return;
  }

  if (req.method === "GET" && req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify(currentState)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && req.url === "/hook") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        // Accept signal directly (from log-watcher) or map from hook_event_name
        const eventName = payload.hook_event_name || payload.event || "Stop";
        const signal = payload.signal || EVENT_TO_SIGNAL[eventName] || "attention";
        const info = SIGNAL_INFO[signal] || SIGNAL_INFO.attention;

        currentState = {
          event: eventName,
          signal,
          summary: info.summary,
          attention: info.attention,
          session_id: payload.session_id || "",
          ts: Date.now(),
        };

        broadcast(currentState);
      } catch {}

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`🚦 Signal Light Simulator running at http://localhost:${PORT}`);
});
