// index.js — MCP + Excel KB + Xiaozhi Bridge (Stable, giữ nguyên thuật toán)

import WebSocket from "ws";
import express from "express";
import path from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const xlsxModule = await import("xlsx");
const XLSX = xlsxModule.default ?? xlsxModule;

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// ---------- Load Excel ----------
const qaPath = path.resolve(process.cwd(), "data", "qa.xlsx");

let rows = [];
try {
  const wb = XLSX.readFile(qaPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  console.log(`✅ Loaded ${rows.length} rows from Excel`);
} catch (e) {
  console.error("❌ Cannot load Excel:", e.message);
  process.exit(1);
}

// =====================
// 🧠 THUẬT TOÁN CỦA BẠN — GIỮ NGUYÊN
// =====================

function normalize(s) {
  return String(s ?? "")
    .normalize("NFC")
    .toLowerCase()
    .trim();
}

function removeDiacritics(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

function toTokens(s) {
  const cleaned = removeDiacritics(normalize(s))
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return [];

  const stop = new Set([
    "la","gi","bao","nhieu","gia","co","khong","cho","toi","minh","ban",
    "a","em","anh","chi","voi","va","the","nay","duoc"
  ]);

  return cleaned
    .split(" ")
    .filter((t) => t.length >= 2 && !stop.has(t));
}

function scoreTokens(qTokens, cTokens) {
  if (!qTokens.length || !cTokens.length) return 0;

  const qSet = new Set(qTokens);
  const cSet = new Set(cTokens);

  let inter = 0;
  for (const t of qSet) if (cSet.has(t)) inter++;

  const union = qSet.size + cSet.size - inter;
  const jaccard = union ? inter / union : 0;
  const overlap = inter / qSet.size;

  return overlap * 0.75 + jaccard * 0.25;
}

function findAnswer(question) {
  const q = String(question ?? "").trim();
  if (!q) return "Bạn hãy nhập câu hỏi.";

  const qTokens = toTokens(q);
  if (!qTokens.length) return "Bạn hãy nhập câu hỏi.";

  let best = null;

  for (const r of rows) {
    const fields = [
      { text: r.Question ?? "", w: 1.0 },
      { text: r["Product Name"] ?? "", w: 0.92 },
      { text: r.Category ?? "", w: 0.75 },
      { text: r.Description ?? "", w: 0.65 }
    ];

    let score = 0;
    for (const f of fields) {
      const s = scoreTokens(qTokens, toTokens(f.text)) * f.w;
      if (s > score) score = s;
    }

    if (score < 0.45) continue;

    if (!best || score > best.score)
      best = { score, answer: String(r.Answer ?? "").trim() };
  }

  return best?.answer || "Xin lỗi, tôi chưa có câu trả lời cho câu hỏi này.";
}

// =====================
// 🧱 MCP
// =====================

const server = new McpServer({ name: "kb-excel", version: "1.0.0" });

server.tool(
  "kb_answer",
  { type: "object", properties: { question: { type: "string" } } },
  async () => ({ content: [{ type: "text", text: "OK" }] })
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

// ---------- HTTP MCP ----------
app.post("/mcp", async (req, res) => {
  if (req.body?.method === "tools/call") {
    const id = req.body.id;
    const question = req.body?.params?.arguments?.question ?? "";
    const answer = findAnswer(question);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.write(`event: message\n`);
    res.write(`data: ${JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: answer }] }
    })}\n\n`);
    return res.end();
  }

  await transport.handleRequest(req, res, req.body);
});

// =====================
// 🌐 Xiaozhi Bridge
// =====================

const XIAOZHI_GATEWAY = "wss://api.xiaozhi.me/mcp/?token=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjc2NDk3NiwiYWdlbnRJZCI6MTM0MTAzMywiZW5kcG9pbnRJZCI6ImFnZW50XzEzNDEwMzMiLCJwdXJwb3NlIjoibWNwLWVuZHBvaW50IiwiaWF0IjoxNzY4NDE3NTM2LCJleHAiOjE3OTk5NzUxMzZ9.M8zQbDxpFuB6IeU_fz4JKn4bqMJWAjdf-VcMiEtq4wJuJXre5GoT4GixUC5X4pp-U-_-qScW38iAx14uierTiA";

function connectXiaozhi() {
  const ws = new WebSocket(XIAOZHI_GATEWAY);

  ws.on("open", () => console.log("🟢 Connected to Xiaozhi Gateway"));
  ws.on("error", (e) => console.error("🔴 Xiaozhi WS error:", e.message));
  ws.on("close", () => {
    console.log("🟡 Xiaozhi disconnected — reconnecting...");
    setTimeout(connectXiaozhi, 3000);
  });

  ws.on("message", (d) => {
    let msg;
    try { msg = JSON.parse(d.toString()); } catch { return; }

    if (msg.method === "tools/call") {
      const id = msg.id;
      const question = msg?.params?.arguments?.question ?? "";
      const answer = findAnswer(question);

      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: answer }] }
      }));
    }
  });
}

// =====================
// 🚀 Boot
// =====================

async function boot() {
  await server.connect(transport);

  app.listen(PORT, () => {
    console.log(`🚀 MCP Server running on port ${PORT}`);
  });

  connectXiaozhi();
}

boot();
