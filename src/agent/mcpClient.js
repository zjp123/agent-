const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

function parseHeaders(value) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key]) => typeof key === "string" && key.trim())
        .map(([key, headerValue]) => [key, String(headerValue)])
    );
  } catch (_) {
    return {};
  }
}

class McpClient {
  constructor() {
    this.mcp = new Client({
      name: "demo-mcp-client",
      version: "1.0.0",
    });
    this.tools = [];// 可用工具列表
  }

  buildRequestInit() {
    const token = String(process.env.MCP_AUTH_TOKEN || "").trim();
    const headers = {
      ...parseHeaders(process.env.MCP_HEADERS || ""),
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (!Object.keys(headers).length) {
      return undefined;
    }
    return { headers };
  }

  createTransport() {
    const remoteUrlRaw = String(process.env.MCP_SERVER_URL || "").trim();
    const transportType = String(
      process.env.MCP_TRANSPORT || (remoteUrlRaw ? "streamable_http" : "stdio")
    )
      .trim()
      .toLowerCase();

    if (transportType === "stdio") {
      const serverScript = path.resolve(__dirname, "../mcp/mcpStdioServer.js");
      return new StdioClientTransport({
        command: "node",
        args: [serverScript],
      });
    }

    if (!remoteUrlRaw) {
      throw new Error("远程 MCP 模式缺少 MCP_SERVER_URL 配置");
    }

    const remoteUrl = new URL(remoteUrlRaw);
    const requestInit = this.buildRequestInit();

    if (transportType === "streamable_http") {
      return new StreamableHTTPClientTransport(
        remoteUrl,
        requestInit ? { requestInit } : undefined
      );
    }

    if (transportType === "sse") {
      return new SSEClientTransport(remoteUrl, requestInit ? { requestInit } : undefined);
    }

    throw new Error(`不支持的 MCP_TRANSPORT: ${transportType}`);
  }

  // 链接mcp服务端
  async connectToServer() {
    const transport = this.createTransport();

    await this.mcp.connect(transport);
    // listTools 获取mcp服务端注册的工具 ---StdioClientTransport
    const toolsResult = await this.mcp.listTools();
    console.log("MCP 服务端注册的工具:", toolsResult.tools || []);
    this.tools = toolsResult.tools || [];
  }

  // 调用mcp服务端的工具---callTool 来源于StdioServerTransport
  // jsonrpc
  async callTool(name, args) {
    return this.mcp.callTool({
      name,
      arguments: args,
    });
  }
}

module.exports = { McpClient };
