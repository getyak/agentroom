const handlePattern = /(^|[^\p{L}\p{N}_@])@([a-z][a-z0-9_-]{1,31})(?![\p{L}\p{N}_-])/giu;
const leadingHandle = /^@([a-z][a-z0-9_-]{1,31})(?![\p{L}\p{N}_-])/iu;
const continuation = /^(?:(?:继续|接着说|展开说说)[。！？.!?]?|(?:请)?(?:把|将)?第[一二三四五六七八九十\d]+[点条项段](?:再)?(?:展开|说详细一点|详细说明|多说一点)|(?:请)?(?:展开|详细说明|再解释一下)第[一二三四五六七八九十\d]+[点条项段]|(?:请)?(?:刚才|上一条|上面)(?:那点|那个|那段)?(?:再说说|再解释一下|详细一点|展开一下)|(?:continue|go on|elaborate|expand on that|tell me more)(?:[.!?])?)[。！!？?]?$/iu;
const stepSeparator = /[，,；;]\s*(再由|再让|然后由|然后让|之后由|之后让|最后由|最后让|然后|之后|最后|再(?=\s*@)|then(?: have| ask)?|finally(?: have| ask)?)\s*/iu;
const firstAssignment = /^(?:(?:请\s*)?(?:先\s*)?(?:让|请|由)\s*|(?:please\s+)?(?:first\s+)?(?:have|ask)\s+)/iu;
const nextParticipant = /^(?:和|与|、|&|and\b)\s*/iu;
const summaryInstruction = /^(?:汇总|总结|给我|整合|综合|输出|summari[sz]e\b|give me\b)/iu;
const finalStage = /^(?:最后|finally)/iu;
const namedStage = /(?:由|让| have| ask)$/iu;
const samePartner = /^(?:你|您|you\b)/iu;
const explicitCoassignee = /(?:和|与|、|&|\band\b)\s*@/iu;
const invalidPlan = '请为每一步指定群内伙伴和任务，名字与任务之间留一个空格。';

export function mentionedHandles(text) {
  return new Set([...text.matchAll(handlePattern)].map(match => match[2].toLowerCase()));
}

export function directGroupRecipient(text, mentions, agents) {
  const addressed = leadingHandle.exec(text)?.[1].toLowerCase();
  if (mentions.size !== 1 || !addressed || addressed === 'all') return null;
  return agents.find(agent => agent.handle === addressed) || null;
}

export function followupGroupReply(text, thread, agents) {
  if (!continuation.test(text)) return null;
  const previous = thread.messages.findLast(message => message.role === 'user');
  if (!previous) return null;
  const runs = thread.runs.filter(run => run.messageId === previous.id);
  if (runs.some(run => ['queued', 'running', 'verifying', 'needs_input', 'unknown'].includes(run.status) || run.cancelPending || run.requiresReconciliation)) return null;
  const replies = thread.messages.filter(message => message.role === 'assistant' && runs.some(run => run.id === message.runId && run.status === 'completed'));
  if (new Set(replies.map(message => message.contactId)).size !== 1) return null;
  const latest = replies.at(-1);
  const member = thread.members.find(item => item.contactId === latest.contactId);
  const accepted = runs.find(run => run.id === latest.runId).participantMemberships?.find(item => item.contactId === latest.contactId);
  if (!member || (accepted?.membershipId && accepted.membershipId !== member.membershipId)) return null;
  return agents.some(agent => agent.id === latest.contactId) ? latest : null;
}

function nameAtStart(input, agents) {
  const lower = input.toLowerCase();
  const matches = agents.flatMap(agent => [...new Set([`@${agent.handle}`, agent.handle, agent.name].filter(Boolean))]
    .filter(label => lower.startsWith(label.toLowerCase()) && /^(?:$|[\s:：])/.test(input.slice(label.length)))
    .map(label => ({ agent, length: label.length }))).sort((a, b) => b.length - a.length);
  const first = matches[0];
  if (!first || matches.some(match => match.length === first.length && match.agent.id !== first.agent.id)) return null;
  return { agent: first.agent, rest: input.slice(first.length).replace(/^[\s:：]+/u, '') };
}

function assignment(input, agents) {
  let match = nameAtStart(input, agents);
  if (!match) return null;
  const contactIds = [match.agent.id];
  let instruction = match.rest;
  while (nextParticipant.test(instruction)) {
    const participant = instruction.replace(nextParticipant, '');
    match = nameAtStart(participant, agents);
    if (!match) return participant.startsWith('@') ? { error: invalidPlan } : { contactIds, instruction };
    if (contactIds.includes(match.agent.id)) return null;
    contactIds.push(match.agent.id);
    instruction = match.rest;
  }
  return instruction ? { contactIds, instruction } : null;
}

/** Only explicit, named stages become work. Prose in replies never schedules a step. */
export function explicitGroupPlan(text, agents) {
  const parts = text.split(stepSeparator);
  if (parts.length < 3 || (!firstAssignment.test(parts[0]) && !parts[0].startsWith('@'))) return null;
  const first = assignment(parts[0].replace(firstAssignment, ''), agents);
  const following = [];
  for (let i = 1; i < parts.length; i += 2) following.push({ direction: parts[i], input: parts[i + 1].trim() });
  const hasNamedStage = following.some(({ direction, input }) =>
    input.startsWith('@') || nameAtStart(input, agents) || (namedStage.test(direction) && !samePartner.test(input)));
  const implicitSummary = finalStage.test(following.at(-1).direction) && summaryInstruction.test(following.at(-1).input);
  const coassignees = first?.contactIds?.length > 1 || first?.error || (!first && explicitCoassignee.test(parts[0]));
  if (!hasNamedStage && !(implicitSummary && coassignees)) return null;
  if (!first || first.error) return { error: invalidPlan };
  const stages = [first];
  for (const [index, { direction, input }] of following.entries()) {
    const stage = assignment(input, agents);
    if (stage?.error) return stage;
    if (stage) stages.push(stage);
    else if (implicitSummary && index === following.length - 1 && !namedStage.test(direction)) stages.push({ contactIds: [first.contactIds[0]], instruction: input });
    else return { error: invalidPlan };
  }
  const participants = stages.flatMap(stage => stage.contactIds);
  if (new Set(participants).size < 2) return null;
  if (participants.length > 6 || stages.length > 4) return { error: '一次群聊派工最多安排 4 个阶段、6 个任务。' };
  return { stages, total: participants.length };
}
