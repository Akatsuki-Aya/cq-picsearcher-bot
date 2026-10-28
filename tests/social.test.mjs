import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requestDecision } from '../src/plugin/social/api.mjs';
import { errorDetails, writeDiagnostic } from '../src/plugin/social/diagnostics.mjs';
import { isAllowed, parseDecision, settings, SocialEngine } from '../src/plugin/social/engine.mjs';
import { loadPersona } from '../src/plugin/social/persona.mjs';

const context = (overrides = {}) => ({
  message_type: 'group', group_id: 100, user_id: 123, self_id: 999,
  message_id: 1, message: '今天聊什么？', sender: { nickname: '小明' }, ...overrides,
});
const speak = (overrides = {}) => JSON.stringify({ action: 'speak', text: '聊聊电影吧', ...overrides });
const silent = JSON.stringify({ action: 'silent' });

function harness(options = {}) {
  let time = 100000;
  let id = 0;
  const timers = new Map();
  const calls = [];
  const sent = [];
  const errors = [];
  const traces = [];
  const config = { enable: true, groups: [100, 200], privateUsers: [123],
    debounceMs: 100, decisionIntervalMs: 1000, replyIntervalMs: 1000, ...options.config };
  const engine = new SocialEngine({
    getConfig: () => config,
    getPersona: options.getPersona,
    request: async messages => {
      calls.push(messages);
      return options.request ? options.request(messages) : silent;
    },
    send: async (ctx, message) => {
      sent.push({ context: ctx, message });
      return options.send ? options.send(ctx, message) : { retcode: 0, data: { message_id: 900 } };
    },
    allowed: options.allowed,
    trace: (ctx, event, details) => traces.push({ event, ...details }),
    log: (...args) => errors.push(args),
    now: () => time,
    setTimer: (callback, delay) => {
      timers.set(++id, { callback, due: time + delay });
      return id;
    },
    clearTimer: timer => timers.delete(timer),
  });
  const next = async () => {
    const entry = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
    assert.ok(entry, 'expected a scheduled callback');
    timers.delete(entry[0]);
    time = Math.max(time, entry[1].due);
    await entry[1].callback();
  };
  return { config, engine, calls, sent, errors, traces, timers, next, advance: ms => { time += ms; } };
}

test('only explicitly allowed conversations, never self messages or guilds', () => {
  const cfg = settings({ enable: true, groups: ['100'], privateUsers: [123] });
  assert.equal(isAllowed(context(), cfg), true);
  assert.equal(isAllowed(context({ group_id: 200 }), cfg), false);
  assert.equal(isAllowed(context({ user_id: 999 }), cfg), false);
  assert.equal(isAllowed(context({ message_type: 'guild' }), cfg), false);
  assert.equal(isAllowed(context({ message_type: 'private' }), cfg), true);
  assert.equal(isAllowed(context(), settings()), false);
});

test('coalesces bursts, deduplicates message events and preserves identities', async () => {
  const h = harness();
  h.engine.observe(context());
  h.engine.observe(context());
  h.engine.observe(context({ message_id: 2, user_id: 456, message: '我还没说完，' }));
  assert.equal(h.timers.size, 1);
  await h.next();
  const snapshot = JSON.parse(h.calls[0][1].content);
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.messages[1].userId, '456');
  assert.equal(snapshot.selfId, '999');
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 0);
});

test('model selects an earlier participant and quote; raw CQ in text is escaped', async () => {
  const h = harness({ request: () => speak({ targetUserId: '123', replyToMessageId: '1', text: '[CQ:at,qq=all]好呀' }) });
  h.engine.observe(context());
  h.engine.observe(context({ user_id: 456, message_id: 2 }));
  await h.next();
  await h.next();
  assert.equal(h.sent[0].context.group_id, 100);
  assert.equal(h.sent[0].message, '[CQ:reply,id=1][CQ:at,qq=123]&#91;CQ:at,qq=all&#93;好呀');
  assert.equal(h.engine.sessions.get('group:100').history.at(-1).isSelf, true);
});

test('unknown recipients and fabricated quote IDs fail closed', () => {
  const history = [{ userId: '123', messageId: '1', isSelf: false }];
  assert.throws(() => parseDecision(speak({ targetUserId: '777' }), history, settings()));
  assert.throws(() => parseDecision(speak({ replyToMessageId: '777' }), history, settings()));
  assert.throws(() => parseDecision('not json', history, settings()));
  assert.throws(() => parseDecision('{"action":"other"}', history, settings()));
  assert.equal(parseDecision('```json\n{"action":"silent"}\n```', history, settings()).action, 'silent');
});

test('wait wakes without a new message and may initiate speech', async () => {
  let count = 0;
  const h = harness({ request: () => ++count === 1 ? '{"action":"wait","delaySeconds":5}' : speak() });
  h.engine.observe(context());
  await h.next();
  await h.next();
  assert.equal(JSON.parse(h.calls[1][1].content).secondsSinceLastMessage, 5);
  await h.next();
  assert.equal(h.sent.length, 1);
  assert.equal(h.timers.size, 0);
});

test('bounded automatic wakeups prevent an infinite idle API loop', async () => {
  const h = harness({ config: { maxAutoTurns: 2 }, request: () => '{"action":"wait","delaySeconds":1}' });
  h.engine.observe(context());
  await h.next();
  await h.next();
  await h.next();
  assert.equal(h.calls.length, 3);
  assert.equal(h.timers.size, 0);
});

test('new input cancels delayed speech and causes a fresh decision', async () => {
  let count = 0;
  const h = harness({ request: () => ++count === 1 ? speak({ delaySeconds: 20 }) : silent });
  h.engine.observe(context());
  await h.next();
  h.engine.observe(context({ message_id: 2, message: '不用回了' }));
  await h.next(); // Too soon to call the API again.
  await h.next();
  assert.equal(h.calls.length, 2);
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 0);
});

test('messages arriving during inference are retained and stale output is discarded', async () => {
  let resolve;
  const h = harness({ request: () => new Promise(done => { resolve = done; }) });
  h.engine.observe(context());
  const pending = h.next();
  h.engine.observe(context({ message_id: 2, message: '话题变了' }));
  assert.equal(h.timers.size, 0);
  resolve(speak());
  await pending;
  assert.equal(h.sent.length, 0);
  assert.equal(h.engine.sessions.get('group:100').history.length, 2);
  assert.equal(h.timers.size, 1);
});

test('config reload invalidates in-flight decisions and clears scheduled sends', async () => {
  let resolve;
  const h = harness({ request: () => new Promise(done => { resolve = done; }) });
  h.engine.observe(context());
  const pending = h.next();
  h.engine.reset();
  resolve(speak());
  await pending;
  assert.equal(h.timers.size, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.engine.sessions.size, 0);
});

test('revoked permissions and disabled mode cancel an already planned send', async () => {
  let allowed = true;
  const h = harness({ request: () => speak(), allowed: () => allowed });
  h.engine.observe(context());
  await h.next();
  allowed = false;
  await h.next();
  assert.equal(h.sent.length, 0);
  allowed = true;
  h.config.enable = false;
  assert.equal(h.engine.observe(context({ message_id: 2 })), false);
});

test('session history does not leak across groups or private chats', async () => {
  const h = harness();
  h.engine.observe(context({ message: '群 A 的话' }));
  h.engine.observe(context({ group_id: 200, message: '群 B 的话' }));
  h.engine.observe(context({ message_type: 'private', message: '私聊的话' }));
  await h.next();
  await h.next();
  await h.next();
  assert.deepEqual(h.calls.map(m => JSON.parse(m[1].content).messages.map(m => m.text)), [
    ['群 A 的话'], ['群 B 的话'], ['私聊的话'],
  ]);
});

test('global decision and reply budgets apply across conversations', async () => {
  const h = harness({ config: { dailyDecisionLimit: 1 }, request: () => speak() });
  h.engine.observe(context());
  h.engine.observe(context({ group_id: 200 }));
  while (h.timers.size) await h.next();
  assert.equal(h.calls.length, 1);
  assert.equal(h.sent.length, 1);

  const replies = harness({ config: { dailyReplyLimit: 1 }, request: () => speak({ delaySeconds: 1 }) });
  replies.engine.observe(context());
  replies.engine.observe(context({ group_id: 200 }));
  while (replies.timers.size) await replies.next();
  assert.equal(replies.calls.length, 2);
  assert.equal(replies.sent.length, 1);
});

test('timeout or invalid model output stays silent without automatic retry storms', async () => {
  for (const request of [() => { throw new Error('timeout'); }, () => 'invalid']) {
    const h = harness({ request, config: { jsonRetries: 0, logFailedResponses: false } });
    h.engine.observe(context());
    await h.next();
    assert.equal(h.sent.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.errors.length, 1);
  }
});

test('failed sends are not inserted as successful assistant history', async () => {
  const h = harness({ request: () => speak(), send: () => ({ retcode: 100 }) });
  h.engine.observe(context());
  await h.next();
  await h.next();
  assert.equal(h.engine.sessions.get('group:100').history.length, 1);
  assert.equal(h.errors.length, 1);
});

test('messages received during QQ delivery wait for send completion and retain assistant history', async () => {
  let resolve;
  const h = harness({ request: () => speak(), send: () => new Promise(done => { resolve = done; }) });
  h.engine.observe(context());
  await h.next();
  const pending = h.next();
  h.engine.observe(context({ message_id: 2 }));
  assert.equal(h.timers.size, 0);
  resolve({ retcode: 0, data: { message_id: 900 } });
  await pending;
  assert.equal(h.timers.size, 1);
  assert.equal(h.engine.sessions.get('group:100').history.length, 3);
});

test('expired conversations cannot send delayed replies', async () => {
  const h = harness({ config: { idleExpireMs: 1000 }, request: () => speak({ delaySeconds: 2 }) });
  h.engine.observe(context());
  await h.next();
  await h.next();
  assert.equal(h.sent.length, 0);
});

test('history and per-message lengths are bounded', async () => {
  const h = harness({ config: { contextMessages: 2, messageMaxChars: 100 } });
  for (let i = 1; i <= 10; i++) h.engine.observe(context({ message_id: i, message: 'a'.repeat(200) }));
  await h.next();
  const messages = JSON.parse(h.calls[0][1].content).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].messageId, '9');
  assert.equal(messages[0].text.length, 100);
});

test('HTTP adapter uses configured compatible endpoint and forces non-streamed decisions', async () => {
  let args;
  const post = async (...value) => {
    args = value;
    return { data: { choices: [{ message: { content: silent } }] } };
  };
  const messages = [{ role: 'user', content: 'test' }];
  assert.equal(await requestDecision(post, {
    apiKey: 'test-key', model: 'test-model', customChatAPI: 'https://example.invalid/v1/chat/completions',
    organization: 'org-test', maxTokens: 512,
    additionParams: { temperature: 0.8, stream: true, n: 10, messages: [], tools: [], response_format: {} },
  }, { requestTimeoutMs: 5000 }, messages), silent);
  assert.equal(args[0], 'https://example.invalid/v1/chat/completions');
  assert.equal(args[1].model, 'test-model');
  assert.equal(args[1].max_tokens, 512);
  assert.equal(args[1].stream, false);
  assert.equal(args[1].n, 1);
  assert.equal(args[1].temperature, 0.8);
  assert.equal(args[1].messages, messages);
  assert.equal(args[1].tools, undefined);
  assert.equal(args[2].headers.Authorization, 'Bearer test-key');
  assert.equal(args[2].headers['OpenAI-Organization'], 'org-test');
  assert.equal(args[2].timeout, 5000);
});

test('HTTP adapter rejects missing keys, provider errors and empty content', async () => {
  await assert.rejects(requestDecision(() => assert.fail('should not call HTTP'), {}, {}, []));
  for (const data of [{ error: { message: 'denied' } }, { choices: [] }]) {
    await assert.rejects(requestDecision(async () => ({ data }), { apiKey: 'test' }, {}, []));
  }
});

test('reply cooldown delays the next decision even when more messages arrive', async () => {
  const h = harness({ config: { replyIntervalMs: 5000 }, request: () => speak() });
  h.engine.observe(context());
  await h.next();
  await h.next();
  h.engine.observe(context({ message_id: 2 }));
  await h.next();
  assert.equal(h.calls.length, 1);
  await h.next();
  assert.equal(h.calls.length, 2);
  assert.equal(JSON.parse(h.calls[1][1].content).secondsSinceLastMessage, 5);
});

test('daily budget renews on a later date without resetting the engine', async () => {
  const h = harness({ config: { dailyDecisionLimit: 1 } });
  h.engine.observe(context());
  await h.next();
  h.advance(86400000);
  h.engine.observe(context({ message_id: 2 }));
  await h.next();
  assert.equal(h.calls.length, 2);
});

test('private replies never add group mentions or quotes', async () => {
  const h = harness({ request: () => speak({ targetUserId: '123', replyToMessageId: '1' }) });
  h.engine.observe(context({ message_type: 'private' }));
  await h.next();
  await h.next();
  assert.equal(h.sent[0].message, '聊聊电影吧');
  assert.equal(h.sent[0].context.user_id, 123);
});

test('group reset cancels delayed speech and preserves other sessions and daily usage', async () => {
  const h = harness({ request: () => speak({ delaySeconds: 20 }) });
  h.engine.observe(context());
  await h.next();
  const usage = { ...h.engine.usage };
  h.engine.observe(context({ group_id: 200 }));
  h.engine.observe(context({ message_type: 'private' }));
  assert.equal(h.engine.resetGroup('100'), true);
  assert.equal(h.engine.sessions.has('group:100'), false);
  assert.equal(h.engine.sessions.has('group:200'), true);
  assert.equal(h.engine.sessions.has('private:123'), true);
  assert.deepEqual(h.engine.usage, usage);
  assert.equal(h.timers.size, 2);
  while (h.timers.size) await h.next();
  assert.equal(h.sent.some(item => item.context.message_type === 'group' && item.context.group_id === 100), false);
  assert.equal(h.engine.resetGroup(100), false);
});

test('group reset cancels automatic wakeups', async () => {
  const h = harness({ request: () => '{"action":"wait","delaySeconds":10}' });
  h.engine.observe(context());
  await h.next();
  assert.equal(h.timers.size, 1);
  h.engine.resetGroup(100);
  assert.equal(h.timers.size, 0);
});

test('group reset invalidates in-flight results even after a new session starts', async () => {
  let resolve;
  let count = 0;
  const h = harness({ request: () => ++count === 1 ? new Promise(done => { resolve = done; }) : silent });
  h.engine.observe(context({ message: '旧话题' }));
  const pending = h.next();
  h.engine.resetGroup(100);
  h.engine.observe(context({ message_id: 2, message: '新的开始' }));
  resolve(speak());
  await pending;
  await h.next();
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(JSON.parse(h.calls[1][1].content).messages.map(m => m.text), ['新的开始']);
});

test('persona Markdown supports UTF-8, live edits, and fallback for missing or empty files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cqps-persona-'));
  const personaFile = join(directory, '人设.md');
  const errors = [];
  const config = { personaFile, persona: '备用人设' };
  try {
    assert.equal(await loadPersona({ persona: '原有配置' }), '原有配置');
    assert.equal(await loadPersona(config, message => errors.push(message)), '备用人设');
    await writeFile(personaFile, '\uFEFF# 测试人设\n\n- 轻松聊天\n', 'utf8');
    assert.equal(await loadPersona(config), '# 测试人设\n\n- 轻松聊天');
    await writeFile(personaFile, '# 修改后的人设', 'utf8');
    assert.equal(await loadPersona(config), '# 修改后的人设');
    await writeFile(personaFile, ' \n ', 'utf8');
    assert.equal(await loadPersona(config, message => errors.push(message)), '备用人设');
    assert.equal(errors.length, 2);
    assert.equal(await loadPersona({ personaFile: '', persona: '只用文本' }), '只用文本');
    assert.match(await loadPersona({ personaFile: 'roles/persona.md' }), /大肥鱼/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('resolved Markdown replaces inline persona in the model system prompt', async () => {
  const h = harness({ config: { persona: 'INLINE_ONLY' }, getPersona: async () => '# FILE_PERSONA' });
  h.engine.observe(context());
  await h.next();
  assert.match(h.calls[0][0].content, /# FILE_PERSONA/);
  assert.equal(h.calls[0][0].content.includes('INLINE_ONLY'), false);
  assert.equal(h.config.persona, 'INLINE_ONLY');
});

test('reset while loading persona cannot start an obsolete model request', async () => {
  let resolve;
  const h = harness({ getPersona: () => new Promise(done => { resolve = done; }) });
  h.engine.observe(context());
  const pending = h.next();
  h.engine.resetGroup(100);
  resolve('人设');
  await pending;
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
});

test('diagnostics distinguish model silence from quota blocking and filtering', async () => {
  const h = harness({ config: { dailyDecisionLimit: 1 } });
  h.engine.observe(context({ group_id: 333 }));
  assert.ok(h.traces.some(t => t.event === 'filtered' && t.reason === 'group_not_enabled'));
  h.engine.observe(context());
  await h.next();
  assert.ok(h.traces.some(t => t.event === 'decision' && t.action === 'silent'));
  h.engine.observe(context({ message_id: 2 }));
  while (h.timers.size) await h.next();
  assert.ok(h.traces.some(t => t.event === 'quota_reached' && t.decisions === 1 && t.decisionLimit === 1));
  assert.equal(h.calls.length, 1);
});

test('diagnostics explain stale results and report the pending request phase', async () => {
  let resolve;
  const h = harness({ request: () => new Promise(done => { resolve = done; }) });
  h.engine.observe(context());
  const pending = h.next();
  h.advance(5000);
  h.engine.observe(context({ message_id: 2 }));
  assert.ok(h.traces.some(t => t.event === 'busy' && t.phase === 'request' && t.busyForMs === 5000));
  resolve(speak());
  await pending;
  assert.ok(h.traces.some(t => t.event === 'discarded' && t.reason === 'new_messages' && t.stage === 'request'));
});

test('diagnostics identify a stuck send and a failed QQ retcode', async () => {
  let resolve;
  const h = harness({ request: () => speak(), send: () => new Promise(done => { resolve = done; }) });
  h.engine.observe(context());
  await h.next();
  const pending = h.next();
  h.advance(60000);
  h.engine.observe(context({ message_id: 2 }));
  assert.ok(h.traces.some(t => t.event === 'busy' && t.phase === 'send' && t.busyForMs === 60000));
  resolve({ retcode: 100, message: 'PRIVATE_SERVER_MESSAGE' });
  await pending;
  assert.ok(h.traces.some(t => t.event === 'send_finished' && t.success === false && t.retcode === 100));
  assert.equal(JSON.stringify(h.traces).includes('PRIVATE_SERVER_MESSAGE'), false);
});

test('diagnostics exclude chat content, raw exceptions, request credentials and model responses', async () => {
  const h = harness({ request: () => {
    const error = new Error('SECRET_API_KEY and CHAT_CONTENT');
    error.code = 'ECONNABORTED';
    error.response = { status: 429, data: 'SECRET_RESPONSE' };
    error.config = { headers: { Authorization: 'SECRET_API_KEY' } };
    throw error;
  } });
  h.engine.observe(context({ message: 'CHAT_CONTENT', sender: { nickname: 'SECRET_NAME' } }));
  await h.next();
  const text = JSON.stringify([h.traces, h.errors]);
  for (const secret of ['SECRET_API_KEY', 'CHAT_CONTENT', 'SECRET_RESPONSE', 'SECRET_NAME']) {
    assert.equal(text.includes(secret), false);
  }
  assert.ok(h.traces.some(t => t.event === 'decision_failed' && t.code === 'ECONNABORTED' && t.httpStatus === 429));
  assert.equal(errorDetails(new Error('目标用户不在当前会话上下文中')).reason, 'unknown_target');
});

test('diagnostic output can be disabled independently and carries only correlation metadata', () => {
  const output = [];
  const write = (...args) => output.push(args);
  const ctx = context({ message: 'SECRET_TEXT', sender: { nickname: 'SECRET_NAME' } });
  writeDiagnostic(false, ctx, 'received', {}, write);
  assert.equal(output.length, 0);
  writeDiagnostic(true, ctx, 'received', {}, write);
  const record = JSON.parse(output[0][1]);
  assert.equal(record.session, 'group:100');
  assert.equal(record.messageId, '1');
  assert.equal(record.event, 'received');
  assert.equal(JSON.stringify(output).includes('SECRET'), false);
});

test('invalid JSON logs the model result and retries with format correction before sending', async () => {
  let count = 0;
  const broken = '我在呢\n{"action":"speak"';
  const h = harness({ request: () => ++count === 1 ? broken : speak() });
  h.engine.observe(context());
  await h.next();
  await h.next();
  assert.equal(h.calls.length, 2);
  assert.equal(h.engine.usage.decisions, 2);
  assert.equal(h.sent.length, 1);
  assert.match(h.calls[1].at(-1).content, /完整合法的 JSON/);
  assert.equal(h.errors.length, 1);
  const logged = JSON.parse(h.errors[0][1]);
  assert.equal(logged.response, broken);
  assert.equal(logged.reason, 'invalid_json');
  assert.equal(logged.attempt, 1);
  assert.ok(h.traces.some(t => t.event === 'json_retry' && t.attempt === 2));
});

test('JSON retries are bounded and every invalid response is logged', async () => {
  const h = harness({ config: { jsonRetries: 2 }, request: () => '{broken' });
  h.engine.observe(context());
  await h.next();
  assert.equal(h.calls.length, 3);
  assert.equal(h.errors.filter(args => args[0] === '[social] model_response_error').length, 3);
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.engine.sessions.get('group:100').busy, false);
});

test('retry respects global quotas and can disable raw response logging separately', async () => {
  const h = harness({ config: { dailyDecisionLimit: 1, logFailedResponses: false }, request: () => 'invalid' });
  h.engine.observe(context());
  await h.next();
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors.length, 0);
  assert.ok(h.traces.some(t => t.event === 'quota_reached' && t.stage === 'retry'));
});

test('new messages invalidate an in-flight format retry and keep the new input queued', async () => {
  let count = 0;
  let resolve;
  let started;
  const retryStarted = new Promise(done => { started = done; });
  const h = harness({ request: () => {
    if (++count === 1) return 'invalid';
    started();
    return new Promise(done => { resolve = done; });
  } });
  h.engine.observe(context());
  const pending = h.next();
  await retryStarted;
  h.engine.observe(context({ message_id: 2, message: '新话题' }));
  resolve(speak());
  await pending;
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 1);
  assert.ok(h.traces.some(t => t.event === 'discarded' && t.reason === 'new_messages'));
});

test('reset before a malformed result returns prevents retries', async () => {
  let resolve;
  const h = harness({ request: () => new Promise(done => { resolve = done; }) });
  h.engine.observe(context());
  const pending = h.next();
  h.engine.resetGroup(100);
  resolve('invalid');
  await pending;
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test('semantic validation failures log the result without retrying or sending it', async () => {
  const response = speak({ targetUserId: '777' });
  const h = harness({ request: () => response });
  h.engine.observe(context());
  await h.next();
  assert.equal(h.calls.length, 1);
  assert.equal(h.sent.length, 0);
  assert.equal(JSON.parse(h.errors[0][1]).response, response);
  assert.ok(h.traces.some(t => t.event === 'response_invalid' && t.reason === 'unknown_target' && !t.retryable));
});
