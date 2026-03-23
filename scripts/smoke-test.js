const { spawn } = require("child_process");

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const child = spawn("node", ["src/app.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "8099", ENABLE_OPENAI: "false", LLM_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let started = false;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.includes("http://localhost:8099")) {
      started = true;
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk.toString());
  });

  for (let i = 0; i < 60; i += 1) {
    if (started) {
      break;
    }
    await wait(100);
  }

  if (!started) {
    child.kill("SIGTERM");
    throw new Error("服务未成功启动");
  }

  const response = await fetch("http://localhost:8099/api/aiAgent/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "请分析 clicktag home_banner_click 和 product_buy_btn",
    }),
  });
  const text = await response.text();
  child.kill("SIGTERM");

  if (!text.includes("data: [DONE]")) {
    throw new Error("SSE 输出缺少结束标识 [DONE]");
  }
  const decoded = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.replace(/^data:\s/, ""))
    .filter((item) => item !== "[DONE]")
    .map((item) => decodeURIComponent(item))
    .join("");

  if (!decoded.includes("home_banner_click")) {
    throw new Error("SSE 输出缺少工具查询结果");
  }

  console.log("Smoke test passed");
}

main().catch((error) => {
  console.error("Smoke test failed:", error.message);
  process.exit(1);
});
