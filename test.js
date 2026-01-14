import { spawn } from "child_process";

function waitForReady(proc, needle, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Server not ready (timeout)")), timeoutMs);

    proc.stdout.on("data", (d) => {
      const s = d.toString();
      process.stdout.write("SERVER: " + s);
      if (s.includes(needle)) {
        clearTimeout(t);
        resolve();
      }
    });

    proc.stderr.on("data", (d) => process.stderr.write("SERVER ERR: " + d.toString()));
  });
}

function extractJsonFromSse(text) {
  // tìm dòng bắt đầu bằng "data: "
  const line = text
    .split(/\r?\n/)
    .find((l) => l.startsWith("data: "));
  if (!line) return null;

  const jsonStr = line.slice("data: ".length).trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

async function main() {
  const proc = spawn("node", ["index.js"], { stdio: ["ignore", "pipe", "pipe"] });

  try {
    // đợi server thật sự ready
    await waitForReady(proc, "MCP Streamable HTTP server running");

    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "kb_answer",
        arguments: { question: "Phù hợp cho loại da kiểu gì như nào?, tại sao?" },
      },
    };

    const res = await fetch("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
    });

    const raw = await res.text();

    console.log("HTTP STATUS:", res.status);
    // console.log("RAW SSE:\n", raw);

    const obj = extractJsonFromSse(raw);
    const answer =
      obj?.result?.content?.[0]?.text ??
      obj?.error?.message ??
      "(Không parse được SSE data)";

    console.log("ANSWER:", answer);
  } catch (e) {
    console.error("TEST FAILED:", e);
  } finally {
    proc.kill("SIGTERM");
  }
}

main();
