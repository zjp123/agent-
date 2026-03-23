const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { mcpServer } = require("./mcpServer");

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((error) => {
  console.error("MCP Server 启动失败:", error);
  process.exit(1);
});
