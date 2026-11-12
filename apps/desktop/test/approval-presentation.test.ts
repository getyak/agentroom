import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalRow, ApprovalSource } from "../../personal/src/ApprovalSource";
import type { Approval, Contact } from "../../personal/src/types";

const contact: Contact = { id: "planner", name: "New Bot", handle: "planner", kind: "agent", description: "", instructions: "", color: "teal", version: 1, binding: { type: "connection", connectionId: "con_original" }, availability: "ready" };
const approval: Approval = { id: "decision", version: 1, title: "确认方案？", summary: "", preview: "", choices: [], state: "pending", decision: null, deliveryState: null, actionState: null, verificationState: null, threadId: "thread", threadTitle: "计划", contact,
  source: { label: "Grok Bot", name: "New Bot", connectionId: "con_original", botId: "original_bot", requestText: null, threadKind: "direct" } };

const row = (value: Approval, person?: Contact) => renderToStaticMarkup(createElement(ApprovalRow, { approval: value, contact: person, selected: false, onSelect() {} }));
const detail = (value: Approval, person?: Contact) => renderToStaticMarkup(createElement(ApprovalSource, { approval: value, contact: person, canOpenContact: Boolean(person), onContact() {}, onChat() {} }));

describe("visible approval sender", () => {
  it("distinguishes unnamed Bots in the primary sender on every card", () => {
    for (const botId of ["bot_alpha", "bot_beta"]) {
      const value = { ...approval, source: { ...approval.source!, botId } };
      expect(row(value, contact)).toContain(`由 Grok Bot · ${botId} 发起`);
      expect(detail(value, contact)).toContain(`Grok Bot · ${botId}`);
      expect(detail(value, contact)).toContain("原服务尚未命名");
    }
  });
  it("keeps a chosen nickname and shows its handle beside each request", () => {
    const person = { ...contact, name: "规划伙伴" };
    expect(row(approval, person)).toContain("由 规划伙伴 发起");
    expect(row(approval, person)).toContain("@planner");
    expect(row(approval, person)).toContain("original_bot");
    expect(row(approval, person)).not.toMatch(/^<button[^>]*aria-label=/);
    expect(detail(approval, person)).toContain("规划伙伴");
    expect(detail(approval, person)).not.toContain("原服务尚未命名");
  });
  it("uses known provider attribution when its address-book contact is missing", () => {
    const value = { ...approval, contact: null };
    expect(row(value)).toContain("由 Grok Bot · original_bot 发起");
    expect(detail(value)).toContain("Grok Bot · original_bot");
    expect(detail(value)).not.toContain("未关联联系人");
  });
  it("preserves a recorded sender name without inventing an unknown sender", () => {
    const value = { ...approval, contact: null, source: { ...approval.source!, name: "研究助手" } };
    expect(row(value)).toContain("由 研究助手 发起");
    expect(row({ ...value, source: undefined })).toContain("发送者待核对");
    expect(detail({ ...value, source: undefined })).toContain("发送者待核对");
  });
  it("labels both direct and group context in every list item", () => {
    expect(row(approval, contact)).toContain("私聊 · 计划");
    expect(row({ ...approval, source: { ...approval.source!, threadKind: "group" } }, contact)).toContain("群聊 · 计划");
  });
});
