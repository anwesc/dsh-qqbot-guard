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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
  /**
   * 续聊窗口：关键词/@ 唤醒后，同一个群里不 @ 也能继续接话，
   * 直到最后一条相关消息之后静默 `followUpWindowMinutes` 分钟。
   */
  followUpEnabled: true,
  /** 窗口静默多久自动关闭（分钟）；窗口只活在内存里，插件重启即消失 */
  followUpWindowMinutes: 10,
  /** 一个窗口最多接几条相关消息（0 = 不限）；到量时本条仍放行，随后关窗 */
  followUpMaxTurns: 0,
  /**
   * 短时间内连着来好几条时，先攒一批、只问一次判定（0 = 不合并，逐条判定）。
   * 汇总只影响「判不判相关」，放行后仍是一条消息一轮、分别回复。
   */
  followUpBurstMs: 1200,
  /** 一批最多攒几条（2~50）；攒满或超字数立即判定，不再等窗口 */
  followUpBurstMax: 12,
  /**
   * 刷屏保护：窗口内消息数超过 followUpFloodMax 就进入「刷屏模式」，
   * 安静 followUpFloodCooldownMs 后自动退出。只影响续聊判定路径，@/关键词照常放行。
   */
  followUpFloodWindowMs: 10000,
  followUpFloodMax: 15,
  followUpFloodCooldownMs: 25000,
  /** 刷屏时怎么办：select = 只回判定挑中的相关消息（默认），skip = 整段不回 */
  followUpFloodAction: 'select',
  /** 一批达到几条才让判定模型挑「相关编号」；比这少仍按整体 1/0 判 */
  followUpSelectMin: 5,
  /** 判定用的模型；两项都留空时自动跟随 qqbot 当前会话模型，只填一项会尽量与默认模型拼成一对 */
  followUpJudgeProvider: '',
  followUpJudgeModel: '',
  /** 单次判定超时（毫秒），超时按失败策略处理 */
  followUpJudgeTimeoutMs: 6000,
  /** 判定失败（报错/超时/答非所问）时：skip = 不接（默认），reply = 仍然接 */
  followUpOnJudgeError: 'skip',
  /**
   * 群聊回复时带引用框（message_reference，引用被回复的那条消息）。
   * 默认关：qqbot 的 sendMarkdown 不透传这个字段，插件要改走 send()；
   * 平台是否接受「msg_id + message_reference」同时传需要真群验证，属于体验增强。
   */
  followUpQuoteReply: false,
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

/** 设置页可以改的布尔开关。`configFile` 不在此列：让 UI 改自己的配置路径容易把用户锁死。 */
const BOOLEAN_KEYS = [
  'enabled',
  'ignoreCase',
  'faces',
  'historyAttachments',
  'historyMedia',
  'followUpEnabled',
  'followUpQuoteReply',
  'verbose',
  'strictVersion',
];

/**
 * 归一化设置页提交的配置片段：只接受已知字段，字段值不合法时抛出带说明的错误。
 * @param {unknown} input 请求体里的 JSON
 * @returns {object} 只含已知字段的配置片段
 */
export function sanitizeConfigPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('配置必须是一个 JSON 对象');
  }
  const out = {};
  for (const key of BOOLEAN_KEYS) {
    if (Object.hasOwn(input, key)) out[key] = Boolean(input[key]);
  }
  if (Object.hasOwn(input, 'triggers')) {
    if (!Array.isArray(input.triggers)) throw new Error('triggers 必须是字符串数组');
    const list = input.triggers.map((t) => String(t ?? '').trim()).filter(Boolean);
    out.triggers = [...new Set(list)];
  }
  if (Object.hasOwn(input, 'historyMediaMaxMB')) {
    const mb = Number(input.historyMediaMaxMB);
    if (!Number.isFinite(mb) || mb <= 0 || mb > 1024) {
      throw new Error('historyMediaMaxMB 需要 0~1024 之间的数字');
    }
    out.historyMediaMaxMB = mb;
  }
  if (Object.hasOwn(input, 'qqbotPackage')) {
    out.qqbotPackage = String(input.qqbotPackage ?? '').trim();
  }
  // 续聊窗口的数字项：范围写死，避免设置页把窗口调成 0 或负数后整个功能静默失灵。
  const NUMBER_RULES = {
    followUpWindowMinutes: [1, 1440, '1~1440 分钟'],
    followUpMaxTurns: [0, 1000, '0~1000 条'],
    followUpJudgeTimeoutMs: [500, 60000, '500~60000 毫秒'],
    followUpBurstMs: [0, 5000, '0~5000 毫秒'],
    followUpBurstMax: [2, 50, '2~50 条'],
    followUpFloodWindowMs: [1000, 60000, '1000~60000 毫秒'],
    followUpFloodMax: [1, 200, '1~200 条'],
    followUpFloodCooldownMs: [1000, 600000, '1000~600000 毫秒'],
    followUpSelectMin: [2, 50, '2~50 条'],
  };
  for (const [key, [min, max, label]] of Object.entries(NUMBER_RULES)) {
    if (!Object.hasOwn(input, key)) continue;
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${key} 需要 ${label}之间的整数`);
    }
    out[key] = n;
  }
  for (const key of ['followUpJudgeProvider', 'followUpJudgeModel']) {
    if (Object.hasOwn(input, key)) out[key] = String(input[key] ?? '').trim();
  }
  if (Object.hasOwn(input, 'followUpOnJudgeError')) {
    const policy = String(input.followUpOnJudgeError ?? '').trim();
    if (policy !== 'skip' && policy !== 'reply') {
      throw new Error('followUpOnJudgeError 只能是 skip 或 reply');
    }
    out.followUpOnJudgeError = policy;
  }
  if (Object.hasOwn(input, 'followUpFloodAction')) {
    const action = String(input.followUpFloodAction ?? '').trim();
    if (action !== 'skip' && action !== 'select') {
      throw new Error('followUpFloodAction 只能是 skip 或 select');
    }
    out.followUpFloodAction = action;
  }
  return out;
}

/** 原子写 JSON：先写临时文件再 rename，写一半断电也不会留下半个配置文件。 */
export function writeConfigFile(file, data) {
  if (!file) throw new Error('没有可写的配置文件路径');
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** 读一个纯 JSON 文件；不存在或损坏返回 null。 */
function readJsonFile(file) {
  if (!file || !existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** 文件指纹：mtime + 大小。只改内容不改大小的情况极少，够用。 */
function configStamp(file) {
  if (!file) return 'missing';
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * 配置来源：cordis 之后还能被 JSON 文件覆盖，文件改了要能重读（设置页保存后即时生效）。
 * @param {object} config cordis 里的 config
 * @param {object} logger
 */
export function createConfigSource(config = {}, logger = console) {
  const file = resolveConfigFile(config);
  let stamp = configStamp(file);
  let merged = mergeConfig(config, logger);
  return {
    /** 写回到哪个文件；没有可写路径时为 null */
    file,
    /** 当前生效的配置；文件 mtime/大小变了就重新合并 */
    get() {
      const next = configStamp(file);
      if (next !== stamp) {
        stamp = next;
        merged = mergeConfig(config, logger);
        logger.info?.(`[qqbot-guard] 配置已重新加载：${file}`);
      }
      return merged;
    },
    /** 强制重读（设置页保存后调用，省得等下一次轮询） */
    reload() {
      stamp = configStamp(file);
      merged = mergeConfig(config, logger);
      return merged;
    },
  };
}

/** 本机回环地址的「主机名:端口」；不认识的写法则返回 null。 */
function loopbackAuthority(authority) {
  if (typeof authority !== 'string' || authority === '') return null;
  let url;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') return null;
  return `${host}:${url.port}`;
}

/**
 * 只允许本机回环来源改配置：Host 必须是回环（挡 DNS rebinding），
 * 带 Origin 时还要求同源（挡别的网页用表单 POST 改配置）。
 * 桌面端页面跑在 `dsh-app://` 下，必须显式放行。
 * @param {object} request Node 的 IncomingMessage
 */
export function isSameOrigin(request) {
  const hostKey = loopbackAuthority(request?.headers?.host);
  if (hostKey === null) return false;
  const origin = request?.headers?.origin;
  if (origin === undefined || origin === '') return true;
  try {
    const url = new URL(origin);
    if (url.protocol === 'dsh-app:') return true;
    return loopbackAuthority(url.host) === hostKey;
  } catch {
    return false;
  }
}

const CONFIG_PATH = '/qqbot-guard/config';
const BODY_LIMIT_BYTES = 64 * 1024;

function sendJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

/** 读请求体并按上限保护；超过上限直接断开连接。 */
function readBody(request, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** 设置页要的全部状态：配置、默认值、qqbot 定位结果。 */
function configSnapshot(source, status, explicit = {}) {
  return {
    file: source.file ?? '',
    config: source.get(),
    defaults: DEFAULT_CONFIG,
    status: { ...status },
    // cordis 里的 config 优先级高于 JSON 文件；这些字段改设置页不会生效，得让 UI 说清楚
    overridden: Object.keys(explicit ?? {}),
  };
}

async function handleConfigRequest(request, response, source, log, status, explicit = {}) {
  if (!isSameOrigin(request)) {
    return sendJson(response, 403, { error: '来源不被信任（只允许本机回环地址）' });
  }
  const method = String(request?.method ?? 'GET').toUpperCase();
  try {
    if (method === 'GET') return sendJson(response, 200, configSnapshot(source, status, explicit));
    if (method === 'PUT' || method === 'POST') {
      if (!source.file) return sendJson(response, 400, { error: '没有可写的配置文件（缺少 DSH_HOME）' });
      const patch = sanitizeConfigPatch(JSON.parse(await readBody(request)));
      const next = { ...(readJsonFile(source.file) ?? {}), ...patch };
      writeConfigFile(source.file, next);
      source.reload();
      log.info?.(`[qqbot-guard] 设置页已保存：${source.file}（${Object.keys(patch).join(', ') || '无改动'}）`);
      return sendJson(response, 200, configSnapshot(source, status, explicit));
    }
    return sendJson(response, 405, { error: '不支持的方法' });
  } catch (err) {
    const message = String(err?.message ?? err);
    log.warn?.(`[qqbot-guard] 配置请求失败：${message}`);
    return sendJson(response, 400, { error: message });
  }
}

/**
 * 注册设置页用到的 HTTP 接口。
 * qqbot 没装也要能打开设置页，所以调用点在 `findQqbotPackage` 之前。
 * @returns {boolean} 宿主是否提供了 `inject`（有 webServer 时再异步挂载）
 */
export function installConfigApi(ctx, source, log, status = {}, explicit = {}) {
  if (typeof ctx?.inject !== 'function') return false;
  ctx.inject(['webServer'], (host) => {
    const server = host?.webServer;
    if (!server || typeof server.register !== 'function') {
      log.warn?.('[qqbot-guard] webServer 不可用，设置页接口未注册');
      return;
    }
    const mount = () => {
      const dispose = server.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: (request, response) =>
          handleConfigRequest(request, response, source, log, status, explicit),
      });
      return () => {
        try {
          dispose?.();
        } catch {
          /* 宿主已经在卸载路由了 */
        }
      };
    };
    if (typeof host.effect === 'function') host.effect(mount, 'qqbot-guard: config api');
    else mount();
  });
  return true;
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

// ────────────────────────── 续聊窗口 ──────────────────────────

/** 判定器最多看到几条最近消息（含机器人自己的发言） */
const FOLLOWUP_RECENT_LIMIT = 8;
/** 单条消息进提示词时最多留多少字，防止一条长文吃光预算 */
const FOLLOWUP_TEXT_LIMIT = 240;
/** 整个提示词的字数上限（判定只是二分类，不需要长上下文） */
const FOLLOWUP_PROMPT_LIMIT = 2000;
/**
 * 判定调用的输出预算。deepseek-flash 这类模型会先把思考写进 reasoning_content，
 * max_tokens 太小（实测 64）会被思考吃光、content 为空，解析必然失败；
 * 给 1024 留足「思考 + 一个字符」的空间，实际仍只输出 1/0。
 */
const FOLLOWUP_JUDGE_MAX_TOKENS = 1024;
const FOLLOWUP_MIN_WINDOW_MS = 60_000;
const FOLLOWUP_MAX_WINDOW_MS = 24 * 60 * 60_000;
const FOLLOWUP_DEFAULT_WINDOW_MS = 10 * 60_000;
const FOLLOWUP_MAX_WINDOWS = 500;
/** 一批最多带多少字进判定提示词：攒过头就提前判定，别把一条批拖成小作文 */
const FOLLOWUP_BURST_CHARS = 1200;

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 「续聊窗口」的内存状态：一个群一个窗口。
 *
 * 窗口只负责回答两件事：这个群现在还要不要继续接话、还能接几条。
 * 过期是**惰性**判定的（每次读写时算差值），不挂定时器，进程退出就全没了——
 * 与 qqbot 自己的会话不同，这里丢窗口没有副作用：下一条 @ 或关键词会重新开窗，
 * 群历史和 agent 会话都还在磁盘上。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] 时钟（测试用）
 * @param {number | (() => number)} [options.windowMs] 静默多久关窗；传函数时每条消息实时读配置
 * @param {number | (() => number)} [options.maxTurns] 窗口内最多接几条，0 = 不限
 * @param {number} [options.recentLimit] 最近消息保留条数
 */
export function createFollowUpState(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const windowMs = () => {
    const raw = typeof options.windowMs === 'function' ? options.windowMs() : options.windowMs;
    return Math.min(
      FOLLOWUP_MAX_WINDOW_MS,
      Math.max(FOLLOWUP_MIN_WINDOW_MS, finiteNumber(raw, FOLLOWUP_DEFAULT_WINDOW_MS)),
    );
  };
  const maxTurns = () => {
    const raw = typeof options.maxTurns === 'function' ? options.maxTurns() : options.maxTurns;
    return Math.max(0, Math.floor(finiteNumber(raw, 0)));
  };
  const recentLimit = Math.max(2, Math.floor(finiteNumber(options.recentLimit, FOLLOWUP_RECENT_LIMIT)));
  const windows = new Map();

  const keyOf = (key) => String(key ?? '');

  /** 清掉过期窗口，避免长时间运行后 Map 只增不减 */
  function prune() {
    const t = now();
    const ttl = windowMs();
    for (const [key, win] of windows) {
      if (t - win.lastRelatedAt > ttl) windows.delete(key);
    }
  }

  /** 取一个仍然有效的窗口；过期就地删除并返回 null */
  function get(key) {
    const k = keyOf(key);
    if (!k) return null;
    const win = windows.get(k);
    if (!win) return null;
    if (now() - win.lastRelatedAt > windowMs()) {
      windows.delete(k);
      return null;
    }
    return win;
  }

  function open(key, info = {}) {
    const k = keyOf(key);
    if (!k) return null;
    const t = now();
    const win = {
      key: k,
      openedAt: t,
      lastRelatedAt: t,
      turns: 0,
      failures: 0,
      /** 上一次记失败的批次 id：同一批里的多条消息只记一次失败，避免瞬间凑满 3 次 */
      lastFailureBatch: null,
      trigger: String(info.trigger ?? ''),
      recent: [],
    };
    windows.set(k, win);
    if (windows.size > FOLLOWUP_MAX_WINDOWS) prune();
    return win;
  }

  /**
   * 窗口内接了一条相关消息：续期 + 计数。
   * 达到 maxTurns 时**本条仍算放行**，但窗口立刻关掉（返回 closed=true）。
   * @returns {{ turns: number, closed: boolean } | null} 窗口不存在/已过期时返回 null
   */
  function touch(key) {
    const win = get(key);
    if (!win) return null;
    win.lastRelatedAt = now();
    win.turns += 1;
    const limit = maxTurns();
    const closed = limit > 0 && win.turns >= limit;
    if (closed) windows.delete(win.key);
    return { turns: win.turns, closed };
  }

  function close(key) {
    return windows.delete(keyOf(key));
  }

  /** 记一条群聊上文；只有窗口开着才记（关窗后的闲聊不占内存） */
  function remember(key, entry = {}) {
    const win = get(key);
    if (!win) return false;
    const text = String(entry.text ?? '').replace(/\s+/g, ' ').trim().slice(0, FOLLOWUP_TEXT_LIMIT);
    if (!text) return false;
    win.recent.push({
      role: entry.role === 'bot' ? 'bot' : 'user',
      name: String(entry.name ?? '').slice(0, 32),
      text,
      at: finiteNumber(entry.at, now()),
      refIdx: String(entry.refIdx ?? ''),
    });
    if (win.recent.length > recentLimit) win.recent.splice(0, win.recent.length - recentLimit);
    return true;
  }

  function recent(key) {
    const win = get(key);
    return win ? win.recent.map((e) => ({ ...e })) : [];
  }

  /** 这条引用指向的是不是机器人刚发的消息（靠出站补丁记下的 ref_idx） */
  function matchesBotRef(key, refIdx) {
    const ref = String(refIdx ?? '');
    if (!ref) return false;
    const win = get(key);
    if (!win) return false;
    return win.recent.some((e) => e.role === 'bot' && e.refIdx === ref);
  }

  function stats(key) {
    const win = get(key);
    if (!win) return null;
    return {
      openedAt: win.openedAt,
      lastRelatedAt: win.lastRelatedAt,
      turns: win.turns,
      failures: win.failures,
      remainingMs: Math.max(0, windowMs() - (now() - win.lastRelatedAt)),
    };
  }

  function size() {
    return windows.size;
  }

  function clear() {
    windows.clear();
  }

  return { get, open, touch, close, remember, recent, matchesBotRef, stats, size, prune, clear };
}

/** 判定批次 id 全局递增：热重载会新建 batcher，但窗口状态可能被复用，不能各自从 1 数 */
let BATCH_SEQ = 0;
function nextBatchId() {
  BATCH_SEQ += 1;
  return BATCH_SEQ;
}

/**
 * 短时间消息批量判定器。
 *
 * 第一条消息到达后先等 `windowMs`，期间到达的并入同一批；攒满 `maxItems`
 * 或超 `maxChars` 时立即判定；`flush(key)` 可以强制提前判定。
 * 一批只调用一次 `decide(items, key)`，所有等待者拿到同一个结论。
 *
 * `add()` 永不 reject：判定失败以 `{ verdict: null, error }` 返回，
 * 让调用方按 `followUpOnJudgeError` 决定放不放行。
 */
export function createBurstBatcher(options = {}) {
  const windowMs = () => {
    const raw = typeof options.windowMs === 'function' ? options.windowMs() : options.windowMs;
    return Math.max(0, Math.min(5000, finiteNumber(raw, 1200)));
  };
  const maxItems = () => {
    const raw = typeof options.maxItems === 'function' ? options.maxItems() : options.maxItems;
    return Math.max(2, Math.min(50, Math.floor(finiteNumber(raw, 12))));
  };
  const maxChars = Math.max(200, Math.floor(finiteNumber(options.maxChars, FOLLOWUP_BURST_CHARS)));
  const decide = typeof options.decide === 'function' ? options.decide : null;
  const batches = new Map();

  function start(key) {
    const batch = { id: nextBatchId(), key, items: [], waiters: [], chars: 0, timer: null, started: false };
    batches.set(key, batch);
    batch.timer = setTimeout(() => {
      void run(batch);
    }, windowMs());
    // 不要 unref：批次还没判完时事件循环就空了，Node 22 的 test runner 会直接判
    // "Promise resolution is still pending but the event loop has already resolved"
    // 并取消后面的用例；这个定时器最多活一个窗口（几百毫秒到几秒），不必省。
    return batch;
  }

  function settle(batch, result) {
    const waiters = batch.waiters;
    const items = batch.items;
    batch.waiters = [];
    batch.items = [];
    waiters.forEach((resolve, i) => {
      // 每条等待者拿到自己在批里的序号（1-based），select 模式据此判断「这条被挑中没有」。
      resolve({ ...result, index: i + 1, count: result.count ?? items.length });
    });
  }

  function run(batch) {
    if (batch.started) return batch.promise;
    batch.started = true;
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    if (batches.get(batch.key) === batch) batches.delete(batch.key);
    const items = batch.items.slice();
    batch.promise = (async () => {
      const outcome = { batchId: batch.id, count: items.length, verdict: null, selected: null, error: null };
      if (items.length === 0) return outcome;
      if (!decide) {
        outcome.error = new Error('没有配置判定函数');
      } else {
        try {
          // decide 可以返回布尔（逐条判定的老约定），也可以返回 {verdict, selected}
          const decision = await decide(items, batch.key);
          const verdict =
            decision && typeof decision === 'object' && !Array.isArray(decision)
              ? decision.verdict
              : decision;
          outcome.verdict = verdict === true ? true : verdict === false ? false : null;
          outcome.selected = Array.isArray(decision?.selected) ? decision.selected : null;
          if (outcome.verdict === null) outcome.error = new Error('判定结果无法解析');
        } catch (err) {
          outcome.error = err instanceof Error ? err : new Error(String(err));
        }
      }
      settle(batch, outcome);
      return outcome;
    })();
    return batch.promise;
  }

  function add(key, item) {
    const k = String(key ?? '');
    if (!k) {
      return Promise.resolve({ batchId: 0, count: 0, verdict: null, error: new Error('没有群标识') });
    }
    const batch = batches.get(k) ?? start(k);
    return new Promise((resolve) => {
      batch.items.push(item);
      batch.chars += String(item?.text ?? '').length;
      batch.waiters.push(resolve);
      if (batch.items.length >= maxItems() || batch.chars >= maxChars) void run(batch);
    });
  }

  /** 强制把某个群当前攒着的这批立刻判定；没有待判定的返回 null */
  async function flush(key) {
    const batch = batches.get(String(key ?? ''));
    return batch ? run(batch) : null;
  }

  function size() {
    return batches.size;
  }

  function clear() {
    for (const batch of batches.values()) {
      if (batch.timer) clearTimeout(batch.timer);
      settle(batch, {
        batchId: batch.id,
        count: batch.items.length,
        verdict: null,
        error: new Error('批量判定已中止'),
      });
    }
    batches.clear();
  }

  return { add, flush, size, clear };
}

/**
 * 按群串行：上一条消息的 `fn`（内部会 `await next()`）跑完，才轮下一条。
 *
 * 用来实现「分消息回复」：批量判定后如果同时放行，qqbot 的 concurrencyGuard
 * 会把仍在处理中的消息 merge 成一个 ctx，只回一次；排成队一条条过，
 * 每条都能独立成一轮、各回各的。
 */
export function createTurnQueue() {
  const tails = new Map();

  function run(key, fn) {
    const k = String(key ?? '');
    const previous = tails.get(k) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const tracked = current
      .catch(() => {})
      .then(() => {
        if (tails.get(k) === tracked) tails.delete(k);
      });
    tails.set(k, tracked);
    return current;
  }

  function size() {
    return tails.size;
  }

  function clear() {
    tails.clear();
  }

  return { run, size, clear };
}

/**
 * 刷屏断路器。
 *
 * 每个群记一串最近的到达时间；`windowMs` 内条数达到 `maxItems` 就进入冷却
 * `cooldownMs`，这期间判定路径上的消息直接不回（fast path 的 @/关键词不拦）。
 * 每次进入冷却会把 `epoch` +1：排队等着放行的旧消息看到代次变了就自己丢弃，
 * 免得冷却结束后把积压的几十条一次性倒出来。
 */
export function createFloodGate(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const windowMs = () =>
    Math.max(1000, Math.min(60_000, finiteNumber(
      typeof options.windowMs === 'function' ? options.windowMs() : options.windowMs,
      10_000,
    )));
  const maxItems = () =>
    Math.max(1, Math.min(200, Math.floor(finiteNumber(
      typeof options.maxItems === 'function' ? options.maxItems() : options.maxItems,
      15,
    ))));
  const cooldownMs = () =>
    Math.max(1000, Math.min(600_000, finiteNumber(
      typeof options.cooldownMs === 'function' ? options.cooldownMs() : options.cooldownMs,
      25_000,
    )));
  const gates = new Map();

  function state(key) {
    let st = gates.get(key);
    if (!st) {
      st = { hits: [], until: 0, epoch: 0 };
      gates.set(key, st);
    }
    return st;
  }

  /**
   * 记一次到达，返回这一刻的状态。
   * `triggered` 表示这一条把窗口打满了（刚进入冷却），`remainingMs` 是冷却剩余时间。
   */
  function observe(key) {
    const k = String(key ?? '');
    if (!k) return { flooding: false, triggered: false, epoch: 0, remainingMs: 0 };
    const st = state(k);
    const t = now();
    st.hits = st.hits.filter((at) => t - at < windowMs());
    st.hits.push(t);
    let triggered = false;
    if (st.hits.length >= maxItems()) {
      triggered = true;
      st.hits = [];
      st.until = t + cooldownMs();
      st.epoch += 1;
    }
    return {
      flooding: t < st.until,
      triggered,
      epoch: st.epoch,
      remainingMs: Math.max(0, st.until - t),
    };
  }

  function isFlooding(key) {
    return now() < state(String(key ?? '')).until;
  }

  function epoch(key) {
    return state(String(key ?? '')).epoch;
  }

  function clear() {
    gates.clear();
  }

  return { observe, isFlooding, epoch, size: () => gates.size, clear };
}

/** 群的窗口键：qqbot 的群消息带 groupOpenid，测试里也可能只给 peerId */
function followUpKey(msg) {
  const key = msg?.groupOpenid ?? msg?.peerId ?? '';
  return typeof key === 'string' ? key : String(key ?? '');
}

/** 取引用消息的正文与「是不是在引用机器人」；msgElements 是 QQ 下发的原始引用内容 */
function quotedBotInfo(msg, appId, isBotRef) {
  const rawRef = msg?.refMsgIdx;
  const refIdx = rawRef === undefined || rawRef === null ? '' : String(rawRef);
  if (refIdx && isBotRef?.(refIdx) === true) return { quotedBot: true, refIdx, text: '' };
  const element = Array.isArray(msg?.msgElements) ? msg.msgElements[0] : null;
  const content = typeof element?.content === 'string' ? element.content.trim() : '';
  if (!content) return { quotedBot: false, refIdx, text: '' };
  const quotedBot = Boolean(appId) && (content.includes(`<@${appId}>`) || content.includes(`<@!${appId}>`));
  return { quotedBot, refIdx, text: content.slice(0, FOLLOWUP_TEXT_LIMIT) };
}

const FOLLOWUP_JUDGE_RULES = [
  '你在判断 QQ 群里的一条新消息，是否属于「机器人（AI）正在参与的同一个话题」。',
  '只判断要不要让机器人接这句话，不要判断这句话本身。',
  '判 1 的情况（满足其一）：',
  '- 在追问、补充、反驳或继续机器人刚才在聊的事；',
  '- 在跟机器人说话（例如接着机器人的提问回答），或明显想让它帮忙；',
  '- 虽然是在回群友，但讨论的还是机器人参与的那个话题。',
  '判 0 的情况（满足其一）：',
  '- 开启了一个与机器人无关的新话题；',
  '- 群友之间的闲聊、刷屏、表情、红包、公告、广告；',
  '- 看不出和机器人刚才的话题有关，或信息不足以判断。',
  '只输出一个字符：1 或者 0。不要解释，不要加代码块。',
].join('\n');

/**
 * 拼判定器的单条用户消息。
 * dsh-llm 的 request-only 输入只支持 user 角色，所以系统规则也塞进同一条消息里，
 * 不依赖 createSystemMessage（本插件零依赖，拿不到 dsh-llm 的构造函数）。
 */
export function buildFollowUpJudgeInput({ recent = [], message = '', sender = '', quotedBot = false } = {}) {
  const lines = [];
  for (const entry of recent) {
    if (!entry?.text) continue;
    const who = entry.role === 'bot' ? '机器人' : entry.name || '群友';
    lines.push(`${who}: ${entry.text}`);
  }
  const head = lines.length > 0 ? `[最近群聊]\n${lines.join('\n')}\n\n` : '';
  const quoteNote = quotedBot ? '（引用了机器人的发言）' : '';
  const body = `${head}[新消息] ${quoteNote}${sender ? `${sender}: ` : ''}${message}`;
  return body.length > FOLLOWUP_PROMPT_LIMIT ? body.slice(body.length - FOLLOWUP_PROMPT_LIMIT) : body;
}

const FOLLOWUP_SELECT_RULES = [
  '你在帮一个 QQ 群机器人过滤刷屏消息。',
  '下面给出当前话题的最近群聊，以及一批新消息（每条带编号）。',
  '判断每条新消息是否仍在延续机器人参与的那个话题：',
  '- 延续（追问、补充、反驳、接着机器人刚说的事，或明显在找它帮忙）→ 保留它的编号；',
  '- 无关（换成别的话题、纯表情、刷屏、公告广告、红包、看不出和机器人有关）→ 不保留。',
  '只输出保留下来的编号，用英文逗号分隔，例如：1,3,7',
  '如果一条都不相关，只输出：0',
  '不要解释，不要加代码块，不要输出其他文字。',
].join('\n');

/** 拼「挑相关消息」的输入：最近群聊 + 编号列表 */
export function buildFollowUpSelectInput({ recent = [], items = [] } = {}) {
  const lines = [];
  for (const entry of recent) {
    if (!entry?.text) continue;
    const who = entry.role === 'bot' ? '机器人' : entry.name || '群友';
    lines.push(`${who}: ${entry.text}`);
  }
  const head = lines.length > 0 ? `[最近群聊]\n${lines.join('\n')}\n\n` : '';
  const rows = items.map((it, i) => {
    const who = it?.sender ? `${it.sender}: ` : '';
    return `[${i + 1}] ${who}${String(it?.text ?? '')}`;
  });
  const body = `${head}[待判断消息]\n${rows.join('\n')}`;
  return body.length > FOLLOWUP_PROMPT_LIMIT ? body.slice(0, FOLLOWUP_PROMPT_LIMIT) : body;
}

/**
 * 解析「挑相关消息」的输出：返回 1-based 编号数组，[] 表示一条都不要，
 * null 表示答非所问（调用方按判定失败处理）。
 */
export function parseFollowUpSelection(text, count) {
  const total = Math.max(0, Math.floor(finiteNumber(count, 0)));
  const cleaned = String(text ?? '')
    .replace(/```[a-z]*|```/gi, '')
    .trim();
  if (cleaned === '') return null;
  const numbers = cleaned.match(/\d+/g);
  if (!numbers) return null;
  const picked = new Set();
  for (const raw of numbers) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= total) picked.add(n);
  }
  if (picked.size > 0) return [...picked].sort((a, b) => a - b);
  // 只剩 0（或「0」混在解释里）才认成「一条都不相关」
  return numbers.some((n) => Number(n) === 0) ? [] : null;
}

/** 判定结果只认 1/0；模型偶尔会带空白、代码块或一句「1」的解释，做最小容错 */export function parseFollowUpVerdict(text) {
  const cleaned = String(text ?? '')
    .replace(/```[a-z]*|```/gi, '')
    .trim();
  if (cleaned === '') return null;
  // 只有「1」「1.」「0」这类纯判定才直接采纳；带解释的交给下面的孤立数字兜底，
  // 免得把「0 或 1」这种拿不准的输出当成明确的否定。
  if (/^1[\s.。、,，:：!！)）]*$/.test(cleaned)) return true;
  if (/^0[\s.。、,，:：!！)）]*$/.test(cleaned)) return false;
  // 兜底：整段话里只有一个孤立的 0/1
  const digits = cleaned.match(/(?<!\d)[01](?!\d)/g);
  if (digits?.length === 1) return digits[0] === '1';
  return null;
}

/**
 * 判定模型路由：显式配置 > 宿主当前模型。
 * 只填了一半时，尽量与宿主默认模型拼成一对；拼不出来就返回 null（调用方按失败策略处理）。
 */
export function resolveFollowUpRoute(config = {}, getRoute) {
  const provider = String(config.followUpJudgeProvider ?? '').trim();
  const model = String(config.followUpJudgeModel ?? '').trim();
  let auto = null;
  if (typeof getRoute === 'function') {
    try {
      auto = getRoute();
    } catch {
      auto = null;
    }
  }
  // 宿主选中的推理档位要一起带上：判定模型和会话模型用同一档，结果才稳定。
  const normalize = (route) => {
    if (!route?.provider || !route?.model) return null;
    const out = { provider: String(route.provider), model: String(route.model) };
    if (route.reasoningEffort) out.reasoningEffort = route.reasoningEffort;
    return out;
  };
  const autoRoute = normalize(auto);
  if (provider && model) return { provider, model };
  if (!provider && !model) return autoRoute;
  if (provider && !model) {
    return autoRoute && autoRoute.provider === provider
      ? { ...autoRoute, provider, model: autoRoute.model }
      : null;
  }
  // 只给了 model：只有当它与宿主默认模型同名时才敢沿用宿主的 provider
  return autoRoute && autoRoute.model === model ? { ...autoRoute, model } : null;
}

/** 收流：只要文本，末块 finish 报错就抛（与 dsh-llm 的 finish 约定一致） */
async function collectStreamText(stream) {
  let text = '';
  for await (const chunk of stream ?? []) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      continue;
    }
    if (chunk?.type === 'finish') {
      const reason = chunk.reason ?? chunk;
      if (reason?.kind === 'error' || reason?.kind === 'aborted') {
        throw new Error(reason?.failure?.message ?? `判定模型调用失败（${reason.kind}）`);
      }
    }
  }
  return text;
}

/** 调一次判定模型，收完整段文本；超时、上游失败、路由缺失都抛错 */
async function callFollowUpModel({
  llm,
  route,
  prompt,
  timeoutMs = 6000,
  maxTokens = 64,
  logger = console,
  label = '判定',
} = {}) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用');
  if (!route?.provider || !route?.model) throw new Error('没有可用的判定模型');
  const limit = Math.min(60_000, Math.max(500, finiteNumber(timeoutMs, 6000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const request = {
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      signal: controller.signal,
    };
    if (route.reasoningEffort) request.reasoningEffort = route.reasoningEffort;
    const stream = llm.stream(request);
    const text = await collectStreamText(stream);
    return { text, route };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一次相关性判定：属于当前话题返回 true，不属于返回 false，失败抛异常。
 * @param {object} options
 * @param {object} options.llm dsh 的 llm 服务（ctx.get('llm')）
 * @param {{provider: string, model: string}} options.route
 */
export async function runFollowUpJudge({
  llm,
  route,
  recent = [],
  message = '',
  sender = '',
  quotedBot = false,
  timeoutMs = 6000,
  logger = console,
} = {}) {
  const prompt = `${FOLLOWUP_JUDGE_RULES}\n\n${buildFollowUpJudgeInput({ recent, message, sender, quotedBot })}`;
  const { text } = await callFollowUpModel({
    llm,
    route,
    prompt,
    timeoutMs,
    maxTokens: FOLLOWUP_JUDGE_MAX_TOKENS,
    logger,
    label: '判定',
  });
  const verdict = parseFollowUpVerdict(text);
  if (verdict === null) throw new Error(`判定模型返回无法解析：${JSON.stringify(text.slice(0, 40))}`);
  logger.debug?.(`[qqbot-guard] 判定 ${route.provider}/${route.model} → ${verdict ? 1 : 0}`);
  return verdict;
}

/**
 * 刷屏/多条时的一次「挑相关」：返回要回复的 1-based 编号，[] 表示一条都不回。
 * 失败抛异常，由调用方按 followUpOnJudgeError 处理。
 */
export async function runFollowUpSelectJudge({
  llm,
  route,
  recent = [],
  items = [],
  timeoutMs = 6000,
  logger = console,
} = {}) {
  const prompt = `${FOLLOWUP_SELECT_RULES}\n\n${buildFollowUpSelectInput({ recent, items })}`;
  const { text } = await callFollowUpModel({
    llm,
    route,
    prompt,
    timeoutMs,
    maxTokens: FOLLOWUP_JUDGE_MAX_TOKENS,
    logger,
    label: '挑选',
  });
  const selected = parseFollowUpSelection(text, items.length);
  if (selected === null) {
    throw new Error(`判定模型返回无法解析：${JSON.stringify(text.slice(0, 40))}`);
  }
  logger.debug?.(
    `[qqbot-guard] 挑选 ${route.provider}/${route.model} → ${
      selected.length > 0 ? selected.join(',') : '0'
    }（共 ${items.length} 条）`,
  );
  return selected;
}

/**
 * 记一条放行消息：先续期/开窗，再写进判定器能看到的上文。
 * 窗口刚过期或刚好被 maxTurns 关掉时，按「新窗口」处理——这条消息本身已经判定为相关。
 */
function confirmFollowUpWindow(followUp, key, trigger) {
  let turn = followUp.touch(key);
  if (!turn) {
    followUp.open(key, { trigger });
    turn = followUp.touch(key);
  }
  return turn;
}

function rememberGroupMessage(followUp, key, msg, text) {
  const attachments = summarizeAttachments(msg?.attachments);
  followUp.remember(key, {
    role: 'user',
    name: msg?.senderName ?? msg?.senderId ?? '',
    text: text || attachments,
    at: Date.now(),
  });
}

/**
 * 真正的门禁逻辑。挂在中间件链头部，做三件事：
 * 1. 正文里的表情标签换成可读文本（历史与当前消息都受益）；
 * 2. 群聊命中关键词时给 `msg.mentions` 补 `{ is_you: true }`，让下游 mentionGate
 *    判成“被 @”，从而放行并拼上群历史。**绝不改 `msg.content`**（历史会被污染）；
 * 3. 续聊窗口：唤醒后同一群里没 @ 的消息，先问一次判定模型「还是同一个话题吗」，
 *    是就同样补 mention 放行，不是就原样交给 mentionGate 拦停（群里零输出）。
 *    短时间多条合并判定、逐条放行；刷屏时按 followUpFloodAction 静默或只回挑中的相关消息。
 *
 * @param {object|(() => object)} config 配置或配置读取函数
 * @param {object} logger
 * @param {Map} notes 附件摘要（历史用）
 * @param {Function|null} mediaDownloader 附件预下载
 * @param {object} [options]
 * @param {object} [options.followUp] createFollowUpState() 的实例；不传 = 不启用续聊
 * @param {() => object} [options.getLlm] 取 dsh 的 llm 服务
 * @param {(msg: object) => object} [options.getRoute] 按消息解析这个群会话实际使用的模型
 * @param {object} [options.flood] createFloodGate() 的实例；不传 = 自动建
 */
export function createGuard(
  config = DEFAULT_CONFIG,
  logger = console,
  notes = new Map(),
  mediaDownloader = null,
  options = {},
) {
  // 设置页保存后要即时生效：每处理一条消息都读一次最新配置（数组很小，开销可以忽略）。
  const read = typeof config === 'function' ? config : () => config;
  const followUp = options?.followUp ?? null;
  const getLlm = typeof options?.getLlm === 'function' ? options.getLlm : null;
  const getRoute = typeof options?.getRoute === 'function' ? options.getRoute : null;
  // 线上没有插件日志可看，把判定调用统计挂到 status 上（/qqbot-guard/config 能直接看到）。
  const judgeStats = options?.judgeStats ?? null;

  // 跨消息状态：批量判定器（短时间多条只问一次）+ 按群串行队列（一条一轮地放行）
  // + 刷屏断路器（短时间大量消息直接静默、或只回挑中的那几条）。
  const turnQueue = createTurnQueue();
  // 机器人 appId：判定模型要按「这个群会话」的 sessionKey 去取，appId 只能从入站消息上拿。
  let botAppId = '';
  const flood =
    followUp && options?.flood !== false
      ? options.flood ??
        createFloodGate({
          windowMs: () => (read() ?? DEFAULT_CONFIG).followUpFloodWindowMs,
          maxItems: () => (read() ?? DEFAULT_CONFIG).followUpFloodMax,
          cooldownMs: () => (read() ?? DEFAULT_CONFIG).followUpFloodCooldownMs,
        })
      : null;
  const burst =
    followUp && options?.burst !== false
      ? options.burst ??
        createBurstBatcher({
          windowMs: () => (read() ?? DEFAULT_CONFIG).followUpBurstMs,
          maxItems: () => (read() ?? DEFAULT_CONFIG).followUpBurstMax,
          decide: decideFollowUpBurst,
        })
      : null;

  /**
   * 把一批消息合成一次判定；最近上下文取判定那一刻的窗口内容。
   * 返回 `{verdict, selected}`：selected 是 select 模式挑中的 1-based 编号，
   * 逐条判定时为 null（表示「整批同进退」）。
   */
  async function decideFollowUpBurst(items, key) {
    if (judgeStats) {
      judgeStats.calls += 1;
      judgeStats.lastAt = Date.now();
    }
    try {
      const cfg = read() ?? DEFAULT_CONFIG;
      const llm = getLlm ? getLlm() : null;
      if (!llm?.stream) throw new Error('llm 服务不可用');
      // 判定模型跟着「这个群会话」走：qqbot 的模型可能是 per-peer 覆盖、settings.yaml
      // 或宿主默认，只读 agentDefaultModel 会拿错（群里切过模型时尤其明显）。
      const route = resolveFollowUpRoute(
        cfg,
        getRoute ? () => getRoute({ appId: botAppId, groupOpenid: key }) : null,
      );
      if (!route) throw new Error('没有可用的判定模型（请配置 followUpJudgeProvider/Model）');
      const recent = followUp?.get(key)?.recent ?? [];
      // 刷屏中、或这一批本来就够大：让模型挑出仍然相关的编号，只回这几条。
      const selectMin = Math.max(2, Math.floor(finiteNumber(cfg.followUpSelectMin, 5)));
      const useSelect =
        cfg.followUpFloodAction === 'select' &&
        (items.length >= selectMin || items.some((it) => it.flooding === true));
      let result;
      if (useSelect) {
        const selected = await runFollowUpSelectJudge({
          llm,
          route,
          recent,
          items: items.map((it) => ({ text: it.text, sender: it.sender })),
          timeoutMs: cfg.followUpJudgeTimeoutMs,
          logger,
        });
        result = { verdict: selected.length > 0, selected };
      } else {
        const lines = items.map((it) => `${it.sender ? `${it.sender}: ` : ''}${it.text}`);
        const message =
          items.length > 1
            ? `（短时间内连续 ${items.length} 条消息，请整体判断）\n${lines.join('\n')}`
            : lines[0] ?? '';
        const verdict = await runFollowUpJudge({
          llm,
          route,
          recent,
          message,
          sender: '',
          quotedBot: items.some((it) => it.quotedBot === true),
          timeoutMs: cfg.followUpJudgeTimeoutMs,
          logger,
        });
        result = { verdict, selected: null };
      }
      if (judgeStats) judgeStats.lastVerdict = result.verdict ? 'related' : 'unrelated';
      return result;
    } catch (err) {
      if (judgeStats) {
        judgeStats.errors += 1;
        judgeStats.lastError = String(err?.message ?? err);
      }
      throw err;
    }
  }

  return async function qqbotGuard(ctx, next) {
    const current = read() ?? DEFAULT_CONFIG;
    const triggers = (current.triggers ?? []).filter((t) => typeof t === 'string' && t.length > 0);
    const ignoreCase = current.ignoreCase !== false;
    const faces = current.faces !== false;
    const historyAttachments = current.historyAttachments !== false;
    // 本条消息是否已经把链交给续聊队列（交了就不在函数末尾再 next 一次）
    let released = false;
    try {
      const msg = ctx?.message;
      if (!botAppId && ctx?.bot?.appId) botAppId = String(ctx.bot.appId);
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

        // 续聊窗口：@/关键词/引用机器人 直接续期；其余消息问一次判定模型，相关才补 mention。
        // 不相关就什么都不做，mentionGate 会以 no_mention 拦停——群里不会出现「我不接这句」的提示。
        if (followUp && current.followUpEnabled !== false && msg.senderIsBot !== true) {
          const groupKey = followUpKey(msg);
          if (groupKey) {
            const mentionedNow =
              Array.isArray(msg.mentions) && msg.mentions.some((m) => m?.is_you === true);
            const keywordHit =
              typeof ctx.state?.qqbotGuard?.trigger === 'string' ? ctx.state.qqbotGuard.trigger : '';
            const quote = quotedBotInfo(msg, appId, (ref) => followUp.matchesBotRef(groupKey, ref));
            const openBefore = followUp.get(groupKey);

            if (mentionedNow || quote.quotedBot) {
              const trigger = keywordHit ? `keyword:${keywordHit}` : quote.quotedBot ? 'quote' : 'mention';
              const turn = confirmFollowUpWindow(followUp, groupKey, trigger);
              // 引用机器人但正文里没有 @：补 mention 才能过 mentionGate
              if (!mentionedNow && quote.quotedBot) {
                markMention(msg, { is_you: true, followUp: true });
                ctx.state = ctx.state ?? {};
                ctx.state.qqbotGuard = { followUp: true, quote: true };
                logger.debug?.('[qqbot-guard] 引用了机器人 → 伪造 mentions.is_you，放行');
              }
              if (!openBefore) logger.info?.(`[qqbot-guard] 续聊窗口打开：群 ${groupKey}（${trigger}）`);
              logger.debug?.(
                `[qqbot-guard] 续聊窗口续期：${trigger} turns=${turn?.turns ?? 0}` +
                  (turn?.closed ? '（达上限，关窗）' : ''),
              );
              rememberGroupMessage(followUp, groupKey, msg, raw);
            } else if (openBefore) {
              const text = typeof raw === 'string' ? raw.trim() : '';
              if (!text) {
                logger.debug?.('[qqbot-guard] 续聊窗口：空文本消息不判定');
              } else if (/^\//.test(text)) {
                // 斜杠命令归 qqbot 的 slashCommand 管；没 @ 时它本来也走不到，这里不替它开道。
                logger.debug?.('[qqbot-guard] 续聊窗口：斜杠命令不判定');
              } else {
                // 先记一次到达：冷却期内直接不回（@/关键词走上面的快通道，不受影响）。
                const floodState = flood ? flood.observe(groupKey) : null;
                // 代次：刷屏触发冷却会 +1，排队中的旧消息看到代次变了就自己丢弃。
                const floodEpoch = flood ? flood.epoch(groupKey) : 0;
                const floodAction = current.followUpFloodAction === 'skip' ? 'skip' : 'select';
                if (floodState?.flooding && floodAction === 'skip') {
                  // 主动丢弃：不往下走，也不在函数末尾补一次 next()
                  released = true;
                  logger.debug?.(
                    `[qqbot-guard] 刷屏保护：冷却中（约 ${Math.ceil(
                      floodState.remainingMs / 1000,
                    )} 秒），本条不回`,
                  );
                } else {
                  const item = {
                    text,
                    sender: msg.senderName ?? '',
                    quotedBot: quote.quotedBot,
                    flooding: floodState?.flooding === true,
                    at: Date.now(),
                  };
                  // 短时间内连着来好几条时只判一次；判定结果对这一批都生效。
                  let outcome;
                  if (burst && finiteNumber(current.followUpBurstMs, 0) > 0) {
                    outcome = await burst.add(groupKey, item);
                  } else {
                    outcome = {
                      batchId: null,
                      count: 1,
                      index: 1,
                      verdict: null,
                      selected: null,
                      error: null,
                    };
                    try {
                      const decision = await decideFollowUpBurst([item], groupKey);
                      outcome.verdict = decision?.verdict === true ? true : decision?.verdict === false ? false : null;
                      outcome.selected = Array.isArray(decision?.selected) ? decision.selected : null;
                    } catch (err) {
                      outcome.error = err;
                    }
                  }

                  // 放行统一走按群串行队列：等上一条的 turn 收尾再 next()，
                  // 这样 concurrencyGuard 不会把几条消息 merge 成一轮，能一条一条回。
                  const release = async (trigger, extra = {}) => {
                    // 先占位：下面若 next() 抛错，末尾也不能再 next 一次
                    released = true;
                    await turnQueue.run(groupKey, async () => {
                      if (flood && flood.epoch(groupKey) !== floodEpoch) {
                        logger.debug?.('[qqbot-guard] 刷屏代次已更新，排队中的旧消息丢弃');
                        return;
                      }
                      if (!followUp.get(groupKey)) {
                        logger.debug?.('[qqbot-guard] 续聊窗口已关闭，排队中的消息不再放行');
                        return;
                      }
                      const turn = confirmFollowUpWindow(followUp, groupKey, trigger);
                      markMention(msg, { is_you: true, followUp: true });
                      ctx.state = ctx.state ?? {};
                      ctx.state.qqbotGuard = { followUp: true, turns: turn?.turns ?? 0, ...extra };
                      rememberGroupMessage(followUp, groupKey, msg, text);
                      logger.debug?.(
                        `[qqbot-guard] 续聊放行（${trigger}，批 ${outcome.count} 条）turns=${
                          turn?.turns ?? 0
                        }` + (turn?.closed ? '（达上限，关窗）' : ''),
                      );
                      await next();
                    });
                    released = true;
                  };

                  const policy = current.followUpOnJudgeError === 'reply' ? 'reply' : 'skip';
                  if (outcome.verdict === true) {
                    // select 模式：同一批里只回被挑中的那几条，其余静默。
                    const picked = Array.isArray(outcome.selected) ? outcome.selected : null;
                    const me = outcome.index ?? 1;
                    if (picked && !picked.includes(me)) {
                      // 没被挑中：静默丢弃，不交给下游
                      released = true;
                      logger.debug?.(
                        `[qqbot-guard] 刷屏挑选：第 ${me}/${outcome.count} 条未被选中，不回`,
                      );
                    } else {
                      await release('judge');
                    }
                  } else if (outcome.verdict === false) {
                    logger.debug?.(
                      `[qqbot-guard] 续聊判定=无关（批 ${outcome.count} 条），交给 mentionGate 拦停`,
                    );
                  } else {
                    const win = followUp.get(groupKey);
                    // 同一批只记一次失败：否则 5 条消息同时失败会瞬间凑满 3 次、把窗口关掉。
                    const firstOfBatch = !outcome.batchId || win?.lastFailureBatch !== outcome.batchId;
                    if (win && firstOfBatch) {
                      win.lastFailureBatch = outcome.batchId;
                      win.failures = (win.failures ?? 0) + 1;
                      logger.warn?.(
                        `[qqbot-guard] 续聊判定失败（第 ${win.failures} 次，按 ${policy} 处理）：${
                          outcome.error?.message ?? outcome.error
                        }`,
                      );
                      if (win.failures >= 3) {
                        followUp.close(groupKey);
                        logger.warn?.(
                          '[qqbot-guard] 续聊判定连续失败 3 次，已关闭该群窗口（@ 或关键词可重新唤醒）',
                        );
                      }
                    }
                    if (policy === 'reply' && followUp.get(groupKey)) {
                      await release('judge-error', { error: true });
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (err) {
      // 门禁本身绝不把消息链路带崩
      logger.error?.(`[qqbot-guard] guard 异常（已忽略）: ${err?.message ?? err}`);
    }
    if (!released) await next();
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
/**
 * qqbot 发布产物目录：0.5.x 发的是 `lib/`，早期文档/版本写 `dist/`。
 * 先看有没有网关入口，避免同名空目录骗过判断；都没有就退回文档里的旧值。
 * @param {string} qqbotDir dsh-qqbot 包目录
 */
export function qqbotSourceDir(qqbotDir) {
  for (const dir of ['lib', 'dist']) {
    if (existsSync(join(qqbotDir, dir, 'gateway', 'middleware-setup.js'))) return dir;
  }
  for (const dir of ['lib', 'dist']) {
    if (existsSync(join(qqbotDir, dir))) return dir;
  }
  return 'dist';
}

function makeMediaDownloader(qqbotDir, cfg, log) {
  if (cfg.historyMedia === false) return null;
  let impl = null;
  return async function downloadAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return new Map();
    if (!impl) {
      try {
        const mod = await import(
          pathToFileURL(
            join(qqbotDir, qqbotSourceDir(qqbotDir), 'transport', 'attachment.js'),
          ).href
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

const OUTBOUND_FLAG = Symbol.for('qqbot-guard.sendMarkdown');

/**
 * 旁路记录机器人自己发出的文字，供续聊判定当上下文。
 *
 * qqbot 的群历史只记入站消息（historyBuffer 在门控前），机器人说过的话在判定时不可见；
 * 这里包一层 `QQBot.prototype.sendMarkdown`，把发出的片段连同 `ext_info.ref_idx` 记进窗口。
 * 只读侧：不改参数、不改返回值，失败一律吞掉——记录失败最多让判定变笨，不能影响发消息。
 *
 * 另外当 `followUpQuoteReply` 打开时，群聊回复改走 `send()` 并带上 `message_reference`，
 * 让 QQ 显示引用框；引用发送失败会退回原来的 `sendMarkdown`，不会把消息弄丢。
 *
 * @param {Function} QQBot @tencent-connect/qqbot-nodejs 的 QQBot 类
 * @param {object} followUp createFollowUpState() 实例
 * @param {object} [logger]
 * @param {object} [options]
 * @param {() => object} [options.readConfig] 实时配置读取（每次发送都重新判断是否带引用）
 * @param {number} [options.markdownType] QQ 的 msg_type，默认 2（markdown）
 * @returns {{ installed: boolean, restored?: () => void, reason?: string }}
 */
export function installOutboundRecorder(QQBot, followUp, logger = console, options = {}) {
  if (typeof QQBot?.prototype?.sendMarkdown !== 'function') {
    return { installed: false, reason: 'QQBot.prototype.sendMarkdown 不存在，版本可能已变' };
  }
  const readConfig = typeof options.readConfig === 'function' ? options.readConfig : null;
  const markdownType = options.markdownType ?? 2;
  const current = QQBot.prototype.sendMarkdown;
  if (current?.[OUTBOUND_FLAG]) {
    // 热重载时换用新的窗口实例与配置来源，保留原来的补丁/还原函数
    current[OUTBOUND_FLAG].followUp = followUp;
    current[OUTBOUND_FLAG].readConfig = readConfig;
    current[OUTBOUND_FLAG].markdownType = markdownType;
    return { installed: true, restored: current[OUTBOUND_FLAG].restore, reason: 'already-patched' };
  }

  const original = current;
  const state = { followUp, readConfig, markdownType, original, restore: null };
  const patched = async function sendMarkdown(target, content, ...rest) {
    const live = patched[OUTBOUND_FLAG];
    const opts = rest[0];
    const quote =
      target?.scope === 'group' &&
      target?.msgId &&
      live?.readConfig?.()?.followUpQuoteReply === true &&
      typeof this.send === 'function';
    let response;
    if (quote) {
      try {
        response = await this.send({
          target,
          msgType: live?.markdownType ?? 2,
          markdown: { content },
          keyboard: opts?.keyboard,
          messageReference: { message_id: String(target.msgId) },
        });
      } catch (err) {
        // 引用只是体验增强：平台不接受就退回普通发送，不能因此把回复丢了
        logger.warn?.(`[qqbot-guard] 带引用发送失败，已退回普通发送: ${err?.message ?? err}`);
        response = await original.call(this, target, content, ...rest);
      }
    } else {
      response = await original.call(this, target, content, ...rest);
    }
    try {
      const groupKey = target?.scope === 'group' ? String(target?.targetId ?? '') : '';
      const text = typeof content === 'string' ? content : '';
      if (live?.followUp && groupKey && text) {
        const refIdx = response?.ext_info?.ref_idx;
        live.followUp.remember(groupKey, {
          role: 'bot',
          name: '机器人',
          text,
          at: Date.now(),
          refIdx: refIdx === undefined || refIdx === null ? '' : String(refIdx),
        });
      }
    } catch (err) {
      logger.debug?.(`[qqbot-guard] 记录机器人发言失败: ${err?.message ?? err}`);
    }
    return response;
  };
  state.restore = () => {
    if (QQBot.prototype.sendMarkdown === patched) {
      QQBot.prototype.sendMarkdown = original;
    }
  };
  patched[OUTBOUND_FLAG] = state;
  QQBot.prototype.sendMarkdown = patched;

  return { installed: true, restored: state.restore };
}

// ────────────────────────── cordis 插件入口 ──────────────────────────

export async function apply(ctx, config) {
  const log = pickLogger(ctx);
  const source = createConfigSource(config, log);
  const cfg = source.get();

  /** 设置页显示的运行状态：qqbot 装在哪、补丁有没有生效。 */
  const status = {
    qqbot: '',
    qqbotVersion: '',
    sdk: '',
    installed: false,
    historyAttachments: false,
    reason: '',
  };
  // 先挂配置接口：qqbot 没装、甚至 enabled=false 时，用户仍然要能打开设置页改配置。
  installConfigApi(ctx, source, log, status, config);

  if (cfg.enabled === false) {
    status.reason = 'enabled=false';
    log.info('[qqbot-guard] enabled=false，跳过（qqbot 行为保持原样）');
    return;
  }

  const qqbot = findQqbotPackage(cfg, log);
  if (!qqbot) {
    status.reason = '没找到 @tencent-connect/dsh-qqbot';
    return;
  }
  status.qqbot = qqbot.dir;
  status.qqbotVersion = qqbot.pkg?.version ?? '';

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

  // 续聊窗口：窗口时长与条数上限都按当前配置实时取，设置页改完不用重启。
  const followUp = createFollowUpState({
    windowMs: () => {
      const minutes = Number(source.get()?.followUpWindowMinutes);
      const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 10;
      return Math.max(1, Math.min(1440, safe)) * 60 * 1000;
    },
    maxTurns: () => {
      const turns = Number(source.get()?.followUpMaxTurns);
      return Number.isFinite(turns) && turns > 0 ? Math.min(1000, Math.trunc(turns)) : 0;
    },
  });
  const getLlm = () => {
    try {
      return ctx?.get?.('llm') ?? null;
    } catch {
      return null;
    }
  };
  // 判定统计：群里看不到日志时，用它判断「到底有没有判、失败了几次」。
  const judgeStats = { calls: 0, errors: 0, lastError: '', lastVerdict: '', lastAt: 0 };
  // qqbot 自己的模型解析链：per-peer 覆盖 > 它的配置 > settings.yaml > 宿主默认 > 兜底。
  // 判定模型跟着群里实际在用的模型走，别只读宿主默认（群里切过模型时会对不上）。
  let modelResolver = null;
  try {
    const sourceDir = qqbotSourceDir(qqbot.dir);
    const mod = await import(
      pathToFileURL(join(qqbot.dir, sourceDir, 'model', 'model-resolver.js')).href
    );
    if (typeof mod.ModelResolver === 'function') modelResolver = new mod.ModelResolver(ctx, {}, log);
  } catch (err) {
    log.warn(`[qqbot-guard] 按会话取判定模型未启用: ${err?.message ?? err}`);
  }

  const hostRoute = () => {
    try {
      const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.();
      if (!selection?.provider || !selection?.model) return null;
      const route = { provider: selection.provider, model: selection.model };
      if (selection.reasoningEffort) route.reasoningEffort = selection.reasoningEffort;
      return route;
    } catch {
      return null;
    }
  };

  const getRoute = (msg) => {
    const appId = String(msg?.appId ?? '');
    const peer = String(msg?.groupOpenid ?? msg?.peerId ?? '');
    if (modelResolver && appId && peer) {
      try {
        const route = modelResolver.getEffectiveRoute(`qqbot:${appId}:group:${peer}`);
        if (route?.provider && route?.model) return route;
      } catch (err) {
        log.debug?.(`[qqbot-guard] 按会话解析模型失败，回退宿主默认: ${err?.message ?? err}`);
      }
    }
    // 和 qqbot 的最终兜底保持一致：宿主没有默认模型时，判定也不能凭空哑掉。
    return hostRoute() ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  };

  const guard = createGuard(() => source.get(), log, notes, mediaDownloader, {
    followUp,
    getLlm,
    getRoute,
    judgeStats,
  });
  const result = installGuard(sdk.QQBot, guard, log);
  if (!result.installed) {
    status.reason = `补丁未安装：${result.reason}`;
    log.error(`[qqbot-guard] 补丁未安装：${result.reason}`);
    return;
  }
  status.installed = true;
  status.sdk = sdkInfo.version ?? '';

  // 机器人发言记录：给续聊判定补上「自己刚说过什么」。
  const outbound = installOutboundRecorder(sdk.QQBot, followUp, log, {
    readConfig: () => source.get(),
    markdownType: sdk.MsgType?.MARKDOWN ?? 2,
  });
  if (!outbound.installed) log.warn(`[qqbot-guard] 出站记录未启用：${outbound.reason}`);
  Object.defineProperty(status, 'followUpWindows', {
    enumerable: true,
    get: () => followUp.size(),
  });
  Object.defineProperty(status, 'followUpJudge', {
    enumerable: true,
    get: () => ({
      calls: judgeStats.calls,
      errors: judgeStats.errors,
      lastError: judgeStats.lastError,
      lastVerdict: judgeStats.lastVerdict,
      lastAt: judgeStats.lastAt,
    }),
  });

  let historyPatched = false;
  let mediaRoot = '';
  if (cfg.historyAttachments !== false) {
    try {
      const sourceDir = qqbotSourceDir(qqbot.dir);
      const storeMod = await import(
        pathToFileURL(join(qqbot.dir, sourceDir, 'features', 'history-store.js')).href
      );
      // 附件落盘的目录：上游从 media-cleaner 导出 MEDIA_ROOT（~/.dsh-qqbot/media），
      // 拿不到就按同一个默认值兜底（路径标注是锦上添花，失败不影响摘要）。
      try {
        const mediaMod = await import(
          pathToFileURL(join(qqbot.dir, sourceDir, 'media', 'media-cleaner.js')).href
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
  status.historyAttachments = historyPatched;

  if (cfg.verbose) {
    const cfgFile = resolveConfigFile(cfg);
    const route = hostRoute();
    log.info(
      `[qqbot-guard] 就绪：qqbot=${qqbot.pkg?.version ?? '?'} sdk=${sdkInfo.version ?? '?'} ` +
        `triggers=${JSON.stringify(cfg.triggers)} 配置源=${existsSync(cfgFile ?? '') ? cfgFile : 'cordis/默认'} ` +
        `表情=${cfg.faces !== false ? '开' : '关'} 历史附件=${historyPatched ? '开' : '关'} ` +
        `续聊=${cfg.followUpEnabled === false ? '关' : `${cfg.followUpWindowMinutes ?? 10}分钟/上限${cfg.followUpMaxTurns || '不限'}`} ` +
        `引用=${cfg.followUpQuoteReply === true ? '开' : '关'} ` +
        `判定模型=${cfg.followUpJudgeProvider ? `${cfg.followUpJudgeProvider}/${cfg.followUpJudgeModel || '?'}` : modelResolver ? `${route ? `${route.provider}/${route.model}` : 'qqbot 默认链'}（按群会话解析）` : route ? `${route.provider}/${route.model}（宿主）` : '无'} ` +
        `注入方式=lazy-unshift + 伪造 mentions（与加载顺序无关）`,
    );
  }

  const restores = [result.restored, outbound.restored].filter((fn) => typeof fn === 'function');
  if (restores.length > 0 && typeof ctx?.on === 'function') {
    ctx.on('dispose', () => {
      for (const restore of restores) {
        try {
          restore();
        } catch (err) {
          log.warn(`[qqbot-guard] 卸载补丁失败: ${err?.message ?? err}`);
        }
      }
      followUp.clear();
      log.info('[qqbot-guard] 已卸载补丁');
    });
  }
}
