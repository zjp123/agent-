const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runRecoveryStrategies,
  createDefaultRecoveryStrategies,
  createCommonRecoveryStrategies,
} = require("./recoveryStrategies");

test("恢复策略按 priority 从高到低执行", async () => {
  const executed = [];
  const result = await runRecoveryStrategies({
    callName: "custom_tool",
    args: { id: "x" },
    error: new Error("boom"),
    mcpClient: {},
    allowedToolNames: new Set(["custom_tool"]),
    recoveryStrategies: [
      {
        name: "low_priority",
        priority: 10,
        match: async () => true,
        recover: async () => {
          executed.push("low");
          return { recovered: true, retryResult: { ok: "low" } };
        },
      },
      {
        name: "high_priority",
        priority: 100,
        match: async () => true,
        recover: async () => {
          executed.push("high");
          return { recovered: true, retryResult: { ok: "high" } };
        },
      },
    ],
    recoveryState: {
      attempts: new Map(),
      defaultBudget: 2,
    },
  });
  assert.equal(result?.retryResult?.ok, "high");
  assert.deepEqual(executed, ["high"]);
});

test("恢复策略预算耗尽后不再执行", async () => {
  const executed = [];
  const strategy = {
    name: "one_shot",
    priority: 50,
    budget: 1,
    match: async () => true,
    recover: async () => {
      executed.push("run");
      return { recovered: true, retryResult: { ok: true } };
    },
  };
  const recoveryState = {
    attempts: new Map(),
    defaultBudget: 2,
  };
  const first = await runRecoveryStrategies({
    callName: "custom_tool",
    args: {},
    error: new Error("boom"),
    mcpClient: {},
    allowedToolNames: new Set(["custom_tool"]),
    recoveryStrategies: [strategy],
    recoveryState,
  });
  const second = await runRecoveryStrategies({
    callName: "custom_tool",
    args: {},
    error: new Error("boom"),
    mcpClient: {},
    allowedToolNames: new Set(["custom_tool"]),
    recoveryStrategies: [strategy],
    recoveryState,
  });
  assert.equal(Boolean(first?.recovered), true);
  assert.equal(second, null);
  assert.deepEqual(executed, ["run"]);
});

test("默认通用策略可在429错误时退避重试", async () => {
  const calls = [];
  const recoveryStrategies = createDefaultRecoveryStrategies();
  const result = await runRecoveryStrategies({
    callName: "any_tool",
    args: { q: 1 },
    error: new Error("status code 429"),
    mcpClient: {
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      },
    },
    allowedToolNames: new Set(["any_tool"]),
    recoveryStrategies,
    recoveryState: {
      attempts: new Map(),
      defaultBudget: 2,
    },
  });
  assert.equal(Boolean(result?.recovered), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "any_tool");
});

test("默认通用策略可在超时错误时重试", async () => {
  const calls = [];
  const recoveryStrategies = createDefaultRecoveryStrategies();
  const result = await runRecoveryStrategies({
    callName: "any_tool",
    args: { q: 2 },
    error: new Error("request timeout"),
    mcpClient: {
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      },
    },
    allowedToolNames: new Set(["any_tool"]),
    recoveryStrategies,
    recoveryState: {
      attempts: new Map(),
      defaultBudget: 2,
    },
  });
  assert.equal(Boolean(result?.recovered), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "any_tool");
});

test("通用策略支持白名单：非白名单工具不执行恢复", async () => {
  const recoveryStrategies = createCommonRecoveryStrategies({
    allowTools: ["allowed_tool"],
  });
  const result = await runRecoveryStrategies({
    callName: "blocked_tool",
    args: {},
    error: new Error("status code 429"),
    mcpClient: {
      callTool: async () => ({ ok: true }),
    },
    allowedToolNames: new Set(["blocked_tool"]),
    recoveryStrategies,
    recoveryState: {
      attempts: new Map(),
      defaultBudget: 2,
    },
  });
  assert.equal(result, null);
});

test("通用策略支持黑名单：命中黑名单工具不执行恢复", async () => {
  const recoveryStrategies = createCommonRecoveryStrategies({
    denyTools: ["danger_tool"],
  });
  const result = await runRecoveryStrategies({
    callName: "danger_tool",
    args: {},
    error: new Error("request timeout"),
    mcpClient: {
      callTool: async () => ({ ok: true }),
    },
    allowedToolNames: new Set(["danger_tool"]),
    recoveryStrategies,
    recoveryState: {
      attempts: new Map(),
      defaultBudget: 2,
    },
  });
  assert.equal(result, null);
});

test("通用策略支持可配置指数退避与抖动", async () => {
  const delays = [];
  const recoveryStrategies = createCommonRecoveryStrategies({
    baseDelayMs: 10,
    maxDelayMs: 1000,
    jitterRatio: 0.5,
    random: () => 0.5,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  const recoveryState = {
    attempts: new Map(),
    defaultBudget: 3,
  };
  await runRecoveryStrategies({
    callName: "retry_tool",
    args: {},
    error: new Error("status code 429"),
    mcpClient: {
      callTool: async () => ({ ok: true }),
    },
    allowedToolNames: new Set(["retry_tool"]),
    recoveryStrategies,
    recoveryState,
  });
  await runRecoveryStrategies({
    callName: "retry_tool",
    args: {},
    error: new Error("status code 429"),
    mcpClient: {
      callTool: async () => ({ ok: true }),
    },
    allowedToolNames: new Set(["retry_tool"]),
    recoveryStrategies,
    recoveryState,
  });
  assert.equal(delays.length, 2);
  assert.equal(delays[0], 15);
  assert.equal(delays[1], 30);
});
