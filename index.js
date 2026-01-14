import express from "express";
import XLSX from "xlsx";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// ========== Load Excel Q&A ==========
const wb = XLSX.readFile("data/qa.xlsx");
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

console.log(`Loaded Q&A: ${rows.length} rows`);

function normalize(s) {
  return String(s ?? "").trim().toLowerCase();
}

function findAnswer(question) {
  const q = normalize(question);
  if (!q) return "Bạn hãy nhập câu hỏi.";

  for (const r of rows) {
    const key = normalize(r.Question);
    if (key && q.includes(key)) {
      const ans = String(r.Answer ?? "").trim();
      return ans || "Câu này chưa có Answer.";
    }
  }
  return "Xin lỗi, tôi chưa có câu trả lời cho câu hỏi này.";
}

// ========== MCP Server ==========
const server = new McpServer({
  name: "kb-excel-server",
  version: "1.0.0",
});

server.tool(
  "kb_answer",
  "Trả lời câu hỏi từ knowledge base Excel (data/qa.xlsx)",
  {
    question: { type: "string", description: "Câu hỏi của người dùng" },
  },
  async ({ question }) => {
    const answer = findAnswer(question);
    return { content: [{ type: "text", text: answer }] };
  }
);

// ========== Streamable HTTP Transport ==========
const transport = new StreamableHTTPServerTransport({
  // undefined = stateless (chuẩn streamable http)
  sessionIdGenerator: undefined,
});

// 1) Health-check route (Render + tự test)
app.get("/", (req, res) => {
  res.status(200).send("✅ MCP KB Server is running");
});

// 2) MCP endpoint: Streamable HTTP (JSON-RPC)
app.post("/mcp", async (req, res) => {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Optional: chặn GET/DELETE cho rõ
app.get("/mcp", (req, res) => res.sendStatus(405));
app.delete("/mcp", (req, res) => res.sendStatus(405));

async function boot() {
  // 3) Connect MCP server AFTER routes are ready
  await server.connect(transport);

  // 4) Start HTTP server (giữ process sống trên Render)
  app.listen(PORT, () => {
    console.log(`✅ MCP Streamable HTTP server running: http://localhost:${PORT}/mcp`);
  });
}

boot().catch((e) => {
  console.error("❌ Failed to boot:", e);
  process.exit(1);
});
