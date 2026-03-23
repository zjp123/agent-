const { spawn } = require("child_process");

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const child = spawn("node", ["src/app.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "8100" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let started = false;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.includes("http://localhost:8100")) {
      started = true;
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk.toString());
  });

  for (let i = 0; i < 80; i += 1) {
    if (started) {
      break;
    }
    await wait(100);
  }

  if (!started) {
    child.kill("SIGTERM");
    throw new Error("服务未成功启动");
  }

  const response = await fetch("http://localhost:8100/api/aiAgent/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "请分析 clicktag home_banner_click 并给出优化建议",
    }),
  });

  const mode = response.headers.get("x-agent-mode");
  const text = await response.text();
  child.kill("SIGTERM");

  if (mode !== "openai") {
    throw new Error(`当前并非真实模型模式，x-agent-mode=${mode || "unknown"}`);
  }
  if (!text.includes("data: [DONE]")) {
    throw new Error("SSE 输出缺少结束标识 [DONE]");
  }

  const decoded = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.replace(/^data:\s/, ""))
    .filter((item) => item !== "[DONE]")
    .map((item) => decodeURIComponent(item))
    .join("")
    .trim();

  if (decoded.length < 20) {
    throw new Error("模型返回内容过短，联调结果不可信");
  }

  console.log("LLM smoke test passed");
}

main().catch((error) => {
  console.error("LLM smoke test failed:", error.message);
  process.exit(1);
});
