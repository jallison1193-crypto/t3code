import * as NodeReadline from "node:readline";

const args = process.argv.slice(2);
const countIdx = args.indexOf("--count");
const extraCount = countIdx >= 0 ? Number(args[countIdx + 1] ?? "0") : 0;

const rl = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function buildTools() {
  const tools = [
    {
      name: "echo",
      description: "Echo input text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "env_check",
      description: "Inspect selected environment variables",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "fail_tool",
      description: "Return an upstream error",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  for (let i = 0; i < extraCount; i += 1) {
    tools.push({
      name: `extra_${i}`,
      description: `Extra tool ${i}`,
      inputSchema: { type: "object", properties: {} },
    });
  }
  return tools;
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.id === undefined) {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "test-mcp-fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: buildTools() },
    });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const toolArgs = message.params?.arguments ?? {};
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: `echo:${String(toolArgs.text ?? "")}` }],
        },
      });
      return;
    }
    if (name === "env_check") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? null,
                t3PluginRoot: process.env.T3_PLUGIN_ROOT ?? null,
                pluginData: process.env.CLAUDE_PLUGIN_DATA ?? null,
                customVar: process.env.PLUGIN_CUSTOM_VAR ?? null,
                fallbackVar: process.env.PLUGIN_FALLBACK_VAR ?? null,
                t3Secret: process.env.T3CODE_SECRET_TEST ?? null,
                cwd: process.cwd(),
              }),
            },
          ],
        },
      });
      return;
    }
    if (name === "fail_tool") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "upstream boom" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unknown tool: ${String(name)}` },
    });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unsupported method: ${String(message.method)}` },
  });
});
