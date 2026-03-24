const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const { getClicktagInfo, getWeatherInfo } = require("../mcp/mcpAdapter");

const envPath = process.env.ENV_FILE
  ? path.resolve(process.cwd(), process.env.ENV_FILE)
  : fs.existsSync(path.resolve(process.cwd(), ".env"))
    ? path.resolve(process.cwd(), ".env")
    : path.resolve(process.cwd(), ".env.example");
dotenv.config({ path: envPath });

function safeJsonParse(content) {
  try {
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

function readOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
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

async function runFunctionCalling({ question, model = process.env.LLM_MODEL || "gpt-4o-mini" }) {
  const apiKey = String(process.env.LLM_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("缺少 LLM_API_KEY");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.LLM_BASE_URL || undefined,
  });

  const tools = [
    {
      type: "function",
      name: "get_clicktag_info",
      description: "按 clicktag 查询 PV、UV、CTR",
      parameters: {
        type: "object",
        properties: {
          clicktags: {
            type: "string",
            description: "逗号分隔的 clicktag 列表，例如 home_banner_click,product_buy_btn",
          },
        },
        required: ["clicktags"],
      },
    },
    {
      type: "function",
      name: "get_weather_info",
      description: "按城市查询天气信息",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "城市名称，例如 北京、Shanghai",
          },
        },
        required: ["city"],
      },
    },
  ];

  const handlers = {
    async get_clicktag_info(args) {
      const clicktags = String(args?.clicktags || "").trim();
      if (!clicktags) {
        return { error: "clicktags 不能为空" };
      }
      const data = await getClicktagInfo({ clicktags });
      return { message: "查询成功", data };
    },
    async get_weather_info(args) {
      const city = String(args?.city || "").trim();
      if (!city) {
        return { error: "city 不能为空" };
      }
      const data = await getWeatherInfo({ city });
      return { message: "查询成功", data };
    },
  };

  let response = await client.responses.create({
    model,
    input: [
      {
        role: "system",
        content:
          "你是数据与天气助手。查询 clicktag 数据时请调用 get_clicktag_info；查询天气时请调用 get_weather_info；拿到工具结果后再回答。",
      },
      { role: "user", content: question },
    ],
    tools,
  });

  for (let step = 0; step < 6; step += 1) {
    const outputItems = Array.isArray(response?.output) ? response.output : [];
    const functionCalls = outputItems.filter((item) => item?.type === "function_call");
    if (!functionCalls.length) {
      break;
    }

    const toolOutputs = [];
    for (const call of functionCalls) {
      const callId = call?.call_id || call?.id;
      const name = String(call?.name || "");
      if (!callId || !name) {
        continue;
      }
      const args = safeJsonParse(call?.arguments || "{}") || {};
      const handler = handlers[name];
      const output = handler
        ? await handler(args)
        : { error: `不支持的工具: ${name}` };
      toolOutputs.push({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      });
    }

    if (!toolOutputs.length) {
      break;
    }

    response = await client.responses.create({
      model,
      previous_response_id: response.id,
      input: toolOutputs,
      tools,
    });
  }

  return readOutputText(response) || "未生成回答。";
}

async function main() {
  const question = String(process.argv.slice(2).join(" ") || "").trim();
  if (!question) {
    console.error("请传入问题，例如: node src/function-calling.js 北京天气");
    process.exit(1);
  }
  const answer = await runFunctionCalling({ question });
  console.log(answer);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("执行失败:", error?.message || error);
    process.exit(1);
  });
}

module.exports = { runFunctionCalling };
