const {
  safeJsonParse,
  isLikelyLarkChatId,
  isLikelyInvalidReceiveIdError,
} = require("./shared");

function parseToolResult(toolResult) {
  const text = toolResult?.content?.[0]?.text;
  if (typeof text !== "string") {
    return null;
  }
  return safeJsonParse(text);
}

function findMatchedChat(chats, targetName) {
  const target = String(targetName || "").trim();
  if (!target) {
    return null;
  }
  const list = Array.isArray(chats) ? chats : [];
  const exactMatch = list.find((item) => String(item?.name || "").trim() === target);
  if (exactMatch?.chatId) {
    return exactMatch;
  }
  const fuzzyMatch = list.find((item) => String(item?.name || "").trim().includes(target));
  if (fuzzyMatch?.chatId) {
    return fuzzyMatch;
  }
  return null;
}

async function resolveChatIdByName({ chatName, mcpClient, allowedToolNames }) {
  if (!allowedToolNames.has("lark_workspace_action")) {
    return null;
  }
  const listResult = await mcpClient.callTool("lark_workspace_action", {
    action: "list_chats",
    pageSize: 100,
  });
  const parsed = parseToolResult(listResult) || {};
  const chats = Array.isArray(parsed?.data?.chats) ? parsed.data.chats : [];
  return findMatchedChat(chats, chatName);
}

function createLarkSendMessageRecoveryStrategy() {
  return {
    name: "lark_send_message_resolve_chat_name",
    category: "business",
    priority: 80,
    budget: 2,
    match: ({ callName, args, error }) => {
      if (!isLikelyInvalidReceiveIdError(error)) {
        return false;
      }
      if (callName !== "send_lark_message") {
        return false;
      }
      const chatName = String(args?.chatId || "").trim();
      if (!chatName || isLikelyLarkChatId(chatName)) {
        return false;
      }
      return true;
    },
    recover: async ({ args, mcpClient, allowedToolNames }) => {
      const chatName = String(args?.chatId || "").trim();
      const matchedChat = await resolveChatIdByName({
        chatName,
        mcpClient,
        allowedToolNames,
      });
      if (!matchedChat?.chatId) {
        return null;
      }
      const retryArgs = {
        ...args,
        chatId: matchedChat.chatId,
      };
      const retryResult = await mcpClient.callTool("send_lark_message", retryArgs);
      return {
        recovered: true,
        retryArgs,
        retryResult,
        recovery: {
          strategy: "resolve_chat_name_to_chat_id",
          chatName,
          chatId: matchedChat.chatId,
        },
      };
    },
  };
}

function createLarkWorkspaceSendRecoveryStrategy() {
  return {
    name: "lark_workspace_send_message_resolve_chat_name",
    category: "business",
    priority: 80,
    budget: 2,
    match: ({ callName, args, error }) => {
      if (!isLikelyInvalidReceiveIdError(error)) {
        return false;
      }
      if (callName !== "lark_workspace_action") {
        return false;
      }
      if (String(args?.action || "").trim() !== "send_message") {
        return false;
      }
      const chatName = String(args?.chatId || "").trim();
      if (!chatName || isLikelyLarkChatId(chatName)) {
        return false;
      }
      return true;
    },
    recover: async ({ args, mcpClient, allowedToolNames }) => {
      const chatName = String(args?.chatId || "").trim();
      const matchedChat = await resolveChatIdByName({
        chatName,
        mcpClient,
        allowedToolNames,
      });
      if (!matchedChat?.chatId) {
        return null;
      }
      const retryArgs = {
        ...args,
        chatId: matchedChat.chatId,
      };
      const retryResult = await mcpClient.callTool("lark_workspace_action", retryArgs);
      return {
        recovered: true,
        retryArgs,
        retryResult,
        recovery: {
          strategy: "resolve_chat_name_to_chat_id",
          chatName,
          chatId: matchedChat.chatId,
        },
      };
    },
  };
}

function createLarkRecoveryStrategies() {
  return [createLarkSendMessageRecoveryStrategy(), createLarkWorkspaceSendRecoveryStrategy()];
}

module.exports = {
  createLarkRecoveryStrategies,
};
