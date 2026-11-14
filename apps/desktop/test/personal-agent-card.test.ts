import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentCard } from "../../personal/src/AgentCard";
import type { Contact } from "../../personal/src/types";

it("describes an MCP contact's explicit local chat backend separately from its tool service", () => {
  const contact: Contact = { id: "tool", kind: "agent", name: "工具伙伴", handle: "tool", color: "blue", version: 1, description: "", instructions: "",
    availability: "ready", binding: { type: "connection", connectionId: "tools" }, connectionType: "mcp", providerName: "Tool Service",
    chatBackend: { type: "local", localAgentId: "codex" }, configuration: { modelMode: "fixed", thinking: "high" },
    execution: { agentId: "codex", provider: "synthetic", model: "synthetic-model", thinking: "high", configurationVersion: "1", modelPolicy: "fixed", thinkingPolicy: "fixed" } };
  const html = renderToStaticMarkup(createElement(AgentCard, { contact }));
  expect(html).toContain("这台 Mac");
  expect(html).toContain("固定模型");
  expect(html).toContain("Tool Service");
  expect(html).toContain("文字对话");
  expect(html).toContain("服务尚未提供额度数据");
});
