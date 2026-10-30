/**
 * 端到端回归：把插件按设备上的真实布局摆好（profiles/web/node_modules），
 * 再用一个假 qqbot 走一遍 apply()，验证「插件不再在第一步退出」。
 *
 * 用法：node boot.test.mjs
 *
 * 现场故障正是这个布局：guard 在 `profiles/web/node_modules/dsh-qqbot-guard`，
 * qqbot 在 `profiles/web/node_modules/@tencent-connect/dsh-qqbot`，
 * 而 DSH_HOME 没设、cwd 是 /root/work。旧版找不到包就直接 return，整条链路静默失效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const QQBOT_PKG = '@tencent-connect/dsh-qqbot';
const SDK_PKG = '@tencent-connect/qqbot-nodejs';

/** 写一个文件（自动建目录）。 */
function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** 造一份「装好的」qqbot：history store / media 常量 / 下载器 / package.json。 */
function makeQqbot(dir) {
  write(join(dir, 'package.json'), JSON.stringify({ name: QQBOT_PKG, version: '0.5.3' }));
  write(
    join(dir, 'dist', 'features', 'history-store.js'),
    `const entries = [];
     export function getHistoryStore() {
       return {
         append(entry) { entries.push(entry); },
         list(key, limit) { return entries.slice(-(limit ?? 20)); },
         entries,
       };
     }
     export function historyGroupKey(appId, groupOpenid) { return appId + ':' + groupOpenid; }
    `,
  );
  write(join(dir, 'dist', 'media', 'media-cleaner.js'), `export const MEDIA_ROOT = '${'/tmp/media'}';`);
  write(
    join(dir, 'dist', 'transport', 'attachment.js'),
    `export async function downloadMediaAttachments() { return []; }`,
  );
}

/** 造一个只保留公开面的假 SDK：middlewares 数组 + handleInboundMessage 拼链。 */
function makeSdk(dir) {
  write(
    join(dir, 'package.json'),
    JSON.stringify({ name: SDK_PKG, version: '1.0.5', type: 'module', main: './dist/index.js' }),
  );
  write(
    join(dir, 'dist', 'index.js'),
    `export class QQBot {
       constructor() {
         this.middlewares = [];
         this.appId = '102000000';
         this.lastCtx = null;
       }
       async handleInboundMessage(raw) {
         const ctx = { message: raw, bot: this, state: {} };
         this.lastCtx = ctx;
         const chain = [...this.middlewares, async () => {}];
         let i = 0;
         const next = async () => {
           const fn = chain[i++];
           if (fn) await fn(ctx, next);
         };
         await next();
         return ctx;
       }
     }
    `,
  );
}

async function bootFakeProfile(t) {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-guard-boot-'));
  const savedCwd = process.cwd();
  const savedHome = process.env.DSH_HOME;
  const savedDir = process.env.DSH_QQBOT_DIR;
  t.after(() => {
    // Windows 上 cwd 还在临时目录里就删不掉，先切回去；删不掉也不算测试失败
    try {
      process.chdir(savedCwd);
    } catch {
      /* 原目录没了 */
    }
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedDir === undefined) delete process.env.DSH_QQBOT_DIR;
    else process.env.DSH_QQBOT_DIR = savedDir;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 临时目录留给系统清理 */
    }
  });

  const home = join(root, 'home');
  const nm = join(home, 'profiles', 'web', 'node_modules');
  const guardDir = join(nm, 'dsh-qqbot-guard');
  mkdirSync(guardDir, { recursive: true });
  copyFileSync(join(HERE, 'index.js'), join(guardDir, 'index.js'));
  copyFileSync(join(HERE, 'package.json'), join(guardDir, 'package.json'));

  makeQqbot(join(nm, QQBOT_PKG));
  makeSdk(join(nm, SDK_PKG));

  const emptyCwd = join(root, 'work'); // 现场 cwd=/root/work，没有 node_modules
  mkdirSync(emptyCwd, { recursive: true });

  // 现场 DSH_HOME 未设置：探测只能靠插件自身位置
  delete process.env.DSH_HOME;
  delete process.env.DSH_QQBOT_DIR;
  process.chdir(emptyCwd);

  const logs = { info: [], warn: [], error: [] };
  const sink = (list) => (m) => list.push(String(m));
  const ctx = {
    logger: (name) => ({
      info: sink(logs.info),
      warn: sink(logs.warn),
      error: sink(logs.error),
      debug() {},
    }),
    on() {},
    state: {},
  };

  const mod = await import(pathToFileURL(join(guardDir, 'index.js')).href);
  await mod.apply(ctx, {}); // 不写 qqbotPackage：完全依赖自动探测

  return { root, home, nm, guardDir, logs, mod };
}

test('profile 布局下 apply() 能走完（不再在第一步退出）', async (t) => {
  const { logs } = await bootFakeProfile(t);

  const warning = logs.warn.join('\n');
  assert.doesNotMatch(warning, /没找到 @tencent-connect\/dsh-qqbot/, `不该有「没找到」告警：\n${warning}`);
  assert.match(logs.info.join('\n'), /\[qqbot-guard\] 就绪/);
  assert.equal(logs.error.length, 0, `不该有错误日志：\n${logs.error.join('\n')}`);
});

test('群消息命中关键词后 mentions.is_you 被补上（补丁真的挂上了）', async (t) => {
  const { nm } = await bootFakeProfile(t);
  const sdk = await import(
    pathToFileURL(join(nm, SDK_PKG, 'dist', 'index.js')).href
  );

  const bot = new sdk.QQBot();
  const ctx = await bot.handleInboundMessage({
    kind: 'group',
    groupOpenid: 'G1',
    senderId: 'U1',
    senderName: 'A',
    messageId: 'M1',
    content: '鱼鱼在吗',
    timestamp: new Date().toISOString(),
    attachments: [],
  });

  // 懒注入：首条入站消息时 guard 被 unshift 到链头
  assert.equal(bot.middlewares.length, 1);
  assert.equal(typeof bot.middlewares[0], 'function');
  // 关键词放行：下游 mentionGate 认 mentions[].is_you
  const mentions = ctx.message.mentions ?? [];
  assert.ok(
    mentions.some((m) => m?.is_you === true && m?.guarded === true),
    `mentions 未补上：${JSON.stringify(mentions)}`,
  );
  assert.equal(ctx.state.qqbotGuard?.trigger, '鱼鱼');
  // 正文不能被改写（历史会原样落库）
  assert.equal(ctx.message.content, '鱼鱼在吗');
});
