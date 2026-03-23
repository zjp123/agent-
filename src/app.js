const fs = require("fs");
const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { PassThrough } = require("stream");
const { McpClient } = require("./agent/mcpClient");
const { processQuery } = require("./agent/agentService");

const envPath = process.env.ENV_FILE
  ? path.resolve(process.cwd(), process.env.ENV_FILE)
  : fs.existsSync(path.resolve(process.cwd(), ".env"))
    ? path.resolve(process.cwd(), ".env")
    : path.resolve(process.cwd(), ".env.example");
dotenv.config({ path: envPath });

const app = express();
const PORT = Number(process.env.PORT || 8001);

app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../public")));

const mcpClient = new McpClient();

app.post("/api/aiAgent/ask", async (req, res) => {
  const modelEnabled = process.env.ENABLE_OPENAI === "true" && Boolean(process.env.LLM_API_KEY);
  res.setHeader("X-Agent-Mode", modelEnabled ? "openai" : "local");

  // SSE 响应头：保持连接不断开，按块推送数据
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");

  // PassThrough 用于把服务层写入的数据直接透传给前端
  const stream = new PassThrough();
  stream.pipe(res);

  try {
    const question = String(req.body?.question || "").trim();
    if (!question) {
      // stream.write(`data: ${encodeURIComponent("请提供您的问题")}\n\n`);
      stream.write(`data: ${JSON.stringify({"error": "请提供您的问题"})}\n\n`);
      stream.write("data: [DONE]\n\n");
      stream.end();
      return;
    }

    await processQuery({
      question,
      mcpClient,
      stream,
      modelConfig: {
        enabled: modelEnabled,
        apiKey: process.env.LLM_API_KEY || "",
        baseURL: process.env.LLM_BASE_URL || "",
        model: process.env.LLM_MODEL || "gpt-4o-mini",
      },
    });
  } catch (error) {
    // stream.write(`data: ${encodeURIComponent("服务异常，请稍后重试")}\n\n`);
    stream.write(`data: ${JSON.stringify({"error": "服务异常，请稍后重试"})}\n\n`);
    stream.write("data: [DONE]\n\n");
    stream.end();
  }
});

async function bootstrap() {
  // 启动 HTTP 服务前，先连接本地 MCP Server，确保工具可用
  await mcpClient.connectToServer();
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});
