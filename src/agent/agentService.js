const OpenAI = require("openai");

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

async function runOpenAiMode({ question, mcpClient, stream, modelConfig }) {
  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseURL || undefined,
  });

  const mcpTools = Array.isArray(mcpClient?.tools) ? mcpClient.tools : [];
  if (!mcpTools.length) {
    throw new Error("MCP 未返回可用工具，已中止本次 OpenAI 工具调用");
  }
  const tools = mcpTools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description || "",
    parameters: tool.inputSchema || {
      type: "object",
      properties: {},
    },
  }));
  const allowedToolNames = new Set(tools.map((tool) => tool.name));

  const readOutputText = (response) => {
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
  };

  let response = await client.responses.create({
    model: modelConfig.model,
    // 预设系统角色，提示模型调用工具的行为
    input: [
      {
        role: "system",
        // content: 'You are a helpful assistant.
        content:
          "你是数据与天气助手。查询 clicktag 数据时请调用 get_clicktag_info；查询天气时请调用 get_weather_info；拿到工具结果后再回答。",
      },
      { role: "user", content: question },
    ],
    tools,// 告诉agent 工具菜单
    // tool_choice: "required",
  });

  // maxSteps = min(10, 2 + 预期链路深度 + 重试预算)
  for (let step = 0; step < 6; step += 1) {
    const outputItems = Array.isArray(response?.output) ? response.output : [];
    const functionCalls = outputItems.filter((item) => item?.type === "function_call");

    if (!functionCalls.length) {
      break;
    }
    const toolOutputs = [];
    for (const call of functionCalls) {
      const callId = call?.call_id || call?.id;
      if (!callId) {
        continue;
      }
      const callName = call?.name || "";
      const rawArgs = typeof call?.arguments === "string" ? call.arguments : "{}";
      const parsedArgs = safeJsonParse(rawArgs);
      const args = parsedArgs && typeof parsedArgs === "object" ? parsedArgs : {};

      if (!allowedToolNames.has(callName)) {
        toolOutputs.push({
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ error: `不支持的工具: ${callName}` }),
        });
        continue;
      }

      const toolResult = await mcpClient.callTool(callName, args);
      toolOutputs.push({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(toolResult),
      });
    }

    if (!toolOutputs.length) {
      break;
    }

    response = await client.responses.create({
      model: modelConfig.model,
      // 这次请求是对上一次响应的延续 ，不是一条全新的独立请求。 防止上下文断开
      previous_response_id: response.id,
      input: toolOutputs,
      tools,
    });
  }

  const finalAnswer = readOutputText(response) || "未生成回答。";
  await writeStreamByChunks(stream, finalAnswer);
}

async function processQuery({ question, mcpClient, stream, modelConfig }) {
  try {
    if (modelConfig.enabled && modelConfig.apiKey) {
      await runOpenAiMode({ question, mcpClient, stream, modelConfig });
    } else {
      await runLocalMode({ question, mcpClient, stream });
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
