/**
 * 续聊窗口测试：状态机、判定结果解析、模型路由、失败策略、出站记录。
 *
 * 这里的每条分支都对应线上一种「说错话/不说话」的场景：
 * 误判会把无关话题吸进来，漏判会让群里突然冷场，所以窗口过期、失败策略、
 * @ 快通道都要单独钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  createBurstBatcher,
  createFloodGate,
  createFollowUpState,
  createGuard,
  createStickerSender,
  createTurnQueue,
  buildFollowUpJudgeInput,
  buildFollowUpSelectInput,
  buildJudgeExamplesPrompt,
  guessStickerMood,
  guessStickerMoodFromItems,
  installOutboundRecorder,
  isAckMessage,
  listStickers,
  parseFollowUpDecision,
  parseFollowUpSelection,
  parseFollowUpVerdict,
  resolveFollowUpRoute,
  runFollowUpJudge,
  runFollowUpSelectJudge,
  runFollowUpTopic,
  sanitizeConfigPatch,
} from './index.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** 可控时钟：所有窗口过期判断都靠它，不 sleep。 */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

function fakeLlm(reply) {
  return {
    calls: 0,
    async *stream(options) {
      this.calls += 1;
      assert.equal(typeof options.provider, 'string');
      assert.equal(typeof options.model, 'string');
      assert.ok(Array.isArray(options.messages) && options.messages.length === 1);
      if (options.signal?.aborted) throw new Error('aborted');
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

// ────────────────────────── 窗口状态机 ──────────────────────────

test('窗口：open → touch 续期 → 超时惰性关闭', () => {
  const c = clock();
  const state = createFollowUpState({ now: c.now, windowMs: 10 * 60 * 1000 });

  assert.equal(state.get('g1'), null);
  const opened = state.open('g1', { trigger: 'keyword:大肥鱼' });
  assert.equal(opened.turns, 0);
  assert.equal(state.size(), 1);

  c.advance(9 * 60 * 1000);
  assert.deepEqual(state.touch('g1'), { turns: 1, closed: false });
  c.advance(9 * 60 * 1000); // 距上次相关 9 分钟，还没过期
  assert.ok(state.get('g1'));
  c.advance(2 * 60 * 1000); // 距上次相关 11 分钟
  assert.equal(state.get('g1'), null);
  assert.equal(state.size(), 0);
});

test('窗口：maxTurns 达到上限时本轮放行随后关窗', () => {
  const c = clock();
  const state = createFollowUpState({ now: c.now, windowMs: 600_000, maxTurns: 2 });
  state.open('g1');
  assert.deepEqual(state.touch('g1'), { turns: 1, closed: false });
  assert.deepEqual(state.touch('g1'), { turns: 2, closed: true });
  assert.equal(state.get('g1'), null);
});

test('窗口：maxTurns=0 表示不限条数', () => {
  const c = clock();
  const state = createFollowUpState({ now: c.now, maxTurns: 0 });
  state.open('g1');
  for (let i = 1; i <= 50; i += 1) {
    assert.equal(state.touch('g1').closed, false);
  }
  assert.equal(state.get('g1').turns, 50);
});

test('窗口：remember 只在开窗时记录，且裁剪条数与单条长度', () => {
  const c = clock();
  const state = createFollowUpState({ now: c.now, recentLimit: 3 });
  state.remember('g1', { role: 'user', text: '窗口没开，丢了' });
  assert.equal(state.recent('g1').length, 0);

  state.open('g1');
  state.remember('g1', { role: 'user', name: '小明', text: `  a   b\n${'字'.repeat(400)}  ` });
  const [entry] = state.recent('g1');
  assert.equal(entry.name, '小明');
  assert.ok(entry.text.length <= 240);
  assert.ok(!entry.text.includes('\n'));
  assert.ok(entry.text.startsWith('a b'));

  for (let i = 0; i < 5; i += 1) state.remember('g1', { role: 'user', text: `第${i}条` });
  const recent = state.recent('g1');
  assert.equal(recent.length, 3);
  assert.equal(recent.at(-1).text, '第4条');
});

test('窗口：stats / prune / clear', () => {
  const c = clock();
  const state = createFollowUpState({ now: c.now, windowMs: 600_000 });
  state.open('g1');
  state.touch('g1');
  c.advance(60_000);
  const stats = state.stats('g1');
  assert.equal(stats.turns, 1);
  assert.equal(stats.remainingMs, 9 * 60 * 1000);

  state.open('g2');
  state.clear();
  assert.equal(state.size(), 0);
  assert.equal(state.get('g2'), null);
});

// ────────────────────────── 判定文本处理 ──────────────────────────

test('parseFollowUpVerdict：只认明确的 0/1', () => {
  assert.equal(parseFollowUpVerdict('1'), true);
  assert.equal(parseFollowUpVerdict('0'), false);
  assert.equal(parseFollowUpVerdict('```\n1\n```'), true);
  assert.equal(parseFollowUpVerdict(' 1. 是的'), true);
  assert.equal(parseFollowUpVerdict('0.'), false);
  assert.equal(parseFollowUpVerdict('10'), null);
  assert.equal(parseFollowUpVerdict('100'), null);
  assert.equal(parseFollowUpVerdict(''), null);
  assert.equal(parseFollowUpVerdict('不知道'), null);
  assert.equal(parseFollowUpVerdict('0 或 1'), null);
});

test('parseFollowUpDecision：相关 + 形态；场景内只续期；无关静默', () => {
  assert.deepEqual(parseFollowUpDecision('2m'), {
    action: 'reply',
    verdict: true,
    mode: 'merge',
    selected: null,
  });
  assert.equal(parseFollowUpDecision('2e').mode, 'each');
  assert.equal(parseFollowUpDecision('```\n2e\n```').action, 'reply');
  assert.equal(parseFollowUpDecision('1').action, 'ack');
  assert.equal(parseFollowUpDecision('0').action, 'ignore');
  // 纯编号是旧版输出：当成「相关但逐条」，不猜合并
  assert.equal(parseFollowUpDecision('2').mode, 'each');
  // 数字串不能被当成 1 或 0
  assert.equal(parseFollowUpDecision('10'), null);
  assert.equal(parseFollowUpDecision('0 或 1'), null);
  assert.equal(parseFollowUpDecision('我觉得相关'), null);

  const picked = parseFollowUpDecision('m:1,3', 4);
  assert.deepEqual(picked, { action: 'reply', verdict: true, mode: 'merge', selected: [1, 3] });
  assert.deepEqual(parseFollowUpDecision('e：2，4', 4).selected, [2, 4]);
  assert.equal(parseFollowUpDecision('0', 3).action, 'ignore');
});

test('isAckMessage：只把短附和当场景反应，问句和正经消息不算', () => {
  assert.equal(isAckMessage('哈哈哈'), true);
  assert.equal(isAckMessage('笑死我了'), true);
  assert.equal(isAckMessage('确实'), true);
  assert.equal(isAckMessage('+1'), true);
  assert.equal(isAckMessage('收到'), true);
  assert.equal(isAckMessage('嗯嗯'), true);
  assert.equal(isAckMessage('🤣🤣🤣'), true);
  assert.equal(isAckMessage('哈哈哈哈然后呢？'), false);
  assert.equal(isAckMessage('这个报错怎么修'), false);
  assert.equal(isAckMessage('好的，那明天下午三点开会'), false);
  assert.equal(isAckMessage(''), false);
});

test('buildFollowUpJudgeInput：带最近发言、发送者与引用标记', () => {
  const text = buildFollowUpJudgeInput({
    recent: [
      { role: 'user', name: '小明', text: '这个报错怎么办' },
      { role: 'bot', name: '机器人', text: '先看日志' },
    ],
    message: '日志在哪',
    sender: '小红',
    quotedBot: true,
  });
  assert.ok(text.includes('[最近群聊]'));
  // 每条带「距上一条多少秒」，让模型能看出隔了多久
  assert.ok(text.includes('小明 (+0s): 这个报错怎么办'));
  assert.ok(text.includes('机器人 (+0s): 先看日志'));
  assert.ok(text.includes('[新消息] （引用了机器人的发言）小红: 日志在哪'));
});

test('buildFollowUpJudgeInput：超长时保留末尾（新消息不能丢）', () => {
  const text = buildFollowUpJudgeInput({
    recent: Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      name: '刷屏',
      text: `${i}-${'背'.repeat(200)}`,
    })),
    message: '末尾这句一定要在',
    sender: '小明',
  });
  assert.ok(text.length <= 3000);
  assert.ok(text.endsWith('末尾这句一定要在'));
});

test('buildFollowUpJudgeInput：话题锚点 + 相对时间 + 已忽略标记', () => {
  const text = buildFollowUpJudgeInput({
    recent: [
      { role: 'user', name: '小明', text: '这个报错怎么办', at: 1_000 },
      { role: 'bot', text: '先看日志', at: 13_000 },
      { role: 'user', name: '老王', text: '晚上吃啥', at: 43_000, ignored: true },
    ],
    message: '日志在哪',
    topic: '报错排查',
  });
  assert.ok(text.startsWith('[当前话题] 报错排查'));
  assert.ok(text.includes('小明 (+0s): 这个报错怎么办'));
  assert.ok(text.includes('机器人 (+12s): 先看日志'));
  assert.ok(text.includes('[已忽略] 老王 (+30s): 晚上吃啥'));
});

test('buildFollowUpJudgeInput：丢旧消息时保住机器人最后一句', () => {
  const recent = [
    { role: 'bot', text: '这条是机器人的话', at: 1_000 },
    ...Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      name: '刷屏',
      text: `${i}-${'背'.repeat(200)}`,
      at: 2_000 + i,
    })),
  ];
  const text = buildFollowUpJudgeInput({ recent, message: '末尾这句' });
  assert.ok(text.includes('[机器人最后一句] 这条是机器人的话'));
  assert.ok(text.endsWith('末尾这句'));
  assert.ok(text.length <= 3000 + 40); // pin 行可能把结果顶出一点点，但不会无界
});

test('buildJudgeExamplesPrompt：空输入不产生提示，非空按口径列出', () => {
  assert.equal(buildJudgeExamplesPrompt([]), '');
  assert.equal(buildJudgeExamplesPrompt(undefined), '');
  const text = buildJudgeExamplesPrompt([
    { text: '这不算跑题', verdict: 'reply' },
    { text: '广告别接', verdict: 'ignore' },
  ]);
  assert.ok(text.includes('[人工纠正过的口径'));
  assert.ok(text.includes('「这不算跑题」→ 2（该回）'));
  assert.ok(text.includes('「广告别接」→ 0（不该回）'));
});

test('runFollowUpTopic：去掉引号空白，只留一句话题', async () => {
  const topic = await runFollowUpTopic({
    llm: fakeLlm('  「报错排查」  '),
    route: { provider: 'p', model: 'm' },
  });
  assert.equal(topic, '报错排查');
  await assert.rejects(
    runFollowUpTopic({ llm: fakeLlm('   '), route: { provider: 'p', model: 'm' } }),
    /话题模型返回空/,
  );
});

// ────────────────────────── 模型路由 ──────────────────────────

test('resolveFollowUpRoute：显式 > 宿主 > 半配置不猜', () => {
  const host = () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  const base = { followUpJudgeProvider: '', followUpJudgeModel: '' };

  assert.deepEqual(resolveFollowUpRoute({ ...base }, host), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  });
  assert.deepEqual(
    resolveFollowUpRoute({ ...base, followUpJudgeProvider: 'p', followUpJudgeModel: 'm' }, host),
    { provider: 'p', model: 'm' },
  );
  // 只填一半：只有和宿主对得上才补齐，否则宁可判不了也不乱调
  assert.deepEqual(
    resolveFollowUpRoute({ ...base, followUpJudgeProvider: 'deepseek-official' }, host),
    { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  );
  assert.equal(resolveFollowUpRoute({ ...base, followUpJudgeProvider: 'other' }, host), null);
  assert.deepEqual(
    resolveFollowUpRoute({ ...base, followUpJudgeModel: 'deepseek-v4-flash' }, host),
    { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  );
  assert.equal(resolveFollowUpRoute({ ...base, followUpJudgeModel: 'other' }, host), null);
  assert.equal(resolveFollowUpRoute({ ...base }, () => null), null);
});

test('resolveFollowUpRoute：带上宿主的推理档位，半配置补齐时也保留', () => {
  const host = () => ({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  });
  const base = { followUpJudgeProvider: '', followUpJudgeModel: '' };
  assert.deepEqual(resolveFollowUpRoute({ ...base }, host), {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  });
  assert.deepEqual(
    resolveFollowUpRoute({ ...base, followUpJudgeProvider: 'deepseek-official' }, host),
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  );
});

// ────────────────────────── 判定调用 ──────────────────────────

test('runFollowUpJudge：把推理档位透传给 llm.stream', async () => {
  let seen = null;
  const llm = {
    async *stream(options) {
      seen = options;
      yield { type: 'text-delta', index: 0, text: '1' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  await runFollowUpJudge({
    llm,
    route: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    message: '继续',
    logger: silent,
  });
  assert.equal(seen.reasoningEffort, 'high');
  assert.equal(seen.provider, 'p');
  assert.equal(seen.model, 'm');
  // deepseek-flash 会先写 reasoning_content；实测 max_tokens=64 时正文为空、解析必失败。
  assert.ok(seen.maxTokens >= 512, `maxTokens 太小会只剩思考：${seen.maxTokens}`);
});

test('runFollowUpJudge：2m/2e/1/0 解析成回复形态', async () => {
  const run = (reply) =>
    runFollowUpJudge({
      llm: fakeLlm(reply),
      route: { provider: 'p', model: 'm' },
      recent: [],
      message: '继续',
      logger: silent,
    });

  const merge = await run('2m');
  assert.equal(merge.action, 'reply');
  assert.equal(merge.verdict, true);
  assert.equal(merge.mode, 'merge');

  const each = await run('2e');
  assert.equal(each.mode, 'each');
  assert.equal(each.verdict, true);

  // 1 = 场景内的附和/反应：只续期，不回复
  const ack = await run('1');
  assert.equal(ack.action, 'ack');
  assert.equal(ack.verdict, false);

  const unrelated = await run('0');
  assert.equal(unrelated.action, 'ignore');
  assert.equal(unrelated.verdict, false);
});

test('runFollowUpJudge：解析失败 / 流内报错 / 缺服务都抛错（由门禁兜底）', async () => {
  await assert.rejects(
    runFollowUpJudge({
      llm: fakeLlm('我猜你想问的是……'),
      route: { provider: 'p', model: 'm' },
      recent: [],
      message: 'x',
      logger: silent,
    }),
    /无法解析/,
  );

  const failing = {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: '1' };
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '上游 429' } } };
    },
  };
  await assert.rejects(
    runFollowUpJudge({
      llm: failing,
      route: { provider: 'p', model: 'm' },
      recent: [],
      message: 'x',
      logger: silent,
    }),
    /429/,
  );

  await assert.rejects(
    runFollowUpJudge({ llm: null, route: { provider: 'p', model: 'm' }, message: 'x', logger: silent }),
    /llm 服务不可用/,
  );
  await assert.rejects(
    runFollowUpJudge({ llm: fakeLlm('1'), route: null, message: 'x', logger: silent }),
    /没有可用的判定模型/,
  );
});

test('runFollowUpJudge：超时会中止并抛错', async () => {
  const hanging = {
    stream(options) {
      return (async function* () {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
        yield { type: 'text-delta', index: 0, text: '1' };
      })();
    },
  };
  const started = Date.now();
  await assert.rejects(
    runFollowUpJudge({
      llm: hanging,
      route: { provider: 'p', model: 'm' },
      recent: [],
      message: 'x',
      timeoutMs: 500,
      logger: silent,
    }),
  );
  assert.ok(Date.now() - started < 3_000);
});

// ────────────────────────── 门禁接线 ──────────────────────────

function makeCtx(appId = 'app-1') {
  return { bot: { appId }, state: {} };
}

function makeMsg(over = {}) {
  return {
    kind: 'group',
    groupOpenid: 'group-1',
    messageId: 'msg-1',
    content: '',
    mentions: [],
    senderId: 'user-1',
    senderName: '群友',
    ...over,
  };
}

async function feed(guard, msg, ctx = makeCtx()) {
  let nexted = false;
  await guard({ ...ctx, message: msg }, async () => {
    nexted = true;
  });
  return nexted;
}

function guarded(followUp, over = {}, extras = {}) {
  let judgeCalls = 0;
  let reply = '2m';
  const llm = {
    async *stream() {
      judgeCalls += 1;
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const guard = createGuard(
    // 判定记录里的话题锚点会多一次模型调用，这里关掉，调用次数才可数
    { ...DEFAULT_CONFIG, followUpTopicAnchor: false, ...over },
    silent,
    new Map(),
    null,
    {
      followUp,
      getLlm: () => llm,
      getRoute: () => ({ provider: 'p', model: 'm' }),
      ...extras,
    },
  );
  return {
    guard,
    llm,
    judgeCalls: () => judgeCalls,
    setReply(value) {
      reply = value;
    },
  };
}

test('门禁：关键词开窗后，相关消息无 @ 也放行并续期', async () => {
  const c = clock();
  const followUp = createFollowUpState({ now: c.now, windowMs: 600_000 });
  const harness = guarded(followUp);

  const first = makeMsg({ content: '大肥鱼 在吗' });
  await feed(harness.guard, first);
  assert.ok(first.mentions.some((m) => m?.is_you === true));
  assert.equal(followUp.get('group-1').turns, 1);

  c.advance(30_000);
  const second = makeMsg({ content: '那个报错又出现了', messageId: 'msg-2' });
  assert.equal(await feed(harness.guard, second), true);
  assert.equal(harness.judgeCalls(), 1);
  assert.ok(second.mentions.some((m) => m?.is_you === true));
  assert.equal(second.mentions.at(-1).followUp, true);
  assert.equal(followUp.get('group-1').turns, 2);
  assert.deepEqual(
    followUp.recent('group-1').map((e) => e.text),
    ['大肥鱼 在吗', '那个报错又出现了'],
  );
});

test('门禁：判定为无关时不补 mention（交给 mentionGate 拦停）', async () => {
  const c = clock();
  const followUp = createFollowUpState({ now: c.now, windowMs: 600_000 });
  const harness = guarded(followUp);
  harness.setReply('0');

  await feed(harness.guard, makeMsg({ content: '大肥鱼' }));
  const unrelated = makeMsg({ content: '今晚开黑吗', messageId: 'msg-2' });
  await feed(harness.guard, unrelated);
  assert.equal(harness.judgeCalls(), 1);
  assert.equal(unrelated.mentions.length, 0);
  assert.equal(followUp.get('group-1').turns, 1);
});

test('门禁：窗口过期后不再判定，关键词可重新开窗', async () => {
  const c = clock();
  const followUp = createFollowUpState({ now: c.now, windowMs: 600_000 });
  const harness = guarded(followUp);

  await feed(harness.guard, makeMsg({ content: '大肥鱼' }));
  c.advance(11 * 60 * 1000);
  assert.equal(followUp.get('group-1'), null);

  const idle = makeMsg({ content: '随便聊聊', messageId: 'msg-2' });
  await feed(harness.guard, idle);
  assert.equal(harness.judgeCalls(), 0);
  assert.equal(idle.mentions.length, 0);

  const again = makeMsg({ content: '肥鱼 你说呢', messageId: 'msg-3' });
  await feed(harness.guard, again);
  assert.ok(again.mentions.some((m) => m?.is_you === true));
  assert.ok(followUp.get('group-1'));
});

test('门禁：真实 @ 与引用机器人走快通道，不调判定模型', async () => {
  const c = clock();
  const followUp = createFollowUpState({ now: c.now, windowMs: 600_000 });
  const harness = guarded(followUp);

  const at = makeMsg({ content: '<@app-1> 你好', messageId: 'msg-1' });
  await feed(harness.guard, at);
  assert.ok(at.mentions.some((m) => m?.is_you === true));
  assert.equal(harness.judgeCalls(), 0);

  followUp.remember('group-1', { role: 'bot', text: '我刚说的', refIdx: 'ref-9' });
  const quoted = makeMsg({
    content: '这个怎么改',
    messageId: 'msg-2',
    refMsgIdx: 'ref-9',
  });
  await feed(harness.guard, quoted);
  assert.equal(harness.judgeCalls(), 0);
  assert.ok(quoted.mentions.some((m) => m?.is_you === true));
  assert.equal(quoted.mentions.at(-1).followUp, true);
  assert.equal(followUp.get('group-1').turns, 2);
});

test('门禁：判定失败按 followUpOnJudgeError 处理，连续 3 次关窗', async () => {
  const c = clock();
  const followUp = createFollowUpState({ now: c.now, windowMs: 600_000 });
  let calls = 0;
  const broken = {
    async *stream() {
      calls += 1;
      throw new Error('boom');
    },
  };
  const mk = (policy) =>
    createGuard(
      { ...DEFAULT_CONFIG, followUpTopicAnchor: false, followUpOnJudgeError: policy },
      silent,
      new Map(),
      null,
      {
      followUp,
      getLlm: () => broken,
      getRoute: () => ({ provider: 'p', model: 'm' }),
    });

  // skip：失败也不放行
  await feed(mk('skip'), makeMsg({ content: '大肥鱼' }));
  const skipped = makeMsg({ content: '在吗', messageId: 'msg-2' });
  await feed(mk('skip'), skipped);
  assert.equal(skipped.mentions.length, 0);

  // reply：失败也当相关放行
  const replied = makeMsg({ content: '还在吗', messageId: 'msg-3' });
  await feed(mk('reply'), replied);
  assert.ok(replied.mentions.some((m) => m?.is_you === true));

  // 第 3 次失败：窗口关闭
  const third = makeMsg({ content: '继续', messageId: 'msg-4' });
  await feed(mk('skip'), third);
  assert.equal(calls, 3);
  assert.equal(followUp.get('group-1'), null);
});

test('门禁：没接 followUp 时行为与旧版一致（只认关键词/@）', async () => {
  let llmCalls = 0;
  const guard = createGuard({ ...DEFAULT_CONFIG }, silent, new Map(), null, {
    getLlm: () => ({
      async *stream() {
        llmCalls += 1;
      },
    }),
    getRoute: () => ({ provider: 'p', model: 'm' }),
  });

  const hit = makeMsg({ content: '大肥鱼 在吗' });
  await feed(guard, hit);
  assert.ok(hit.mentions.some((m) => m?.is_you === true));

  const later = makeMsg({ content: '继续刚才的话题', messageId: 'msg-2' });
  await feed(guard, later);
  assert.equal(later.mentions.length, 0);
  assert.equal(llmCalls, 0);
});

test('门禁：判定模型按群会话解析（getRoute 拿到 appId 和群标识）', async () => {
  const c = clock();
  const followUp = createFollowUpState({ now: c.now, windowMs: 600_000 });
  const seen = [];
  let judgeCalls = 0;
  const llm = {
    async *stream() {
      judgeCalls += 1;
      yield { type: 'text-delta', index: 0, text: '1' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const guard = createGuard(
    { ...DEFAULT_CONFIG, followUpBurstMs: 0, followUpTopicAnchor: false },
    silent,
    new Map(),
    null,
    {
      followUp,
      getLlm: () => llm,
      getRoute: (msg) => {
        seen.push(msg);
        return { provider: 'p', model: 'm' };
      },
    },
  );

  await feed(guard, makeMsg({ content: '大肥鱼 在吗' }));
  await feed(guard, makeMsg({ content: '继续刚才的', messageId: 'msg-2' }));

  assert.equal(judgeCalls, 1);
  assert.deepEqual(seen, [{ appId: 'app-1', groupOpenid: 'group-1' }]);
});

test('门禁：机器人自己的消息、斜杠命令、空消息都不触发判定', async () => {
  const c = clock();
  const followUp = createFollowUpState({ now: c.now, windowMs: 600_000 });
  const harness = guarded(followUp);
  await feed(harness.guard, makeMsg({ content: '大肥鱼' }));

  await feed(harness.guard, makeMsg({ content: '我是别的机器人', senderIsBot: true }));
  await feed(harness.guard, makeMsg({ content: '/help', messageId: 'msg-2' }));
  await feed(harness.guard, makeMsg({ content: '   ', messageId: 'msg-3' }));
  assert.equal(harness.judgeCalls(), 0);
  assert.equal(followUp.get('group-1').turns, 1);
});

// ────────────────────────── 出站记录 ──────────────────────────

test('installOutboundRecorder：记录群消息文本与 ref_idx，只记开着的窗口', async () => {
  class FakeBot {
    async sendMarkdown(target, content) {
      return { id: 'sent-1', timestamp: 0, ext_info: { ref_idx: 'ref-9' } };
    }
  }
  const c = clock();
  const followUp = createFollowUpState({ now: c.now });
  const original = FakeBot.prototype.sendMarkdown;

  const installed = installOutboundRecorder(FakeBot, followUp, silent);
  assert.equal(installed.installed, true);
  assert.equal(FakeBot.prototype.sendMarkdown.length, 2); // 不额外加形参，避免 qqbot 内部调用位置变化

  const bot = new FakeBot();
  const client = await bot.sendMarkdown({ scope: 'group', targetId: 'g1' }, '我记下了');
  assert.equal(client.id, 'sent-1');
  // 窗口没开：不记
  assert.equal(followUp.recent('g1').length, 0);

  followUp.open('g1');
  await bot.sendMarkdown({ scope: 'group', targetId: 'g1' }, '日志在 ~/.dsh-qqbot**');
  const [entry] = followUp.recent('g1');
  assert.equal(entry.role, 'bot');
  assert.equal(entry.name, '机器人');
  assert.equal(entry.text, '日志在 ~/.dsh-qqbot**');
  assert.equal(entry.refIdx, 'ref-9');
  assert.equal(followUp.matchesBotRef('g1', 'ref-9'), true);
  assert.equal(followUp.matchesBotRef('g1', 'ref-8'), false);

  // 私聊不记
  await bot.sendMarkdown({ scope: 'c2c', targetId: 'u1' }, '私聊内容');
  assert.equal(followUp.recent('g1').length, 1);

  installed.restored();
  assert.equal(FakeBot.prototype.sendMarkdown, original);
});

test('installOutboundRecorder：发送失败照常抛出，不被记录逻辑吞掉', async () => {
  class FailingBot {
    async sendMarkdown() {
      throw new Error('网络断了');
    }
  }
  const installed = installOutboundRecorder(FailingBot, createFollowUpState(), silent);
  await assert.rejects(new FailingBot().sendMarkdown({ scope: 'group', targetId: 'g1' }, 'x'), /网络断了/);
  installed.restored();
  assert.equal(typeof FailingBot.prototype.sendMarkdown, 'function');
});

test('installOutboundRecorder：类上没这个方法时安全跳过', () => {
  const result = installOutboundRecorder(class {}, createFollowUpState(), silent);
  assert.equal(result.installed, false);
  assert.match(result.reason, /sendMarkdown/);
});

test('installOutboundRecorder：开启引用时改走 send 并带 message_reference', async () => {
  const sends = [];
  class QuoteBot {
    async sendMarkdown() {
      throw new Error('开启引用时不应再走 sendMarkdown');
    }
    async send(opts) {
      sends.push(opts);
      return { id: 'quoted-1', timestamp: 0, ext_info: { ref_idx: 'ref-q' } };
    }
  }
  const followUp = createFollowUpState();
  followUp.open('g1');
  const installed = installOutboundRecorder(QuoteBot, followUp, silent, {
    readConfig: () => ({ followUpQuoteReply: true }),
    markdownType: 2,
  });
  const bot = new QuoteBot();
  const response = await bot.sendMarkdown({ scope: 'group', targetId: 'g1', msgId: 'm-7' }, '# 收到', {
    keyboard: { rows: [] },
  });

  assert.equal(response.id, 'quoted-1');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].messageReference, { message_id: 'm-7' });
  assert.equal(sends[0].msgType, 2);
  assert.deepEqual(sends[0].markdown, { content: '# 收到' });
  assert.deepEqual(sends[0].keyboard, { rows: [] });
  assert.equal(sends[0].target.msgId, 'm-7');
  // 记录逻辑照常跑，ref_idx 来自 send() 的返回
  assert.equal(followUp.recent('g1')[0].refIdx, 'ref-q');
  installed.restored();
});

test('installOutboundRecorder：开关关闭 / 私聊 / 没有 msgId 时仍走 sendMarkdown', async () => {
  const calls = { plain: 0, send: 0 };
  class BothBot {
    async sendMarkdown() {
      calls.plain += 1;
      return { id: 'plain', timestamp: 0 };
    }
    async send() {
      calls.send += 1;
      return { id: 'send', timestamp: 0 };
    }
  }
  let cfg = { followUpQuoteReply: false };
  const installed = installOutboundRecorder(BothBot, createFollowUpState(), silent, {
    readConfig: () => cfg,
  });
  const bot = new BothBot();

  await bot.sendMarkdown({ scope: 'group', targetId: 'g1', msgId: 'm-1' }, '关着');
  cfg = { followUpQuoteReply: true };
  await bot.sendMarkdown({ scope: 'c2c', targetId: 'u1', msgId: 'm-2' }, '私聊');
  await bot.sendMarkdown({ scope: 'group', targetId: 'g1' }, '没有 msgId');

  assert.deepEqual(calls, { plain: 3, send: 0 });
  installed.restored();
});

test('installOutboundRecorder：引用发送失败退回普通发送，不丢消息', async () => {
  const warns = [];
  class QuoteFailBot {
    async sendMarkdown() {
      return { id: 'fallback', timestamp: 0 };
    }
    async send() {
      throw new Error('平台不支持引用');
    }
  }
  const installed = installOutboundRecorder(
    QuoteFailBot,
    createFollowUpState(),
    { ...silent, warn: (m) => warns.push(m) },
    { readConfig: () => ({ followUpQuoteReply: true }) },
  );
  const response = await new QuoteFailBot().sendMarkdown(
    { scope: 'group', targetId: 'g1', msgId: 'm-9' },
    '还是要发出去',
  );
  assert.equal(response.id, 'fallback');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /退回普通发送/);
  installed.restored();
});

// ────────────────────────── 配置校验 ──────────────────────────

test('sanitizeConfigPatch：续聊字段的取值边界', () => {
  const ok = sanitizeConfigPatch({
    followUpEnabled: true,
    followUpWindowMinutes: 30,
    followUpMaxTurns: 0,
    followUpJudgeTimeoutMs: 6000,
    followUpJudgeProvider: '  p  ',
    followUpJudgeModel: 'm',
    followUpOnJudgeError: 'reply',
    followUpQuoteReply: true,
  });
  assert.equal(ok.followUpWindowMinutes, 30);
  assert.equal(ok.followUpQuoteReply, true);
  assert.equal(ok.followUpMaxTurns, 0);
  assert.equal(ok.followUpJudgeProvider, 'p');
  assert.equal(ok.followUpOnJudgeError, 'reply');

  assert.throws(() => sanitizeConfigPatch({ followUpWindowMinutes: 0 }), /1~1440/);
  assert.throws(() => sanitizeConfigPatch({ followUpWindowMinutes: 1441 }), /1~1440/);
  assert.throws(() => sanitizeConfigPatch({ followUpWindowMinutes: 1.5 }), /整数/);
  assert.throws(() => sanitizeConfigPatch({ followUpMaxTurns: -1 }), /0~1000/);
  assert.throws(() => sanitizeConfigPatch({ followUpJudgeTimeoutMs: 100 }), /500~60000/);
  assert.throws(() => sanitizeConfigPatch({ followUpOnJudgeError: 'maybe' }), /skip 或 reply/);
});

// ────────────────────────── 批量判定 + 分消息放行 ──────────────────────────

test('批量判定：窗口内多条合并成一次 decide', async () => {
  let calls = 0;
  let seen = null;
  const batcher = createBurstBatcher({
    windowMs: 20,
    maxItems: 10,
    decide: async (items) => {
      calls += 1;
      seen = items.map((it) => it.text);
      return true;
    },
  });
  const results = await Promise.all([
    batcher.add('g1', { text: 'a' }),
    batcher.add('g1', { text: 'b' }),
    batcher.add('g1', { text: 'c' }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.ok(results.every((r) => r.verdict === true && r.count === 3));
  assert.equal(new Set(results.map((r) => r.batchId)).size, 1);
});

test('批量判定：攒满 maxItems 立即判，不等窗口', async () => {
  let calls = 0;
  const batcher = createBurstBatcher({
    windowMs: 5000,
    maxItems: 2,
    decide: async () => {
      calls += 1;
      return false;
    },
  });
  const started = Date.now();
  await Promise.all([batcher.add('g1', { text: 'a' }), batcher.add('g1', { text: 'b' })]);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 2000, 'maxItems 到量就不该再等 5 秒');
});

test('批量判定：flush 强制提前判定；失败整批共享同一个 error', async () => {
  let calls = 0;
  const batcher = createBurstBatcher({
    windowMs: 5000,
    decide: async () => {
      calls += 1;
      return false;
    },
  });
  const waiting = batcher.add('g1', { text: 'a' });
  const outcome = await batcher.flush('g1');
  assert.equal(calls, 1);
  assert.equal(outcome.verdict, false);
  assert.equal((await waiting).verdict, false);

  const broken = createBurstBatcher({
    windowMs: 10,
    decide: async () => {
      throw new Error('boom');
    },
  });
  const [result] = await Promise.all([broken.add('g2', { text: 'x' })]);
  assert.equal(result.verdict, null);
  assert.match(result.error.message, /boom/);
});

test('批量判定：群标识为空时直接失败，不建批次', async () => {
  const batcher = createBurstBatcher({ windowMs: 10, decide: async () => true });
  const result = await batcher.add('', { text: 'x' });
  assert.equal(result.verdict, null);
  assert.match(result.error.message, /群标识/);
  assert.equal(batcher.size(), 0);
});

test('串行队列：同一群的上一条跑完才轮下一条', async () => {
  const queue = createTurnQueue();
  let active = 0;
  let maxActive = 0;
  const order = [];
  const task = (id) =>
    queue.run('g1', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${id}`);
      active -= 1;
    });
  await Promise.all([task(1), task(2), task(3)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
});

test('门禁：短时间多条只判一次，判 2e 时逐条放行、一条一轮', async () => {
  const followUp = createFollowUpState({ windowMs: 600_000 });
  const harness = guarded(followUp, { followUpBurstMs: 20 });
  await feed(harness.guard, makeMsg({ content: '大肥鱼 在吗' }));
  harness.setReply('2e');

  let active = 0;
  let maxActive = 0;
  const order = [];
  const msgs = [1, 2, 3].map((i) => makeMsg({ content: `追问 ${i}`, messageId: `m-${i}` }));
  await Promise.all(
    msgs.map((msg) =>
      harness.guard({ ...makeCtx(), message: msg }, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(msg.messageId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    ),
  );

  assert.equal(harness.judgeCalls(), 1, '一批只该问一次判定');
  assert.ok(msgs.every((m) => m.mentions.some((x) => x?.is_you === true)));
  assert.equal(maxActive, 1, '续聊放行要串行，不能让 concurrencyGuard merge 成一轮');
  assert.deepEqual(order, ['m-1', 'm-2', 'm-3']);
});

test('门禁：批量判为无关时整批都不补 mention', async () => {
  const followUp = createFollowUpState({ windowMs: 600_000 });
  const harness = guarded(followUp, { followUpBurstMs: 20 });
  await feed(harness.guard, makeMsg({ content: '大肥鱼 在吗' }));
  harness.setReply('0');

  const msgs = [1, 2].map((i) => makeMsg({ content: `闲聊 ${i}`, messageId: `n-${i}` }));
  await Promise.all(msgs.map((msg) => feed(harness.guard, msg)));
  assert.equal(harness.judgeCalls(), 1);
  assert.ok(msgs.every((m) => m.mentions.length === 0));
});

test('门禁：同一批失败只记一次，不会瞬间关窗', async () => {
  const followUp = createFollowUpState({ windowMs: 600_000 });
  const broken = {
    async *stream() {
      throw new Error('boom');
    },
  };
  const guard = createGuard(
    { ...DEFAULT_CONFIG, followUpBurstMs: 20, followUpOnJudgeError: 'skip' },
    silent,
    new Map(),
    null,
    { followUp, getLlm: () => broken, getRoute: () => ({ provider: 'p', model: 'm' }) },
  );
  await feed(guard, makeMsg({ content: '大肥鱼 在吗' }));

  const msgs = [1, 2, 3].map((i) => makeMsg({ content: `失败 ${i}`, messageId: `f-${i}` }));
  await Promise.all(msgs.map((msg) => feed(guard, msg)));
  const win = followUp.get('group-1');
  assert.ok(win, '一批失败只该记 1 次，窗口不该关');
  assert.equal(win.failures, 1);
});

test('sanitizeConfigPatch：批量汇总结界的取值边界', () => {
  const ok = sanitizeConfigPatch({ followUpBurstMs: 0, followUpBurstMax: 12 });
  assert.equal(ok.followUpBurstMs, 0);
  assert.equal(ok.followUpBurstMax, 12);

  assert.throws(() => sanitizeConfigPatch({ followUpBurstMs: -1 }), /0~5000/);
  assert.throws(() => sanitizeConfigPatch({ followUpBurstMs: 5001 }), /0~5000/);
  assert.throws(() => sanitizeConfigPatch({ followUpBurstMs: 1.5 }), /整数/);
  assert.throws(() => sanitizeConfigPatch({ followUpBurstMax: 1 }), /2~50/);
  assert.throws(() => sanitizeConfigPatch({ followUpBurstMax: 51 }), /2~50/);
});

// ────────────────────────── 刷屏保护 + 只回相关 ──────────────────────────

test('刷屏断路器：窗口内打满即进冷却，冷却结束自动退出，代次递增', () => {
  const c = clock();
  const gate = createFloodGate({ now: c.now, windowMs: 10_000, maxItems: 3, cooldownMs: 25_000 });

  assert.equal(gate.observe('g1').flooding, false);
  assert.equal(gate.observe('g1').flooding, false);
  const hit = gate.observe('g1');
  assert.equal(hit.triggered, true);
  assert.equal(hit.flooding, true);
  assert.equal(hit.epoch, 1);
  assert.ok(hit.remainingMs > 24_000);

  assert.equal(gate.isFlooding('g1'), true);
  c.advance(26_000);
  assert.equal(gate.isFlooding('g1'), false);
  // 冷却后重新攒，打满一次代次继续递增
  gate.observe('g1');
  gate.observe('g1');
  assert.equal(gate.observe('g1').epoch, 2);
  gate.clear();
  assert.equal(gate.size(), 0);
});

test('parseFollowUpSelection：只认范围内的编号，0 表示一条都不要', () => {
  assert.deepEqual(parseFollowUpSelection('1,3', 4), [1, 3]);
  assert.deepEqual(parseFollowUpSelection('3,1,3', 4), [1, 3]);
  assert.deepEqual(parseFollowUpSelection('```\n2\n```', 5), [2]);
  assert.deepEqual(parseFollowUpSelection('0', 3), []);
  assert.deepEqual(parseFollowUpSelection('0。', 3), []);
  assert.equal(parseFollowUpSelection('', 3), null);
  assert.equal(parseFollowUpSelection('这不好说', 3), null);
  assert.equal(parseFollowUpSelection('9', 3), null, '全越界时不能当成「都不要」');
});

test('buildFollowUpSelectInput：最近群聊 + 编号列表', () => {
  const input = buildFollowUpSelectInput({
    recent: [{ role: 'user', name: '小明', text: '刚才说到哪了' }, { role: 'bot', text: '说到缓存' }],
    items: [{ sender: '小红', text: '缓存咋办' }, { text: '今晚开黑' }],
  });
  assert.match(input, /\[最近群聊\]/);
  assert.match(input, /小明: 刚才说到哪了/);
  assert.match(input, /机器人: 说到缓存/);
  assert.match(input, /\[1\] 小红: 缓存咋办/);
  assert.match(input, /\[2\] 今晚开黑/);
});

test('runFollowUpSelectJudge：返回编号与形态；答非所问抛错', async () => {
  const route = { provider: 'p', model: 'm' };
  const llm = fakeLlm('2');
  assert.deepEqual(
    await runFollowUpSelectJudge({ llm, route, recent: [], items: [{ text: 'a' }, { text: 'b' }], logger: silent }),
    { selected: [2], mode: 'each' },
  );
  assert.deepEqual(
    await runFollowUpSelectJudge({
      llm: fakeLlm('m:1,2'),
      route,
      items: [{ text: 'a' }, { text: 'b' }],
      logger: silent,
    }),
    { selected: [1, 2], mode: 'merge' },
  );
  await assert.rejects(
    runFollowUpSelectJudge({ llm: fakeLlm('不好说'), route, items: [{ text: 'a' }], logger: silent }),
    /无法解析/,
  );
});

test('runFollowUpSelectJudge：输出预算同样留够（reasoning 会吃 token）', async () => {
  let seen = null;
  const llm = {
    async *stream(options) {
      seen = options;
      yield { type: 'text-delta', index: 0, text: '1' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  await runFollowUpSelectJudge({
    llm,
    route: { provider: 'p', model: 'm' },
    items: [{ text: 'a' }, { text: 'b' }],
    logger: silent,
  });
  assert.ok(seen.maxTokens >= 512, `maxTokens 太小会只剩思考：${seen.maxTokens}`);
});

test('门禁：select 模式只放行被挑中的那条', async () => {
  const followUp = createFollowUpState({ windowMs: 600_000 });
  const harness = guarded(followUp, { followUpBurstMs: 20, followUpSelectMin: 2 });
  await feed(harness.guard, makeMsg({ content: '大肥鱼 在吗' }));
  harness.setReply('2');

  const msgs = [1, 2].map((i) => makeMsg({ content: `接着聊 ${i}`, messageId: `s-${i}` }));
  const nexted = await Promise.all(msgs.map((msg) => feed(harness.guard, msg)));
  assert.equal(harness.judgeCalls(), 1);
  assert.deepEqual(nexted, [false, true], '只有第 2 条被挑中，第 1 条应静默');
  assert.equal(msgs[0].mentions.length, 0);
  assert.ok(msgs[1].mentions.some((m) => m?.is_you === true));
  assert.equal(followUp.get('group-1').turns, 2);
});

test('门禁：判 2m 时合并成一条——只放行最后一条，其余只进历史', async () => {
  const followUp = createFollowUpState({ windowMs: 600_000 });
  const harness = guarded(followUp, { followUpBurstMs: 20 });
  await feed(harness.guard, makeMsg({ content: '大肥鱼 在吗' }));

  const msgs = [1, 2, 3].map((i) => makeMsg({ content: `追问 ${i}`, messageId: `mg-${i}` }));
  const nexted = await Promise.all(msgs.map((msg) => feed(harness.guard, msg)));

  assert.deepEqual(nexted, [false, false, true], '只有最后一条进 agent');
  assert.equal(harness.judgeCalls(), 1);
  assert.equal(msgs[0].mentions.length, 0);
  assert.equal(msgs[1].mentions.length, 0);
  assert.ok(msgs[2].mentions.some((m) => m?.is_you === true));
  // 三条都在续聊上下文里，模型才写得出合并回复
  assert.deepEqual(
    followUp.recent('group-1').map((e) => e.text).slice(-3),
    ['追问 1', '追问 2', '追问 3'],
  );
});

test('门禁：纯笑声/附和走快通道，只续期、不调模型、不回', async () => {
  const followUp = createFollowUpState({ windowMs: 600_000 });
  const harness = guarded(followUp, { followUpBurstMs: 0 });
  await feed(harness.guard, makeMsg({ content: '大肥鱼 在吗' }));
  const before = followUp.get('group-1').turns;

  const ack = makeMsg({ content: '哈哈哈', messageId: 'ack-1' });
  assert.equal(await feed(harness.guard, ack), false);
  assert.equal(harness.judgeCalls(), 0, '附和不该花模型调用');
  assert.equal(ack.mentions.length, 0);
  assert.equal(followUp.get('group-1').turns, before, '附和只续期，不占回复条数');
  assert.equal(followUp.recent('group-1').at(-1).text, '哈哈哈');
});

test('门禁：followUpAckMode=ignore 时附着完全不理会（不续期、不判定）', async () => {
  const followUp = createFollowUpState({ windowMs: 600_000 });
  const harness = guarded(followUp, { followUpBurstMs: 0, followUpAckMode: 'ignore' });
  await feed(harness.guard, makeMsg({ content: '大肥鱼 在吗' }));
  const before = followUp.stats('group-1');

  const ack = makeMsg({ content: '收到', messageId: 'ack-2' });
  // ignore 不补 mention，交给下游 mentionGate 拦停（测试里的 next 只是继续链路，不代表会被回复）
  assert.equal(await feed(harness.guard, ack), true);
  assert.equal(harness.judgeCalls(), 0);
  assert.equal(ack.mentions.length, 0);
  assert.equal(followUp.stats('group-1').lastRelatedAt, before.lastRelatedAt, 'ignore 不该续期');
  // 不过期、不判定，但这条消息会以 [已忽略] 留在上下文里（不续期）
  assert.equal(followUp.recent('group-1').at(-1).text, '收到');
});

test('门禁：强制 batch / each 覆盖模型给的形态', async () => {
  const f1 = createFollowUpState({ windowMs: 600_000 });
  const h1 = guarded(f1, { followUpBurstMs: 20, followUpReplyMode: 'batch' });
  await feed(h1.guard, makeMsg({ content: '大肥鱼' }));
  h1.setReply('2e');
  const m1 = [1, 2].map((i) => makeMsg({ content: `批 ${i}`, messageId: `b-${i}` }));
  const n1 = await Promise.all(m1.map((m) => feed(h1.guard, m)));
  assert.deepEqual(n1, [false, true], 'batch 强制合并');

  const f2 = createFollowUpState({ windowMs: 600_000 });
  const h2 = guarded(f2, { followUpBurstMs: 20, followUpReplyMode: 'each' });
  await feed(h2.guard, makeMsg({ content: '大肥鱼' }));
  h2.setReply('2m');
  const m2 = [1, 2].map((i) => makeMsg({ content: `逐 ${i}`, messageId: `e-${i}` }));
  const n2 = await Promise.all(m2.map((m) => feed(h2.guard, m)));
  assert.deepEqual(n2, [true, true], 'each 强制逐条');
});

test('窗口：renew 不增加 turns；suppressQuote 只压一条消息的引用', async () => {
  const c = clock();
  const state = createFollowUpState({ now: c.now, windowMs: 600_000 });
  state.open('g1');
  state.touch('g1');
  c.advance(60_000);
  state.renew('g1');
  assert.equal(state.get('g1').turns, 1);
  assert.equal(state.stats('g1').remainingMs, 600_000);

  state.suppressQuote('g1', 'm-9');
  assert.equal(state.shouldSuppressQuote('g1', 'm-9'), true);
  assert.equal(state.shouldSuppressQuote('g1', 'm-8'), false);
  state.suppressQuote('g1', '');
  assert.equal(state.shouldSuppressQuote('g1', 'm-9'), false);
  assert.equal(state.shouldSuppressQuote('g2', 'm-9'), false);
});

test('installOutboundRecorder：合并回复即使开了引用也不带 message_reference', async () => {
  const calls = { plain: 0, send: 0 };
  class BothBot {
    async sendMarkdown() {
      calls.plain += 1;
      return { id: 'plain', timestamp: 0 };
    }
    async send() {
      calls.send += 1;
      return { id: 'quoted', timestamp: 0 };
    }
  }
  const followUp = createFollowUpState();
  followUp.open('g1');
  followUp.suppressQuote('g1', 'm-7');
  const installed = installOutboundRecorder(BothBot, followUp, silent, {
    readConfig: () => ({ followUpQuoteReply: true }),
  });
  await new BothBot().sendMarkdown({ scope: 'group', targetId: 'g1', msgId: 'm-7' }, '合并后的回复');
  assert.deepEqual(calls, { plain: 1, send: 0 }, '被抑制的消息不走引用发送');
  assert.equal(followUp.shouldSuppressQuote('g1', 'm-7'), false, '发完要清掉抑制标记');
  installed.restored();
});

test('sanitizeConfigPatch：回复形态与附和处理只认枚举值', () => {
  const ok = sanitizeConfigPatch({
    followUpReplyMode: 'batch',
    followUpAckMode: 'ignore',
    followUpAckFastPath: false,
  });
  assert.equal(ok.followUpReplyMode, 'batch');
  assert.equal(ok.followUpAckMode, 'ignore');
  assert.equal(ok.followUpAckFastPath, false);
  assert.throws(() => sanitizeConfigPatch({ followUpReplyMode: 'smart' }), /auto、batch 或 each/);
  assert.throws(() => sanitizeConfigPatch({ followUpAckMode: 'silent' }), /renew、reply 或 ignore/);
});

test('门禁：skip 模式刷屏时直接不回，也不调判定', async () => {
  const followUp = createFollowUpState({ windowMs: 600_000 });
  const harness = guarded(followUp, {
    followUpBurstMs: 20,
    followUpFloodAction: 'skip',
    followUpFloodMax: 2,
    followUpFloodWindowMs: 10_000,
  });
  await feed(harness.guard, makeMsg({ content: '大肥鱼 在吗' }));

  const first = makeMsg({ content: '刷屏 1', messageId: 'f-1' });
  const second = makeMsg({ content: '刷屏 2', messageId: 'f-2' });
  const a = await feed(harness.guard, first);
  const b = await feed(harness.guard, second);
  assert.equal(harness.judgeCalls(), 1, '第一条正常判定，第二条已进入冷却不再判定');
  assert.equal(a, true);
  assert.equal(b, false);
  assert.equal(second.mentions.length, 0);
});

test('sanitizeConfigPatch：刷屏保护的取值边界', () => {
  const ok = sanitizeConfigPatch({
    followUpFloodWindowMs: 10_000,
    followUpFloodMax: 15,
    followUpFloodCooldownMs: 25_000,
    followUpFloodAction: 'select',
    followUpSelectMin: 5,
  });
  assert.equal(ok.followUpFloodAction, 'select');
  assert.equal(ok.followUpSelectMin, 5);

  assert.throws(() => sanitizeConfigPatch({ followUpFloodWindowMs: 999 }), /1000~60000/);
  assert.throws(() => sanitizeConfigPatch({ followUpFloodMax: 0 }), /1~200/);
  assert.throws(() => sanitizeConfigPatch({ followUpFloodCooldownMs: 999 }), /1000~600000/);
  assert.throws(() => sanitizeConfigPatch({ followUpSelectMin: 1 }), /2~50/);
  assert.throws(() => sanitizeConfigPatch({ followUpFloodAction: 'mute' }), /skip 或 select/);
});

// ────────────────────────── 附和表情 ──────────────────────────

test('表情包：内置目录能读到图片，随机发送、同群冷却、不连续重复', async () => {
  const files = listStickers();
  assert.ok(files.length >= 5, `内置表情至少 5 张，实际 ${files.length}`);
  assert.ok(files.every((file) => /\.(png|jpe?g|gif|webp)$/i.test(file)));
  assert.equal(listStickers('Z:\definitely-missing-dir').length, 0);
  assert.equal(files.length, 9, '内置表情固定 9 张鲸鱼娘');

  let now = 1_000_000;
  const sent = [];
  const bot = {
    async sendImage(target, source) {
      sent.push({ target, source });
    },
  };
  const sender = createStickerSender({
    stickers: files,
    cooldownMs: 60_000,
    now: () => now,
    random: () => 0,
    logger: silent,
  });

  assert.equal(await sender.send(bot, { scope: 'group', targetId: 'g1', msgId: 'm1' }), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].target, { scope: 'group', targetId: 'g1', msgId: 'm1' });
  assert.ok(sent[0].source.localPath);

  // 同群冷却内不再发
  assert.equal(await sender.send(bot, { scope: 'group', targetId: 'g1', msgId: 'm2' }), false);
  assert.equal(sent.length, 1);

  // 冷却过后可发，且不会连挑同一张
  now += 60_000;
  assert.equal(await sender.send(bot, { scope: 'group', targetId: 'g1', msgId: 'm3' }), true);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].source.localPath, sent[1].source.localPath);
});

test('表情包：没有 bot/图片或发送失败时安静跳过', async () => {
  const warnings = [];
  const sender = createStickerSender({
    stickers: ['/tmp/a.png'],
    cooldownMs: 0,
    logger: { ...silent, warn: (msg) => warnings.push(String(msg)) },
  });
  assert.equal(await sender.send(null, { scope: 'group', targetId: 'g1' }), false);
  assert.equal(await sender.send({ sendImage: async () => { throw new Error('upload boom'); } }, {
    scope: 'group',
    targetId: 'g1',
  }), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /upload boom/);

  const empty = createStickerSender({ stickers: [], logger: silent });
  assert.equal(empty.size(), 0);
  assert.equal(await empty.send({ sendImage: async () => {} }, { scope: 'group', targetId: 'g1' }), false);
});

test('门禁：场景内附和只发一张表情，不发文本（一批只发一次）', async () => {
  const followUp = createFollowUpState({ windowMs: 600_000 });
  const sent = [];
  const stickerSender = {
    size: () => 3,
    async send(bot, target, options) {
      sent.push({ ...target, mood: options?.mood ?? null });
      return true;
    },
  };
  const harness = guarded(followUp, { followUpBurstMs: 20 }, { stickerSender });
  await feed(harness.guard, makeMsg({ content: '大肥鱼 在吗' }));

  const first = makeMsg({ content: '哈哈哈', messageId: 's-1' });
  const second = makeMsg({ content: '确实', messageId: 's-2' });
  const [a, b] = await Promise.all([feed(harness.guard, first), feed(harness.guard, second)]);
  assert.equal(harness.judgeCalls(), 0, '纯附和不调模型');
  assert.equal(a, false);
  assert.equal(b, false);
  assert.equal(sent.length, 1, '一批附和只发一张');
  assert.equal(sent[0].msgId, 's-1');
  assert.equal(sent[0].mood, 'happy', '按文字猜出情绪，挑更贴切的表情');

  // 关掉表情就只剩续期，不发图
  const offHarness = guarded(followUp, { followUpBurstMs: 0, followUpStickerEnabled: false }, { stickerSender });
  await feed(offHarness.guard, makeMsg({ content: '嗯嗯', messageId: 's-3' }));
  assert.equal(sent.length, 1);
});

test('表情情绪：从文件名和文字里挑贴合的那一张', async () => {
  assert.equal(guessStickerMood('哈哈哈哈哈'), 'happy');
  assert.equal(guessStickerMood('吃瓜看戏'), 'melon');
  assert.equal(guessStickerMood('晚安，睡了'), 'sleep');
  assert.equal(guessStickerMood('这样行吗？'), 'question');
  assert.equal(guessStickerMood('收到，谢谢'), 'like');
  assert.equal(guessStickerMood('无语了……'), 'speechless');
  assert.equal(guessStickerMood('卧槽真的假的'), 'shock');
  assert.equal(guessStickerMood('呜呜破防了'), 'cry');
  assert.equal(guessStickerMood('今天摸鱼'), 'lazy');
  assert.equal(guessStickerMood('今天写了一天代码'), null);

  assert.equal(guessStickerMoodFromItems([{ text: '哈哈哈' }, { text: '震惊' }]), 'shock');
  assert.equal(guessStickerMoodFromItems([{ text: '今天写代码' }]), null);

  assert.equal(parseFollowUpDecision('1 happy').mood, 'happy');
  assert.equal(parseFollowUpDecision('1 melon').mood, 'melon');
  assert.equal(parseFollowUpDecision('1').mood, null);
  assert.equal(parseFollowUpDecision('1 随便').mood, null);

  const sent = [];
  const bot = {
    async sendImage(target, source) {
      sent.push(source.localPath);
    },
  };
  const sender = createStickerSender({
    stickers: ['/tmp/01-happy.png', '/tmp/03-melon.png'],
    cooldownMs: 0,
    random: () => 0,
    logger: silent,
  });
  assert.equal(await sender.send(bot, { scope: 'group', targetId: 'g1', msgId: 'm1' }, { mood: 'melon' }), true);
  assert.match(sent[0], /03-melon\.png$/);
});

test('批量窗口：续约式结算，但受最长等待硬上限约束', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const calls = [];
  const debounced = createBurstBatcher({
    windowMs: 80,
    maxWaitMs: 2000,
    decide: async (items) => {
      calls.push(items.map((it) => it.text));
      return { action: 'reply', verdict: true, mode: 'merge' };
    },
  });
  let settled = false;
  const first = debounced.add('g1', { text: 'A' }).then((out) => {
    settled = true;
    return out;
  });
  await sleep(40);
  const second = debounced.add('g1', { text: 'B' });
  await sleep(25);
  assert.equal(settled, false, '第二条到达后窗口应续约，不按第一条的 80ms 结算');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['A', 'B']);
  assert.equal(a.count, 2);
  assert.equal(b.index, 2);

  // 群里一直说话：窗口不断续约，但 maxWait 到了必须结算
  const capped = [];
  const startedAt = Date.now();
  const batcher = createBurstBatcher({
    windowMs: 5000,
    maxWaitMs: 120,
    decide: async (items) => {
      capped.push(items.length);
      return { action: 'ack', verdict: false };
    },
  });
  const pending = batcher.add('g2', { text: '1' });
  await sleep(60);
  void batcher.add('g2', { text: '2' });
  await sleep(60);
  void batcher.add('g2', { text: '3' });
  const out = await pending;
  assert.ok(Date.now() - startedAt < 1000, '不能被 5 秒窗口拖住');
  assert.equal(capped.length, 1);
  assert.equal(out.count >= 2, true);

  assert.equal(sanitizeConfigPatch({ followUpBurstMaxWaitMs: 1000 }).followUpBurstMaxWaitMs, 1000);
  assert.throws(() => sanitizeConfigPatch({ followUpBurstMaxWaitMs: 500 }), /1000~20000/);
  assert.throws(() => sanitizeConfigPatch({ followUpBurstMaxWaitMs: 20001 }), /1000~20000/);
});

test('门禁：判定进环形缓冲；话题锚点每窗口一次且拼进下一轮提示词', async () => {
  const followUp = createFollowUpState({ windowMs: 600_000 });
  const judgeStats = { calls: 0, errors: 0, lastError: '', lastVerdict: '', lastAt: 0 };
  const prompts = [];
  let topicCalls = 0;
  const llm = {
    async *stream(options) {
      const raw = options?.messages?.[0]?.content;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      prompts.push(text);
      if (text.includes('话题标签')) {
        topicCalls += 1;
        yield { type: 'text-delta', index: 0, text: '报错排查' };
      } else {
        yield { type: 'text-delta', index: 0, text: '2e' };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const guard = createGuard({ ...DEFAULT_CONFIG, followUpBurstMs: 0 }, silent, new Map(), null, {
    followUp,
    getLlm: () => llm,
    getRoute: () => ({ provider: 'p', model: 'm' }),
    judgeStats,
  });

  await feed(guard, makeMsg({ content: '大肥鱼 在吗' }));
  await feed(guard, makeMsg({ content: '报错又来了', messageId: 'm2' }));
  // 话题是后台生成，等它落地
  await new Promise((r) => setTimeout(r, 60));
  await feed(guard, makeMsg({ content: '日志在哪', messageId: 'm3' }));

  assert.equal(topicCalls, 1, '同一个窗口只生成一次话题');
  assert.equal(judgeStats.recent.length, 2);
  assert.equal(judgeStats.recent[0].verdict, 'reply');
  assert.ok(prompts.some((p) => p.includes('[当前话题] 报错排查')));
});
