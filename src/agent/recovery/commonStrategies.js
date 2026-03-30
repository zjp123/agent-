function readErrorMessage(errorLike) {
  return String(errorLike?.message || errorLike || "").toLowerCase();
}

function isRateLimitError(errorLike) {
  const message = readErrorMessage(errorLike);
  if (!message) {
    return false;
  }
  return (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  );
}

function isTimeoutError(errorLike) {
  const message = readErrorMessage(errorLike);
  if (!message) {
    return false;
  }
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("etimedout") ||
    message.includes("deadline exceeded")
  );
}

function sleep(ms) {
  const timeout = Number(ms);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, timeout);
  });
}

function normalizeToolSet(list) {
  if (!Array.isArray(list) || !list.length) {
    return null;
  }
  return new Set(list.map((item) => String(item || "").trim()).filter(Boolean));
}

function shouldAllowTool({ callName, allowSet, denySet }) {
  const toolName = String(callName || "").trim();
  if (!toolName) {
    return false;
  }
  if (allowSet && !allowSet.has(toolName)) {
    return false;
  }
  if (denySet && denySet.has(toolName)) {
    return false;
  }
  return true;
}

function createDelayCalculator({ baseDelayMs, maxDelayMs, jitterRatio, random }) {
  const base = Number.isFinite(Number(baseDelayMs)) ? Math.max(0, Number(baseDelayMs)) : 40;
  const max = Number.isFinite(Number(maxDelayMs)) ? Math.max(base, Number(maxDelayMs)) : 2000;
  const jitter = Number.isFinite(Number(jitterRatio)) ? Math.max(0, Number(jitterRatio)) : 0;
  const rand = typeof random === "function" ? random : Math.random;
  return ({ attempt }) => {
    const safeAttempt = Number.isFinite(Number(attempt)) ? Math.max(1, Number(attempt)) : 1;
    const exponential = Math.min(max, base * 2 ** (safeAttempt - 1));
    const randomValue = Math.min(1, Math.max(0, Number(rand() || 0)));
    const factor = 1 + jitter * (0.5 + randomValue);
    return Math.min(max, Math.round(exponential * factor));
  };
}

function createRateLimitRetryStrategy(config) {
  const strategyName = "common_retry_rate_limit";
  return {
    name: strategyName,
    category: "common",
    priority: 200,
    budget: 2,
    match: ({ error, allowedToolNames, callName }) => {
      if (!allowedToolNames?.has(callName)) {
        return false;
      }
      if (!shouldAllowTool({ callName, allowSet: config.allowSet, denySet: config.denySet })) {
        return false;
      }
      return isRateLimitError(error);
    },
    recover: async ({ callName, args, mcpClient, recoveryState }) => {
      const attempt = Number(recoveryState?.attempts?.get(strategyName) || 1);
      const delay = config.delayCalculator({ attempt, callName, args, reason: "rate_limit" });
      await config.sleep(delay);
      const retryResult = await mcpClient.callTool(callName, args);
      return {
        recovered: true,
        retryArgs: args,
        retryResult,
        recovery: {
          strategy: strategyName,
          delay,
          attempt,
        },
      };
    },
  };
}

function createTimeoutRetryStrategy(config) {
  const strategyName = "common_retry_timeout";
  return {
    name: strategyName,
    category: "common",
    priority: 180,
    budget: 2,
    match: ({ error, allowedToolNames, callName }) => {
      if (!allowedToolNames?.has(callName)) {
        return false;
      }
      if (!shouldAllowTool({ callName, allowSet: config.allowSet, denySet: config.denySet })) {
        return false;
      }
      return isTimeoutError(error);
    },
    recover: async ({ callName, args, mcpClient, recoveryState }) => {
      const attempt = Number(recoveryState?.attempts?.get(strategyName) || 1);
      const delay = config.delayCalculator({ attempt, callName, args, reason: "timeout" });
      await config.sleep(delay);
      const retryResult = await mcpClient.callTool(callName, args);
      return {
        recovered: true,
        retryArgs: args,
        retryResult,
        recovery: {
          strategy: strategyName,
          delay,
          attempt,
        },
      };
    },
  };
}

function createCommonRecoveryStrategies(options = {}) {
  const config = {
    allowSet: normalizeToolSet(options.allowTools),
    denySet: normalizeToolSet(options.denyTools),
    sleep: typeof options.sleep === "function" ? options.sleep : sleep,
    delayCalculator:
      typeof options.delayCalculator === "function"
        ? options.delayCalculator
        : createDelayCalculator({
            baseDelayMs: options.baseDelayMs,
            maxDelayMs: options.maxDelayMs,
            jitterRatio: options.jitterRatio,
            random: options.random,
          }),
  };
  return [createRateLimitRetryStrategy(config), createTimeoutRetryStrategy(config)];
}

module.exports = {
  createCommonRecoveryStrategies,
};
