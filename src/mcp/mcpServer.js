const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { getClicktagInfo, getWeatherInfo, getAStockHistory } = require("./mcpAdapter");

const clicktagsInputSchema = z.object({
  clicktags: z
    .string()
    .trim()
    .min(1, "clicktags 不能为空")
    .max(500, "clicktags 长度不能超过 500")
    .regex(/^[a-zA-Z0-9_:\-,\s]+$/, "clicktags 包含非法字符"),
});
const weatherInputSchema = z.object({
  city: z
    .string()
    .trim()
    .min(1, "city 不能为空")
    .max(40, "city 长度不能超过 40")
    .regex(/^[\u4e00-\u9fa5a-zA-Z\s·-]+$/, "city 格式不合法"),
});
const aShareInputSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1, "symbol 不能为空")
    .max(12, "symbol 长度不能超过 12")
    .regex(/^(?:(?:sh|sz|bj)\d{6}|\d{6})$/i, "symbol 格式不合法，例如 600519 或 sh600519"),
});

const mcpServer = new McpServer({
  name: "demo-mcp-server",
  version: "1.0.0",
});

mcpServer.tool(
  "get_clicktag_info",
  "按 clicktag 查询 PV、UV、CTR",
  {
    clicktags: clicktagsInputSchema.shape.clicktags.describe("逗号分隔的 clicktag 列表"),
  },
  async ({ clicktags }) => {
    const parsedInput = clicktagsInputSchema.safeParse({ clicktags });
    if (!parsedInput.success) {
      throw new Error(parsedInput.error.issues[0]?.message || "clicktags 参数不合法");
    }
    const normalizedClicktags = parsedInput.data.clicktags
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .join(",");
    if (!normalizedClicktags) {
      throw new Error("clicktags 参数不能为空");
    }
    const result = await getClicktagInfo({ clicktags: normalizedClicktags });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "查询成功",
              data: result,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

mcpServer.tool(
  "get_weather_info",
  "按城市查询天气信息",
  {
    city: weatherInputSchema.shape.city.describe("城市名称，例如：北京、Shanghai"),
  },
  async ({ city }) => {
    const parsedInput = weatherInputSchema.safeParse({ city });
    if (!parsedInput.success) {
      throw new Error(parsedInput.error.issues[0]?.message || "city 参数不合法");
    }
    const result = await getWeatherInfo({ city: parsedInput.data.city });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "查询成功",
              data: result,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

mcpServer.tool(
  "get_a_share_history",
  "按 A 股股票代码查询近一年日线价格数据",
  {
    symbol: aShareInputSchema.shape.symbol.describe("A 股代码，例如 600519、000001、sh600519"),
  },
  async ({ symbol }) => {
    const parsedInput = aShareInputSchema.safeParse({ symbol });
    if (!parsedInput.success) {
      throw new Error(parsedInput.error.issues[0]?.message || "symbol 参数不合法");
    }
    const result = await getAStockHistory({ symbol: parsedInput.data.symbol });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "查询成功",
              data: result,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

module.exports = { mcpServer };
