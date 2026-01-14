import { spawn } from "child_process";

const proc = spawn("node", ["index.js"]);

proc.stdout.on("data", data => {
  console.log("SERVER:", data.toString());
});

setTimeout(() => {
  console.log("\n--- TEST QUESTION ---\n");

  const testInput = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "kb_answer",
      arguments: {
        question: "Tinh dầu bưởi HERBAL GROW giá bao nhiêu?"
      }
    }
  };

  proc.stdin.write(JSON.stringify(testInput) + "\n");
}, 1500);
