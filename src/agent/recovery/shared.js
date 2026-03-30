function safeJsonParse(content) {
  try {
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

function isLikelyLarkChatId(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  return /^oc_[a-z0-9]+$/i.test(normalized) || /^chat_[a-z0-9]+$/i.test(normalized);
}

function isLikelyInvalidReceiveIdError(errorLike) {
  const message = String(errorLike?.message || errorLike || "").toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes("invalid receive_id") ||
    message.includes("illegal receive_id") ||
    message.includes("chat_id not found") ||
    message.includes("status code 400")
  );
}

function normalizeStrategies(recoveryStrategies = []) {
  return (Array.isArray(recoveryStrategies) ? recoveryStrategies : [])
    .filter((item) => item && typeof item.match === "function" && typeof item.recover === "function")
    .map((item, index) => ({
      ...item,
      name: String(item.name || `strategy_${index}`),
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 0,
      budget: Number.isFinite(Number(item.budget)) ? Math.max(0, Number(item.budget)) : undefined,
      order: index,
    }))
    .sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.order - b.order;
    });
}

function ensureRecoveryState(recoveryState) {
  const attempts = recoveryState?.attempts instanceof Map ? recoveryState.attempts : new Map();
  const defaultBudgetRaw = Number(recoveryState?.defaultBudget);
  const defaultBudget = Number.isFinite(defaultBudgetRaw) ? Math.max(0, defaultBudgetRaw) : 1;
  return {
    attempts,
    defaultBudget,
  };
}

function canRunStrategy({ strategy, recoveryState }) {
  const key = String(strategy.name || "");
  const used = Number(recoveryState.attempts.get(key) || 0);
  const budget = Number.isFinite(strategy.budget) ? strategy.budget : recoveryState.defaultBudget;
  return used < budget;
}

function markStrategyAttempt({ strategy, recoveryState }) {
  const key = String(strategy.name || "");
  const used = Number(recoveryState.attempts.get(key) || 0);
  recoveryState.attempts.set(key, used + 1);
}

module.exports = {
  safeJsonParse,
  isLikelyLarkChatId,
  isLikelyInvalidReceiveIdError,
  normalizeStrategies,
  ensureRecoveryState,
  canRunStrategy,
  markStrategyAttempt,
};
