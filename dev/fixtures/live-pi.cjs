// Synthetic Pi protocol. This program never imports a model SDK or calls HTTP.
const fs = require('node:fs');
const args = process.argv.slice(2);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (args.includes('--version')) console.log('pi 0.85.1');
else if (args.includes('--help')) console.log('--no-builtin-tools');
else if (args.includes('rpc')) {
  process.stdin.setEncoding('utf8'); process.stdin.on('data', line => { const command = JSON.parse(line); emit({ id: command.id, success: true, data: { models: ['alpha', 'beta'].map(id => ({ provider: 'fixture', id, name: id, reasoning: true, input: ['text'] })) } }); });
}
else {
  let prompt = '';
  process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { prompt += value; });
  process.stdin.on('end', async () => {
    const context = JSON.parse(prompt.split('<untrusted_thread_context>\n')[1].split('\n</untrusted_thread_context>')[0]);
    const request = context.messages.filter(message => message.role === 'user').at(-1).text;
    const get = flag => args[args.indexOf(flag) + 1];
    const model = get('--model'), provider = get('--provider'), thinking = get('--thinking');
    if (process.env.AGENTSTUDIO_SYNTHETIC_TRACE) fs.appendFileSync(process.env.AGENTSTUDIO_SYNTHETIC_TRACE, `${JSON.stringify({ request, model, provider, thinking, context })}\n`);
    emit({ type: 'agent_start' }); emit({ type: 'message_start', message: { role: 'assistant' } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'SYNTHETIC_PRIVATE_THINKING_MUST_NOT_REACH_UI' } });
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    await pause(130);
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '合成回复的第一段已经出现。\n\n' } });
    if (request.includes('FIRST') && process.env.AGENTSTUDIO_SYNTHETIC_RELEASE) {
      const deadline = Date.now() + 90000;
      while (!fs.existsSync(process.env.AGENTSTUDIO_SYNTHETIC_RELEASE)) { if (Date.now() > deadline) process.exit(2); await pause(30); }
    }
    await pause(130);
    const firstSeen = context.messages.some(message => message.role === 'assistant' && message.text.includes('FIRST_REPLY'));
    const text = request.includes('FIRST') ? 'FIRST_REPLY\n\n## 一段更清楚的回答\n\n这份内容来自合成 Pi，没有调用真实模型。\n\n- 连续追问会排队\n- 回复跟随原问题\n\n> 保留上下文，也保留你的节奏。\n\n```ts\nconst synthetic = true;\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 模型 | 已固定 |' : `合成回复 ${request}，模型 ${model}。\n\nSECOND_REPLY · 已看到前一条回答：${firstSeen}`;
    emit({ type: 'message_end', message: { role: 'assistant', provider, model, stopReason: request.includes('FAIL_ZERO') ? 'error' : 'stop', content: [{ type: 'text', text }] } });
    emit({ type: 'agent_end' }); emit({ type: 'agent_settled' });
  });
}
