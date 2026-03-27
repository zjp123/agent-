const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { mcpServer } = require("./mcpServer");

const envPath = process.env.ENV_FILE
  ? path.resolve(process.cwd(), process.env.ENV_FILE)
  : fs.existsSync(path.resolve(process.cwd(), ".env"))
    ? path.resolve(process.cwd(), ".env")
    : path.resolve(process.cwd(), ".env.example");
dotenv.config({ path: envPath });

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((error) => {
  console.error("MCP Server 启动失败:", error);
  process.exit(1);
});
