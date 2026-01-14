import fs from "fs";
import path from "path";
import xlsx from "xlsx";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// ========= Helpers: normalize tiếng Việt + chuẩn hoá text =========
function normalizeText(s = "") {
  return s
    .toString()
    .trim()
    .toLowerCase()
    // bỏ dấu tiếng Việt
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // bỏ ký tự thừa
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ========= Load Excel Q&A =========
function loadQA(excelPath) {
  if (!fs.existsSync(excelPath)) {
    throw new Error(`Không thấy file Excel: ${excelPath}`);
  }
  const wb = xlsx.readFile(excelPath);
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  // Map về cấu trúc chuẩn
  return rows
    .map((r) => {
      const question = r["Question"] ?? r["question"] ?? "";
      const answer = r["Answer"] ?? r["answer"] ?? "";
      return {
        category: r["Category"] ?? r["category"] ?? "",
        productName: r["Product Name"] ?? r["product"] ?? r["Product"] ?? "",
        price: r["Price (VND)"] ?? r["Price"] ?? r["price"] ?? "",
        description: r["Description"] ?? r["description"] ?? "",
        question,
        answer,
        qNorm: normalizeText(question),
      };
    })
    .filter((x) => x.question && x.answer);
}

// ========= Simple matcher: exact -> contains =========
function findBestAnswer(qaList, userQuestion) {
  const q = normalizeText(userQuestion);

  // 1) Exact match
  let hit = qaList.find((x) => x.qNorm === q);
  if (hit) return { ...hit, matchType: "exact", score: 1.0 };

  // 2) Contains match (2 chiều)
  // - nếu câu user chứa câu mẫu hoặc câu mẫu chứa câu user
  let best = null;
  for (const item of qaList) {
    const a = item.qNorm;
    if (!a) continue;

    const contains1 = q.includes(a);
    const contains2 = a.includes(q);

    if (contains1 || contains2) {
      // score thô theo độ dài trùng
      const score = Math.min(a.length, q.length) / Math.max(a.length, q.length);
      if (!best || score > best.score) best = { ...item, score };
    }
  }
  if (best) return { ...best, matchType: "contains", score: best.score };

  return null;
}

// ========= MCP Server =========
const server = new McpServer({
  name: "kb-excel-mcp",
  version: "1.0.0",
});

const excelPath = path.resolve("data/qa.xlsx");
let QA = [];
try {
  QA = loadQA(excelPath);
  console.log(`Loaded Q&A: ${QA.length} rows`);
} catch (e) {
  console.error(e.message);
}

server.tool(
  "kb_answer",
  {
    question: {
      type: "string",
      description: "Câu hỏi của người dùng",
    },
  },
  async ({ question }) => {
    if (!QA.length) {
      return {
        content: [
          {
            type: "text",
            text: `KB chưa load được. Kiểm tra file Excel tại: ${excelPath}`,
          },
        ],
      };
    }

    const best = findBestAnswer(QA, question);

    if (!best) {
      return {
        content: [
          {
            type: "text",
            text:
              "Mình chưa tìm thấy câu trả lời trong knowledge base cho câu hỏi này. " +
              "Bạn thử hỏi lại đúng tên sản phẩm hoặc từ khóa giá/mô tả nhé.",
          },
        ],
      };
    }

    // Trả về đúng theo Excel + metadata để debug
    const payload = {
      answer: best.answer,
      product_name: best.productName,
      price_vnd: best.price,
      description: best.description,
      match_type: best.matchType,
      score: best.score,
    };

    return {
      content: [
        { type: "text", text: best.answer },
        { type: "text", text: `\n[debug] ${JSON.stringify(payload)}` },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
