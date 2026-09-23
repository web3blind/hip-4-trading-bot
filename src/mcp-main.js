import { startMcpServer } from './mcp-server.js';

startMcpServer().then(app => {
  process.stdout.write(`HIP-4 MCP listening on ${app.url}/mcp\n`);
}).catch(() => {
  process.stderr.write('HIP-4 MCP failed to start\n');
  process.exitCode = 1;
});
