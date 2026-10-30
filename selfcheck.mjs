/**
 * qqbot-guard 自检：在真实 qqbot 中间件链上验证懒注入补丁是否生效。
 *
 * 用法（在装有 dsh-qqbot 的机器上）：
 *   DSH_QQBOT_DIR=/path/to/node_modules/@tencent-connect/dsh-qqbot node selfcheck.mjs
 *   node selfcheck.mjs --qqbot /path/to/dsh-qqbot
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 找不到 qqbot / SDK。
 */
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  findQqbotPackage,
  resolveSdk,
  installGuard,
  createGuard,
  patchHistoryStore,
  normalizeFaces,
  summarizeAttachments,
} from './index.js';

const argvDir = (() => {
  const i = process.argv.indexOf('--qqbot');
  return i > -1 ? process.argv[i + 1] : '';
})();

const logger = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
const qqbot = findQqbotPackage({ ...DEFAULT_CONFIG, qqbotPackage: argvDir }, logger);
if (!qqbot) {
  console.error('FAIL: 没找到 @tencent-connect/dsh-qqbot，请用 --qqbot 或 DSH_QQBOT_DIR 指定');
  process.exit(2);
}

const sdkInfo = resolveSdk(qqbot.dir);
const sdk = await import(pathToFileURL(sdkInfo.entry).href);

if (typeof sdk.QQBot?.prototype?.handleInboundMessage !== 'function') {
  console.error('FAIL: SDK 里没有 QQBot.prototype.handleInboundMessage');
  process.exit(2);
}

const setupMod = await import(
  pathToFileURL(join(qqbot.dir, 'dist', 'gateway', 'middleware-setup.js')).href
);
const storeMod = await import(
  pathToFileURL(join(qqbot.dir, 'dist', 'features', 'history-store.js')).href
);

const APP = '102000000';
const KEYWORD = 'YONGJIE';

// 先按 qqbot 原样建 bot（补丁前），验证补丁不依赖加载顺序
const bot = new sdk.QQBot({ appId: APP, appSecret: 'secret', transport: 'websocket', logger });
const config = {
  appId: APP,
  requireMention: true,
  historyLimit: 10,
  debug: false,
  textChunkLimit: 4500,
  access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] },
};
setupMod.setupMiddlewares(bot, config, {}, logger);

// 造一个假媒体目录：上游落盘名是 `<原名>_<时间戳>_<随机><ext>`，插件按前缀匹配补路径
const mediaRoot = mkdtempSync(join(tmpdir(), 'qqbot-guard-media-'));
writeFileSync(join(mediaRoot, 'a_1700000000_abcd.png'), 'x');

const chainLenBefore = bot.getMiddlewares().length;
const notes = new Map();
// 假下载器：模拟 qqbot 的 downloadMediaAttachments 返回 localPath
const downloaded = [];
const fakeDownloader = async (atts) => {
  const m = new Map();
  for (const a of atts) {
    if (a?.filename === 'a.png') m.set(a.filename, join(mediaRoot, 'a_1700000000_abcd.png'));
  }
  downloaded.push(m);
  return m;
};
const guard = createGuard({ ...DEFAULT_CONFIG, triggers: [KEYWORD] }, logger, notes, fakeDownloader);
const patch = installGuard(sdk.QQBot, guard, logger);
const storePatched = patchHistoryStore(storeMod.getHistoryStore(), notes, logger, { mediaRoot });

const seen = [];
const decisions = [];
bot.on('message', (ctx) => {
  seen.push(String(ctx.message.content ?? ''));
  decisions.push(ctx.state.mention ?? null);
});

const raw = (id, content, attachments = []) => ({
  kind: 'group',
  groupOpenid: 'G1',
  senderId: 'U1',
  senderName: 'A',
  messageId: id,
  content,
  timestamp: new Date().toISOString(),
  attachments,
  rawEventType: 'GROUP_MESSAGE_CREATE',
});

// 现场遇到的真实占位符：ext 解出来是 {"text":""}，faceId=0（用户收藏的表情包）
const FACE_TAG = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">';
// 带名字的系统表情：ext 解出来是 {"text":"捂脸"}
const FACE_TAG_NAMED = '<faceType=1,faceId="264",ext="eyJ0ZXh0Ijoi5o2C6IS4In0=">';

await bot.handleInboundMessage(raw('M1', 'casual chat no trigger'));
await bot.handleInboundMessage(raw('M2', `${KEYWORD} how to`));
await bot.handleInboundMessage(raw('M3', `<@${APP}> hello there`));
await bot.handleInboundMessage(raw('M4', `${FACE_TAG} 表情测试`));
await bot.handleInboundMessage(raw('M5', '', [{ type: 'image', filename: 'a.png' }]));

const store = storeMod.getHistoryStore();
const key = storeMod.historyGroupKey(APP, 'G1');
const history = store.list(key, 20).map((e) => String(e.content));

const results = [
  ['补丁已安装', patch.installed === true],
  ['链头部是 guard', bot.getMiddlewares()[0] === guard],
  ['补丁未改变原链长度（懒注入时机正确）', bot.getMiddlewares().length === chainLenBefore + 1],
  // 用 includes 而不是 startsWith：现场安装的 qqbot 可能还叠了别的门禁中间件，
  // 会在正文前加前缀（例如「[门禁] 本条来自非管理员…」），正文不再是关键词开头。
  ['关键词消息被处理', seen.some((c) => c.includes(KEYWORD))],
  ['关键词消息 wasMentioned=true', decisions[1]?.wasMentioned === true],
  ['模型收到的是干净文本（无 <@ 标记）', !seen.some((c) => c.includes('<@'))],
  ['无关键词的消息被门控拦下', seen.length === 2],
  ['群历史已累积', history.length >= 2],
  ['history store 已包装（附件摘要生效）', storePatched === true],
  // 伪造 mentions 而不是改正文，历史条目里不该再出现 <@appId>
  ['历史条目无 <@ 残留', !history.some((h) => h.includes('<@'))],
  // 空 ext 不再按 faceId 猜 emoji（faceId=0 实测是收藏表情包，猜 😊 是错的）
  ['空 ext 的表情标签变成 [表情]（历史里）', history.some((h) => h.includes('[表情]') && h.includes('表情测试'))],
  ['空 ext 不猜 faceId 对照表', normalizeFaces(FACE_TAG) === '[表情]'],
  ['命名表情解码成名字（264 → 捂脸）', normalizeFaces(`${FACE_TAG_NAMED} 测试`) === '捂脸 测试'],
  ['老格式 [<face,id=1/>] 仍查表', normalizeFaces('[<face,id=1/>]') === '😣'],
  ['历史里带附件摘要', history.some((h) => h.includes('图片「a.png」'))],
  ['历史里补上附件真实路径', history.some((h) => h.includes('a_1700000000_abcd.png'))],
  ['附件在 guard 里就预下载（不等 mentionGate）', downloaded.length === 1 && downloaded[0].size === 1],
  ['预下载路径直接进历史（不靠 glob 兜底）', history.some((h) => h.includes('图片「a.png」@'))],
  ['附件路径是 POSIX 风格绝对路径', history.some((h) => new RegExp('@[A-Za-z]:/').test(h) || h.includes('@/'))],
  ['没有本地文件时不硬写路径', summarizeAttachments([{ type: 'file', filename: 'no-such.pdf' }], mediaRoot) === ' [文件「no-such.pdf」]'],
  ['表情标签不再以占位符形式出现', !history.some((h) => h.includes('faceType='))],
];

console.log(`qqbot=${qqbot.pkg.version} sdk=${sdkInfo.version ?? '?'} chain=${chainLenBefore}`);
for (const [label, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
