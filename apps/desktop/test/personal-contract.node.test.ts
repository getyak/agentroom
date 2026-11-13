import { describe, expect, it } from "vitest";
import { isArtifactId, isTrustedDocument, personalCsp, readPersonalRequest, readNativeIntegration } from "../src/shared/personal-api";

describe("personal IPC capabilities", () => {
  it("permits scoped MCP settings and Nango sessions without arbitrary proxy or secret routes", () => {
    expect(readPersonalRequest({ path: "/api/mcp/access", method: "GET" }).path).toBe("/api/mcp/access");
    expect(readPersonalRequest({ path: "/api/integrations/nango/recovery", method: "GET" }).path).toBe("/api/integrations/nango/recovery");
    for (const path of ["/api/mcp/access/con_owned", "/api/integrations/nango", "/api/integrations/nango/con_owned/renew"]) expect(readPersonalRequest({ path, method: "POST", body: {} }).path).toBe(path);
    for (const path of ["/api/mcp/call", "/api/mcp/access/con_owned/execute", "/api/integrations/nango/con_owned/token", "/api/integrations/nango/proxy", "/api/integrations/nango/con_owned/renew?url=https://other"]) expect(() => readPersonalRequest({ path, method: "POST", body: {} })).toThrow();
  });
  it("allows explicit local device sharing controls and rejects network administration routes", () => {
    expect(readPersonalRequest({ path: "/api/sharing", method: "GET" }).path).toBe("/api/sharing");
    for (const path of ["/api/sharing", "/api/sharing/invite"]) expect(readPersonalRequest({ path, method: "POST", body: {} }).path).toBe(path);
    for (const path of ["/api/sharing/invite?token=x", "/api/sharing/exec", "/api/sharing/files", "http://100.64.0.1:18750/api/sharing"]) expect(() => readPersonalRequest({ path, method: "POST", body: {} })).toThrow();
  });
  it("accepts the existing task, approval, memory and connection routes", () => {
    expect(readPersonalRequest({ path: "/api/bootstrap", method: "GET" })).toEqual({ path: "/api/bootstrap", method: "GET" });
    expect(readPersonalRequest({ path: "/api/threads/thr_own/messages", method: "POST", body: { text: "补充", clientId: "accepted-request-id" } }).path).toBe("/api/threads/thr_own/messages");
    expect(readPersonalRequest({ path: "/api/decisions/dec_own", method: "POST", body: { choice: "approve", version: 1, clientId: "accepted-request-id" } }).method).toBe("POST");
    expect(readPersonalRequest({ path: "/api/connections/con_own", method: "DELETE" }).method).toBe("DELETE");
  });

  it("allows node enrollment and checks without exposing server administration", () => {
    for (const path of ["/api/nodes/connect", "/api/nodes/node_owned/check"]) expect(readPersonalRequest({ path, method: "POST", body: {} }).path).toBe(path);
    for (const path of ["/api/nodes/node_owned/exec", "/api/nodes/../check", "/api/nodes/node_owned/check?url=https://other", "/api/nodes/node_owned/token"]) expect(() => readPersonalRequest({ path, method: "POST", body: {} })).toThrow();
  });

  it("rejects arbitrary destinations, headers, filesystem routes, streams and traversal", () => {
    for (const path of ["https://example.com/api/bootstrap", "//127.0.0.1:18740/api/bootstrap", "file:///etc/passwd", "/api/threads/../connections", "/api/threads/%2e%2e", "/api/events", "/api/artifacts/art_own/download", "/api/bootstrap?url=http://example.com", "/internal/admin"]) {
      expect(() => readPersonalRequest({ path, method: "GET" })).toThrow();
    }
    expect(() => readPersonalRequest({ path: "/api/bootstrap", method: "GET", headers: { Authorization: "not allowed" } })).toThrow();
    expect(() => readPersonalRequest({ path: "/api/bootstrap", method: "PUT" })).toThrow();
    expect(() => readPersonalRequest({ path: "/api/bootstrap", method: "GET", body: {} })).toThrow();
    expect(() => readPersonalRequest({ path: "/api/threads", method: "POST", body: [] })).toThrow();
    expect(() => readPersonalRequest({ path: "/api/threads", method: "POST", body: { text: "字".repeat(700_000) } })).toThrow();
  });

  it("allows fixed messenger capabilities without arbitrary identities or URL syntax", () => {
    for (const path of ["/api/contacts", "/api/contacts/agent_codex", "/api/approvals"]) expect(readPersonalRequest({ path, method: "GET" }).path).toBe(path);
    for (const path of ["/api/contacts", "/api/contacts/local", "/api/contacts/contact_owned", "/api/chats", "/api/chats/thr_owned"]) expect(readPersonalRequest({ path, method: "POST", body: { clientId: "owned-request" } }).path).toBe(path);
    for (const path of ["/api/contacts/../../connection", "/api/contacts/contact_owned?account=other", "/api/chats/https://example.com", "/api/chats/thr_owned/members", "/api/approvals/bulk"]) expect(() => readPersonalRequest({ path, method: "POST", body: {} })).toThrow();
  });

  it("allows only fixed IM preferences and message reaction routes", () => {
    expect(readPersonalRequest({ path: "/api/im/settings", method: "GET" }).path).toBe("/api/im/settings");
    for (const path of ["/api/im/settings", "/api/threads/thr_owned/reactions", "/api/threads/thr_owned/read"]) expect(readPersonalRequest({ path, method: "POST", body: { clientId: "owned-reaction" } }).path).toBe(path);
    for (const path of ["/api/im/settings/execute", "/api/im/settings?url=https://example.com", "/api/threads/thr_owned/reactions/another", "/api/threads/../reactions"]) expect(() => readPersonalRequest({ path, method: "POST", body: {} })).toThrow();
  });

  it("exposes only bounded contact control and host discovery capabilities", () => {
    for (const path of ["/api/host/discovery", "/api/contacts/contact_owned/control"]) expect(readPersonalRequest({ path, method: "GET" }).path).toBe(path);
    for (const path of ["/api/contacts/contact_owned/control", "/api/contacts/contact_owned/run"]) expect(readPersonalRequest({ path, method: "POST", body: {} }).path).toBe(path);
    for (const path of ["/api/contacts/contact_owned/run/command", "/api/contacts/contact_owned/control?host=other", "/api/host/discovery/processes", "/api/host/execute"]) expect(() => readPersonalRequest({ path, method: "POST", body: {} })).toThrow();
    expect(() => readPersonalRequest({ path: "/api/host/discovery", method: "POST", body: {} })).toThrow();
  });

  it("only accepts opaque artifact identifiers for the native save dialog", () => {
    expect(isArtifactId("art_97bf-accepted")).toBe(true);
    for (const id of ["/etc/passwd", "art_x/../../secret", "https://example.com/", null, "thread_1"]) expect(isArtifactId(id)).toBe(false);
  });

  it("allows discovery and fixed connection actions without exposing a command launcher", () => {
    expect(readPersonalRequest({ path: "/api/integrations", method: "GET" }).path).toBe("/api/integrations");
    expect(readPersonalRequest({ path: "/api/integrations/local/claude", method: "POST", body: {} }).method).toBe("POST");
    expect(readNativeIntegration({ kind: "connect", serviceId: "cue" })).toEqual({ kind: "connect", serviceId: "cue" });
    expect(readNativeIntegration({ kind: "submit", flowId: "owned-flow", value: "synthetic-input" }).kind).toBe("submit");
    expect(readNativeIntegration({ kind: "reconnect", instanceId: "owned-instance" })).toEqual({ kind: "reconnect", instanceId: "owned-instance" });
    for (const action of [
      { kind: "local-login", agentId: "sh" }, { kind: "connect", serviceId: "custom" },
      { kind: "services", command: "anything" }, { kind: "local-login", agentId: "codex", args: ["exec"] },
      { kind: "progress", flowId: "../../another-profile" }, { kind: "submit", flowId: "owned", value: "x".repeat(8001) },
      { kind: "open", instanceId: "https://example.com/" }, { kind: "__proto__" },
      { kind: "reconnect", instanceId: "owned", url: "https://example.com/", token: "untrusted" },
    ]) expect(() => readNativeIntegration(action)).toThrow();
  });
});

describe("trusted bundled document", () => {
  const own = "file:///Applications/AgentRoom.app/Contents/Resources/app.asar/out/renderer/personal/index.html";
  it("accepts only the exact file or dev pathname, with ordinary in-document anchors", () => {
    expect(isTrustedDocument(`${own}#source-att_own`, own)).toBe(true);
    expect(isTrustedDocument("http://127.0.0.1:5173/personal/index.html#own", "http://127.0.0.1:5173/personal/index.html")).toBe(true);
    expect(isTrustedDocument("http://127.0.0.1:51730/personal/index.html", "http://127.0.0.1:5173/personal/index.html")).toBe(false);
    expect(isTrustedDocument("http://127.0.0.1:5173.evil.example/personal/index.html", "http://127.0.0.1:5173/personal/index.html")).toBe(false);
    expect(isTrustedDocument(own.replace("personal/index.html", "index.html"), own)).toBe(false);
    expect(isTrustedDocument(own.replace("file:///", "file://other-host/"), own)).toBe(false);
  });

  it("needs no renderer HTTP access and does not weaken script execution", () => {
    const csp = personalCsp();
    expect(csp).toContain("connect-src 'none'"); expect(csp).toContain("default-src 'none'"); expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("http:");
    expect(personalCsp("http://127.0.0.1:5173")).toContain("connect-src http://127.0.0.1:5173 ws://127.0.0.1:5173");
  });
});

 describe("agent onboarding IPC", () => {
  it("allows only fixed preparation, result, adoption and cancellation routes", () => {
    for (const path of ["/api/agent-onboarding", "/api/agent-onboarding/context", "/api/agent-onboarding/onboard_owned"]) expect(readPersonalRequest({ path, method: "GET" }).path).toBe(path);
    for (const path of ["/api/agent-onboarding", "/api/agent-onboarding/onboard_owned/adopt", "/api/agent-onboarding/onboard_owned/cancel"]) expect(readPersonalRequest({ path, method: "POST", body: {} }).path).toBe(path);
    for (const path of ["/api/agent-onboarding/../../secrets", "/api/agent-onboarding/onboard_owned/run-command", "/api/agent-onboarding?path=/tmp"]) expect(() => readPersonalRequest({ path, method: "POST", body: {} })).toThrow();
  });
 });
