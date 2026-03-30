const OpenAI = require("openai");
const { runReActStateMachine } = require("./reactStateMachine");

const DEFAULT_THINKING_MODE = "react";
const SUPPORTED_THINKING_MODES = new Set(["react", "local"]);

function safeJsonParse(content) {
  try {
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

function extractClicktags(question) {
  const matched = question.match(/([a-zA-Z][a-zA-Z0-9_:-]{2,})/g) || [];
  const unique = [...new Set(matched.map((item) => item.toLowerCase()))];
  return unique.slice(0, 5);
}

function isWeatherQuestion(question) {
  return /(天气|气温|温度|下雨|weather)/i.test(question);
}

function extractCity(question) {
  const cnMatch = question.match(/([\u4e00-\u9fa5]{2,20})(?:市|区|县)?(?:今天|明天|后天)?(?:的)?(?:天气|气温|温度)/);
  if (cnMatch?.[1]) {
    return cnMatch[1];
  }
  const enMatch = question.match(/weather(?:\s+in)?\s+([a-zA-Z][a-zA-Z\s-]{1,30})/i);
  if (enMatch?.[1]) {
    return enMatch[1].trim();
  }
  return "北京";
}

function isAStockQuestion(question) {
  return /(a股|股票|股价|k线|走势|上证|深证|沪深|sh\d{6}|sz\d{6}|\b[0368]\d{5}\b)/i.test(
    question
  );
}

function extractAStockSymbol(question) {
  const normalized = String(question || "").toLowerCase().replace(/\s+/g, "");
  const prefixed = normalized.match(/(sh|sz|bj)\d{6}/);
  if (prefixed?.[0]) {
    return prefixed[0];
  }
  const plain = normalized.match(/\b[0368]\d{5}\b/);
  if (plain?.[0]) {
    return plain[0];
  }
  return "600519";
}

function normalizeThinkingMode(thinkingMode) {
  const mode = String(thinkingMode || DEFAULT_THINKING_MODE).toLowerCase().trim();
  if (SUPPORTED_THINKING_MODES.has(mode)) {
    return mode;
  }
  return DEFAULT_THINKING_MODE;
}

function mapMcpToolsToOpenAiTools(mcpClient) {
  const mcpTools = Array.isArray(mcpClient?.tools) ? mcpClient.tools : [];
  return mcpTools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description || "",
    parameters: tool.inputSchema || {
      type: "object",
      properties: {},
    },
  }));
}

function createReActSystemPrompt(toolNames) {
  const menu = toolNames.length ? toolNames.join("、") : "无";
  return [
    "你是一个 ReAct Agent。",
    "你需要在每一步先判断是否需要行动，再决定是否调用工具。",
    "可用工具只有以下这些：",
    menu,
    "当信息不足时，优先调用工具；当信息足够时，直接给出最终回答。",
    "当用户要求“发给飞书/Lark”时，优先理解完整意图与上下文，先完成内容生成，再调用 send_lark_message 发送。",
    "涉及 send_lark_message 时，不要主动索要 chat_id 或 receiveId，先直接调用工具；仅当工具明确报错缺少接收方时再提示用户。",
    "如果用户提供的是群名称（例如“哈哈哈”），先调用 lark_workspace_action(action=list_chats) 找到匹配 chatId，再调用 send_lark_message 或 lark_workspace_action(action=send_message) 发送。",
    "如果用户要求“先A再发给飞书”，请先完成 A，再把最终内容通过 send_lark_message 发送。",
    "处理飞书会议时间时，默认按 Asia/Shanghai（北京时间）展示；除非用户明确要求 UTC，否则不要将北京时间误写成 UTC。",
    "当会议数据里存在 meetingLink 字段时，汇总结果要一并展示会议链接。",
    "禁止编造不存在的工具；如果用户目标超出可用工具能力，请明确说明能力边界并给出下一步建议。",
  ].join("");
}

async function writeStreamByChunks(stream, text) {
  // 模拟模型“逐字输出”的体验
  const chunkSize = 20;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    stream.write(`data: ${encodeURIComponent(chunk)}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function runLocalMode({ question, mcpClient, stream }) {
  if (isWeatherQuestion(question)) {
    const city = extractCity(question);
    const toolResult = await mcpClient.callTool("get_weather_info", { city });
    const textBlock = toolResult?.content?.[0]?.text || "{}";
    const parsed = safeJsonParse(textBlock) || {};
    const weather = parsed?.data || {};
    const weatherText = [
      `我已经调用 MCP 工具查询天气：`,
      `城市：${weather.city || city}`,
      `天气：${weather.condition || "未知"}`,
      `温度：${weather.temperature ?? "--"}${weather?.unit?.temperature || "°C"}`,
      `湿度：${weather.humidity ?? "--"}${weather?.unit?.humidity || "%"}`,
      `风速：${weather.windSpeed ?? "--"}${weather?.unit?.windSpeed || "m/s"}`,
    ].join("\n");
    await writeStreamByChunks(stream, weatherText);
    return;
  }

  if (isAStockQuestion(question)) {
    const symbol = extractAStockSymbol(question);
    const toolResult = await mcpClient.callTool("get_a_share_history", { symbol });
    const textBlock = toolResult?.content?.[0]?.text || "{}";
    const parsed = safeJsonParse(textBlock) || {};
    const stock = parsed?.data || {};
    const summary = stock?.summary || {};
    const stockText = [
      `我已经调用 MCP 工具查询 A 股历史行情：`,
      `代码：${stock.symbol || symbol}`,
      `交易所：${stock.exchange || "--"}`,
      `区间：${stock.from || "--"} 到 ${stock.to || "--"}`,
      `起始收盘：${summary.startClose ?? "--"}`,
      `结束收盘：${summary.endClose ?? "--"}`,
      `涨跌额：${summary.change ?? "--"}`,
      `涨跌幅：${summary.changePercent ?? "--"}%`,
      `最高价：${summary.highest ?? "--"}`,
      `最低价：${summary.lowest ?? "--"}`,
      `数据点：${summary.pointCount ?? "--"} 个交易日`,
      `已返回可绘制折线图的数据序列（labels + closeSeries）。`,
    ].join("\n");
    await writeStreamByChunks(stream, stockText);
    return;
  }

  const clicktags = extractClicktags(question);
  const targetTags = clicktags.length ? clicktags : ["home_banner_click"];
  const toolResult = await mcpClient.callTool("get_clicktag_info", {
    clicktags: targetTags.join(","),
  });

  const textBlock = toolResult?.content?.[0]?.text || "{}";
  const parsed = safeJsonParse(textBlock) || {};
  const rows = Array.isArray(parsed.data) ? parsed.data : [];

  const header = "我已经调用 MCP 工具完成查询，下面是分析结果：\n";
  const body =
    rows
      .map(
        (row, index) =>
          `${index + 1}. ${row.clicktag}：PV=${row.pv}，UV=${row.uv}，转化率=${row.ctr}%`
      )
      .join("\n") || "未查到数据，请更换 clicktag 再试。";
  const tail =
    "\n\n建议：优先优化 CTR 最低且 PV 较高的入口位，先改文案和按钮样式，再做 A/B 测试。";

  await writeStreamByChunks(stream, `${header}${body}${tail}`);
}

async function runReActMode({ question, mcpClient, stream, modelConfig }) {
  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseURL || undefined,
  });

  const tools = mapMcpToolsToOpenAiTools(mcpClient);
  if (!tools.length) {
    throw new Error("MCP 未返回可用工具，已中止本次 OpenAI 工具调用");
  }
  const allowedToolNames = new Set(tools.map((tool) => tool.name));
  const systemPrompt = createReActSystemPrompt([...allowedToolNames]);

  const finalAnswer = await runReActStateMachine({
    llmClient: client,
    model: modelConfig.model,
    systemPrompt,
    question,
    tools,
    mcpClient,
    maxSteps: 6,
  });
  await writeStreamByChunks(stream, finalAnswer);
}

async function processQuery({ question, mcpClient, stream, modelConfig }) {
  try {
    const thinkingMode = normalizeThinkingMode(modelConfig.thinkingMode);
    if (!modelConfig.enabled || !modelConfig.apiKey) {
      await runLocalMode({ question, mcpClient, stream });
    } else if (thinkingMode === "local") {
      await runLocalMode({ question, mcpClient, stream });
    } else {
      await runReActMode({ question, mcpClient, stream, modelConfig });
    }
    stream.write("data: [DONE]\n\n");
    stream.end();
  } catch (error) {
    console.error("processQuery error:", error?.message || error);
    stream.write(
      `data: ${JSON.stringify({"error": "抱歉，处理请求时出现错误，请稍后重试。"})}\n\n`
    );
    stream.write("data: [DONE]\n\n");
    stream.end();
  }
}

module.exports = { processQuery };
