import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { PersonalServices, type PersonalServicesManager } from "../src/main/personal-services";
import { ConnectorHost } from "../src/main/connectors/host";
import type { AgentEvent, InboundMessage } from "../src/main/connectors/protocol";
import type { Connector, ConnectorSummary, DirectConnectorEvent, Emitter, LoginProgress, ServiceId } from "../src/main/connectors/types";
import { NotSentError } from "../src/main/connectors/types";
import { GrokBotConnector, GROK_DEFAULTS, type GrokClient } from "../src/main/connectors/grokbot";
import { CueConnector, type CueClient, type CueEvent } from "../src/main/connectors/cue";
import { WebChatConnector } from "../src/main/connectors/webchat";
import type { WebSession } from "../src/main/connectors/websession";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() }, BrowserWindow: vi.fn(), app: { userAgentFallback: "Synthetic" } }));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const instances = [
  { instanceId: "fake_grok", service: "grokbot" as ServiceId, name: "Synthetic Grok", token: "synthetic_grok_local_token_12345" },
  { instanceId: "fake_cue", service: "cue" as ServiceId, name: "Synthetic Cue", token: "synthetic_cue_local_token_12345" },
];
class FakeManager implements PersonalServicesManager {
  readonly host: ConnectorHost;
  readonly emitters = new Map<string, Emitter>();
  readonly sends: InboundMessage[] = [];
  readonly records = instances.map((entry) => ({ ...entry }));
  readonly opened: string[] = [];
  readonly removed: string[] = [];
  readonly chosen: string[] = [];
  readonly submitted: string[] = [];
  readonly cancelled: string[] = [];
  decisions: { id: string; choice: string }[] = [];
  onDecide: () => Promise<void> = async () => {};
  starts = 0;
  stops = 0;
  status: ConnectorSummary["status"] = "ready";
  onSend: (id: string, message: InboundMessage) => Promise<void> = async () => {};
  nextProgress: LoginProgress = { state: "waiting", message: "Synthetic sign-in" };
  constructor(onEvent: (id: string, event: DirectConnectorEvent) => void) { this.host = new ConnectorHost(0, () => {}, () => {}, onEvent); }
  async start() {
    this.starts++;
    await this.host.listen();
    for (const entry of this.records) {
      const connector: Connector = {
        info: () => ({ name: entry.name, capabilities: ["chat", "approvals"], protocol: "agentstudio-agent/0" }),
        start: async () => {}, stop: async () => {},
        send: async (message) => { this.sends.push(message); await this.onSend(entry.instanceId, message); },
        decide: async () => { throw new Error("must not automatically decide"); },
        state: () => ({ status: "ready" }), serialize: () => ({}),
      };
      this.emitters.set(entry.instanceId, this.host.add({ id: entry.instanceId, token: entry.token, connector }));
    }
  }
  async stop() { this.stops++; await this.host.close(); }
  list(): ConnectorSummary[] { return this.records.map((entry) => ({ id: entry.instanceId, service: entry.service, name: entry.name, status: this.status, url: "http://legacy.invalid", canOpen: true })); }
  registrations() { return this.records; }
  begin(service: ServiceId) { return `flow_${service}`; }
  progress() { return this.nextProgress; }
  choose(id: string, choice: string) { this.chosen.push(`${id}:${choice}`); }
  submit(_id: string, value: string) { this.submitted.push(value); }
  cancel(id: string) { this.cancelled.push(id); }
  open(id: string) { this.opened.push(id); }
  async remove(id: string) { this.removed.push(id); const position = this.records.findIndex((entry) => entry.instanceId === id); if (position >= 0) this.records.splice(position, 1); this.host.remove(id); }
  handleLink(url: string) { return url === "cuedev://synthetic"; }
  async decideDirect(_instance: string, id: string, choice: string) { this.decisions.push({ id, choice }); await this.onDecide(); }
  sendDirect(id: string, message: InboundMessage) { return this.host.sendDirect(id, message); }
}
async function fixture(existingDirectory?: string) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), "agentstudio-personal-services-"));
  if (!existingDirectory) cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let manager!: FakeManager;
  const factory = vi.fn(({ onEvent }: { onEvent: (id: string, event: DirectConnectorEvent) => void }) => (manager = new FakeManager(onEvent)));
  const services = new PersonalServices({ userData: directory, createManager: factory });
  cleanups.push(() => services.stop());
  const privateInstances = async () => { await services.list(); return services.registrations(); };
  const rpc = async (method: string, params: unknown, account = 0, headers: Record<string, string> = {}) => {
    const entry = (await privateInstances())[account]!;
    return fetch(entry.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}`, Connection: "close", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: "synthetic_rpc", method, params }) });
  };
  const send = async (messageId = "message_1", text = "Synthetic task") => (await rpc("message/send", { message: { kind: "message", role: "user", messageId, parts: [{ kind: "text", text }] } })).json() as Promise<any>;
  const get = async (taskId: string, account = 0) => (await rpc("tasks/get", { id: taskId }, account)).json() as Promise<any>;
  return { directory, services, factory, manager: () => manager, send, get, rpc, privateInstances };
}
const eventTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function finish(f: Awaited<ReturnType<typeof fixture>>, text = "# Synthetic result\n\nActual fake connector reply") {
  await expect.poll(() => f.manager().sends.length).toBe(1);
  const message = f.manager().sends[0]!;
  const emitter = f.manager().emitters.get("fake_grok")!;
  emitter.emit({ type: "message", text, reply_to: message.message_id });
  emitter.emit({ type: "status", state: "idle" });
  await eventTurn();
}

describe("personal service catalog and private sign-in capabilities", () => {
  it("returns service metadata while a slow avatar is still loading", async () => {
    const f = await fixture(); await f.services.list();
    let release!: (image: null) => void;
    const pending = new Promise<null>(resolve => { release = resolve; });
    let reads = 0;
    Object.assign(f.manager(), { avatarDirect: async () => { reads++; return pending; } });
    let metadata: Awaited<ReturnType<PersonalServices["list"]>> | undefined;
    const listing = f.services.list().then(value => { metadata = value; });
    await eventTurn();
    try {
      expect(metadata?.[0]?.name).toBe("Synthetic Grok");
      await Promise.all([f.services.list(), f.services.list(), f.services.list()]);
      expect(reads).toBe(2); // One in-flight lookup per instance, across all catalogs.
    }
    finally { release(null); await listing; }
  });
  it("returns a bot raster image without exposing provider URLs or credentials", async () => {
    const f = await fixture(); await f.services.list();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=", "base64");
    Object.assign(f.manager(), { avatarDirect: async (id: string) => id === "fake_grok" ? { mime: "image/png", data: png } : null });
    await expect.poll(async () => (await f.services.list())[0]?.avatarDataUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
    const catalog = await f.services.list();
    expect(JSON.stringify(catalog)).not.toMatch(/token|https?:/);
    Object.assign(f.manager(), { avatarDirect: async () => ({ mime: "image/svg+xml", data: Buffer.from("<svg/>") }) });
    await expect.poll(async () => (await f.services.list())[0]?.avatarDataUrl).toBeUndefined();
    Object.assign(f.manager(), { avatarDirect: async () => ({ mime: "image/png", data: Buffer.alloc(512_001) }) });
    expect((await f.services.list())[0]).not.toHaveProperty("avatarDataUrl");
    Object.assign(f.manager(), { avatarDirect: async () => { throw new Error("avatar unavailable"); } });
    expect((await f.services.list())[0]?.name).toBe("Synthetic Grok");
  });
  it("lists four services without network, keychain, storage creation or legacy discovery", async () => {
    const f = await fixture();
    expect(f.services.services().map((entry) => entry.id)).toEqual(["grokbot", "muse", "dots", "cue"]);
    expect(await f.services.restore()).toBe(false);
    await expect(stat(join(f.directory, "personal-services"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.factory).not.toHaveBeenCalled();
    await expect(f.services.begin("invalid" as ServiceId)).rejects.toThrow("Unknown");
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("isolates storage and partitions, merges initialization and separates private/public ready", async () => {
    const f = await fixture();
    await writeFile(join(f.directory, "connectors.bin"), "legacy-secret-file-must-stay-untouched");
    await Promise.all([f.services.list(), f.services.list(), f.services.begin("cue")]);
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.factory.mock.calls[0]![0]).toMatchObject({ directory: join(f.directory, "personal-services"), partitionPrefix: "persist:agentstudio-personal-services" });
    expect(f.manager().starts).toBe(1);
    f.manager().nextProgress = { state: "ready", instances: instances.map((entry) => ({ ...entry, url: "http://legacy.invalid" })) };
    const progress = await f.services.progress("flow_cue");
    expect(progress).toMatchObject({ state: "ready", instances: [{ token: instances[0]!.token, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/a2a\/fake_grok$/) }, { instanceId: "fake_cue" }] });
    const publicState = JSON.stringify(await f.services.publicProgress("flow_cue"));
    expect(publicState).not.toContain("token"); expect(publicState).not.toContain("http");
    expect(JSON.stringify(await f.services.list())).not.toContain("token");
    expect(await readFile(join(f.directory, "connectors.bin"), "utf8")).toBe("legacy-secret-file-must-stay-untouched");
    expect((await stat(join(f.directory, "personal-services"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.directory, "personal-services/manifest.json"))).mode & 0o777).toBe(0o600);
    await f.services.choose("flow_cue", "api-key"); await f.services.submit("flow_cue", "synthetic_manus_key"); await f.services.cancel("flow_cue");
    expect(f.manager().chosen).toEqual(["flow_cue:api-key"]); expect(f.manager().submitted).toEqual(["synthetic_manus_key"]); expect(f.manager().cancelled).toEqual(["flow_cue"]);
    expect(f.services.handleLink("cuedev://synthetic")).toBe(true);
  });
});

describe("durable local A2A dispatch", () => {
  it("records an unready service as a failed unsent task and permits a new message after recovery", async () => {
    const f = await fixture(); await f.services.list();
    f.manager().status = "starting";
    const response = await f.send();
    expect(response.result).toMatchObject({ kind: "task", status: { state: "failed" } });
    expect(f.manager().sends).toHaveLength(0);
    expect((await f.get(response.result.id)).result.status.state).toBe("failed");
    f.manager().status = "ready";
    // A retry of the same identity reads the failure; it never silently sends.
    expect((await f.send()).result.id).toBe(response.result.id);
    expect(f.manager().sends).toHaveLength(0);
    const next = await f.send("new_message");
    expect(next.result.status.state).toBe("submitted");
    await finish(f);
    expect((await f.get(next.result.id)).result.status.state).toBe("completed");
  });

  it("retains a pre-dispatch failure through restart without blocking or replaying it", async () => {
    const f = await fixture(); await f.services.list(); f.manager().status = "starting";
    const first = await f.send(); await f.services.stop();
    const restored = await fixture(f.directory); await restored.services.restore();
    expect((await restored.get(first.result.id)).result).toMatchObject({ status: { state: "failed" }, metadata: { uncertain: false } });
    expect((await restored.send()).result.id).toBe(first.result.id);
    expect(restored.manager().sends).toHaveLength(0);
    expect(restored.services.hasUnresolvedTasks()).toBe(false);
    await restored.services.remove("fake_grok");
    expect(restored.manager().removed).toEqual(["fake_grok"]);
  });

  it("persists before send and exposes only correlated actual output as a completed artifact", async () => {
    const f = await fixture(); await f.services.list();
    f.manager().onSend = async (_instance, message) => {
      const saved = JSON.parse(readFileSync(join(f.directory, "personal-services/manifest.json"), "utf8"));
      expect(saved.tasks).toMatchObject([{ messageId: message.message_id, state: "submitted" }]);
      expect(message.session_id).toMatch(/^personal:pst_/);
    };
    const response = await f.send(); expect(response.result).toMatchObject({ kind: "task", status: { state: "submitted" } });
    await finish(f);
    await expect.poll(async () => (await f.get(response.result.id)).result.status.state).toBe("completed");
    const result = (await f.get(response.result.id)).result;
    expect(result.artifacts[0].parts[0].text).toContain("# Synthetic result");
    expect(result.metadata).toEqual({ source: "personal-service", receiptScope: "single_active_service_conversation", uncertain: false, replayAllowed: false });
    expect(f.manager().sends).toHaveLength(1);
  });

  it("deduplicates messageId before and after completion, rejects payload changes and cross-account task reads", async () => {
    const f = await fixture();
    const first = await f.send(); const repeated = await f.send();
    expect(repeated.result.id).toBe(first.result.id);
    expect((await f.send("message_1", "changed")).error).toMatchObject({ code: -32602 });
    expect((await f.get(first.result.id, 1)).error).toMatchObject({ code: -32001 });
    await finish(f);
    expect((await f.send()).result.id).toBe(first.result.id); expect(f.manager().sends).toHaveLength(1);
    const next = await f.send("message_2"); expect(next.result.id).not.toBe(first.result.id);
  });

  it("ignores history, profile, user history and wrong reply IDs; manual service input becomes unknown", async () => {
    const f = await fixture(); const first = await f.send();
    await expect.poll(() => f.manager().sends.length).toBe(1);
    const emitter = f.manager().emitters.get("fake_grok")!;
    emitter.emit({ type: "message", text: "old assistant", history: true, reply_to: "message_1" });
    emitter.emit({ type: "message", text: "old user", history: true, from_user: true });
    emitter.emit({ type: "profile", name: "A new profile" });
    emitter.emit({ type: "message", text: "another task", reply_to: "different_message" });
    emitter.emit({ type: "message", text: "autonomous uncorrelated message" });
    emitter.emit({ type: "status", state: "idle" });
    await eventTurn();
    expect((await f.get(first.result.id)).result).toMatchObject({ status: { state: "working" } });
    emitter.emit({ type: "message", text: "manual phone input", from_user: true }); await eventTurn();
    expect((await f.get(first.result.id)).result).toMatchObject({ status: { state: "unknown" }, metadata: { uncertain: true } });
    emitter.emit({ type: "message", text: "late answer", reply_to: "message_1" }); emitter.emit({ type: "status", state: "idle" }); await eventTurn();
    expect((await f.get(first.result.id)).result.status.state).toBe("unknown");
    expect((await f.send("message_2")).error).toMatchObject({ code: -32002 });
    expect(f.manager().sends).toHaveLength(1);
  });

  it("does not let a send error or its late results become completed", async () => {
    const f = await fixture(); await f.services.list();
    f.manager().onSend = async (_instance, message) => {
      const emitter = f.manager().emitters.get("fake_grok")!;
      emitter.emit({ type: "message", text: "must not be accepted before send resolves", reply_to: message.message_id });
      emitter.emit({ type: "status", state: "idle" });
      throw new Error("synthetic ambiguous transport failure");
    };
    const first = await f.send();
    await expect.poll(async () => (await f.get(first.result.id)).result.status.state).toBe("unknown");
    expect((await f.get(first.result.id)).result.artifacts).toBeUndefined();
    await finish(f); expect((await f.get(first.result.id)).result.status.state).toBe("unknown");
    expect((await f.send()).result.id).toBe(first.result.id); expect(f.manager().sends).toHaveLength(1);
  });
  it("records a proved preflight rejection as not sent rather than uncertain", async () => {
    const f=await fixture();await f.services.list();f.manager().onSend=async()=>{throw new NotSentError("known preflight");};const sent=await f.send();
    await expect.poll(async()=>(await f.get(sent.result.id)).result.status.state).toBe("failed");
    expect((await f.get(sent.result.id)).result.metadata.uncertain).toBe(false);
  });

  it("returns input-required for agent decisions, offers original service and never auto-answers", async () => {
    const f = await fixture(); const first = await f.send();
    await expect.poll(() => f.manager().sends.length).toBe(1);
    const emitter = f.manager().emitters.get("fake_grok")!;
    emitter.emit({ type: "message", text: "I need approval", reply_to: "message_1" });
    emitter.emit({ type: "approval_request", external_id: "approval_1", title: "Synthetic choice", choices: [{ key: "yes", label: "Approve", category: "approve" }, { key: "no", label: "Deny", category: "deny" }] });
    emitter.emit({ type: "status", state: "idle" }); await eventTurn();
    expect((await f.get(first.result.id)).result).toMatchObject({ status: { state: "input-required" } });
    await f.services.open("fake_grok"); expect(f.manager().opened).toEqual(["fake_grok"]);
    await expect(f.services.remove("fake_grok")).rejects.toThrow("待核查");
    expect((await f.send("message_2")).error).toBeDefined(); expect(f.manager().sends).toHaveLength(1);
  });

  it("keeps the port and task IDs across restart without resending; unknown keeps its inspection channel", async () => {
    const f = await fixture(); const first = await f.send(); const endpoint = (await f.privateInstances())[0]!.url;
    await f.services.stop();
    const restored = await fixture(f.directory); expect(await restored.services.restore()).toBe(true);
    expect((await restored.privateInstances())[0]!.url).toBe(endpoint);
    const result = (await restored.get(first.result.id)).result;
    expect(result).toMatchObject({ id: first.result.id, status: { state: "unknown" }, metadata: { uncertain: true, replayAllowed: false } });
    expect((await restored.send()).result.id).toBe(first.result.id);
    expect((await restored.send("new_message")).error).toBeDefined(); expect(restored.manager().sends).toHaveLength(0);
    await expect(restored.services.remove("fake_grok")).rejects.toThrow("待核查");
  });

  it("preserves completed results through restart and allows only safe local removal", async () => {
    const f = await fixture(); const first = await f.send(); await finish(f); await f.services.stop();
    const restored = await fixture(f.directory); await restored.services.restore();
    expect((await restored.get(first.result.id)).result.status.state).toBe("completed");
    await restored.services.remove("fake_grok"); expect(restored.manager().removed).toEqual(["fake_grok"]);
    expect((await restored.services.list()).map((entry) => entry.id)).not.toContain("fake_grok");
    expect(restored.manager().sends).toHaveLength(0);
  });

  it("fails closed on an occupied saved port without creating or attaching a manager", async () => {
    const f = await fixture(); await f.services.list();
    const manifest = JSON.parse(await readFile(join(f.directory, "personal-services/manifest.json"), "utf8"));
    await f.services.stop();
    const occupied = createServer((_req, res) => res.end("unrelated service"));
    await new Promise<void>((resolve) => occupied.listen(manifest.chosenPort, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    const another = await fixture(f.directory);
    await expect(another.services.restore()).rejects.toMatchObject({ code: "EADDRINUSE" }); expect(another.factory).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(f.directory, "personal-services/manifest.json"), "utf8"))).toEqual(manifest);
  });

  it("keeps an explicit connector uncertainty signal as unknown even after correlated late output", async () => {
    const f = await fixture(); const first = await f.send(); await expect.poll(() => f.manager().sends.length).toBe(1);
    f.manager().emitters.get("fake_grok")!.uncertain!("message_1"); await eventTurn();
    await finish(f); expect((await f.get(first.result.id)).result.status.state).toBe("unknown");
  });

  it("does not complete a text answer when the connector reports an unsupported manual step", async () => {
    const f = await fixture(); const first = await f.send(); await expect.poll(() => f.manager().sends.length).toBe(1);
    const emitter = f.manager().emitters.get("fake_grok")!;
    emitter.emit({ type: "message", text: "partial answer", reply_to: "message_1" });
    emitter.inputRequired!("message_1"); emitter.emit({ type: "status", state: "idle" }); await eventTurn();
    expect((await f.get(first.result.id)).result.status.state).toBe("input-required");
    expect((await f.get(first.result.id)).result.artifacts).toBeUndefined();
  });

  it("resumes an input-required task only with a fresh correlated answer after working", async () => {
    const f = await fixture(); const first = await f.send(); await expect.poll(() => f.manager().sends.length).toBe(1);
    const emitter = f.manager().emitters.get("fake_grok")!;
    emitter.emit({ type: "message", text: "partial before the manual step", reply_to: "message_1" });
    emitter.inputRequired!("message_1"); emitter.emit({ type: "status", state: "idle" }); await eventTurn();
    expect((await f.get(first.result.id)).result.status.state).toBe("input-required");
    emitter.emit({ type: "status", state: "working" }); emitter.emit({ type: "status", state: "idle" }); await eventTurn();
    expect((await f.get(first.result.id)).result.status.state).toBe("working");
    emitter.emit({ type: "message", text: "unrelated late answer", reply_to: "different_message" });
    emitter.emit({ type: "status", state: "idle" }); await eventTurn();
    expect((await f.get(first.result.id)).result.status.state).toBe("working");
    emitter.emit({ type: "message", text: "Final answer after original-service decision", reply_to: "message_1" });
    emitter.emit({ type: "status", state: "idle" }); await eventTurn();
    const result = (await f.get(first.result.id)).result;
    expect(result.status.state).toBe("completed");
    expect(result.artifacts[0].parts[0].text).toContain("Final answer after original-service decision");
    expect(result.artifacts[0].parts[0].text).not.toContain("unrelated late answer");
    expect(f.manager().sends).toHaveLength(1);
  });

  it.each([false, true])("preserves all web-chat bubbles before completion (second bubble pending: %s)", async (secondPending) => {
    const f = await fixture(); const first = await f.send(); await expect.poll(() => f.manager().sends.length).toBe(1);
    const emitter = f.manager().emitters.get("fake_grok")!;
    const events: DirectConnectorEvent[] = [];
    const harness = Object.create(WebChatConnector.prototype) as { process(snapshot: unknown): void };
    Object.assign(harness, {
      cfg: { name: "Synthetic WebChat" }, emitter: { ...emitter, approval: (card: any) => { events.push({ type: "native_approval", card }); emitter.approval!(card); }, emit: (event: AgentEvent) => { events.push(event); emitter.emit(event); } },
      ownTexts: new Set(), personalReply: { messageId: "message_1", text: "Synthetic task", echoed: true, startSeq: 0, cards: [] }, seen: new Set(),
      pending: new Map([["answer_1", { text: "First bubble", polls: 1 }], ...(secondPending ? [] : [["answer_2", { text: "Second bubble contains final result", polls: 1 }] as const])]),
      approvals: new Map(), pendingAsk: null,
    });
    const snapshot = { signedIn: true, ready: true, busy: false, messages: [
      { id: "answer_1", role: "assistant", text: "First bubble", actions: [] },
      { id: "answer_2", role: "assistant", text: "Second bubble contains final result", actions: [] },
    ] };
    harness.process(snapshot); await eventTurn();
    if (secondPending) {
      expect((await f.get(first.result.id)).result.status.state).toBe("working");
      expect(events.filter((event) => event.type === "status" && event.state === "idle")).toHaveLength(0);
      harness.process(snapshot); await eventTurn();
    }
    const result = (await f.get(first.result.id)).result;
    expect(result.status.state).toBe("completed");
    expect(result.artifacts[0].parts[0].text).toBe("First bubble\n\nSecond bubble contains final result");
    expect(events.filter((event) => event.type === "status" && event.state === "idle")).toHaveLength(1);
  });

  it.each(["stable", "pending", "approval", "manual-step"])("preserves the full Grok batch and waits for outstanding work (%s)", async (scenario) => {
    const f = await fixture(); const first = await f.send(); await expect.poll(() => f.manager().sends.length).toBe(1);
    const emitter = f.manager().emitters.get("fake_grok")!;
    const events: DirectConnectorEvent[] = [];
    const harness = Object.create(GrokBotConnector.prototype) as { process(entries: unknown[]): void; settlePersonalTurn(before: any, after: any): void };
    Object.assign(harness, {
      cfg: {}, data: { lastSeq: 0, agent: { id: "qa", sessionId: "qa" } }, nativeCards: new Map(), onChange() {},
      emitter: { ...emitter, approval: (card: any) => { events.push({ type: "native_approval", card }); emitter.approval!(card); }, emit: (event: AgentEvent) => { events.push(event); emitter.emit(event); }, inputRequired: (messageId: string) => { events.push({ type: "input_required", messageId }); emitter.inputRequired!(messageId); } },
      ownTexts: new Set(), ownMessageIds: new Set(), personalReply: { messageId: "message_1", providerMessageId: "qa_nonce", sessionId: "qa", text: "Synthetic task", echoed: true, startSeq: 0, cards: [] }, seen: new Map(),
      pending: new Map([["entry_1", { updated: 1, text: "First Grok bubble", polls: 1 }], ...(scenario === "pending" ? [] : [["entry_2", { updated: 1, text: "Final Grok result", polls: 1 }] as const])]),
      widgets: new Set(), widgetAnswers: new Map(), widgetEchoCards: new Set(), pendingAsk: null,
    });
    const entry = (seq: number, body: unknown, kind = "message") => ({ seq, entry_id: `entry_${seq}`, updated_seq: 1, entry_kind: kind, body: new TextEncoder().encode(JSON.stringify(body)) });
    const entries = [entry(1, { role: "assistant", content: "First Grok bubble" }), entry(2, { role: "assistant", content: "Final Grok result" })];
    if (scenario === "approval") entries.push(entry(3, { kind: "widget-options", prompt: "Synthetic approval", options: ["yes", "no"] }, "widget"));
    if (scenario === "manual-step") entries.push(entry(3, { kind: "send-message", message: { type: "local-tool-permission", ask: { status: "pending", action: "use a synthetic tool" } } }, "send-message"));
    harness.process(entries); await eventTurn();
    if (scenario === "pending") {
      expect((await f.get(first.result.id)).result.status.state).toBe("working");
      expect(events.filter((event) => event.type === "status" && event.state === "idle")).toHaveLength(0);
      harness.process(entries); await eventTurn();
    }
    const settled = { agent_id: "qa", live: { session_id: "qa", last_turn_settlement: { turn_id: "qa_nonce", outcome: "success" } } };
    harness.settlePersonalTurn(settled, settled); await eventTurn();
    const result = (await f.get(first.result.id)).result;
    if (scenario === "approval" || scenario === "manual-step") {
      expect(result.status.state).toBe("input-required"); expect(result.artifacts).toBeUndefined();
      const required = events.findIndex((event) => event.type === "approval_request" || event.type === "input_required" || event.type === "native_approval");
      expect(required).toBeGreaterThan(-1);
      expect(events.filter((event) => event.type === "status" && event.state === "idle")).toHaveLength(["approval", "manual-step"].includes(scenario) ? 0 : 1);
    } else {
      expect(result.status.state).toBe("completed");
      expect(result.artifacts[0].parts[0].text).toBe("First Grok bubble\n\nFinal Grok result");
    }
    expect(events.filter((event) => event.type === "message" && event.reply_to === "message_1")).toHaveLength(2);
    expect(events.filter((event) => event.type === "status" && event.state === "idle")).toHaveLength(["approval", "manual-step"].includes(scenario) ? 0 : 1);
  });

  it("coalesces stop and rejects late writes from a previous manager after the next launch", async () => {
    const f = await fixture(); await f.services.list(); let release!: () => void;
    f.manager().onSend = () => new Promise<void>((resolve) => { release = resolve; });
    const first = await f.send(); await expect.poll(() => f.manager().sends.length).toBe(1);
    const stopping = f.services.stop(); expect(f.services.stop()).toBe(stopping); await stopping;
    expect(f.manager().stops).toBe(1);
    const restored = await fixture(f.directory); await restored.services.restore();
    const before = await readFile(join(f.directory, "personal-services/manifest.json"), "utf8");
    release(); await eventTurn();
    f.manager().emitters.get("fake_grok")!.emit({ type: "message", text: "late old child", reply_to: "message_1" }); await eventTurn();
    expect(await readFile(join(f.directory, "personal-services/manifest.json"), "utf8")).toBe(before);
    expect((await restored.get(first.result.id)).result.status.state).toBe("unknown");
  });

  it("does not send if the durable manifest cannot be replaced, and blocks subsequent reads", async () => {
    const f = await fixture(); const entry = (await f.privateInstances())[0]!;
    const manifest = join(f.directory, "personal-services/manifest.json");
    await rename(manifest, `${manifest}.retained`); await mkdir(manifest);
    const request = () => fetch(entry.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}`, Connection: "close" }, body: JSON.stringify({ jsonrpc: "2.0", id: "disk_failure", method: "message/send", params: { message: { kind: "message", role: "user", messageId: "disk_failure_message", parts: [{ kind: "text", text: "must not send" }] } } }) });
    expect((await request()).status).toBe(500); expect(f.manager().sends).toHaveLength(0);
    expect((await request()).status).toBe(503); expect(f.manager().sends).toHaveLength(0);
    expect(JSON.parse(await readFile(`${manifest}.retained`, "utf8")).tasks).toEqual([]);
  });
});

describe("personal A2A local boundary", () => {
  it("enforces bearer, instance, Host/Origin, fixed routes, JSON shape and body bounds", async () => {
    const f = await fixture(); const [entry] = await f.privateInstances();
    for (const headers of [{ Authorization: "Bearer wrong" }, { Authorization: `Bearer ${instances[1]!.token}` }]) expect((await f.rpc("tasks/get", { id: "none" }, 0, headers)).status).toBe(401);
    expect((await f.rpc("tasks/get", { id: "none" }, 0, { Origin: "https://example.invalid" })).status).toBe(403);
    expect((await f.rpc("tasks/get", { id: "none" }, 0, { Origin: "null" })).status).toBe(403);
    const rawStatus = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const request = httpRequest(entry!.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry!.token}`, ...headers } }, (response) => { response.resume(); resolve(response.statusCode!); });
      request.on("error", reject); request.end(JSON.stringify({ jsonrpc: "2.0", id: "raw_rpc", method: "tasks/get", params: { id: "none" } }));
    });
    expect(await rawStatus({ Host: "evil.invalid" })).toBe(403);
    expect(await rawStatus({ "Sec-Fetch-Site": "cross-site" })).toBe(403);
    expect((await fetch(`${entry!.url}?arbitrary=1`, { method: "POST", headers: { "Content-Type": "application/json" } })).status).toBe(404);
    expect((await fetch(entry!.url)).status).toBe(404);
    expect((await f.rpc("tools/call", {})).status).toBe(200);
    expect((await (await f.rpc("message/send", { message: { messageId: "bad", parts: [{ kind: "file", data: "no" }] } })).json() as any).error.code).toBe(-32602);
    expect((await f.rpc("message/send", { padding: "x".repeat(1_000_001) })).status).toBe(413);
    expect(f.manager().sends).toHaveLength(0);
  });

  it("redacts known submitted secrets and local bearer echoes before public output and durable receipts", async () => {
    const f = await fixture(); await f.services.list(); const secret = 'synthetic_key_"_with_quote';
    await f.services.submit("flow_cue", secret);
    f.manager().nextProgress = { state: "failed", message: `service echoed ${secret}` };
    expect(await f.services.publicProgress("flow_cue")).toEqual({ state: "failed", message: "登录未完成，请检查原服务的登录页面或重新连接；已有连接仍保留。" });
    f.manager().nextProgress = { state: "input", message: `echo ${secret}`, label: "API key", secret: true, error: `echo ${secret}` };
    expect(JSON.stringify(await f.services.publicProgress("flow_cue"))).not.toContain(secret);
    expect(await f.services.publicProgress("flow_cue")).toMatchObject({ error: "服务未接受此次输入，请核对后重试。" });
    const first = await f.send(); await finish(f, `# Text\n\n${instances[0]!.token} ${secret}`);
    const readback = JSON.stringify(await f.get(first.result.id));
    expect(readback).toContain("[redacted]"); expect(readback).not.toContain(instances[0]!.token); expect(readback).not.toContain(secret);
    const manifest = await readFile(join(f.directory, "personal-services/manifest.json"), "utf8");
    expect(manifest).not.toContain(instances[0]!.token); expect(manifest).not.toContain("synthetic_key");
  });
});

describe("real connector personal-turn association with synthetic providers", () => {
  const message: InboundMessage = { session_id: "personal:synthetic_task", message_id: "personal_message", text: "Synthetic request", sent_at: "2026-11-10T00:00:00Z" };
  const sink = () => {
    const events: DirectConnectorEvent[] = [];
    const emitter: Emitter = { emit: (event) => events.push(event), profileChanged: () => {}, uncertain: (messageId) => events.push({ type: "uncertain", messageId }), inputRequired: (messageId) => events.push({ type: "input_required", messageId }) };
    return { events, emitter };
  };

  it("Grok baselines earlier entries, matches our provider nonce and clears association on manual input or send failure", async () => {
    const { events, emitter } = sink(); let providerId = ""; let fail = false;
    const entry = (seq: number, role: string, content: string, nonce?: string) => ({ seq, entry_id: `entry_${seq}`, updated_seq: 1, entry_kind: "message", body: new TextEncoder().encode(JSON.stringify({ role, content, ...(nonce ? { clientNonce: nonce } : {}) })) });
    const old = entry(1, "assistant", "old answer");
    const client = { rpc: vi.fn(async (method: string, _schema: unknown, input: { message_id?: string }) => {
      if (method === "ListGrokBotTranscriptEntries") return { entries: [old] };
      providerId = input.message_id!; if (fail) throw new Error("synthetic send failure"); return { dispatched: true };
    }) } as unknown as GrokClient;
    const connector = new GrokBotConnector({ ...GROK_DEFAULTS, pollActiveMs: 100, pollIdleMs: 100 }, { accessToken: "synthetic", refreshToken: "synthetic", machineId: "synthetic", agent: { id: "agent", name: "Fake", description: "", sessionId: "provider_conversation" } }, client, () => {}, async () => null);
    const harness = connector as unknown as { emitter: Emitter; process(entries: unknown[]): void; settlePersonalTurn(before: any, after: any): void };
    harness.emitter = emitter;
    await connector.send(message);
    const reply = [old, entry(2, "user", message.text, providerId), entry(3, "assistant", "new answer")];
    harness.process(reply); harness.process(reply);
    expect(events).toContainEqual({ type: "message", text: "new answer", reply_to: message.message_id });
    expect(events).not.toContainEqual(expect.objectContaining({ text: "old answer" }));
    const settled = { agent_id: "agent", live: { session_id: "provider_conversation", last_turn_settlement: { turn_id: providerId, outcome: "success" } } };
    harness.settlePersonalTurn(settled, settled);
    await connector.send({ ...message, message_id: "second_message" });
    const interrupted = [entry(4, "user", "manual input"), entry(5, "assistant", "manual reply")];
    harness.process(interrupted); harness.process(interrupted);
    expect(events).toContainEqual({ type: "message", text: "manual reply" });
    fail = true; await expect(connector.send({ ...message, message_id: "failed_message" })).rejects.toThrow("synthetic");
    const late = [entry(6, "user", message.text, providerId), entry(7, "assistant", "late reply")];
    harness.process(late); harness.process(late);
    expect(events).toContainEqual({ type: "message", text: "late reply" });
  });

  it("Cue uses its saved provider conversation and exact user echo, blocks a busy old task and does not correlate error replies", async () => {
    const { events, emitter } = sink(); let before: CueEvent[] = []; let fail = false;
    const send = vi.fn(async (taskId: string, text: string) => { expect(taskId).toBe("provider_cue_task"); expect(text).toBe(message.text); if (fail) throw new Error("synthetic failure"); });
    const client = { events: async () => before, send } as unknown as CueClient;
    const connector = new CueConnector({ apiUrl: "http://synthetic.invalid", pollActiveMs: 100, pollIdleMs: 100, listBudgetPerMinute: 80 }, { apiKey: "synthetic", agent: { id: "agent", taskId: "provider_cue_task", name: "Fake", about: "" }, since: 0 }, client, () => {}, async () => null);
    const harness = connector as unknown as { emitter: Emitter; process(events: CueEvent[]): void };
    harness.emitter = emitter;
    before = [{ id: "old_running", type: "status_update", timestamp: 1, status_update: { agent_status: "running" } }];
    await expect(connector.send(message)).rejects.toThrow("still working"); expect(send).not.toHaveBeenCalled();
    before = []; await connector.send(message);
    harness.process([
      { id: "own", type: "user_message", timestamp: 2, user_message: { content: message.text } },
      { id: "answer", type: "assistant_message", timestamp: 3, assistant_message: { content: "Cue result" } },
      { id: "stopped", type: "status_update", timestamp: 4, status_update: { agent_status: "stopped" } },
    ]);
    expect(events).toContainEqual({ type: "message", text: "Cue result", reply_to: message.message_id });
    await connector.send({ ...message, message_id: "second_message" });
    harness.process([{ id: "error", type: "error_message", timestamp: 5, error_message: { content: "Synthetic error" } }]);
    expect(events).toContainEqual({ type: "uncertain", messageId: "second_message" });
    fail = true; await expect(connector.send({ ...message, message_id: "failed_message" })).rejects.toThrow("synthetic failure");
    harness.process([{ id: "late", type: "assistant_message", timestamp: 6, assistant_message: { content: "late Cue answer" } }]);
    expect(events).toContainEqual({ type: "message", text: "late Cue answer" });
  });

  it.each(["Muse", "Dots"])("%s requires a quiescent baseline and own page echo, then invalidates manual turns", async (name) => {
    const { events, emitter } = sink(); let busy = true; let failedSubmit = false;
    const snap = () => ({ signedIn: true, ready: true, busy, messages: [{ id: "old", role: "assistant", text: "old page answer", actions: [] }] });
    const session = { eval: async (script: string) => script.startsWith("typeof ") ? true : script.includes("snapshot()") ? snap() : { ok: !failedSubmit, error: "synthetic submit failure" }, pressEnter: async () => {} } as unknown as WebSession;
    const connector = new WebChatConnector({ name, description: "Synthetic", partition: "persist:synthetic", url: "https://synthetic.invalid", driver: "", pollMs: 100, openLabel: "Open", fallbackAvatar: async () => null }, { connectedAt: message.sent_at }, session);
    const harness = connector as unknown as { emitter: Emitter; baselined: boolean; process(snapshot: unknown): void };
    harness.emitter = emitter; harness.baselined = true;
    await expect(connector.send(message)).rejects.toThrow("unfinished");
    busy = false; await connector.send(message);
    const own = { id: "own", role: "user", text: message.text, actions: [] };
    const answer = { id: "answer", role: "assistant", text: `${name} result`, actions: [] };
    const reply = { ...snap(), messages: [...snap().messages, own, answer] };
    harness.process(reply); harness.process(reply);
    expect(events).toContainEqual({ type: "message", text: `${name} result`, reply_to: message.message_id });
    await connector.send({ ...message, message_id: "second_message" });
    const manual = { ...snap(), messages: [{ id: "manual_user", role: "user", text: "manual input", actions: [] }, { id: "manual_answer", role: "assistant", text: "manual answer", actions: [] }] };
    harness.process(manual); harness.process(manual);
    expect(events).toContainEqual({ type: "message", text: "manual answer" });
    failedSubmit = true; await expect(connector.send({ ...message, message_id: "failed_message" })).rejects.toThrow("synthetic submit failure");
    const late = { ...snap(), messages: [{ id: "late", role: "assistant", text: "late page reply", actions: [] }] };
    harness.process(late); harness.process(late);
    expect(events).toContainEqual({ type: "message", text: "late page reply" });
  });

  it.each([
    ["replaced ID", false, "replacement", true],
    ["empty conversation", true, "replacement", true],
    ["canonical ID on first observation", false, "canonical-only", true],
    ["empty echo fills before the reply", false, "placeholder", true],
    ["reply streaming before ID replacement", false, "streaming", true],
    ["same text appended manually", false, "append", false],
    ["different replacement text", false, "different", false],
    ["replacement after an assistant", false, "after-assistant", false],
    ["missing history anchor", false, "missing-anchor", false],
    ["older history ID replaced", false, "older-history", true],
  ] as const)("web echo correlation: %s", async (_label, empty, scenario, correlated) => {
    const { events, emitter } = sink();
    const oldUser = { id: "old_user", role: "user", text: "Earlier input", actions: [] };
    const anchor = { id: "anchor", role: "assistant", text: "Earlier result", actions: [] };
    const before = empty ? [] : [oldUser, anchor];
    const snap = (messages: unknown[]) => ({ signedIn: true, ready: true, busy: false, messages });
    const session = { eval: async (script: string) => script.startsWith("typeof ") ? true : script.includes("snapshot()") ? snap(before) : { ok: true } } as unknown as WebSession;
    const connector = new WebChatConnector({ name: "Muse", description: "Synthetic", partition: "persist:synthetic", url: "https://synthetic.invalid", driver: "", pollMs: 100, openLabel: "Open", fallbackAvatar: async () => null }, { connectedAt: message.sent_at }, session);
    const harness = connector as unknown as { emitter: Emitter; baselined: boolean; process(snapshot: unknown): void };
    harness.emitter = emitter; harness.baselined = true;
    await connector.send(message);
    const optimistic = { id: "optimistic", role: "user", text: message.text, actions: [] };
    const canonical = { ...optimistic, id: "canonical", ...(scenario === "different" ? { text: "Manual input" } : {}) };
    const answer = { id: "answer", role: "assistant", text: "Actual synthetic answer", actions: [] };
    harness.process(snap([...before, scenario === "canonical-only" ? canonical : scenario === "placeholder" ? { ...canonical, text: "" } : optimistic]));
    if (scenario === "after-assistant" || scenario === "streaming") harness.process({ ...snap([...before, optimistic, answer]), busy: true });
    const history = scenario === "missing-anchor" ? [] : scenario === "older-history" ? [{ ...oldUser, id: "old_user_canonical" }, anchor] : before;
    const turns = scenario === "append" ? [optimistic, canonical, answer] : scenario === "after-assistant" ? [answer, canonical] : [canonical, answer];
    harness.process(snap([...history, ...turns])); harness.process(snap([...history, ...turns]));
    expect(events.some(event => event.type === "message" && !event.from_user && event.reply_to === message.message_id)).toBe(correlated);
    expect(events.some(event => event.type === "message" && event.from_user && !event.history)).toBe(!correlated);
  });

  it.each([false, true])("web service task reaches a terminal state with an empty echo: %s", async emptyEcho => {
    const f = await fixture(); await f.services.list();
    f.manager().onSend = async (_instance, outbound) => {
      const anchor = { id: "anchor", role: "assistant", text: "History", actions: [] };
      const snapshot = (messages: unknown[]) => ({ signedIn: true, ready: true, busy: false, messages });
      const session = { eval: async (script: string) => script.startsWith("typeof ") ? true : script.includes("snapshot()") ? snapshot([anchor]) : { ok: true } } as unknown as WebSession;
      const connector = new WebChatConnector({ name: "Muse", description: "Synthetic", partition: "persist:synthetic", url: "https://synthetic.invalid", driver: "", pollMs: 100, openLabel: "Open", fallbackAvatar: async () => null }, { connectedAt: outbound.sent_at }, session);
      const harness = connector as unknown as { emitter: Emitter; baselined: boolean; process(snapshot: unknown): void };
      harness.emitter = f.manager().emitters.get("fake_grok")!; harness.baselined = true;
      await connector.send(outbound);
      const optimistic = { id: "optimistic", role: "user", text: emptyEcho ? "" : outbound.text, actions: [] };
      harness.process(snapshot([anchor, optimistic]));
      const final = snapshot([anchor, { ...optimistic, id: emptyEcho ? "optimistic" : "canonical" }, { id: "answer", role: "assistant", text: "Synthetic actual result", actions: [] }]);
      harness.process(final); harness.process(final);
    };
    const response = await f.send();
    await expect.poll(async () => (await f.get(response.result.id)).result.status.state).toBe(emptyEcho ? "unknown" : "completed");
    expect(f.manager().sends).toHaveLength(1);
  });
});


describe("workspace switch readiness", () => {
  it("keeps service sign-in flows blocking until they have a terminal state", async () => {
    const f = await fixture();
    expect(f.services.hasPendingLogin()).toBe(false);
    await f.services.begin("muse");
    expect(f.services.hasPendingLogin()).toBe(true);
    f.manager().nextProgress = { state: "failed", message: "Synthetic cancellation" };
    expect(f.services.hasPendingLogin()).toBe(false);
    await f.services.begin("cue"); f.manager().nextProgress = { state: "waiting", message: "Synthetic waiting" };
    await f.services.cancel("flow_cue"); expect(f.services.hasPendingLogin()).toBe(false);
  });
  it("keeps submitted external work blocking a workspace switch", async () => {
    const f = await fixture();
    expect(f.services.hasUnresolvedTasks()).toBe(false);
    await f.send(); expect(f.services.hasUnresolvedTasks()).toBe(true);
    await finish(f); expect(f.services.hasUnresolvedTasks()).toBe(false);
  });
});

it("refuses original-app permissions even when their card contains an ordinary-looking option", async () => {
  const f = await fixture(); await f.services.list();
  const card = { id: "permission", revision: "p".repeat(64), requestGeneration: "permission_1", title: "Use computer?", choices: [{ key: "allow", label: "Allow" }], originalAppOnly: true, state: "pending" as const };
  f.manager().emitters.get("fake_grok")!.approval!(card); await eventTurn();
  const response: any = await (await f.rpc("agentstudio/approvals/respond", { id: card.id, revision: card.revision, choice: "allow", requestId: "permission_answer" })).json();
  expect(response.error).toBeTruthy(); expect(f.manager().decisions).toHaveLength(0);
});

it("keeps answer receipts within their semantic generation while retaining the revision fence", async () => {
  const f = await fixture(); await f.services.list();
  const first = { id: "reused_card", requestGeneration: "first_request", revision: "a".repeat(64), title: "First action?", choices: [{ key: "first", label: "First" }], state: "pending" as const };
  const emitter = f.manager().emitters.get("fake_grok")!; emitter.approval!(first); await eventTurn();
  const submit = (card: typeof first, requestId: string) => f.rpc("agentstudio/approvals/respond", { id: card.id, revision: card.revision, choice: card.choices[0]!.key, requestId });
  expect(((await (await submit(first, "generation_answer_1")).json()) as any).result.state).toBe("accepted");
  const second = { ...first, requestGeneration: "second_request", revision: "b".repeat(64), title: "Second action?", choices: [{ key: "second", label: "Second" }] };
  emitter.approval!(second); await eventTurn();
  const list: any = await (await f.rpc("agentstudio/approvals/list", {})).json();
  expect(list.result.approvals[0].deliveryState).toBeUndefined();
  expect(((await (await submit(second, "generation_answer_2")).json()) as any).result.state).toBe("accepted");
  expect(f.manager().decisions).toEqual([{ id: first.id, choice: "first" }, { id: first.id, choice: "second" }]);
});

it("does not carry an old generation's task binding or local-answer provenance into a new request", async () => {
  const f = await fixture(); await f.services.list();
  const first = { id: "generation_binding", requestGeneration: "one", revision: "a".repeat(64), title: "Continue?", choices: [{ key: "go", label: "Continue" }], state: "pending" as const, replyTo: "old_run" };
  const emitter = f.manager().emitters.get("fake_grok")!; emitter.approval!(first); await eventTurn();
  await f.rpc("agentstudio/approvals/respond", { id: first.id, revision: first.revision, choice: "go", requestId: "binding_answer" });
  emitter.approval!({ ...first, state: "resolved", source: "agentroom", choiceLabel: "Continue" });
  emitter.approval!({ ...first, requestGeneration: "two", revision: "b".repeat(64), state: "resolved", source: "original", choiceLabel: "Continue", replyTo: "new_run" });
  const list: any = await (await f.rpc("agentstudio/approvals/list", {})).json();
  expect(list.result.approvals[0].replyTo).toBe("new_run");
  expect(list.result.approvals[0].source).toBe("original");
});

it("syncs independent approvals and durably deduplicates responses across restart", async () => {
  const f = await fixture(); await f.services.list();
  const card = { id: "provider_card", revision: "a".repeat(64), title: "QA?", choices: [{ key: "opaque", label: "Reject QA" }], state: "pending" as const };
  f.manager().emitters.get("fake_grok")!.approval!(card); await eventTurn();
  const list: any = await (await f.rpc("agentstudio/approvals/list", {})).json();
  expect(list.result.approvals).toMatchObject([card]);
  const params = { id: card.id, revision: card.revision, choice: "opaque", requestId: "response_1" };
  f.manager().onDecide = async () => { throw new Error("lost response"); };
  expect((await (await f.rpc("agentstudio/approvals/respond", params)).json() as any).result.state).toBe("unknown");
  await f.rpc("agentstudio/approvals/respond", params); expect(f.manager().decisions).toHaveLength(1);
  const revised = { ...card, revision: "b".repeat(64) }; f.manager().emitters.get("fake_grok")!.approval!(revised);
  const retry: any = await (await f.rpc("agentstudio/approvals/respond", { ...params, revision: revised.revision, requestId: "response_2" })).json();
  expect(retry.error).toBeTruthy(); expect(f.manager().decisions).toHaveLength(1);
  const conflict: any = await (await f.rpc("agentstudio/approvals/respond", { ...params, choice: "changed" })).json(); expect(conflict.error).toBeTruthy();
  await f.services.stop(); const restored = await fixture(f.directory); await restored.services.restore();
  expect((await (await restored.rpc("agentstudio/approvals/respond", params)).json() as any).result.state).toBe("unknown");
  expect(restored.manager().decisions).toHaveLength(0);
});
it.each([
  { receipt: "accepted", incoming: "same", expected: "agentroom" },
  { receipt: "unknown", incoming: "same", expected: "original" },
  { receipt: "absent", incoming: "same", expected: "original" },
  { receipt: "accepted", incoming: "changed", expected: "original" },
  { receipt: "accepted", incoming: "duplicate", expected: "original" },
  { receipt: "accepted", incoming: "pending", expected: undefined },
])("keeps proven response provenance across restart ($receipt / $incoming)", async ({ receipt, incoming, expected }) => {
  const f = await fixture(); await f.services.list();
  const card = { id: "provenance_card", revision: "a".repeat(64), title: "QA?", choices: [{ key: "opaque", label: "Continue" }], state: "pending" as const };
  const emitter = f.manager().emitters.get("fake_grok")!; emitter.approval!(card);
  if (receipt !== "absent") {
    if (receipt === "unknown") f.manager().onDecide = async () => { throw new Error("lost receipt"); };
    await f.rpc("agentstudio/approvals/respond", { id: card.id, revision: card.revision, choice: "opaque", requestId: "provenance_answer" });
  }
  emitter.approval!({ ...card, state: "resolved", source: "agentroom", choiceLabel: "Continue" });
  await f.services.stop();
  const restored = await fixture(f.directory); await restored.services.restore();
  // Readback advances the provider revision and infers original by default.
  const refreshed = { ...card, revision: "b".repeat(64), state: "resolved" as "resolved" | "pending", source: "original" as "original" | undefined, choiceLabel: "Continue" as string | undefined };
  if (incoming === "changed") refreshed.choiceLabel = "Other";
  if (incoming === "duplicate") refreshed.choices.push({ key: "second", label: "Continue" });
  if (incoming === "pending") { refreshed.state = "pending"; refreshed.source = undefined; refreshed.choiceLabel = undefined; }
  restored.manager().emitters.get("fake_grok")!.approval!(refreshed);
  const result: any = await (await restored.rpc("agentstudio/approvals/list", {})).json();
  expect(result.result.approvals[0].source).toBe(expected);
  expect(restored.manager().decisions).toHaveLength(0);
  expect(restored.manager().sends).toHaveLength(0);
});
it("restores a proven approval wait and requires fresh post-approval text to complete", async () => {
 const f=await fixture();const sent=await f.send();await expect.poll(async()=>(await f.get(sent.result.id)).result.status.state).toBe("working");
 const card={id:"approval",revision:"a".repeat(64),state:"pending" as const,title:"QA?",choices:[{key:"opaque",label:"Continue"}],replyTo:"message_1"};
 f.manager().emitters.get("fake_grok")!.approval!(card);await eventTurn();expect((await f.get(sent.result.id)).result.status.state).toBe("input-required");
 await f.services.stop();const restored=await fixture(f.directory);await restored.services.restore();
 expect((await restored.get(sent.result.id)).result.status.state).toBe("input-required");
 const emitter=restored.manager().emitters.get("fake_grok")!;emitter.approval!({...card,state:"resolved",source:"original",choiceLabel:"Continue"});
 emitter.emit({type:"status",state:"working"});emitter.emit({type:"message",reply_to:"message_1",text:"old partial",provisional:true});emitter.emit({type:"status",state:"idle"});await eventTurn();
 expect((await restored.get(sent.result.id)).result.status.state).toBe("working");
 emitter.emit({type:"message",reply_to:"message_1",text:"fresh final"});emitter.emit({type:"status",state:"idle"});await eventTurn();
 expect((await restored.get(sent.result.id)).result.status.state).toBe("completed");expect(restored.manager().sends).toHaveLength(0);
});
it("restores a correlated approval continuation after text arrived but before terminal readback", async () => {
 const f=await fixture(),sent=await f.send();await expect.poll(()=>f.manager().sends.length).toBe(1);
 const card={id:"approval",revision:"a".repeat(64),state:"pending" as const,title:"QA?",choices:[{key:"opaque",label:"Continue"}],replyTo:"message_1"};
 const e=f.manager().emitters.get("fake_grok")!;e.approval!(card);e.approval!({...card,state:"resolved",source:"original"});e.emit({type:"status",state:"working"});e.emit({type:"message",reply_to:"message_1",text:"verified continuation"});await eventTurn();await f.services.stop();
 const restored=await fixture(f.directory);await restored.services.restore();expect((await restored.get(sent.result.id)).result.status.state).toBe("working");
 restored.manager().emitters.get("fake_grok")!.approval!({...card,state:"resolved",replyTo:undefined});await eventTurn();
 const cards:any=await (await restored.rpc("agentstudio/approvals/list",{})).json();expect(cards.result.approvals[0].replyTo).toBe("message_1");
 restored.manager().emitters.get("fake_grok")!.emit({type:"status",state:"idle"});await eventTurn();
 const result=(await restored.get(sent.result.id)).result;expect(result.status.state).toBe("completed");expect(result.artifacts[0].parts[0].text).toBe("verified continuation");expect(restored.manager().sends).toHaveLength(0);
 restored.manager().emitters.get("fake_grok")!.approval!({...card,id:"later_approval"});await eventTurn();
 expect((await restored.get(sent.result.id)).result.status.state).toBe("input-required");expect(restored.manager().sends).toHaveLength(0);
});
it("exposes only the original public Grok start link and distinguishes an expired login", async()=>{
 const f=await fixture();await f.services.list();
 f.manager().nextProgress={state:"waiting",message:"Waiting for Grok sign-in receipt",link:{label:"Start",url:"https://cursor.com/loginDeepControl?uuid=synthetic&challenge=public&mode=login&redirectTarget=sand"},expiresAt:"2026-11-11T12:00:00Z"};
 expect(await f.services.publicProgress("flow_grokbot")).toMatchObject({state:"waiting",link:{label:"本次 Grok 登录链接"},expiresAt:"2026-11-11T12:00:00Z"});
 f.manager().nextProgress={state:"waiting",message:"Waiting for Grok sign-in receipt",link:{label:"bad",url:"https://cursor.com/loginDeepControl?uuid=x&challenge=y&verifier=private"}};
 expect(await f.services.publicProgress("flow_grokbot")).not.toHaveProperty("link");
 f.manager().nextProgress={state:"waiting",message:"Waiting for Grok sign-in receipt",link:{label:"bad",url:"https://other.example/loginDeepControl?uuid=x&challenge=y"}};
 expect(await f.services.publicProgress("flow_grokbot")).not.toHaveProperty("link");
 f.manager().nextProgress={state:"failed",message:"Grok sign-in timed out; the old login link has expired"};
 expect((await f.services.publicProgress("flow_grokbot")) as any).toMatchObject({state:"failed",message:expect.stringContaining("已超时")});
});
