const OpenAI = require("openai");

const DEFAULT_THINKING_MODE = "planning";
const SUPPORTED_THINKING_MODES = new Set(["planning"]);

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

function readOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const blocks = [];
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  for (const item of outputItems) {
    if (item?.type !== "message") {
      continue;
    }
    const contentList = Array.isArray(item?.content) ? item.content : [];
    for (const contentItem of contentList) {
      if (typeof contentItem?.text === "string") {
        blocks.push(contentItem.text);
      }
    }
  }
  return blocks.join("\n").trim();
}

function normalizeThinkingMode(mode) {
  const normalized = String(mode || DEFAULT_THINKING_MODE).toLowerCase().trim();
  if (SUPPORTED_THINKING_MODES.has(normalized)) {
    return normalized;
  }
  return DEFAULT_THINKING_MODE;
}

function getAvailableToolNames(mcpClient) {
  const tools = Array.isArray(mcpClient?.tools) ? mcpClient.tools : [];
  return new Set(tools.map((tool) => tool.name));
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

function buildRuleBasedPlan(question, allowedToolNames) {
  if (isWeatherQuestion(question) && allowedToolNames.has("get_weather_info")) {
    return {
      goal: "查询天气并生成结构化摘要",
      steps: [
        {
          id: "s1",
          action: "call_tool",
          toolName: "get_weather_info",
          args: { city: extractCity(question) },
        },
      ],
    };
  }

  if (isAStockQuestion(question) && allowedToolNames.has("get_a_share_history")) {
    return {
      goal: "查询 A 股历史行情并汇总关键指标",
      steps: [
        {
          id: "s1",
          action: "call_tool",
          toolName: "get_a_share_history",
          args: { symbol: extractAStockSymbol(question) },
        },
      ],
    };
  }

  if (allowedToolNames.has("get_clicktag_info")) {
    const clicktags = extractClicktags(question);
    return {
      goal: "查询 clicktag 指标并给出优化建议",
      steps: [
        {
          id: "s1",
          action: "call_tool",
          toolName: "get_clicktag_info",
          args: { clicktags: (clicktags.length ? clicktags : ["home_banner_click"]).join(",") },
        },
      ],
    };
  }

  const firstToolName = [...allowedToolNames][0];
  return {
    goal: "调用可用工具完成查询",
    steps: firstToolName
      ? [
          {
            id: "s1",
            action: "call_tool",
            toolName: firstToolName,
            args: {},
          },
        ]
      : [],
  };
}

function normalizePlan(plan, question, allowedToolNames) {
  const fallback = buildRuleBasedPlan(question, allowedToolNames);
  if (!plan || typeof plan !== "object") {
    return fallback;
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const normalizedSteps = steps
    .map((step, index) => {
      if (step?.action !== "call_tool") {
        return null;
      }
      const toolName = String(step?.toolName || "").trim();
      if (!toolName || !allowedToolNames.has(toolName)) {
        return null;
      }
      const args = step?.args && typeof step.args === "object" ? step.args : {};
      return {
        id: String(step?.id || `s${index + 1}`),
        action: "call_tool",
        toolName,
        args,
      };
    })
    .filter(Boolean);

  if (!normalizedSteps.length) {
    return fallback;
  }

  return {
    goal: String(plan.goal || fallback.goal),
    steps: normalizedSteps,
  };
}

function normalizeToolArgs(toolName, args, question) {
  if (toolName === "get_weather_info") {
    const city = String(args?.city || "").trim() || extractCity(question);
    return { city };
  }
  if (toolName === "get_a_share_history") {
    const symbol = String(args?.symbol || "").trim() || extractAStockSymbol(question);
    return { symbol };
  }
  if (toolName === "get_clicktag_info") {
    const clicktags =
      String(args?.clicktags || "").trim() ||
      (extractClicktags(question).length ? extractClicktags(question).join(",") : "home_banner_click");
    return { clicktags };
  }
  return args && typeof args === "object" ? args : {};
}

function parseToolData(toolResult) {
  const textBlock = toolResult?.content?.[0]?.text || "{}";
  const parsed = safeJsonParse(textBlock) || {};
  return parsed?.data ?? parsed;
}

function formatWeatherAnswer(data, fallbackCity) {
  return [
    "我已经按计划完成天气查询：",
    `城市：${data?.city || fallbackCity}`,
    `天气：${data?.condition || "未知"}`,
    `温度：${data?.temperature ?? "--"}${data?.unit?.temperature || "°C"}`,
    `湿度：${data?.humidity ?? "--"}${data?.unit?.humidity || "%"}`,
    `风速：${data?.windSpeed ?? "--"}${data?.unit?.windSpeed || "m/s"}`,
  ].join("\n");
}

function formatAStockAnswer(data, fallbackSymbol) {
  const summary = data?.summary || {};
  return [
    "我已经按计划完成 A 股历史行情查询：",
    `代码：${data?.symbol || fallbackSymbol}`,
    `交易所：${data?.exchange || "--"}`,
    `区间：${data?.from || "--"} 到 ${data?.to || "--"}`,
    `起始收盘：${summary.startClose ?? "--"}`,
    `结束收盘：${summary.endClose ?? "--"}`,
    `涨跌额：${summary.change ?? "--"}`,
    `涨跌幅：${summary.changePercent ?? "--"}%`,
    `最高价：${summary.highest ?? "--"}`,
    `最低价：${summary.lowest ?? "--"}`,
    `数据点：${summary.pointCount ?? "--"} 个交易日`,
    "已返回可绘制折线图的数据序列（labels + closeSeries）。",
  ].join("\n");
}

function formatClicktagAnswer(dataRows) {
  const rows = Array.isArray(dataRows) ? dataRows : [];
  const header = "我已经按计划完成 clicktag 查询，下面是分析结果：\n";
  const body =
    rows
      .map(
        (row, index) =>
          `${index + 1}. ${row.clicktag}：PV=${row.pv}，UV=${row.uv}，转化率=${row.ctr}%`
      )
      .join("\n") || "未查到数据，请更换 clicktag 再试。";
  const tail =
    "\n\n建议：优先优化 CTR 最低且 PV 较高的入口位，先改文案和按钮样式，再做 A/B 测试。";
  return `${header}${body}${tail}`;
}

function synthesizeAnswerFromObservations(observations) {
  const firstSuccess = observations.find((item) => item.ok);
  if (!firstSuccess) {
    return "已完成计划执行，但工具调用均失败，请稍后重试。";
  }
  if (firstSuccess.toolName === "get_weather_info") {
    return formatWeatherAnswer(firstSuccess.data, firstSuccess.args?.city || "北京");
  }
  if (firstSuccess.toolName === "get_a_share_history") {
    return formatAStockAnswer(firstSuccess.data, firstSuccess.args?.symbol || "600519");
  }
  if (firstSuccess.toolName === "get_clicktag_info") {
    return formatClicktagAnswer(firstSuccess.data);
  }
  return JSON.stringify(firstSuccess.data || {}, null, 2);
}

async function tryBuildModelPlan({ client, question, model, tools, allowedToolNames }) {
  const toolCatalog = tools.map((tool) => `${tool.name}`).join(", ");
  const response = await client.responses.create({
    model,
    input: [
      {
        role: "system",
        content:
          `你是 Planner。请把用户问题拆成可执行计划，只输出 JSON，不要输出 markdown。可用工具：${toolCatalog}。` +
          'JSON 结构：{"goal":"...","steps":[{"id":"s1","action":"call_tool","toolName":"...","args":{}}]}。',
      },
      { role: "user", content: question },
    ],
  });
  const parsed = safeJsonParse(readOutputText(response));
  return normalizePlan(parsed, question, allowedToolNames);
}

async function executePlan({ plan, question, mcpClient, allowedToolNames }) {
  const observations = [];
  for (const step of plan.steps.slice(0, 6)) {
    if (step.action !== "call_tool") {
      observations.push({ ok: false, error: "不支持的动作类型", step });
      continue;
    }
    if (!allowedToolNames.has(step.toolName)) {
      observations.push({ ok: false, error: `不支持的工具: ${step.toolName}`, step });
      continue;
    }
    const args = normalizeToolArgs(step.toolName, step.args, question);
    try {
      const toolResult = await mcpClient.callTool(step.toolName, args);
      observations.push({
        ok: true,
        toolName: step.toolName,
        args,
        data: parseToolData(toolResult),
        raw: toolResult,
      });
    } catch (error) {
      observations.push({
        ok: false,
        toolName: step.toolName,
        args,
        error: error?.message || String(error),
      });
    }
  }
  return observations;
}

async function trySynthesizeByModel({ client, model, question, plan, observations }) {
  const response = await client.responses.create({
    model,
    input: [
      {
        role: "system",
        content: "你是执行总结助手。基于计划和工具执行结果，输出最终答复。",
      },
      {
        role: "user",
        content: JSON.stringify({ question, plan, observations }),
      },
    ],
  });
  return readOutputText(response);
}

async function writeStreamByChunks(stream, text) {
  const chunkSize = 20;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    stream.write(`data: ${encodeURIComponent(chunk)}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function runPlanningMode({ question, mcpClient, stream, modelConfig }) {
  const tools = mapMcpToolsToOpenAiTools(mcpClient);
  if (!tools.length) {
    throw new Error("MCP 未返回可用工具，已中止本次 OpenAI 工具调用");
  }
  const allowedToolNames = new Set(tools.map((tool) => tool.name));
  const canUseModelPlanner = Boolean(modelConfig.enabled && modelConfig.apiKey);
  const client = canUseModelPlanner
    ? new OpenAI({
        apiKey: modelConfig.apiKey,
        baseURL: modelConfig.baseURL || undefined,
      })
    : null;

  let plan = null;
  if (client) {
    try {
      plan = await tryBuildModelPlan({
        client,
        question,
        model: modelConfig.model,
        tools,
        allowedToolNames,
      });
    } catch (_) {
      plan = null;
    }
  }
  if (!plan) {
    plan = buildRuleBasedPlan(question, allowedToolNames);
  }

  let observations = await executePlan({ plan, question, mcpClient, allowedToolNames });
  if (!observations.some((item) => item.ok)) {
    const replanned = buildRuleBasedPlan(question, allowedToolNames);
    observations = await executePlan({
      plan: replanned,
      question,
      mcpClient,
      allowedToolNames,
    });
    plan = replanned;
  }

  let finalAnswer = "";
  if (client) {
    try {
      finalAnswer = await trySynthesizeByModel({
        client,
        model: modelConfig.model,
        question,
        plan,
        observations,
      });
    } catch (_) {
      finalAnswer = "";
    }
  }
  if (!finalAnswer) {
    finalAnswer = synthesizeAnswerFromObservations(observations);
  }
  await writeStreamByChunks(stream, finalAnswer);
}

async function processQuery({ question, mcpClient, stream, modelConfig }) {
  try {
    const thinkingMode = normalizeThinkingMode(modelConfig.thinkingMode);
    const handlers = {
      planning: runPlanningMode,
    };
    const handler = handlers[thinkingMode] || runPlanningMode;
    await handler({ question, mcpClient, stream, modelConfig });
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
