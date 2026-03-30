const test = require("node:test");
const assert = require("node:assert/strict");

const { runReActStateMachine } = require("./reactStateMachine");

function createToolCall({ id, name, args }) {
  return {
    type: "function_call",
    id,
    call_id: id,
    name,
    arguments: JSON.stringify(args || {}),
  };
}

test("状态机在无工具调用时直接完成", async () => {
  const llmCalls = [];
  const llmClient = {
    responses: {
      create: async (payload) => {
        llmCalls.push(payload);
        return {
          id: "resp_1",
          output_text: "final answer",
          output: [],
        };
      },
    },
  };
  const mcpClient = {
    callTool: async () => {
      throw new Error("should not call");
    },
  };
  const finalAnswer = await runReActStateMachine({
    llmClient,
    model: "test-model",
    systemPrompt: "sys",
    question: "q",
    tools: [],
    mcpClient,
    maxSteps: 4,
  });
  assert.equal(finalAnswer, "final answer");
  assert.equal(llmCalls.length, 1);
});

test("状态机在发送失败时自动恢复：群名解析后重试发送", async () => {
  const llmPayloads = [];
  const llmResponses = [
    {
      id: "resp_1",
      output: [
        createToolCall({
          id: "call_send_1",
          name: "send_lark_message",
          args: { text: "16:00公司楼下集合", chatId: "咩咩咩" },
        }),
      ],
    },
    {
      id: "resp_2",
      output: [],
      output_text: "已发送成功",
    },
  ];
  const llmClient = {
    responses: {
      create: async (payload) => {
        llmPayloads.push(payload);
        return llmResponses.shift();
      },
    },
  };
  const callHistory = [];
  const mcpClient = {
    callTool: async (name, args) => {
      callHistory.push({ name, args });
      if (name === "send_lark_message" && args.chatId === "咩咩咩") {
        throw new Error("Request failed with status code 400, invalid receive_id");
      }
      if (name === "lark_workspace_action" && args.action === "list_chats") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: "ok",
                data: {
                  chats: [{ name: "咩咩咩", chatId: "oc_target" }],
                },
              }),
            },
          ],
        };
      }
      if (name === "send_lark_message" && args.chatId === "oc_target") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: "发送成功",
                data: { platformResponse: { code: 0 } },
              }),
            },
          ],
        };
      }
      throw new Error("unexpected call");
    },
  };
  const finalAnswer = await runReActStateMachine({
    llmClient,
    model: "test-model",
    systemPrompt: "sys",
    question: "q",
    tools: [{ type: "function", name: "send_lark_message" }, { type: "function", name: "lark_workspace_action" }],
    mcpClient,
    maxSteps: 4,
  });
  assert.equal(finalAnswer, "已发送成功");
  assert.deepEqual(
    callHistory.map((item) => [item.name, item.args?.action || item.args?.chatId]),
    [
      ["send_lark_message", "咩咩咩"],
      ["lark_workspace_action", "list_chats"],
      ["send_lark_message", "oc_target"],
    ]
  );
  assert.equal(llmPayloads.length, 2);
});

test("状态机支持注入自定义恢复策略", async () => {
  const llmResponses = [
    {
      id: "resp_1",
      output: [
        createToolCall({
          id: "call_custom_1",
          name: "custom_tool",
          args: { target: "bad" },
        }),
      ],
    },
    {
      id: "resp_2",
      output: [],
      output_text: "custom recovered",
    },
  ];
  const llmClient = {
    responses: {
      create: async () => llmResponses.shift(),
    },
  };
  const calls = [];
  const mcpClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "custom_tool" && args.target === "bad") {
        throw new Error("bad target");
      }
      if (name === "custom_tool" && args.target === "good") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ message: "ok" }),
            },
          ],
        };
      }
      throw new Error("unexpected call");
    },
  };
  const finalAnswer = await runReActStateMachine({
    llmClient,
    model: "test-model",
    systemPrompt: "sys",
    question: "q",
    tools: [{ type: "function", name: "custom_tool" }],
    mcpClient,
    maxSteps: 3,
    recoveryStrategies: [
      {
        name: "custom_retry",
        match: ({ callName, error }) =>
          callName === "custom_tool" && String(error?.message || "").includes("bad target"),
        recover: async ({ args, mcpClient: toolClient }) => {
          const retryArgs = { ...args, target: "good" };
          const retryResult = await toolClient.callTool("custom_tool", retryArgs);
          return {
            recovered: true,
            retryArgs,
            retryResult,
            recovery: {
              strategy: "custom_retry",
            },
          };
        },
      },
    ],
  });
  assert.equal(finalAnswer, "custom recovered");
  assert.deepEqual(
    calls.map((item) => item.args.target),
    ["bad", "good"]
  );
});
