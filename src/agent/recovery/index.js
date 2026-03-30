const { createLarkRecoveryStrategies } = require("./larkStrategies");
const { createCommonRecoveryStrategies } = require("./commonStrategies");
const {
  isLikelyInvalidReceiveIdError,
  normalizeStrategies,
  ensureRecoveryState,
  canRunStrategy,
  markStrategyAttempt,
} = require("./shared");

function createDefaultRecoveryStrategies(options = {}) {
  return [
    ...createCommonRecoveryStrategies(options.common || {}),
    ...createLarkRecoveryStrategies(options.lark || {}),
  ];
}

async function runRecoveryStrategies({
  callName,
  args,
  error,
  mcpClient,
  allowedToolNames,
  recoveryStrategies,
  recoveryState,
}) {
  const state = ensureRecoveryState(recoveryState);
  const strategies = normalizeStrategies(recoveryStrategies);
  for (const strategy of strategies) {
    if (!canRunStrategy({ strategy, recoveryState: state })) {
      continue;
    }
    const matched = await strategy.match({
      callName,
      args,
      error,
      mcpClient,
      allowedToolNames,
      recoveryState: state,
    });
    if (!matched) {
      continue;
    }
    markStrategyAttempt({ strategy, recoveryState: state });
    const recovered = await strategy.recover({
      callName,
      args,
      error,
      mcpClient,
      allowedToolNames,
      recoveryState: state,
    });
    if (recovered?.recovered) {
      return recovered;
    }
  }
  return null;
}

module.exports = {
  createDefaultRecoveryStrategies,
  runRecoveryStrategies,
  isLikelyInvalidReceiveIdError,
  createCommonRecoveryStrategies,
};
