import assert from 'node:assert/strict';
import test from 'node:test';
import { requestDecision } from '../src/plugin/social/api.mjs';
import { isAllowed, parseDecision, settings, SocialEngine } from '../src/plugin/social/engine.mjs';

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
  const config = { enable: true, groups: [100, 200], privateUsers: [123],
    debounceMs: 100, decisionIntervalMs: 1000, replyIntervalMs: 1000, ...options.config };
  const engine = new SocialEngine({
    getConfig: () => config,
    request: async messages => {
      calls.push(messages);
      return options.request ? options.request(messages) : silent;
    },
    send: async (ctx, message) => {
      sent.push({ context: ctx, message });
      return options.send ? options.send(ctx, message) : { retcode: 0, data: { message_id: 900 } };
    },
    allowed: options.allowed,
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
  return { config, engine, calls, sent, errors, timers, next, advance: ms => { time += ms; } };
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
    const h = harness({ request });
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
