import { afterEach, expect, it, vi } from "vitest";
import { GrokBotConnector, GROK_DEFAULTS, type GrokClient } from "../src/main/connectors/grokbot";
vi.mock("electron", () => ({ shell: {}, app: {} }));
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });
const entry = (answer?: string, updated = 1, options = [{ label: "Approve QA", value: "a" }, { label: "Reject QA", value: "r" }]) => ({ entry_id: "card", seq: 2, updated_seq: updated, entry_kind: "send-message", body: Buffer.from(JSON.stringify({ kind: "send-message", message: { type: "widget", widget: { prompt: "QA?", options } }, ...(answer ? { widgetAnswered: true, answer } : {}) })) });
async function fixture(personalTurn?: any, harness?: string, lastSeq = personalTurn ? 4 : 10) {
  let entries = [entry()]; const calls: any[] = [], cards: any[] = [], events: any[] = [];
  let live: any = { session_id: "session", last_turn_settlement: { turn_id: personalTurn?.providerMessageId, outcome: "success" } };
  let status: any;
  const agent = { id: "qa", name: "QA", description: "", sessionId: "session", harness };
  const client = { listAgents: async () => [agent], rpc: async (method: string, _schema: unknown, params: any) => {
    calls.push({ method, params });
    return method === "ListGrokBotTranscriptEntries" ? { entries } : method === "ListGrokBotAgentStatuses" ? { statuses: [status ?? { agent_id: "qa", live }] } : { accepted: true };
  } } as unknown as GrokClient;
  const connector = new GrokBotConnector({ ...GROK_DEFAULTS, pollActiveMs: 1_000_000, pollIdleMs: 1_000_000 }, { agent, machineId: "qa", accessToken: "fake", refreshToken: "fake", lastSeq, personalTurn }, client, () => {}, async () => null);
  stops.push(() => connector.stop());
  await connector.start({ emit: e => events.push(e), profileChanged: () => {}, approval: c => cards.push(c) });
  return { connector, cards, calls, events, setStatus: (value: any) => { status = value; }, setLive: (value: any) => { live = value; }, set: (value: typeof entries) => { entries = value; }, poll: () => (connector as any).tick() };
}
it("requires a known temporal running phase before idle can complete a stable reply", async () => {
  const f=await fixture(undefined,"temporal");f.set([]);await f.connector.send({session_id:"personal:qa",message_id:"turn",text:"QA",sent_at:new Date().toISOString()});
  const nonce=f.calls.find(c=>c.method==="SendGrokBotUserMessage").params.message_id;
  f.set([{entry_id:"t2u",seq:11,updated_seq:11,entry_kind:"user-message",body:Buffer.from(JSON.stringify({kind:"user-message",clientNonce:nonce,text:"QA"}))},{entry_id:"t2s0",seq:12,updated_seq:12,entry_kind:"send-message",body:Buffer.from(JSON.stringify({kind:"send-message",message:{text:"QA reply"}}))}]);
  f.setStatus({agent_id:"qa"});await f.poll();await f.poll();expect(f.events).not.toContainEqual({type:"status",state:"idle"});
  f.setStatus({agent_id:"qa",is_running:true});await f.poll();expect(f.events).not.toContainEqual({type:"status",state:"idle"});
  f.setStatus({agent_id:"different"});await f.poll();expect(f.events).not.toContainEqual({type:"status",state:"idle"});
  f.setStatus({agent_id:"qa"});await f.poll();await f.poll();expect(f.events).toContainEqual({type:"status",state:"idle"});
});
it("completes a short known Temporal request when its running phase falls between polls, retaining late cards", async () => {
 const f=await fixture(undefined,"temporal");f.set([]);await f.connector.send({session_id:"personal:short",message_id:"short",text:"QA",sent_at:new Date().toISOString()});
 const nonce=f.calls.find(c=>c.method==="SendGrokBotUserMessage").params.message_id;f.setStatus({agent_id:"qa"});
 const user={entry_id:"t2u",seq:11,updated_seq:11,entry_kind:"user-message",body:Buffer.from(JSON.stringify({kind:"user-message",clientNonce:nonce,text:"QA",requestId:"request_qa"}))};
 const reply={entry_id:"t2s0",seq:12,updated_seq:12,entry_kind:"send-message",body:Buffer.from(JSON.stringify({kind:"send-message",requestId:"request_qa",message:{text:"QA connected"}}))};
 f.set([user,reply]);await f.poll();await f.poll();expect(f.events).not.toContainEqual({type:"status",state:"idle"});
 await f.poll();expect(f.events).toContainEqual({type:"status",state:"idle"});
 f.set([user,reply,{...entry(),entry_id:"t2s1",seq:13,updated_seq:13}]);await f.poll();expect(f.cards.at(-1)).toMatchObject({state:"pending",replyTo:"short"});
 expect(f.calls.filter(c=>c.method==="SendGrokBotUserMessage")).toHaveLength(1);
});
it("does not authorize short-request completion from a nonce-free same-text user echo", async () => {
 const f=await fixture(undefined,"temporal");f.set([]);await f.connector.send({session_id:"personal:short",message_id:"short",text:"QA",sent_at:new Date().toISOString()});f.setStatus({agent_id:"qa"});
 f.set([{entry_id:"t2u",seq:11,updated_seq:11,entry_kind:"user-message",body:Buffer.from(JSON.stringify({kind:"user-message",text:"QA",requestId:"foreign"}))},{entry_id:"t2s0",seq:12,updated_seq:12,entry_kind:"send-message",body:Buffer.from(JSON.stringify({kind:"send-message",requestId:"foreign",message:{text:"Other result"}}))}]);
 await f.poll();await f.poll();await f.poll();expect(f.events).not.toContainEqual({type:"status",state:"idle"});
});
it("keeps a turn open when a stable preamble arrives before its native approval card", async () => {
  const f = await fixture(); f.set([]);
  await f.connector.send({ session_id: "personal:qa", message_id: "outbound", text: "QA", sent_at: new Date().toISOString() });
  const nonce = f.calls.find(c => c.method === "SendGrokBotUserMessage").params.message_id;
  const user = { entry_id: "user", seq: 11, updated_seq: 11, entry_kind: "user-message", body: Buffer.from(JSON.stringify({ kind: "user-message", clientNonce: nonce, text: "QA" })) };
  const preamble = { entry_id: "preamble", seq: 12, updated_seq: 12, entry_kind: "send-message", body: Buffer.from(JSON.stringify({ kind: "send-message", message: { text: "Waiting for your choice" } })) };
  f.setLive({ session_id: "session", is_running: true }); f.set([user, preamble]);
  await f.poll(); await f.poll();
  expect(f.events).not.toContainEqual({ type: "status", state: "idle" });
  const card = { ...entry(), seq: 13, updated_seq: 13 }; f.set([user, preamble, card]); await f.poll();
  expect(f.cards.at(-1)).toMatchObject({ state: "pending", replyTo: "outbound" });
  f.set([user, preamble, { ...entry("r", 15), seq: 13 }, { ...preamble, entry_id: "final", seq: 14, updated_seq: 14, body: Buffer.from(JSON.stringify({ kind: "send-message", message: { text: "Selected Reject QA" } })) }]);
  await f.poll(); await f.poll();
  expect(f.events).not.toContainEqual({ type: "status", state: "idle" });
  f.setLive({ session_id: "session", last_turn_settlement: { turn_id: "unrelated", outcome: "success" } }); await f.poll();
  expect(f.events).not.toContainEqual({ type: "status", state: "idle" });
  f.setLive({ session_id: "session", last_turn_settlement: { turn_id: nonce, outcome: "success" } }); await f.poll();
  expect(f.events).toContainEqual({ type: "status", state: "idle" });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "message", reply_to: "outbound", text: "Selected Reject QA" }));
  expect(f.calls.filter(c => c.method === "SendGrokBotUserMessage")).toHaveLength(1);
});
it("publishes existing pending cards despite an older seq, with exact opaque choices", async () => {
  const f = await fixture(); const values = Array.from({ length: 6 }, (_, i) => ({ label: `Choice ${i}`, value: `${i}${"x".repeat(250)}` }));
  f.set([entry(undefined, 2, values)]); await f.poll();
  const card = f.cards.at(-1); expect(card.state).toBe("pending"); expect(card.choices).toHaveLength(6);
  expect(card.choices[5].key).not.toContain("xxx");
  await f.connector.decide("card", card.choices[5].key);
  expect(f.calls.filter(c => c.method === "RespondGrokBotWidget")[0].params.value).toBe(values[5]!.value);
});
it("separates semantic request generation from answer-observation revisions", async () => {
 const f=await fixture();await f.poll();const pending=f.cards.at(-1);
 expect(pending.requestGeneration).toMatch(/^[0-9a-f]{64}$/);
 f.set([entry('r',2)]);await f.poll();const answered=f.cards.at(-1);
 expect(answered.revision).not.toBe(pending.revision);expect(answered.requestGeneration).toBe(pending.requestGeneration);
 const changed=await fixture();await changed.poll();const original=changed.cards.at(-1);
 changed.set([entry(undefined,3,[{label:'Different target',value:'new_target'}])]);await changed.poll();
 expect(changed.cards.at(-1).requestGeneration).not.toBe(original.requestGeneration);
});
it("accepts a distinct request after a resolved reused card and fences old opaque buttons", async () => {
 const f=await fixture(); const scoped=(requestId:string,answer?:string,updated=4)=>{const item=entry(answer,updated);return {...item,body:Buffer.from(JSON.stringify({...JSON.parse(item.body.toString()),requestId}))};};
 f.set([scoped('operation_one')]);await f.poll();const first=f.cards.at(-1);
 f.set([scoped('operation_one','r')]);await f.poll();expect(f.cards.at(-1).state).toBe('resolved');
 f.set([scoped('operation_two')]);await f.poll();const second=f.cards.at(-1);
 expect(second.state).toBe('pending');expect(second.requestGeneration).not.toBe(first.requestGeneration);expect(second.revision).not.toBe(first.revision);
 await expect(f.connector.decide('card',first.choices[0].key)).rejects.toThrow();
 expect(f.calls.some(call=>call.method==='RespondGrokBotWidget')).toBe(false);
 const answered=scoped('operation_two','r',5),withoutId=JSON.parse(answered.body.toString());delete withoutId.requestId;
 f.set([{...answered,body:Buffer.from(JSON.stringify(withoutId))}]);await f.poll();
 expect(f.cards.at(-1).requestGeneration).toBe(second.requestGeneration);
});
it("refreshes a changed viewer session even when public profile fields are identical", async () => {
 const f=await fixture();await f.poll();const first=f.cards.at(-1);
 (f.connector as any).personalReply={messageId:'old_turn'};
 (f.connector as any).client.listAgents=async()=>[{id:'qa',name:'QA',description:'',sessionId:'new_session'}];
 await (f.connector as any).refreshProfile();await f.poll();
 expect(f.cards.at(-1).requestGeneration).not.toBe(first.requestGeneration);
 expect((f.connector as any).personalReply).toBeNull();expect(f.cards.at(-1).replyTo).toBeUndefined();
});
it("does not settle pre-approval text when the first card snapshot is already answered", async () => {
 const f=await fixture();f.set([]);await f.connector.send({session_id:"personal:qa",message_id:"turn",text:"QA",sent_at:new Date().toISOString()});
 const nonce=f.calls.find(c=>c.method==="SendGrokBotUserMessage").params.message_id;
 const user={entry_id:"user",seq:11,updated_seq:11,entry_kind:"user-message",body:Buffer.from(JSON.stringify({kind:"user-message",clientNonce:nonce,text:"QA"}))};
 const text={entry_id:"preamble",seq:12,updated_seq:12,entry_kind:"send-message",body:Buffer.from(JSON.stringify({kind:"send-message",message:{text:"Waiting for your choice"}}))};
 f.setLive({session_id:"session",is_running:true});f.set([user,text]);await f.poll();await f.poll();
 f.setLive({session_id:"session",last_turn_settlement:{turn_id:nonce,outcome:"success"}});
 f.set([user,text,{...entry("r",15),seq:13}]);await f.poll();
 expect(f.events).not.toContainEqual({type:"status",state:"idle"});
 f.set([user,text,{...entry("r",15),seq:13},{...text,entry_id:"final",seq:14,updated_seq:14,body:Buffer.from(JSON.stringify({kind:"send-message",message:{text:"Selected Reject QA"}}))}]);await f.poll();await f.poll();
 expect(f.events).toContainEqual({type:"status",state:"idle"});
});
it("waits for post-approval text when the original echo and answered card first arrive together", async () => {
  const f = await fixture(); f.set([]);
  await f.connector.send({ session_id: "personal:qa", message_id: "turn", text: "QA", sent_at: new Date().toISOString() });
  const nonce = f.calls.find(c => c.method === "SendGrokBotUserMessage").params.message_id;
  const user = { entry_id: "user", seq: 11, updated_seq: 11, entry_kind: "user-message", body: Buffer.from(JSON.stringify({ kind: "user-message", clientNonce: nonce, text: "QA" })) };
  const preamble = { entry_id: "preamble", seq: 12, updated_seq: 12, entry_kind: "send-message", body: Buffer.from(JSON.stringify({ kind: "send-message", message: { text: "Waiting for your choice" } })) };
  const answered = { ...entry("r", 15), seq: 13 };
  f.setLive({ session_id: "session", last_turn_settlement: { turn_id: nonce, outcome: "success" } });
  f.set([user, preamble, answered]);
  await f.poll(); await f.poll();
  expect(f.cards.at(-1)).toMatchObject({ state: "resolved", replyTo: "turn", source: "original" });
  expect(f.events).not.toContainEqual({ type: "status", state: "idle" });

  const final = { entry_id: "final", seq: 14, updated_seq: 14, entry_kind: "send-message", body: Buffer.from(JSON.stringify({ kind: "send-message", message: { text: "Selected Reject QA" } })) };
  f.set([user, preamble, answered, final]);
  await f.poll(); await f.poll();
  expect(f.events).toContainEqual({ type: "message", text: "Selected Reject QA", reply_to: "turn" });
  expect(f.events.filter(event => event.type === "status" && event.state === "idle")).toHaveLength(1);
  expect(f.calls.filter(call => call.method === "SendGrokBotUserMessage")).toHaveLength(1);
});
it("rechecks revisions before answering and observes answers made in the original app", async () => {
  const f = await fixture(); await f.poll(); const old = f.cards.at(-1);
  f.set([entry(undefined, 3)]);
  await expect(f.connector.decide("card", old.choices[0].key)).rejects.toThrow();
  expect(f.calls.filter(c => c.method === "RespondGrokBotWidget")).toHaveLength(0);
  f.set([entry("r", 4)]); await f.poll();
  expect(f.cards.at(-1)).toMatchObject({ id: "card", state: "resolved", choiceLabel: "Reject QA", source: "original" });
});
it("does not answer a card missing or omitted from the fresh read", async () => {
 const f=await fixture(); await f.poll();const choice=f.cards.at(-1).choices[0].key;
 f.set([]);await expect(f.connector.decide("card",choice)).rejects.toThrow();
 f.set([{...entry(),body:undefined,body_omitted:true} as any]);await expect(f.connector.decide("card",choice)).rejects.toThrow();
 expect(f.calls.filter(c=>c.method==="RespondGrokBotWidget")).toHaveLength(0);
});
it("restores a known pending turn and accepts an original-app answer after restart without resending", async () => {
 const turn={messageId:"original",providerMessageId:"nonce",text:"QA",echoed:true,startSeq:1,sessionId:"session",waiting:true,cards:["card"],resumeAfter:4};
 const f=await fixture(turn);
 f.set([entry("r",3),{entry_id:"reply",seq:5,updated_seq:1,entry_kind:"send-message",body:Buffer.from(JSON.stringify({kind:"send-message",message:{text:"Selected Reject QA"}}))}]);
 await f.poll();await f.poll();
 expect(f.events).toContainEqual(expect.objectContaining({type:"status",state:"working"}));
 expect(f.events).toContainEqual(expect.objectContaining({type:"message",reply_to:"original",text:"Selected Reject QA"}));
 expect(f.events).toContainEqual({type:"status",state:"idle"});
 expect(f.calls.some(c=>c.method==="SendGrokBotUserMessage")).toBe(false);
});
it("does not regress a resolved original-app card on a late older snapshot", async () => {
 const f=await fixture();await f.poll();f.set([entry("r",4)]);await f.poll();f.set([entry(undefined,3)]);await f.poll();
 expect(f.cards.at(-1)).toMatchObject({state:"resolved",choiceLabel:"Reject QA"});
});
it("reads the temporal harness respondedValue when a choice is made in Grok Bot", async () => {
 const f=await fixture(); await f.poll(); const pending=entry();
 f.set([{...pending,updated_seq:3,body:Buffer.from(JSON.stringify({...JSON.parse(pending.body.toString()),respondedValue:"r"}))}]); await f.poll();
 expect(f.cards.at(-1)).toMatchObject({state:"resolved",choiceLabel:"Reject QA",source:"original"});
});
it("reads a native dismissal with no response value", async () => {
 const f=await fixture();await f.poll();const p=entry();
 f.set([{...p,seq:11,updated_seq:11,body:Buffer.from(JSON.stringify({...JSON.parse(p.body.toString()),respondedValue:null,widgetDismissed:true}))}]);await f.poll();
 expect(f.cards.at(-1)).toMatchObject({state:"resolved",choiceLabel:"已跳过",source:"original"});
 expect(f.events.some(e=>e.type==="approval_request")).toBe(false);
});
it("reconciles a closed-app answer only from a new request in the same temporal turn", async () => {
 const turn={messageId:"original",providerMessageId:"nonce",text:"QA",echoed:true,startSeq:1,sessionId:"session",waiting:true,cards:["t1s1"],resumeAfter:4,resumeUpdated:4,temporalTurn:"t1",approvalRequests:["before"]};
 const f=await fixture(turn,"temporal");f.setStatus({agent_id:"qa"});
 const card={...entry("r",8),entry_id:"t1s1",seq:4};card.body=Buffer.from(JSON.stringify({...JSON.parse(card.body.toString()),requestId:"before"}));
 const pre={entry_id:"t1s2",seq:5,updated_seq:5,entry_kind:"send-message",body:Buffer.from(JSON.stringify({kind:"send-message",requestId:"before",message:{text:"Wait for choice"}}))};
 const user={entry_id:"t1u",seq:2,updated_seq:2,entry_kind:"user-message",body:Buffer.from(JSON.stringify({kind:"user-message",clientNonce:"nonce",text:"QA"}))};
 f.set([user,card,pre]);await f.poll();await f.poll();expect(f.events).not.toContainEqual({type:"status",state:"idle"});
 f.set([user,card,pre,{...pre,entry_id:"t1s3",seq:6,updated_seq:6,body:Buffer.from(JSON.stringify({kind:"send-message",requestId:"after",message:{text:"Selected Reject QA"}}))}]);await f.poll();await f.poll();await f.poll();
 expect(f.events).toContainEqual({type:"status",state:"idle"});expect(f.calls.some(c=>c.method==="SendGrokBotUserMessage")).toBe(false);
});
it("finishes an already-read approval continuation after restart without replaying its text", async () => {
 const turn={messageId:"original",providerMessageId:"nonce",text:"QA",echoed:true,startSeq:1,sessionId:"session",waiting:false,cards:[],resumeAfter:4,resumeUpdated:4,temporalTurn:"t1",approvalRequests:["before"],lastCardSeq:4,responseSeq:6,responseUpdated:6,responseTurn:"t1",responseRequest:"after"};
 const f=await fixture(turn,"temporal",6);f.setStatus({agent_id:"qa"});
 const p=entry("r",8);f.set([{...p,entry_id:"t1s1",seq:4,body:Buffer.from(JSON.stringify({...JSON.parse(p.body.toString()),requestId:"before"}))},{entry_id:"t1s2",seq:6,updated_seq:6,entry_kind:"send-message",body:Buffer.from(JSON.stringify({kind:"send-message",requestId:"after",message:{text:"Selected Reject QA"}}))}]);await f.poll();await f.poll();
 expect(f.events).toContainEqual({type:"status",state:"idle"});expect(f.events.some(e=>e.type==="message")).toBe(false);
 expect(f.calls.some(c=>c.method==="SendGrokBotUserMessage")).toBe(false);
 const later=entry();f.set([{...later,entry_id:"t1s3",seq:7,updated_seq:9,body:Buffer.from(JSON.stringify({...JSON.parse(later.body.toString()),requestId:"after"}))}]);await f.poll();
 expect(f.cards.at(-1)).toMatchObject({state:"pending",replyTo:"original"});expect((f.connector as any).personalReply.settled).toBe(false);
});
it("does not send a new prompt when preflight discovers an answered late card for the settled turn", async () => {
 const turn={messageId:"original",providerMessageId:"nonce",text:"QA",echoed:true,startSeq:1,sessionId:"session",waiting:false,cards:[],resumeAfter:4,temporalTurn:"t1",settled:true};
 const f=await fixture(turn,"temporal",6),p=entry("r",8);f.set([{...p,entry_id:"t1s3",seq:7}]);
 await expect(f.connector.send({session_id:"personal:next",message_id:"next",text:"next",sent_at:new Date().toISOString()})).rejects.toMatchObject({name:"NotSentError"});
 expect(f.calls.some(c=>c.method==="SendGrokBotUserMessage")).toBe(false);expect((f.connector as any).personalReply.messageId).toBe("original");
});
it("keeps the original turn while two cards are answered separately in Grok Bot", async () => {
 const turn={messageId:"original",providerMessageId:"nonce",text:"QA",echoed:true,startSeq:1,sessionId:"session",waiting:true,cards:["card","card2"],resumeAfter:4};
 const f=await fixture(turn), second={...entry(undefined,1),entry_id:"card2",seq:3};
 const user=(seq:number)=>({entry_id:`user${seq}`,seq,updated_seq:1,entry_kind:"user-message",body:Buffer.from(JSON.stringify({kind:"user-message",text:"r"}))});
 f.set([entry("r",2),second,user(5)]);await f.poll();
 expect((f.connector as any).personalReply?.messageId).toBe("original");
 expect(f.events.some(e=>e.type==="message"&&e.from_user)).toBe(false);
 expect(f.events.some(e=>e.type==="status"&&e.state==="working")).toBe(false);
 f.set([entry("r",2),{...entry("r",2),entry_id:"card2",seq:3},user(5),user(6)]);await f.poll();
 expect((f.connector as any).personalReply?.messageId).toBe("original");
 expect(f.events.filter(e=>e.type==="status"&&e.state==="working")).toHaveLength(1);
 expect(f.events.some(e=>e.type==="message"&&e.from_user)).toBe(false);
});
it("does not carry an independent answer into a later turn or suppress an unrelated nonce", async () => {
 const f=await fixture();await f.poll();await f.connector.decide("card",f.cards.at(-1).choices[1].key);
 expect((f.connector as any).widgetAnswers.size).toBe(0);
 (f.connector as any).personalReply={messageId:"new",providerMessageId:"newnonce",text:"new prompt",echoed:true,startSeq:10,sessionId:"session",cards:[]};
 (f.connector as any).rememberWidgetAnswer("relatedcard","r");
 f.set([{entry_id:"foreign",seq:11,updated_seq:1,entry_kind:"user-message",body:Buffer.from(JSON.stringify({kind:"user-message",clientNonce:"foreignnonce",text:"r"}))}]);await f.poll();
 expect(f.events).toContainEqual(expect.objectContaining({type:"message",from_user:true,text:"r"}));
 expect((f.connector as any).personalReply).toBeNull();
});
