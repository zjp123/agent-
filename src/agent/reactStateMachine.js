const {
  createDefaultRecoveryStrategies,
  runRecoveryStrategies,
  isLikelyInvalidReceiveIdError,
} = require("./recoveryStrategies");

function safeJsonParse(content) {
  try {
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
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

function buildToolOutput(callId, output) {
  return {
    type: "function_call_output",
    call_id: callId,
    output: JSON.stringify(output),
  };
}

async function executeToolCallWithRecovery({
  call,
  mcpClient,
  allowedToolNames,
  recoveryStrategies,
  recoveryState,
}) {
  const callId = call?.call_id || call?.id;
  if (!callId) {
    return null;
  }
  const callName = String(call?.name || "").trim();
  const rawArgs = typeof call?.arguments === "string" ? call.arguments : "{}";
  const parsedArgs = safeJsonParse(rawArgs);
  const args = parsedArgs && typeof parsedArgs === "object" ? parsedArgs : {};
  if (!allowedToolNames.has(callName)) {
    return buildToolOutput(callId, { error: `不支持的工具: ${callName}` });
  }
  try {
    const toolResult = await mcpClient.callTool(callName, args);
    return buildToolOutput(callId, toolResult);
  } catch (error) {
    try {
      const recovered = await runRecoveryStrategies({
        callName,
        args,
        error,
        mcpClient,
        allowedToolNames,
        recoveryStrategies,
        recoveryState,
      });
      if (recovered?.recovered) {
        return buildToolOutput(callId, {
          ...recovered.retryResult,
          _recovery: recovered.recovery,
        });
      }
    } catch (recoveryError) {
      return buildToolOutput(callId, {
        error: String(recoveryError?.message || recoveryError),
      });
    }
    return buildToolOutput(callId, {
      error: String(error?.message || error),
      recoverable: isLikelyInvalidReceiveIdError(error),
    });
  }
}

function getFunctionCalls(response) {
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  return outputItems.filter((item) => item?.type === "function_call");
}

async function runReActStateMachine({
  llmClient,
  model,
  systemPrompt,
  question,
  tools,
  mcpClient,
  maxSteps = 6,
  recoveryStrategies,
  recoveryDefaultBudget = 1,
  recoveryStrategyOptions,
}) {
  const allowedToolNames = new Set((Array.isArray(tools) ? tools : []).map((tool) => tool.name));
  const activeRecoveryStrategies = Array.isArray(recoveryStrategies)
    ? recoveryStrategies
    : createDefaultRecoveryStrategies(recoveryStrategyOptions || {});
  let phase = "INIT";
  let step = 0;
  let response = null;
  const recoveryState = {
    attempts: new Map(),
    defaultBudget: recoveryDefaultBudget,
  };
  while (phase !== "DONE") {
    if (phase === "INIT") {
      response = await llmClient.responses.create({
        model,
        input: [
          {
            role: "system",
            content: systemPrompt,
          },
          { role: "user", content: question },
        ],
        extra_body: {
          enable_thinking: true,
        },
        tools,
      });
      phase = "PROCESS_MODEL_OUTPUT";
      continue;
    }
    if (phase === "PROCESS_MODEL_OUTPUT") {
      const functionCalls = getFunctionCalls(response);
      if (!functionCalls.length) {
        phase = "DONE";
        continue;
      }
      if (step >= maxSteps) {
        phase = "DONE";
        continue;
      }
      const toolOutputs = [];
      for (const call of functionCalls) {
        const output = await executeToolCallWithRecovery({
          call,
          mcpClient,
          allowedToolNames,
          recoveryStrategies: activeRecoveryStrategies,
          recoveryState,
        });
        if (output) {
          toolOutputs.push(output);
        }
      }
      if (!toolOutputs.length) {
        phase = "DONE";
        continue;
      }
      response = await llmClient.responses.create({
        model,
        previous_response_id: response.id,
        input: toolOutputs,
        tools,
      });
      step += 1;
      phase = "PROCESS_MODEL_OUTPUT";
      continue;
    }
    phase = "DONE";
  }
  return readOutputText(response) || "未生成回答。";
}

module.exports = {
  runReActStateMachine,
  safeJsonParse,
  readOutputText,
};
