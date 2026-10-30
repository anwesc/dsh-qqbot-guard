/**
 * qqbot-guard — dsh-android 内置的 qqbot 增强层（伴侣插件）。
 *
 * 目标：qqbot 主体仍由用户从插件市场安装，本插件只补三件事——
 *   1) 群聊关键词放行（不 @ 也能触发）；
 *   2) 关键词触发时把历史上下文带进本轮（qqbot 原逻辑只有 wasMentioned 才拼历史）；
 *   3) 全程不改 qqbot / SDK 的磁盘文件，只做进程内补丁。
 *
 * 做法（已在本仓库 tools 的探针里验证，见 plugins/qqbot-guard/README.md）：
 *   - 不抢 `bot.use` 的调用时机，改为懒注入：
 *     重写 `QQBot.prototype.handleInboundMessage`，首条入站消息时才把 guard
 *     `unshift` 到 `this.middlewares` 头部，因此**与插件加载顺序无关**。
 *   - guard 命中关键词时给 `msg.mentions` 补一条 `{ is_you: true }`，让 mentionGate
 *     自己判定 `wasMentioned=true`，从而触发 inbound 的历史拼接。**不改正文**：
 *     historyBuffer 在门控之前记录 content，早年往正文里插 `<@appId>` 的做法会把标记
 *     带进历史条目，模型在 `[Chat history begins]` 里看到 `<@102000000> …`。
 *     slashCommand 也认 `mentions[].is_you`，所以斜杠命令照旧可用。
 *   - 顺带把正文里的两类“机器标记”换成可读文本（只改 content，不改附件本体）：
 *     新版表情标签 `<faceType=…,faceId="N",ext="…">` → emoji 或 `[表情]`；
 *     群历史里只存 content，附件会整条消失，所以在读历史时补一句附件摘要
 *     （含本地路径——落盘名带随机后缀，只能读的时候按前缀去 media 目录里找）。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'qqbot-guard';
// 与 qqbot 插件保持一致的最小依赖，保证它排在 agents 之后激活即可。
export const inject = ['agents'];

const SDK_PKG = '@tencent-connect/qqbot-nodejs';
const QQBOT_PKG = '@tencent-connect/dsh-qqbot';
const SDK_MIN = [1, 0, 5];
const SDK_MAX_EXCLUSIVE = [2, 0, 0];
const PATCH_FLAG = Symbol.for('qqbot-guard.handleInboundMessage');

export const DEFAULT_CONFIG = {
  /** 总开关：false 时插件什么都不做（纯直通，不改 qqbot 的任何行为） */
  enabled: true,
  /** 关键词放行：正文包含任一词即视为对我说话（不 @ 也可） */
  triggers: ['大肥鱼', '肥鱼', '鱼鱼'],
  /** 关键词匹配是否忽略大小写 */
  ignoreCase: true,
  /**
   * dsh-qqbot 安装目录或 package.json 路径；留空则自动探测。
   * 探测顺序见 findQqbotPackage()：本插件同 profile 的 node_modules → 各 dsh home 下的
   * profiles/<name>/node_modules（含 pnpm 的 .pnpm store）→ 从 cwd 按 Node 规则向上找。
   */
  qqbotPackage: '',
  /**
   * 外部 JSON 配置（给不便于改 cordis.patch.yml 的场景，例如手机端）。
   * 留空则依次尝试 DSH_QQBOT_GUARD_CONFIG、$DSH_HOME/qqbot-guard.json、~/.dsh/qqbot-guard.json。
   * 优先级：这里的 cordis 配置 > JSON 文件 > DEFAULT_CONFIG。
   */
  configFile: '',
  /** 把新版表情标签 `<faceType=…>` 换成 emoji（映射不到时给 `[表情]`），默认开 */
  faces: true,
  /** 群历史只存 content，附件会丢；读历史时补一句 `[图片「x.png」@/…]`，默认开 */
  historyAttachments: true,
  /**
   * 历史附件要不要顺手落盘，默认开。
   * qqbot 的 `attachmentProcessor` 排在 mentionGate 之后，没触发关键词的群消息走不到它，
   * 附件就永远不会下载——历史里只剩文件名、点开是空的。
   */
  historyMedia: true,
  /** 预下载的体积上限（MB），语义同 qqbot 的 media.maxMB */
  historyMediaMaxMB: 20,
  /** SDK 版本超出白名单时是否仍然安装（默认只告警） */
  strictVersion: false,
  /** 是否输出诊断日志 */
  verbose: true,
};

// ────────────────────────── 工具 ──────────────────────────

function pickLogger(ctx) {
  // cordis 的 ctx.logger 是函数（`ctx.logger('name')` 返回 logger），
  // 但测试与旧版本也可能直接给一个带 info/warn 的对象，两种都接。
  let l = ctx?.logger ?? console;
  if (typeof l === 'function') {
    try {
      l = l('qqbot-guard') ?? console;
    } catch {
      l = console;
    }
  }
  const emit = (level, fallback, m) => {
    const fn = l?.[level];
    if (typeof fn === 'function') return fn.call(l, m);
    return fallback(m);
  };
  return {
    info: (m) => emit('info', console.log, m),
    warn: (m) => emit('warn', console.warn, m),
    error: (m) => emit('error', console.error, m),
    debug: (m) => emit('debug', () => {}, m),
  };
}

// ────────────────────────── 外部配置 ──────────────────────────

/**
 * 解析外部 JSON 配置文件的路径。
 * 手机端改 cordis.patch.yml 不方便，所以留一个 JSON 后门。
 */
export function resolveConfigFile(config = DEFAULT_CONFIG) {
  const explicit = typeof config?.configFile === 'string' ? config.configFile.trim() : '';
  if (explicit) return explicit;
  const env = process.env.DSH_QQBOT_GUARD_CONFIG;
  if (env) return env;
  const home = process.env.DSH_HOME;
  if (home) return join(home, 'qqbot-guard.json');
  try {
    return join(homedir(), '.dsh', 'qqbot-guard.json');
  } catch {
    return null;
  }
}

/** 读取外部 JSON 配置；文件不存在或内容损坏时返回 null，绝不抛出。 */
export function readConfigFile(config = DEFAULT_CONFIG, logger = console) {
  const file = resolveConfigFile(config);
  if (!file || !existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('顶层必须是 JSON 对象');
    }
    logger.debug?.(`[qqbot-guard] 已读取外部配置 ${file}`);
    return data;
  } catch (err) {
    logger.warn?.(`[qqbot-guard] 读取配置 ${file} 失败（忽略）: ${err?.message ?? err}`);
    return null;
  }
}

/** 合并优先级：DEFAULT_CONFIG < 外部 JSON < cordis 里的 config。 */
export function mergeConfig(config = {}, logger = console) {
  const explicit = config ?? {};
  const file = readConfigFile(explicit, logger) ?? {};
  return { ...DEFAULT_CONFIG, ...file, ...explicit };
}

function parseVersion(v) {  const m = String(v ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function readPkg(dir) {
  const file = existsSync(join(dir, 'package.json')) ? join(dir, 'package.json') : dir;
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    return { pkg, dir: dirname(file), file };
  } catch {
    return null;
  }
}

/** 本文件自己的路径；用来反推 dsh 的目录布局（profile 布局下插件与 qqbot 同处一个 node_modules）。 */
const SELF_FILE = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return '';
  }
})();

/** 统一成正斜杠再比较：设备上是 Linux，但桌面端调试时路径是 `D:\…`。 */
function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function safeHomeDsh() {
  try {
    return join(homedir(), '.dsh');
  } catch {
    return '';
  }
}

/**
 * 从本插件的安装位置反推目录布局。
 *
 * 按 profile 组织时本文件在
 * `<home>/profiles/<name>/node_modules/dsh-qqbot-guard/index.js`，
 * 于是能直接拿到 `<home>` 和 profile 目录；qqbot 就装在同一个 node_modules 里。
 *
 * @param {string} [selfFile] 本插件入口文件；默认取 import.meta.url
 * @returns {{home: string, profile: string, profileDir: string, dir: string}}
 */
export function locateSelfLayout(selfFile = SELF_FILE) {
  const dir = selfFile ? dirname(selfFile) : '';
  const m = toPosix(dir).match(/^(.*)\/profiles\/([^/]+)\/node_modules(\/|$)/);
  if (!m) return { home: '', profile: '', profileDir: '', dir };
  return { home: m[1], profile: m[2], profileDir: `${m[1]}/profiles/${m[2]}`, dir };
}

/**
 * 按 Node 的 node_modules 向上查找规则列出候选路径。
 *
 * 从 startDir 起每一级看 `<dir>/node_modules/<pkg>`；如果这一级本身就叫 node_modules，
 * 直接看 `<dir>/<pkg>`（否则会拼出 `node_modules/node_modules/…` 这种永远不存在的路径）。
 *
 * @param {string} startDir 起点目录
 * @param {string} pkg 包名（可带 scope）
 * @param {string[]} [stopDirs] 走到这些目录就停（含），避免一路走到 `/` 把诊断列表刷满
 * @returns {string[]} 候选安装目录，由近到远
 */
function nodeLookupCandidates(startDir, pkg, stopDirs = []) {
  const stops = new Set((stopDirs ?? []).filter(Boolean).map((d) => toPosix(d).replace(/\/+$/, '')));
  const out = [];
  let dir = startDir;
  while (dir) {
    const base = toPosix(dir).replace(/\/+$/, '').split('/').pop();
    out.push(base === 'node_modules' ? join(dir, pkg) : join(dir, 'node_modules', pkg));
    if (stops.has(toPosix(dir).replace(/\/+$/, ''))) break;
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * pnpm 布局：`<node_modules>/.pnpm/@tencent-connect+dsh-qqbot@<ver>/node_modules/<pkg>`。
 * 顶层软链被 prune 掉时（或 symlink 未展开时）还能靠 store 找到。
 *
 * @param {string} nodeModules node_modules 目录
 * @param {string} pkg 包名
 * @returns {string[]} 候选安装目录
 */
function pnpmCandidates(nodeModules, pkg) {
  const out = [];
  const store = join(nodeModules, '.pnpm');
  const prefix = `${pkg.replace('/', '+')}@`;
  try {
    for (const entry of readdirSync(store, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      out.push(join(store, entry.name, 'node_modules', pkg));
    }
  } catch {
    /* 没有 .pnpm 目录 */
  }
  return out;
}

/**
 * 列出 qqbot 的所有候选安装目录（按优先级，已去重）。
 *
 * 顺序：显式配置 → DSH_QQBOT_DIR → 本插件所在位置（Node 向上查找 + 同 profile 的 pnpm store）
 * → 各 dsh home 下的 node_modules / plugins/* / profiles/* → cwd 向上查找。
 *
 * @param {object} config 插件配置
 * @param {{selfFile?: string, cwd?: string, fallbackHome?: string}} [opts] 测试用注入点
 * @returns {string[]} 候选目录
 */
export function qqbotCandidates(config = DEFAULT_CONFIG, opts = {}) {
  const selfFile = opts.selfFile ?? SELF_FILE;
  const cwd = opts.cwd ?? process.cwd();
  const candidates = [];
  const seen = new Set();
  const push = (...paths) => {
    for (const p of paths.flat()) {
      if (!p || typeof p !== 'string') continue;
      const key = toPosix(p);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(p);
    }
  };

  // 1. 显式配置 > 环境变量
  push(config?.qqbotPackage);
  push(process.env.DSH_QQBOT_DIR);

  const layout = locateSelfLayout(selfFile);
  const homes = [];
  const addHome = (h) => {
    if (!h) return;
    if (homes.some((x) => toPosix(x) === toPosix(h))) return;
    homes.push(h);
  };
  addHome(process.env.DSH_HOME);
  addHome(layout.home);
  addHome(opts.fallbackHome !== undefined ? opts.fallbackHome : safeHomeDsh());

  // 2. 本插件自己的位置：profile 布局（<home>/profiles/<name>/node_modules）走这条
  if (selfFile) push(nodeLookupCandidates(dirname(selfFile), QQBOT_PKG, homes));
  if (layout.profileDir) push(pnpmCandidates(join(layout.profileDir, 'node_modules'), QQBOT_PKG));

  // 3. 各 dsh home 下的常见布局
  for (const home of homes) {
    push(join(home, 'node_modules', QQBOT_PKG));
    push(pnpmCandidates(join(home, 'node_modules'), QQBOT_PKG));
    // 插件市场早期的平铺布局
    push(join(home, 'plugins', 'node_modules', QQBOT_PKG));
    const plugins = join(home, 'plugins');
    if (existsSync(plugins)) {
      try {
        for (const entry of readdirSync(plugins, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const nm = join(plugins, entry.name, 'node_modules');
          push(join(nm, QQBOT_PKG));
          push(pnpmCandidates(nm, QQBOT_PKG));
        }
      } catch {
        /* 读不到就跳过 */
      }
    }
    // 按 profile 组织：<home>/profiles/<name>/node_modules（插件市场的实际落盘位置）
    const profiles = join(home, 'profiles');
    if (existsSync(profiles)) {
      try {
        for (const entry of readdirSync(profiles, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const nm = join(profiles, entry.name, 'node_modules');
          push(join(nm, QQBOT_PKG));
          push(pnpmCandidates(nm, QQBOT_PKG));
        }
      } catch {
        /* 读不到就跳过 */
      }
    }
  }

  // 4. cwd 向上（非 profile 的裸部署，保留旧行为）
  push(nodeLookupCandidates(cwd, QQBOT_PKG));

  return candidates;
}

/**
 * 探测 dsh-qqbot 的安装目录（也就是 qqbot 插件本体）。
 *
 * 找不到时不会抛错，但会在日志里列出**试过的每一处**——以前只打一句「没找到」，
 * 于是插件在第一步静默退出，花很久才定位到「候选列表缺 profiles/<name>/node_modules」。
 *
 * @param {object} config 插件配置
 * @param {object} logger 日志
 * @param {{selfFile?: string, cwd?: string, fallbackHome?: string}} [opts] 测试用注入点
 * @returns {{pkg: object, dir: string, file: string} | null}
 */
export function findQqbotPackage(config = DEFAULT_CONFIG, logger = console, opts = {}) {
  const candidates = qqbotCandidates(config, opts);
  for (const c of candidates) {
    const hit = readPkg(c);
    if (hit?.pkg?.name === QQBOT_PKG) return hit;
  }

  const layout = locateSelfLayout(opts.selfFile ?? SELF_FILE);
  const shown = candidates.slice(0, 12).map((c) => `\n  - ${c}`).join('');
  const rest = candidates.length > 12 ? `\n  - …另有 ${candidates.length - 12} 处` : '';
  logger.warn?.(
    `[qqbot-guard] 没找到 ${QQBOT_PKG}，补丁不会生效（关键词放行、历史附件都不可用）。` +
      `\n  本插件在 ${layout.dir || '(未知)'}，共试了 ${candidates.length} 处：${shown}${rest}` +
      `\n  可用 config.qqbotPackage 或环境变量 DSH_QQBOT_DIR 指定它的安装目录。`,
  );
  return null;
}

/**
 * 定位 SDK 的真实文件，保证和 qqbot 拿到的是同一个模块实例。
 *
 * 不能用 createRequire(...).resolve：qqbot-nodejs 的 exports 只有 "import"，
 * CJS 解析器会直接抛 ERR_PACKAGE_PATH_NOT_EXPORTED（实测 Node 24）。
 * 这里按 Node 的 node_modules 向上查找规则手工定位，再读它自己的 exports 映射。
 */
export function resolveSdk(qqbotDir) {
  const segments = SDK_PKG.split('/');
  let dir = qqbotDir;
  let pkgHit = null;
  while (dir && dir !== dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...segments);
    const hit = readPkg(candidate);
    if (hit?.pkg?.name === SDK_PKG) {
      pkgHit = hit;
      break;
    }
    dir = dirname(dir);
  }
  if (!pkgHit) {
    throw new Error(`从 ${qqbotDir} 向上找不到 ${SDK_PKG} 的安装位置`);
  }
  const exp = pkgHit.pkg.exports?.['.'];
  const target =
    (typeof exp === 'string' ? exp : exp?.import ?? exp?.default ?? exp?.require) ??
    pkgHit.pkg.module ??
    pkgHit.pkg.main ??
    './dist/index.js';
  const entry = join(pkgHit.dir, target);
  if (!existsSync(entry)) {
    throw new Error(`${SDK_PKG} 入口不存在：${entry}`);
  }
  return { entry, pkgFile: pkgHit.file, version: pkgHit.pkg.version, dir: pkgHit.dir };
}

// ────────────────────────── guard 中间件 ──────────────────────────

/**
 * QQ 表情 id → emoji。与 `qqbot-nodejs` 的 `content-sanitizer` 用的同一张表：
 * 那张表只在**老格式** `[<face,id=N/>]` 分支里用到，新格式分支只看 `<faceType>` 里的
 * `ext.text`，于是 `ext` 为空（QQ 只下发 `{"text":""}`）时就退化成「未知表情」。
 * 注意：新格式的 `faceId` 与本表的 id 是否同一命名空间，上游没有任何文档或代码证据，
 * 这里按同一套编号猜——猜错只是 emoji 不对，不会丢信息（正文里的 ext 本身就没内容）。
 */
const FACE_EMOJI = {
  0: '😊', 1: '😣', 2: '😍', 4: '😎', 5: '😭', 6: '😳', 7: '🤐', 8: '😴',
  9: '😢', 10: '😰', 11: '😡', 12: '🤗', 13: '⭐', 14: '🌟', 15: '🌙',
  16: '👍', 18: '✊', 21: '😊', 23: '😢', 25: '🤔', 26: '😱', 27: '😅',
  28: '😁', 29: '🤮', 30: '💪', 32: '🎉', 33: '😤', 34: '😏', 35: '🥺',
  49: '🐷', 53: '🎂', 60: '☕', 63: '🌹', 66: '❤️', 74: '🌞', 75: '🌛',
  76: '👏', 78: '🤝', 79: '✌️', 85: '🎅', 89: '🍉', 96: '😓', 97: '😲',
  100: '😂', 101: '😊', 104: '😭', 106: '😱', 109: '😘', 111: '🥰',
};

/** `<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">` */
const FACE_TAG_NEW = /<faceType=\d+,faceId="([^"]*)",ext="([^"]*)">/g;
/** 老格式 `[<face,id=6/>]`；上游 sanitizer 也会处理，这里先手换掉避免历史里留下标签 */
const FACE_TAG_OLD = /\[<face,id=(\d+)\/?>]/g;

/**
 * 把表情标签换成可读文本。
 *
 * 优先用 `ext` 里 QQ 下发的表情名；没有名字就统一给 `[表情]`，
 * 不按 `faceId` 猜 emoji（实测 faceId=0 配空文本 = 收藏表情包，猜出来的语义是错的）。
 * 只做字符串替换，不抛异常（`ext` 是外部数据）。
 *
 * @param {string} text 原始正文
 * @returns {string} 替换后的正文
 */
export function normalizeFaces(text) {
  if (typeof text !== 'string' || text === '') return text;
  return text
    .replace(FACE_TAG_NEW, (match, _faceId, ext) => {
      let name = '';
      try {
        const decoded = Buffer.from(ext ?? '', 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        name = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
      } catch {
        // ext 不是合法 base64/JSON：当作没有名字
      }
      if (name) return name;
      // ext.text 为空：多半是用户收藏的表情包（本体在图片附件里），
      // 实测 faceId=0 配空文本就是这种情况，按 faceId 猜 emoji 会给出错误语义，
      // 所以这里只给一个中性的占位符。
      return '[表情]';
    })
    .replace(FACE_TAG_OLD, (_match, id) => FACE_EMOJI[String(id)] ?? '[表情]');
}

const ATTACHMENT_LABEL = { image: '图片', voice: '语音', video: '视频', file: '文件' };

/**
 * 给历史条目拼一句附件摘要。
 *
 * `historyBuffer` 只把 `content` 落库（senderId/senderName/content/timestamp/messageId），
 * 所以纯图片/纯文件的消息在历史里是一条空行。这里补成 `[图片「a.png」]`。
 *
 * @param {Array} attachments qqbot 解析后的附件数组
 * @returns {string} 形如 ` [图片「a.png」、语音]`，无附件时返回空串
 */
/**
 * 找附件真正落在磁盘上的位置。
 *
 * 上游 `attachment.js` 的落盘名是 `<原名去扩展>_<Date.now()>_<8位hex><ext>`，
 * 后缀带时间戳和随机数，**写历史的时候算不出来**（而且下载本身就晚于历史落库），
 * 所以只能事后按 `<原名>_*` 前缀去 media 目录里匹配，取 mtime 最新的那个。
 *
 * @param {string} mediaRoot 媒体目录（qqbot 的 MEDIA_ROOT，默认 ~/.dsh-qqbot/media）
 * @param {string} filename QQ 下发的原始文件名
 * @returns {string} POSIX 风格绝对路径；找不到返回空串
 */
function resolveMediaPath(mediaRoot, filename) {
  if (!mediaRoot || typeof filename !== 'string' || filename === '') return '';
  try {
    // 与上游 attachment.js:45 sanitizeFilename 保持一致：只换文件系统非法字符 + NFC
    const base = String(filename).replace(/\\/g, '/').split('/').pop() ?? '';
    const safe = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim().normalize('NFC') || 'attachment';
    const dot = safe.lastIndexOf('.');
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : '';
    const candidates = readdirSync(mediaRoot).filter(
      (n) => n.startsWith(`${stem}_`) && n.endsWith(ext),
    );
    if (candidates.length === 0) return '';
    let best = '';
    let bestTime = -1;
    for (const n of candidates) {
      const stat = statSync(join(mediaRoot, n));
      if (stat.mtimeMs > bestTime) {
        bestTime = stat.mtimeMs;
        best = n;
      }
    }
    // inbound 注入的路径是 POSIX 风格（renderMediaLine），这里保持一致
    return `${mediaRoot.replace(/\\/g, '/').replace(/\/$/, '')}/${best}`;
  } catch {
    // 目录不存在 / 没权限：不标路径即可，不影响摘要
    return '';
  }
}

/**
 * 把附件列表压成一句摘要，给群历史用。
 * @param {Array} attachments msg.attachments（或存下来的精简副本）
 * @param {string} [mediaRoot] 给了就顺带标注本地路径
 */
export function summarizeAttachments(attachments, mediaRoot = '') {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = [];
  for (const att of attachments) {
    const label = ATTACHMENT_LABEL[att?.type] ?? '附件';
    const name = att?.filename ?? att?.voiceText ?? '';
    if (!name) {
      parts.push(label);
      continue;
    }
    const raw = att?.localPath || resolveMediaPath(mediaRoot, att?.filename ?? '');
    // 落盘路径统一成 POSIX，跟 inbound 注入的 `- Image:` 保持一致
    const path = raw ? raw.replace(/\\/g, '/') : '';
    parts.push(path ? `${label}「${name}」@${path}` : `${label}「${name}」`);
  }
  return parts.length > 0 ? ` [${parts.join('、')}]` : '';
}

/** 正则字面量转义：appId 是纯数字，但配置里可能塞奇怪东西，别让它变成正则元字符 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 给消息补一条“自己 @ 了 bot”的 mention。
 * mentionGate 认 `mentions[].is_you`，slashCommand 也认；historyBuffer 只存正文，所以这样最干净。
 */
function markMention(msg, extra = {}) {
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
  if (!mentions.some((m) => m?.is_you === true)) {
    mentions.push({ is_you: true, ...extra });
  }
  msg.mentions = mentions;
}

/**
 * 真正的门禁逻辑。挂在中间件链头部，做两件事：
 * 1. 正文里的表情标签换成可读文本（历史与当前消息都受益）；
 * 2. 群聊命中关键词时给 `msg.mentions` 补 `{ is_you: true }`，让下游 mentionGate
 *    判成“被 @”，从而放行并拼上群历史。**绝不改 `msg.content`**（历史会被污染）。
 */
export function createGuard(
  config = DEFAULT_CONFIG,
  logger = console,
  notes = new Map(),
  mediaDownloader = null,
) {
  const triggers = (config.triggers ?? []).filter((t) => typeof t === 'string' && t.length > 0);
  const ignoreCase = config.ignoreCase !== false;
  const faces = config.faces !== false;
  const historyAttachments = config.historyAttachments !== false;

  return async function qqbotGuard(ctx, next) {
    try {
      const msg = ctx?.message;
      if (faces && typeof msg?.content === 'string') {
        const normalized = normalizeFaces(msg.content);
        if (normalized !== msg.content) msg.content = normalized;
      }
      if (historyAttachments && msg?.kind === 'group' && msg?.messageId) {
        if (summarizeAttachments(msg.attachments)) {
          if (notes.size > 200) notes.clear();
          // 附件得在这里就落盘：qqbot 的 attachmentProcessor 排在 mentionGate 之后，
          // 没触发关键词的群消息根本走不到那一步，历史里就只剩文件名、点不开。
          let paths = new Map();
          if (mediaDownloader) {
            try {
              paths = (await mediaDownloader(msg.attachments)) ?? new Map();
            } catch (err) {
              logger.warn?.(`[qqbot-guard] 附件预下载失败（已忽略）: ${err?.message ?? err}`);
            }
          }
          notes.set(
            msg.messageId,
            msg.attachments.slice(0, 6).map((a) => ({
              type: a?.type,
              filename: a?.filename,
              voiceText: a?.voiceText,
              localPath: paths.get?.(a?.filename) ?? '',
            })),
          );
        }
      }
      // 只处理群聊；私聊本来就 alwaysAnswer
      if (msg?.kind === 'group') {
        const appId = ctx?.bot?.appId;
        let raw = typeof msg.content === 'string' ? msg.content : '';
        // 真实 @bot：把 `<@appId>` 从正文挪进 mentions。
        // historyBuffer 在门控之前记录 content，标记留在正文里会被拼进群历史。
        if (appId) {
          const selfTag = new RegExp(`<@!?${escapeRegExp(appId)}>\\s*`, 'g');
          if (selfTag.test(raw)) {
            markMention(msg, { is_you: true });
            raw = raw.replace(selfTag, '').trim();
            msg.content = raw;
            logger.debug?.('[qqbot-guard] 已把 <@appId> 移进 mentions');
          }
        }
        if (triggers.length > 0 && raw) {
          const already = Array.isArray(msg.mentions) && msg.mentions.some((m) => m?.is_you === true);
          if (!already) {
            const hay = ignoreCase ? raw.toLowerCase() : raw;
            const hit = triggers.find((t) => hay.includes(ignoreCase ? t.toLowerCase() : t));
            if (hit) {
              markMention(msg, { is_you: true, guarded: true });
              ctx.state = ctx.state ?? {};
              ctx.state.qqbotGuard = { trigger: hit };
              logger.debug?.(`[qqbot-guard] keyword "${hit}" → 伪造 mentions.is_you，放行`);
            }
          }
        }
      }
    } catch (err) {
      // 门禁本身绝不把消息链路带崩
      logger.error?.(`[qqbot-guard] guard 异常（已忽略）: ${err?.message ?? err}`);
    }
    await next();
  };
}

const STORE_PATCH_FLAG = Symbol.for('qqbot-guard.historyStore');

/**
 * 让群历史带上附件摘要。
 *
 * 做法：包装共享 `HistoryStore.append`，把 guard 在链头算好的附件摘要拼进 `content`
 * 后再落库。只影响历史条目，不动 `ctx.message.content`（当前消息仍由 inbound 用
 * `Image: /path` 正常渲染）。幂等：打过的 store 不会重复包装。
 *
 * @param {object} store history store 单例
 * @param {Map<string, string>} notes messageId → 附件摘要
 * @param {object} logger 日志
 * @returns {boolean} 是否已安装（含“本来就有”）
 */
/**
 * 包装共享 history store 的 `list()`：读出历史时给带附件的条目补一句摘要。
 *
 * 改 `list` 而不是 `append` 的原因：本地路径要等附件下载完才存在，
 * 而 `downloadMediaAttachments()` 在中间件链之后才跑，落库那一刻根本拿不到路径。
 *
 * @param {object} store getHistoryStore() 返回的单例
 * @param {Map<string, Array>} notes messageId → 附件数组
 * @param {object} [logger]
 * @param {{mediaRoot?: string}} [options] mediaRoot：媒体目录，用来把路径补回去
 */
export function patchHistoryStore(store, notes, logger = console, options = {}) {
  if (!store || typeof store.list !== 'function') return false;
  if (store[STORE_PATCH_FLAG]) {
    const state = store[STORE_PATCH_FLAG];
    state.notes = notes;
    if (options.mediaRoot) state.mediaRoot = options.mediaRoot;
    return true;
  }
  const baseList = store.list.bind(store);
  const state = { notes, mediaRoot: options.mediaRoot ?? '' };
  const patched = function list(key, limit) {
    const entries = baseList(key, limit) ?? [];
    if (!state.notes || state.notes.size === 0) return entries;
    return entries.map((entry) => {
      try {
        const attachments = state.notes.get(entry?.messageId);
        if (!attachments) return entry;
        const content = typeof entry.content === 'string' ? entry.content : '';
        // 已经带过附件标注的条目不再重复追加
        if (content.includes('[图片「') || content.includes('[附件「')) return entry;
        const suffix = summarizeAttachments(attachments, state.mediaRoot);
        return suffix ? { ...entry, content: `${content}${suffix}` } : entry;
      } catch (err) {
        logger.warn?.(`[qqbot-guard] 历史附件标注失败（已忽略）: ${err?.message ?? err}`);
        return entry;
      }
    });
  };
  patched[STORE_PATCH_FLAG] = state;
  store.list = patched;
  store[STORE_PATCH_FLAG] = state;
  return true;
}

/**
 * 造一个“把附件下到本地”的函数，复用 qqbot 自己的下载器（落盘规则、体积上限都一致）。
 *
 * 为什么要预下载：qqbot 的 `attachmentProcessor` 是链上第 13 层，排在 mentionGate（第 5 层）
 * 后面；群里没触发关键词的消息被门控拦下，压根走不到下载那一步，于是历史里只有文件名。
 *
 * @param {string} qqbotDir dsh-qqbot 包目录
 * @param {object} cfg 插件配置
 * @param {object} log logger
 * @returns {((attachments: Array) => Promise<Map<string, string>>) | null}
 */
function makeMediaDownloader(qqbotDir, cfg, log) {
  if (cfg.historyMedia === false) return null;
  let impl = null;
  return async function downloadAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return new Map();
    if (!impl) {
      try {
        const mod = await import(
          pathToFileURL(join(qqbotDir, 'dist', 'transport', 'attachment.js')).href
        );
        impl = typeof mod.downloadMediaAttachments === 'function' ? mod.downloadMediaAttachments : null;
      } catch (err) {
        log.warn?.(`[qqbot-guard] 找不到 qqbot 的下载器，历史附件不落盘: ${err?.message ?? err}`);
        impl = null;
      }
      if (!impl) return new Map();
    }
    const media = { enabled: true, maxMB: cfg.historyMediaMaxMB ?? 20 };
    const files = await impl(attachments, media, log);
    return new Map((files ?? []).map((f) => [f.filename, f.localPath]));
  };
}

// ────────────────────────── 补丁安装 ──────────────────────────

/**
 * 给 QQBot 类打懒注入补丁。
 * 幂等：重复调用（含 HMR 重载）只装一次。
 * @returns {{ installed: boolean, restored?: () => void, reason?: string }}
 */
export function installGuard(QQBot, guard, logger = console) {
  if (typeof QQBot?.prototype?.handleInboundMessage !== 'function') {
    return { installed: false, reason: 'QQBot.prototype.handleInboundMessage 不存在，版本可能已变' };
  }
  const current = QQBot.prototype.handleInboundMessage;
  if (current?.[PATCH_FLAG]) {
    current.guard = guard; // 热重载时换用新的 guard 实例
    return { installed: true, reason: 'already-patched' };
  }

  const original = current;
  const patched = function handleInboundMessage(raw, ...rest) {
    try {
      if (!this.__qqbotGuardInstalled) {
        if (Array.isArray(this.middlewares)) {
          this.middlewares.unshift(patched.guard);
          this.__qqbotGuardInstalled = true;
          logger.debug?.('[qqbot-guard] 已挂载到中间件链头部');
        }
      }
    } catch (err) {
      logger.error?.(`[qqbot-guard] 挂载失败: ${err?.message ?? err}`);
    }
    return original.call(this, raw, ...rest);
  };
  patched[PATCH_FLAG] = true;
  patched.guard = guard;
  patched.original = original;

  QQBot.prototype.handleInboundMessage = patched;
  return {
    installed: true,
    restored: () => {
      if (QQBot.prototype.handleInboundMessage === patched) {
        QQBot.prototype.handleInboundMessage = original;
      }
    },
  };
}

// ────────────────────────── cordis 插件入口 ──────────────────────────

export async function apply(ctx, config) {
  const log = pickLogger(ctx);
  const cfg = mergeConfig(config, log);

  if (cfg.enabled === false) {
    log.info('[qqbot-guard] enabled=false，跳过（qqbot 行为保持原样）');
    return;
  }

  const qqbot = findQqbotPackage(cfg, log);
  if (!qqbot) return;

  let sdkInfo;
  try {
    sdkInfo = resolveSdk(qqbot.dir);
  } catch (err) {
    log.error(`[qqbot-guard] 解析 ${SDK_PKG} 失败: ${err?.message ?? err}`);
    return;
  }

  const sdkVersion = parseVersion(sdkInfo.version);
  const supported =
    sdkVersion && cmp(sdkVersion, SDK_MIN) >= 0 && cmp(sdkVersion, SDK_MAX_EXCLUSIVE) < 0;
  if (!supported) {
    const msg = `[qqbot-guard] ${SDK_PKG} 版本 ${sdkInfo.version ?? '未知'} 不在白名单 ${SDK_MIN.join('.')}~<${SDK_MAX_EXCLUSIVE.join('.')}`;
    if (cfg.strictVersion) {
      log.error(`${msg}；strictVersion=true，放弃安装`);
      return;
    }
    log.warn(`${msg}；仍尝试安装（内部只用公开字段 middlewares / handleInboundMessage，多半可用）`);
  }

  let sdk;
  try {
    sdk = await import(pathToFileURL(sdkInfo.entry).href);
  } catch (err) {
    // 退回按包名解析，尽量拿同一个实例（可能因 realpath 不同而失效）
    try {
      sdk = await import(SDK_PKG);
      log.warn(`[qqbot-guard] 按路径导入失败，已回退到裸包名导入：${err?.message ?? err}`);
    } catch (err2) {
      log.error(`[qqbot-guard] 导入 ${SDK_PKG} 失败: ${err2?.message ?? err2}`);
      return;
    }
  }

  const notes = new Map();
  const mediaDownloader = makeMediaDownloader(qqbot.dir, cfg, log);
  const guard = createGuard(cfg, log, notes, mediaDownloader);
  const result = installGuard(sdk.QQBot, guard, log);
  if (!result.installed) {
    log.error(`[qqbot-guard] 补丁未安装：${result.reason}`);
    return;
  }

  let historyPatched = false;
  let mediaRoot = '';
  if (cfg.historyAttachments !== false) {
    try {
      const storeMod = await import(
        pathToFileURL(join(qqbot.dir, 'dist', 'features', 'history-store.js')).href
      );
      // 附件落盘的目录：上游从 media-cleaner 导出 MEDIA_ROOT（~/.dsh-qqbot/media），
      // 拿不到就按同一个默认值兜底（路径标注是锦上添花，失败不影响摘要）。
      try {
        const mediaMod = await import(
          pathToFileURL(join(qqbot.dir, 'dist', 'media', 'media-cleaner.js')).href
        );
        mediaRoot = typeof mediaMod.MEDIA_ROOT === 'string' ? mediaMod.MEDIA_ROOT : '';
      } catch {
        mediaRoot = join(homedir(), '.dsh-qqbot', 'media');
      }
      historyPatched = patchHistoryStore(storeMod.getHistoryStore?.(), notes, log, { mediaRoot });
      if (!historyPatched) log.warn('[qqbot-guard] 没找到 history store，历史附件摘要未启用');
    } catch (err) {
      log.warn(`[qqbot-guard] 历史附件摘要未启用: ${err?.message ?? err}`);
    }
  }

  if (cfg.verbose) {
    const cfgFile = resolveConfigFile(cfg);
    log.info(
      `[qqbot-guard] 就绪：qqbot=${qqbot.pkg?.version ?? '?'} sdk=${sdkInfo.version ?? '?'} ` +
        `triggers=${JSON.stringify(cfg.triggers)} 配置源=${existsSync(cfgFile ?? '') ? cfgFile : 'cordis/默认'} ` +
        `表情=${cfg.faces !== false ? '开' : '关'} 历史附件=${historyPatched ? '开' : '关'} ` +
        `注入方式=lazy-unshift + 伪造 mentions（与加载顺序无关）`,
    );
  }

  if (result.restored && typeof ctx?.on === 'function') {
    ctx.on('dispose', () => {
      result.restored();
      log.info('[qqbot-guard] 已卸载补丁');
    });
  }
}
