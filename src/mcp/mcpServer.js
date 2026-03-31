const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  getClicktagInfo,
  getWeatherInfo,
  getAStockHistory,
  sendLarkMessage,
  runLarkWorkspaceAction,
  runWorkspaceAction,
  getWorkspaceCapabilities,
} = require("./mcpAdapter");

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
const larkInputShape = {
  text: z.string().trim().min(1, "text 不能为空").max(4000, "text 长度不能超过 4000"),
  chatId: z.string().trim().min(1, "chatId 不能为空").max(128, "chatId 长度不能超过 128").optional(),
  receiveIdType: z
    .enum(["chat_id", "open_id", "user_id", "email", "union_id"], {
      errorMap: () => ({
        message: "receiveIdType 仅支持 chat_id | open_id | user_id | email | union_id",
      }),
    })
    .optional(),
  receiveId: z.string().trim().min(1, "receiveId 不能为空").max(256, "receiveId 长度不能超过 256").optional(),
};
const larkInputSchema = z.object(larkInputShape).superRefine((value, ctx) => {
  if (value.chatId) {
    return;
  }
  if ((value.receiveIdType && !value.receiveId) || (!value.receiveIdType && value.receiveId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "receiveIdType 和 receiveId 需要同时提供",
      path: ["receiveId"],
    });
  }
});
const larkWorkspaceShape = {
  action: z.string().trim().min(1, "action 不能为空").max(128, "action 长度不能超过 128"),
  text: z.string().trim().min(1, "text 不能为空").max(4000, "text 长度不能超过 4000").optional(),
  summary: z.string().trim().min(1, "summary 不能为空").max(500, "summary 长度不能超过 500").optional(),
  description: z.string().trim().max(5000, "description 长度不能超过 5000").optional(),
  visibility: z.string().trim().max(64, "visibility 长度不能超过 64").optional(),
  preferPrimary: z.boolean().optional(),
  chatId: z.string().trim().min(1, "chatId 不能为空").max(128, "chatId 长度不能超过 128").optional(),
  receiveIdType: z
    .enum(["chat_id", "open_id", "user_id", "email", "union_id"], {
      errorMap: () => ({
        message: "receiveIdType 仅支持 chat_id | open_id | user_id | email | union_id",
      }),
    })
    .optional(),
  receiveId: z.string().trim().min(1, "receiveId 不能为空").max(256, "receiveId 长度不能超过 256").optional(),
  calendarId: z.string().trim().min(1, "calendarId 不能为空").max(256, "calendarId 长度不能超过 256").optional(),
  startTime: z
    .string()
    .trim()
    .min(1, "startTime 不能为空")
    .max(64, "startTime 长度不能超过 64")
    .optional(),
  endTime: z
    .string()
    .trim()
    .min(1, "endTime 不能为空")
    .max(64, "endTime 长度不能超过 64")
    .optional(),
  pageSize: z.number().int().min(1, "pageSize 不能小于 1").max(200, "pageSize 不能超过 200").optional(),
  pageToken: z.string().trim().max(256, "pageToken 长度不能超过 256").optional(),
};
const larkWorkspaceSchema = z
  .object(larkWorkspaceShape)
  .superRefine((value, ctx) => {
    if (value.action === "send_message") {
      if (!value.text) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "send_message 必须提供 text",
          path: ["text"],
        });
      }
      if (!value.chatId && (Boolean(value.receiveIdType) !== Boolean(value.receiveId))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "send_message 在不传 chatId 时，receiveIdType 和 receiveId 需要同时提供",
          path: ["receiveId"],
        });
      }
    }
    if (value.action === "list_calendar_events" && !value.calendarId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "list_calendar_events 必须提供 calendarId",
        path: ["calendarId"],
      });
    }
    if (value.action === "create_calendar_event") {
      if (!value.startTime || !value.endTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "create_calendar_event 必须同时提供 startTime 和 endTime",
          path: ["endTime"],
        });
      }
    }
    if ((value.startTime && !value.endTime) || (!value.startTime && value.endTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startTime 和 endTime 需要同时提供",
        path: ["endTime"],
      });
    }
  });
const workspaceActionSchema = z.object({
  provider: z.string().trim().min(1, "provider 不能为空").max(64, "provider 长度不能超过 64"),
  action: z.string().trim().min(1, "action 不能为空").max(128, "action 长度不能超过 128"),
  input: z.record(z.any()).optional(),
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

mcpServer.tool(
  "send_lark_message",
  "通过飞书/Lark 应用消息 API 发送文本消息",
  {
    text: larkInputShape.text.describe("要发送的消息文本"),
    chatId: larkInputShape.chatId.describe("可选，飞书会话 chat_id；也可传群显示名称（会自动解析）"),
    receiveIdType: larkInputShape.receiveIdType.describe("可选，接收者ID类型: chat_id/open_id/user_id/email/union_id"),
    receiveId: larkInputShape.receiveId.describe("可选，接收者ID值"),
  },
  async ({ text, chatId, receiveIdType, receiveId }) => {
    const parsedInput = larkInputSchema.safeParse({
      text,
      chatId,
      receiveIdType,
      receiveId,
    });
    if (!parsedInput.success) {
      throw new Error(parsedInput.error.issues[0]?.message || "Lark 参数不合法");
    }
    const result = await sendLarkMessage(parsedInput.data);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "发送成功",
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
  "lark_workspace_action",
  "飞书综合能力入口：动作清单由 workspace_capabilities 运行时返回，模型按权限与可用性自主选择 action",
  {
    action: larkWorkspaceShape.action.describe("动作名称，建议先调用 workspace_capabilities 再选择"),
    text: larkWorkspaceShape.text.describe("send_message 时必填，要发送的文本"),
    summary: larkWorkspaceShape.summary.describe("create_calendar_event 可选，会议主题"),
    description: larkWorkspaceShape.description.describe("create_calendar_event 可选，会议描述"),
    visibility: larkWorkspaceShape.visibility.describe("create_calendar_event 可选，可见性，如 public"),
    preferPrimary: larkWorkspaceShape.preferPrimary.describe("create_calendar_event 可选，是否优先创建到主日历，默认 true"),
    chatId: larkWorkspaceShape.chatId.describe("send_message 可选，飞书会话 chat_id；也可传群显示名称（会自动解析）"),
    receiveIdType: larkWorkspaceShape.receiveIdType.describe("send_message 可选，接收者ID类型"),
    receiveId: larkWorkspaceShape.receiveId.describe("send_message 可选，接收者ID值"),
    calendarId: larkWorkspaceShape.calendarId.describe("会议相关动作可选，日历ID"),
    startTime: larkWorkspaceShape.startTime.describe("list_calendar_events 可选，起始时间 ISO8601"),
    endTime: larkWorkspaceShape.endTime.describe("list_calendar_events 可选，结束时间 ISO8601"),
    pageSize: larkWorkspaceShape.pageSize.describe("分页大小，默认按接口约定"),
    pageToken: larkWorkspaceShape.pageToken.describe("分页游标"),
  },
  async (args) => {
    const parsedInput = larkWorkspaceSchema.safeParse(args);
    if (!parsedInput.success) {
      throw new Error(parsedInput.error.issues[0]?.message || "lark_workspace_action 参数不合法");
    }
    const result = await runLarkWorkspaceAction(parsedInput.data);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "执行成功",
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
  "workspace_capabilities",
  "查询当前已接入的业务 Provider 及其动作能力，供模型自主规划后再调用 workspace_action",
  {},
  async () => {
    const result = await getWorkspaceCapabilities();
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
  "workspace_action",
  "通用业务能力入口。由 provider + action + input 执行，避免将能力绑定在单一平台，实现可扩展 Agent。",
  {
    provider: workspaceActionSchema.shape.provider.describe("业务提供方，例如 lark、meituan、ctrip"),
    action: workspaceActionSchema.shape.action.describe("业务动作名称，例如 summarize_today_meetings"),
    input: workspaceActionSchema.shape.input.describe("动作参数对象，结构由 provider/action 决定"),
  },
  async ({ provider, action, input }) => {
    const parsedInput = workspaceActionSchema.safeParse({
      provider,
      action,
      input,
    });
    if (!parsedInput.success) {
      throw new Error(parsedInput.error.issues[0]?.message || "workspace_action 参数不合法");
    }
    const result = await runWorkspaceAction(parsedInput.data);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "执行成功",
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

/** 
 * 
 * 除了 content ，还常见这些顶层字段（按你现在用的 SDK 类型定义）：
- structuredContent （可选）：结构化对象数据
- isError （可选）：标记这次 tool 调用是否为错误结果
- _meta （可选）：元信息（例如 progress token、关联任务信息）你可以在这里看到定义：types.d.ts:CallToolResultSchema
另外， content 本身不是只能 text，它的块类型还支持：
- text
- image
- audio
- resource_link
- resource
contetn 是强约束

MCP 规定“外壳”（content 块结构），你自定义“内核”（text 里的业务 JSON）。
*/

module.exports = { mcpServer };
