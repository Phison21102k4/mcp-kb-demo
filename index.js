// index.js (ESM) — MCP Streamable HTTP + Excel KB (workaround tools/call args)

import express from "express";
import path from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ✅ FIX XLSX IMPORT CHO ESM (tránh lỗi: XLSX.readFile is not a function)
const xlsxModule = await import("xlsx");
const XLSX = xlsxModule.default ?? xlsxModule;

const app = express();
app.use(express.json({ limit: "1mb" }));

// (optional) trả JSON khi body là JSON lỗi thay vì HTML
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: Invalid JSON body" },
      id: null,
    });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;

// ========== Load Excel Q&A ==========
const qaPath = path.resolve(process.cwd(), "data", "qa.xlsx");

let rows = [];
try {
  const wb = XLSX.readFile(qaPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  console.log(`✅ Loaded Q&A: ${rows.length} rows from ${qaPath}`);
  console.log("✅ Columns:", Object.keys(rows[0] || {}));

  const cols = new Set(Object.keys(rows[0] || {}));
  if (!cols.has("Question") || !cols.has("Answer")) {
    console.warn("⚠️ Thiếu cột 'Question'/'Answer' trong Excel.");
  }
} catch (e) {
  console.error(`❌ Cannot load Excel at: ${qaPath}`);
  console.error(e);
  process.exit(1);
}

function normalize(s) {
  return String(s ?? "")
    .normalize("NFC")
    .toLowerCase()
    .trim();
}

// Bỏ dấu tiếng Việt để token-match bền hơn
function removeDiacritics(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // bỏ dấu
    .replace(/đ/g, "d");
}

// Chuẩn hoá + bỏ dấu + bỏ ký tự lạ + token hoá
function toTokens(s) {
  const cleaned = removeDiacritics(normalize(s))
    .replace(/[^a-z0-9\s]/g, " ") // bỏ dấu câu/ký tự đặc biệt
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return [];

  // bỏ stopwords nhẹ (tuỳ bạn muốn giữ/bỏ)
  const stop = new Set([
    "la", "gi", "bao", "nhieu", "gia", "co", "khong", "cho", "toi", "minh", "ban",
    "a", "em", "anh", "chi", "voi", "va", "the", "nay", "nay", "duoc", "khong",
  ]);

  return cleaned
    .split(" ")
    .filter((t) => t.length >= 2 && !stop.has(t));
}

// Jaccard + overlap score đơn giản
function scoreTokens(qTokens, cTokens) {
  if (qTokens.length === 0 || cTokens.length === 0) return 0;

  const qSet = new Set(qTokens);
  const cSet = new Set(cTokens);

  let inter = 0;
  for (const t of qSet) if (cSet.has(t)) inter++;

  const union = qSet.size + cSet.size - inter;
  const jaccard = union ? inter / union : 0;

  // overlap theo query: trúng bao nhiêu % token của query
  const overlap = inter / qSet.size;

  // trọng số: ưu tiên overlap (vì query ngắn)
  return overlap * 0.75 + jaccard * 0.25;
}

function findAnswer(question) {
  const q = String(question ?? "").trim();
  if (!q) return "Bạn hãy nhập câu hỏi.";

  const qTokens = toTokens(q);
  if (qTokens.length === 0) return "Bạn hãy nhập câu hỏi.";

  let best = null;

  for (const r of rows) {
    // Ưu tiên match theo Question trước, rồi Product/Category/Description
    const fields = [
      { name: "Question", text: r.Question ?? "" , weight: 1.00 },
      { name: "Product Name", text: r["Product Name"] ?? "" , weight: 0.92 },
      { name: "Category", text: r.Category ?? "" , weight: 0.75 },
      { name: "Description", text: r.Description ?? "" , weight: 0.65 },
    ];

    let rowBest = 0;
    let rowBestField = "";

    for (const f of fields) {
      const cTokens = toTokens(f.text);
      const s = scoreTokens(qTokens, cTokens) * f.weight;
      if (s > rowBest) {
        rowBest = s;
        rowBestField = f.name;
      }
    }

    // Ngưỡng: chỉnh nếu muốn “dễ trúng” hơn
    // 0.45 là mức khá ổn cho query ngắn
    if (rowBest < 0.45) continue;

    const ans = String(r.Answer ?? "").trim();
    const keyLen = String(r.Question ?? r["Product Name"] ?? "").length;

    if (
      !best ||
      rowBest > best.score ||
      (rowBest === best.score && keyLen > best.keyLen)
    ) {
      best = { score: rowBest, answer: ans, keyLen, field: rowBestField };
    }
  }

  if (best) {
    console.log("BEST MATCH score=", best.score, "field=", best.field);
    return best.answer || "Câu này chưa có Answer.";
  }
  return "Xin lỗi, tôi chưa có câu trả lời cho câu hỏi này.";
}


// ========== MCP Server ==========
const server = new McpServer({
  name: "kb-excel-server",
  version: "1.0.0",
});

// Đăng ký tool để tools/list vẫn thấy tool này.
// (Nhưng tools/call sẽ được workaround ở route /mcp)
const kbAnswerInputSchema = {
  type: "object",
  properties: {
    question: { type: "string", description: "Câu hỏi của người dùng" },
  },
  required: ["question"],
  additionalProperties: true,
};

server.tool(
  "kb_answer",
  "Trả lời câu hỏi từ knowledge base Excel (data/qa.xlsx)",
  kbAnswerInputSchema,
  async () => {
    // Nếu SDK đã fix bug trong tương lai, bạn có thể chuyển logic về đây.
    return { content: [{ type: "text", text: "OK" }] };
  }
);

// ========== Streamable HTTP Transport ==========
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless
});

// Health-check
app.get("/", (req, res) => {
  res.status(200).send("✅ MCP KB Server is running");
});

// ===== Helpers: SSE 1-message response =====
function writeSseMessage(res, jsonObj) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify(jsonObj)}\n\n`);
  res.end();
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// ✅ CHỈ 1 ROUTE /mcp DUY NHẤT
app.post("/mcp", async (req, res) => {
  console.log("Accept:", req.headers.accept);
  console.log("REQ BODY:", JSON.stringify(req.body));

  // ✅ Workaround: tự xử lý tools/call để lấy params.arguments.question
  if (req.body?.method === "tools/call") {
    const id = req.body?.id ?? null;
    const toolName = req.body?.params?.name;
    const args = req.body?.params?.arguments ?? {};

    if (toolName !== "kb_answer") {
      return writeSseMessage(res, jsonRpcError(id, -32601, "Tool not found"));
    }

    const question = String(args?.question ?? "");
    const answer = findAnswer(question);

    return writeSseMessage(res, {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: answer }] },
    });
  }

  // Các method khác (initialize, tools/list, etc.) để SDK xử lý
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(null, -32603, "Internal server error"));
    }
  }
});

// Optional: chặn GET/DELETE cho rõ
app.get("/mcp", (req, res) => res.sendStatus(405));
app.delete("/mcp", (req, res) => res.sendStatus(405));

async function boot() {
  await server.connect(transport);

  app.listen(PORT, () => {
    console.log(`✅ MCP Streamable HTTP server running: http://localhost:${PORT}/mcp`);
  });
}

boot().catch((e) => {
  console.error("❌ Failed to boot:", e);
  process.exit(1);
});
