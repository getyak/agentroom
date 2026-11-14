export type PlayTemplate = 'twin' | 'travel' | 'project';
export type PlayAction = { type: string; clientId?: string; [key: string]: unknown };
export type PlayParticipant = { id: string; name: string; isOwner: boolean };
export type PlayRoom = {
  id: string; template: PlayTemplate; title: string; brief: string; agentName: string; hostName: string;
  expiresAt: string; closed: boolean; version: number; remainingTurns: number; me?: PlayParticipant;
  participants: PlayParticipant[];
  messages: { id: string; actorId: string; name: string; role: string; text: string; createdAt: string }[];
  jobs: { id: string; actorId: string; status: string; error?: string }[];
  board: { choices: { id: string; label: string; votes: string[] }[]; tasks: { id: string; label: string; done: boolean }[]; notes: string; notesVersion: number };
};
export type PlayPreview = Pick<PlayRoom, 'id' | 'template' | 'title' | 'brief' | 'agentName' | 'hostName' | 'expiresAt'> & { participantCount: number };
export function acceptPlaySnapshot<T extends { id: string; version: number }>(current: T | null, next: T): T | null {
  return !current || current.id !== next.id || current.version > next.version ? current : next;
}
export const playCases = {
  twin: { title: '小熊会客厅', subtitle: '我不在，分身也能陪你聊两句。', mark: '🐻', tag: '和我的 AI 分身聊聊', prompt: '如果我们一起做件有趣的事，你会建议什么？',
    brief: '想聊 AI、旅行，或一个还没成形的点子都可以。这个房间只带着这里公开的介绍，不读取主人的其他聊天或资料。先说说你最近对什么着迷吧。', persona: '你是主人的 AI 分身，亲切、好奇，有一点幽默。明确说明自己是 AI，不冒充真人，不替主人作承诺。只依据公开背景认识主人；不确定的事坦白说。' },
  travel: { title: '下一站，去山那边', subtitle: '先把人凑齐，再把“改天”变成一趟旅行。', mark: '🏕️', tag: '和朋友规划一趟旅行', prompt: '帮我们把这趟旅行拆成三个需要一起决定的小问题。',
    brief: '计划一次周末小旅行。先收集每个人的时间、预算和不想做的事，再选山间、海边或城市。示例预算为每人 600 元，可以直接修改。旅行助理负责整理选择与分工，不进行预订或付款。', persona: '你是这群朋友的旅行搭子。轻松具体地帮大家比较选择，主动照顾预算、节奏和饮食限制。没有实时查询能力，不能编造票价、天气或订位结果。' },
  project: { title: '一起造点东西', subtitle: '一个还不成熟的点子，正适合一起开始。', mark: '🛠️', tag: '共同创作一个小项目', prompt: '我们想在 48 小时里做个小项目，先怎么开始？',
    brief: '一起在 48 小时里做一个小项目：一张旅行地图、一个有趣网页，或一份共同清单。先定受众、最小成果和各自想贡献的部分。这里可以讨论、共同写便笺并导出；实际制作、运行和发布另行安排。', persona: '你是有创意又务实的共创搭子。帮助大家把模糊想法变成一份可动手的草稿和小分工。鼓励人补充自己的想法，不伪称已经编写、运行或发布软件。' },
} as const;
export const playError = (error: unknown) => error instanceof Error ? /fetch|network|timeout|aborted/i.test(`${error.name} ${error.message}`) ? '连接中断，内容已保留，正在尝试重连。' : error.message : '刚才没有连上，内容还在，稍后再试。';
