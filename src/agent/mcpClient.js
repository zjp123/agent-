const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

class McpClient {
  constructor() {
    this.mcp = new Client({
      name: "demo-mcp-client",
      version: "1.0.0",
    });
    this.tools = [];// 可用工具列表
  }

  // 链接mcp服务端
  async connectToServer() {
    const serverScript = path.resolve(__dirname, "../mcp/mcpStdioServer.js");
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverScript],
    });

    await this.mcp.connect(transport);
    const toolsResult = await this.mcp.listTools();
    console.log("MCP 服务端注册的工具:", toolsResult.tools || []);
    this.tools = toolsResult.tools || [];
  }

  // 调用mcp服务端的工具
  async callTool(name, args) {
    return this.mcp.callTool({
      name,
      arguments: args,
    });
  }
}

module.exports = { McpClient };
