import { describe, expect, it } from "vite-plus/test";

import {
  buildPluginMcpProcessEnv,
  computePluginExternalPowersHash,
  expandPluginHooksEventMap,
  expandPluginMcpString,
  pluginMcpToolName,
} from "./pluginExternalConfig.ts";

describe("pluginMcpToolName", () => {
  it.each([
    {
      label: "short standard names keep readable format",
      pluginId: "docs",
      serverName: "search",
      toolName: "query",
      expected: "plugin_docs_search__query",
    },
    {
      label: "sanitizes characters outside [A-Za-z0-9_-] to underscores",
      pluginId: "my-plugin",
      serverName: "api.v2",
      toolName: "docs/search:all",
      expected: "plugin_my-plugin_api_v2__docs_search_all",
    },
    {
      label: "exact 50-char name stays uncompacted",
      pluginId: "abcdefghij",
      serverName: "1234567890",
      toolName: "12345678901234567890",
      expected: "plugin_abcdefghij_1234567890__12345678901234567890",
    },
  ])("$label", ({ pluginId, serverName, toolName, expected }) => {
    const actual = pluginMcpToolName(pluginId, serverName, toolName);
    expect(actual).toBe(expected);
    expect(actual.length).toBeLessThanOrEqual(50);
    expect(actual).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("compacts names over 50 chars to plugin_<20 chars>__<16 hex sha256> and differentiates collisions", () => {
    const first = pluginMcpToolName(
      "very-long-plugin-identifier-name",
      "primary-server",
      "create_detailed_document_summary",
    );
    const second = pluginMcpToolName(
      "very-long-plugin-identifier-name",
      "primary-server",
      "create_detailed_document_outline",
    );
    const sameAgain = pluginMcpToolName(
      "very-long-plugin-identifier-name",
      "primary-server",
      "create_detailed_document_summary",
    );

    expect(first).toBe(sameAgain);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^plugin_very-long-plugin-ide__[a-f0-9]{16}$/);
    expect(first.length).toBeLessThanOrEqual(50);
  });
});

describe("expandPluginMcpString and expandPluginHooksEventMap", () => {
  it("expands plugin paths, server env vars, defaults, and leaves unset vars literal", () => {
    const context = {
      pluginRoot: "/plugins/demo",
      pluginDataDir: "/state/plugins-data/demo",
      env: { API_TOKEN: "secret-1", EMPTY_VAR: "" },
    };

    expect(
      expandPluginMcpString(
        "${CLAUDE_PLUGIN_ROOT}/bin:${T3_PLUGIN_ROOT}/lib:${CLAUDE_PLUGIN_DATA}/cache",
        context,
      ),
    ).toBe("/plugins/demo/bin:/plugins/demo/lib:/state/plugins-data/demo/cache");

    expect(
      expandPluginMcpString(
        "tok=${API_TOKEN} def=${MISSING:-fallback} emptyDef=${EMPTY_VAR:-emptyFallback} keep=${UNSET}",
        context,
      ),
    ).toBe("tok=secret-1 def=fallback emptyDef=emptyFallback keep=${UNSET}");
  });

  it("expands plugin path variables in hook command, args, url, headers, and prompt fields", () => {
    const expanded = expandPluginHooksEventMap(
      {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "${CLAUDE_PLUGIN_ROOT}/hooks/check.sh",
                args: ["--data", "${CLAUDE_PLUGIN_DATA}", "--root", "${T3_PLUGIN_ROOT}"],
              },
              {
                type: "http",
                url: "https://example.test/hook?dir=${CLAUDE_PLUGIN_DATA}",
                headers: { "X-Root": "${CLAUDE_PLUGIN_ROOT}" },
              },
            ],
          },
        ],
      },
      { pluginRoot: "/p/demo", pluginDataDir: "/d/demo" },
    );

    expect(expanded.PreToolUse?.[0]?.hooks).toEqual([
      {
        type: "command",
        command: "/p/demo/hooks/check.sh",
        args: ["--data", "/d/demo", "--root", "/p/demo"],
      },
      {
        type: "http",
        url: "https://example.test/hook?dir=/d/demo",
        headers: { "X-Root": "/p/demo" },
      },
    ]);
  });
});

describe("buildPluginMcpProcessEnv", () => {
  it("keeps allowlisted base vars, strips T3CODE_* and unrelated secrets, and adds plugin paths + declared env", () => {
    const env = buildPluginMcpProcessEnv({
      hostEnv: {
        PATH: "/usr/bin",
        HOME: "/home/dev",
        TEMP: "/tmp",
        HTTPS_PROXY: "http://proxy.local:8080",
        T3CODE_AUTH_TOKEN: "must-not-leak",
        OPENAI_API_KEY: "must-not-leak",
        MY_SERVER_KEY: "from-parent",
      },
      pluginRoot: "/plugins/demo",
      pluginDataDir: "/state/plugins-data/demo",
      declaredEnv: {
        SERVER_KEY: "${MY_SERVER_KEY}",
        DEFAULTED: "${NOT_SET:-ok}",
        DATA_REF: "${CLAUDE_PLUGIN_DATA}/db",
      },
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env.TEMP).toBe("/tmp");
    expect(env.HTTPS_PROXY).toBe("http://proxy.local:8080");
    expect(env.T3CODE_AUTH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.MY_SERVER_KEY).toBeUndefined();
    expect(env.CLAUDE_PLUGIN_ROOT).toBe("/plugins/demo");
    expect(env.T3_PLUGIN_ROOT).toBe("/plugins/demo");
    expect(env.CLAUDE_PLUGIN_DATA).toBe("/state/plugins-data/demo");
    expect(env.SERVER_KEY).toBe("from-parent");
    expect(env.DEFAULTED).toBe("ok");
    expect(env.DATA_REF).toBe("/state/plugins-data/demo/db");
  });
});

describe("computePluginExternalPowersHash", () => {
  it("is stable across key ordering and changes when MCP or hooks config changes", () => {
    const hashA = computePluginExternalPowersHash(
      [
        { name: "b", rawConfig: { command: "node", args: ["b.mjs"], env: { Z: "1", A: "2" } } },
        {
          name: "a",
          rawConfig: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { B: "2", A: "1" },
          },
        },
      ],
      {
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
      },
    );
    const hashB = computePluginExternalPowersHash(
      [
        {
          name: "a",
          rawConfig: {
            headers: { A: "1", B: "2" },
            url: "https://example.test/mcp",
            type: "http",
          },
        },
        { name: "b", rawConfig: { env: { A: "2", Z: "1" }, args: ["b.mjs"], command: "node" } },
      ],
      {
        PreToolUse: [{ hooks: [{ command: "echo pre", type: "command" }], matcher: "Bash" }],
        Stop: [{ hooks: [{ command: "echo stop", type: "command" }] }],
      },
    );
    const hashChanged = computePluginExternalPowersHash(
      [
        {
          name: "a",
          rawConfig: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { A: "1", B: "2" },
          },
        },
        {
          name: "b",
          rawConfig: { command: "node", args: ["b.mjs", "--flag"], env: { A: "2", Z: "1" } },
        },
      ],
      {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      },
    );

    expect(hashA).toMatch(/^[a-f0-9]{12}$/);
    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashChanged);
  });
});
