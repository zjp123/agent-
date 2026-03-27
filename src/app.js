const fs = require("fs");
const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const Lark = require("@larksuiteoapi/node-sdk");
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
const MODEL_ENABLED = process.env.ENABLE_OPENAI === "true" && Boolean(process.env.LLM_API_KEY);
const LARK_LONG_CONNECTION_ENABLED = String(process.env.LARK_LONG_CONNECTION_ENABLED || "false") === "true";
let larkApiClient = null;
const LARK_RECEIVER_CACHE_FILE = path.resolve(process.cwd(), ".lark-receiver-cache.json");

function normalizeLarkDomain(domainInput) {
  const normalized = String(domainInput || "lark").trim().toLowerCase();
  if (normalized === "feishu") {
    return Lark.Domain.Feishu;
  }
  if (normalized === "lark") {
    return Lark.Domain.Lark;
  }
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return normalized;
  }
  return Lark.Domain.Lark;
}

function normalizeLarkAppType(appTypeInput) {
  const normalized = String(appTypeInput || "self_build").trim().toLowerCase();
  if (normalized === "marketplace") {
    return Lark.AppType.Marketplace;
  }
  return Lark.AppType.SelfBuild;
}

function readAgentTextFromSse(raw) {
  const lines = String(raw || "")
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.replace(/^data:\s/, ""))
    .filter((line) => line && line !== "[DONE]");
  const chunks = [];
  for (const item of lines) {
    try {
      const parsed = JSON.parse(item);
      if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
        throw new Error(parsed.error.trim());
      }
    } catch (_) {
      chunks.push(decodeURIComponent(item));
    }
  }
  return chunks.join("").trim();
}

function extractLarkText(contentText) {
  const source = String(contentText || "").trim();
  if (!source) {
    return "";
  }
  try {
    const parsed = JSON.parse(source);
    return String(parsed?.text || "").trim();
  } catch (_) {
    return "";
  }
}

function trimReplyText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 3800) {
    return normalized;
  }
  return `${normalized.slice(0, 3800)}...`;
}

function isChatIdQuery(question) {
  const normalized = String(question || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("chat_id") || normalized.includes("chatid")) {
    return true;
  }
  return /获取|查询|查看|告诉我/.test(normalized) && /会话|id/.test(normalized);
}

function upsertLarkReceiverCache({ chatId }) {
  const targetChatId = String(chatId || "").trim();
  if (!targetChatId) {
    return;
  }
  const payload = {
    receiveIdType: "chat_id",
    receiveId: targetChatId,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(LARK_RECEIVER_CACHE_FILE, JSON.stringify(payload));
}

async function sendLarkReply({ chatId, text }) {
  const content = trimReplyText(text);
  if (!content) {
    return;
  }
  if (!larkApiClient) {
    throw new Error("缺少 Lark 应用客户端配置，请检查 LARK_APP_ID/LARK_APP_SECRET");
  }
  const targetChatId = String(chatId || "").trim();
  if (!targetChatId) {
    throw new Error("回复消息时缺少 chat_id");
  }

  await larkApiClient.im.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: targetChatId,
      msg_type: "text",
      content: JSON.stringify({ text: content }),
    },
  });
}

// 回复lark
async function processLarkIncomingMessage({ content, chatId, senderType }) {
  if (String(senderType || "").trim().toLowerCase() === "app") {
    return;
  }
  const question = extractLarkText(content);
  upsertLarkReceiverCache({ chatId });
  if (!question) {
    await sendLarkReply({
      chatId,
      text: "收到消息，但内容为空，请发送文本消息。",
    });
    return;
  }
  if (isChatIdQuery(question)) {
    await sendLarkReply({
      chatId,
      text: `当前会话 chat_id：${chatId}。该会话已注册为网页侧默认飞书接收目标。`,
    });
    return;
  }

  const answer = await runAgentAndCollectText(question);
  await sendLarkReply({
    chatId,
    text: answer || "我已收到你的消息，但暂时没有可返回的内容。",
  });
}

function createLarkClient() {
  const appId = String(process.env.LARK_APP_ID || "").trim();
  const appSecret = String(process.env.LARK_APP_SECRET || "").trim();
  if (!appId || !appSecret) {
    return null;
  }
  return new Lark.Client({
    appId,
    appSecret,
    appType: normalizeLarkAppType(process.env.LARK_APP_TYPE),
    domain: normalizeLarkDomain(process.env.LARK_DOMAIN),
  });
}

// im.message.receive_v1 注册与消息处理
function startLarkLongConnection() {
  if (!LARK_LONG_CONNECTION_ENABLED) {
    return;
  }
  const appId = String(process.env.LARK_APP_ID || "").trim();
  const appSecret = String(process.env.LARK_APP_SECRET || "").trim();
  if (!appId || !appSecret) {
    console.error("Lark 长连接已启用，但缺少 LARK_APP_ID 或 LARK_APP_SECRET");
    return;
  }

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    appType: normalizeLarkAppType(process.env.LARK_APP_TYPE),
    domain: normalizeLarkDomain(process.env.LARK_DOMAIN),
    loggerLevel: Lark.LoggerLevel.info,
  });

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (payload) => {
      const event = payload?.event || payload || {};
      await processLarkIncomingMessage({
        content: event?.message?.content,
        chatId: event?.message?.chat_id,
        senderType: event?.sender?.sender_type,
      });
    },
  });

  wsClient.start({ eventDispatcher });
}

async function runAgentAndCollectText(question) {
  const stream = new PassThrough();
  const chunks = [];

  stream.on("data", (chunk) => {
    chunks.push(chunk.toString());
  });

  await processQuery({
    question,
    mcpClient,
    stream,
    modelConfig: {
      enabled: MODEL_ENABLED,
      apiKey: process.env.LLM_API_KEY || "",
      baseURL: process.env.LLM_BASE_URL || "",
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      thinkingMode: process.env.AGENT_THINKING_MODE || "react",
    },
  });

  const raw = chunks.join("");
  return readAgentTextFromSse(raw);
}

app.post("/api/aiAgent/ask", async (req, res) => {
  res.setHeader("X-Agent-Mode", MODEL_ENABLED ? "openai" : "local");
  res.setHeader("X-Agent-Thinking-Mode", String(process.env.AGENT_THINKING_MODE || "react"));

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
        enabled: MODEL_ENABLED,
        apiKey: process.env.LLM_API_KEY || "",
        baseURL: process.env.LLM_BASE_URL || "",
        model: process.env.LLM_MODEL || "gpt-4o-mini",
        thinkingMode: process.env.AGENT_THINKING_MODE || "react",
      },
    });
  } catch (error) {
    // stream.write(`data: ${encodeURIComponent("服务异常，请稍后重试")}\n\n`);
    stream.write(`data: ${JSON.stringify({"error": "服务异常，请稍后重试"})}\n\n`);
    stream.write("data: [DONE]\n\n");
    stream.end();
  }
});

app.post("/api/lark/events", async (req, res) => {
  if (req.body?.challenge) {
    res.json({ challenge: req.body.challenge });
    return;
  }

  const eventType = String(req.body?.header?.event_type || "").trim();
  if (eventType !== "im.message.receive_v1") {
    res.json({ code: 0, msg: "ignored" });
    return;
  }

  const messageType = String(req.body?.event?.message?.message_type || "").trim();
  if (messageType !== "text") {
    res.json({ code: 0, msg: "ignored non-text message" });
    return;
  }

  try {
    await processLarkIncomingMessage({
      content: req.body?.event?.message?.content,
      chatId: req.body?.event?.message?.chat_id,
      senderType: req.body?.event?.sender?.sender_type,
    });
    res.json({ code: 0, msg: "ok" });
  } catch (error) {
    const fallback = "处理消息时出现异常，请稍后重试。";
    try {
      await sendLarkReply({ text: fallback, chatId: req.body?.event?.message?.chat_id });
    } catch (_) {}
    res.json({ code: 0, msg: "ok" });
  }
});

async function bootstrap() {
  await mcpClient.connectToServer();
  larkApiClient = createLarkClient();
  // 开启长连接
  startLarkLongConnection();
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});
