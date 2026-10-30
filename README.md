# qqbot-guard

**qqbot 增强层**（伴侣插件）。qqbot 主体仍由用户从插件市场安装（`@tencent-connect/dsh-qqbot`），
本插件只做进程内补丁，不修改 qqbot / SDK 的任何磁盘文件。

本仓库是 `dsh-qqbot-guard` 的**唯一真源**（源码、测试、发布都在这里）。
两种来源，包名相同：从插件市场 / npm 单独安装（`dsh-qqbot-guard`），
或随 [dsh-android](https://github.com/anwesc/dsh-android) APK 内置（构建时从 npm 拉同一版本）。

## 它补什么

| 编号 | 现象 | 本插件的处理 |
| --- | --- | --- |
| 1 | 群聊必须 @ 才回，关键词（如 `YONGJIE`）被 `mentionGate` 拦下 | 正文命中关键词时给 `msg.mentions` 补 `{is_you:true}`，`mentionGate` / `slashCommand` 都判成被提及 |
| 2 | 关键词触发时看不到上下文（`inbound.js:209` 只在 `wasMentioned` 时拼历史） | 同上：`wasMentioned` 变 true → `buildAgentBody` 自动带上 `[Chat history]` |
| 3 | 群历史里只剩文字，图片/语音/文件的条目是空行（`history-buffer.js:90-96` 只存 `content`） | 在链头**预下载**附件（`downloadMediaAttachments`），再包装 history store 的 `list`，给条目补 `[图片「a.png」@/…/media/a_…png、语音]` |
| 4 | 表情是占位符 `<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">`，上游只读 `ext.text`（是空的） | 解码 `ext.text` 有名字就用名字（如 `捂脸`）；为空则统一给 `[表情]`，**不按 `faceId` 猜**（见下方第 5 条风险） |
| 5 | 群里没触发关键词的消息，附件根本不会下载（`attachmentProcessor` 是链上第 13 层，在 `mentionGate` 后面） | guard 自己在链头调 qqbot 的下载器，历史条目因此能带路径 |
| 6 | 不想动 qqbot 的 `dist` 文件（升级即失效） | 全部走进程内原型补丁，升级 qqbot 不影响本插件文件 |

**为什么改成伪造 mentions 而不是往日文里塞 `<@appId>`**：`historyBuffer` 是第 4 层、在门控（第 5 层）
之前记录 `ctx.message.content`，往里插标记等于把 `<@102000000>` 写进群历史，再被 `buildAgentBody`
原样拼进 prompt。伪造 `mentions[].is_you` 能达到同样效果且不碰正文；真实 @ 的标记同理，会被搬进
mentions 后从正文摘掉。

## 为什么和加载顺序无关

`@tencent-connect/qqbot-nodejs` 的 `handleInboundMessage` 在**每次收到消息时**才拼链
（`dist/QQBot.js:387` `const chain = [...this.middlewares, downstream]`），而 `middlewares` 是公开数组
（`dist/QQBot.js:80`）。所以本插件不用抢 `bot.use` 的时机，而是在首条入站消息时
`this.middlewares.unshift(guard)` —— 即使 qqbot 插件先启动、链已经建好，补丁照样生效。

## 安装

两种来源写的是同一个目录 `node_modules/dsh-qqbot-guard`，装其中一个即可：

| 来源 | 怎么装 | 谁负责升级 |
| --- | --- | --- |
| 插件市场 / npm | 市场里搜 `dsh-qqbot-guard`，或 `dsh plugin --profile web add dsh-qqbot-guard` | 你自己（市场安装的版本优先） |
| dsh-android 内置 | 随 APK 的 `plugin-seed` 自动复制进 profile | App 发新版时顺带升级 |

`PluginSeed` 每次开机比较「内置版本」与「profile 已装版本」（semver）：已装版本有效且不比内置旧就
**保留不覆盖**；只有缺 `index.js`、没有 `package.json`、版本号非法、或内置版本更新时才用资产覆盖。
所以市场装的新版能活过重启，APK 带更新的内置版时也能自动升级。

反过来，从市场卸载不会让它消失：下次启动内置副本会补回（这是「内置插件」的预期行为）。
不想让它工作就设 `enabled: false`，而不是卸载。

1. 先装好 qqbot（`@tencent-connect/dsh-qqbot`），本插件靠它才能拿到 bot 实例；
2. 装本插件：市场安装，或 `dsh plugin --profile web add dsh-qqbot-guard`；
3. 本包自带 `dsh.bundle.patch`（`cordis.patch.yml`，用 `- insert:` 插入 `qqbot-guard` 行），
   被列入 `dsh.profile.bundles` 后会自动生效——**不要**在 profile 的 `cordis.patch.yml` 里再写一条同 id 的新行；
4. 需要改参数时，二选一：
   - **JSON 后门（手机端推荐）**：编辑 `$DSH_HOME/qqbot-guard.json`
     （App 里是 `/root/.dsh/qqbot-guard.json`，首次启动由 `PluginSeed` 生成）；
   - **profile patch 覆盖**（能写 YAML 时）：

```yaml
- id: qqbot-guard
  name: 'dsh-qqbot-guard'
  config:
    triggers:
      - '大肥鱼'
      - '小鱼'
      - '鱼鱼'
    qqbotPackage: 'C:/Users/<you>/.dsh/profiles/<profile>/node_modules/@tencent-connect/dsh-qqbot'
    verbose: true
```

5. **重启 App**（bundles 变更不走热重载）。

> 关键机制（`@deepseek-ai/dsh-app-boot` 的 `applyEntryPatches`）：普通 patch 只能改**已存在**的 id，
> 找不到就 `warn` 并跳过；新增插件行只能用 `insert`。所以「只写一条 `- id: xxx` 到 profile patch」
> 会静默无效——踩过这个坑。

`qqbotPackage` 一般**不用写**：插件会按下面的顺序自动定位 qqbot（命中即停）：

| 顺序 | 位置 | 说明 |
| --- | --- | --- |
| 1 | `config.qqbotPackage` / `DSH_QQBOT_DIR` | 显式指定优先，用于非标准布局 |
| 2 | 本插件自己所在的 `node_modules` | profile 布局：`<home>/profiles/<name>/node_modules/…`，**与 qqbot 是同一个目录** |
| 3 | `<home>/profiles/*/node_modules` | 依次枚举各 profile；另含 pnpm 的 `.pnpm` store |
| 4 | `<home>/node_modules`、`<home>/plugins/*/node_modules` | 插件市场早期的平铺布局 |
| 5 | 从 `cwd` 按 Node 规则向上找 | 裸部署/仓库内调试 |

`<home>` 依次取 `$DSH_HOME`、**从本插件的安装路径反推**（`…/profiles/<name>/node_modules/…` → `…`）、`~/.dsh`。
第 2 条是这次修掉的关键：以前候选列表里没有 `profiles/<name>/node_modules` 这一层，手机端（qqbot 由插件市场装进 profile）
每次都「没找到」然后**在第一步直接 return**，关键词放行、原型补丁、历史附件全部静默失效。

只有真的找不到时才需要写死路径：

```yaml
- id: qqbot-guard
  name: 'dsh-qqbot-guard'
  config:
    qqbotPackage: 'C:/Users/<you>/.dsh/profiles/<profile>/node_modules/@tencent-connect/dsh-qqbot'
```

找不到时的日志会列出**试过的每一处**安装路径（而不是只报一句「没找到」），可直接照着补 `qqbotPackage`。

插件声明 `inject: ['agents']`，与 qqbot 插件同级，谁先启动都行。

> APK 内置时不写 `dependencies`：`PluginSeed` 只把目录拷进 `node_modules` 并登记
> `dsh.profile.bundles`。`file:` 依赖会绑死容器路径，而 loader 按名字解析，够用。

### 配置项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时插件什么都不做，qqbot 行为保持原样 |
| `triggers` | `['大肥鱼', '肥鱼', '鱼鱼']` | 关键词列表，正文包含任一词即视为对我说话 |
| `ignoreCase` | `true` | 关键词是否忽略大小写 |
| `qqbotPackage` | `''` | dsh-qqbot 安装目录或它的 package.json；留空则自动探测（本插件同 profile 的 `node_modules` → `DSH_HOME/profiles/*` → `DSH_HOME` → `cwd` 向上） |
| `configFile` | `''` | 外部 JSON 配置路径；留空时依次取 `$DSH_QQBOT_GUARD_CONFIG` → `$DSH_HOME/qqbot-guard.json` → `~/.dsh/qqbot-guard.json` |
| `faces` | `true` | 把 `<faceType=…>` / `[<face,id=N/>]` 还原成 emoji；关掉则保持上游原样（上游会直接删标签） |
| `historyAttachments` | `true` | 往群历史条目里补附件摘要（`[图片「a.png」]`）；关掉则历史里只剩文字 |
| `strictVersion` | `false` | SDK 版本超出白名单 `>=1.0.5 <2.0.0` 时是否放弃安装 |
| `verbose` | `true` | 是否打印诊断日志，就绪日志会带上「配置源=…」 |

配置优先级：`DEFAULT_CONFIG` < 外部 JSON 文件 < cordis 里的 `config`。JSON 解析失败只会打一条
warn 然后忽略，不会让插件挂掉——手机上手改坏了不会变砖。

## 自检

```bash
node --test                     # 定位逻辑 + apply() 端到端回归（不需要真的装 qqbot）
DSH_QQBOT_DIR=/path/to/node_modules/@tencent-connect/dsh-qqbot node selfcheck.mjs
```

`discovery.test.mjs` 在 tmp 里造出设备上的真实布局（guard 与 qqbot 同在
`profiles/web/node_modules`、`DSH_HOME` 未设、cwd 为空的 `work` 目录），断言能定位到包；
`boot.test.mjs` 用假 qqbot 跑一遍 `apply()`，断言不再在第一步退出、且群消息关键词能补上
`mentions.is_you`。这两个用例在旧实现上都会失败（失败点正是「没找到 @tencent-connect/dsh-qqbot」）。

自检会：先按 qqbot 原样建 bot（补丁前）→ 装补丁 + 包装 history store → 喂五条消息
（闲聊 / 关键词 / 真 @ / 表情占位符 / 纯图片），断言链头部是 guard、关键词消息被处理、
`wasMentioned=true`、正文无 `<@` 标记、闲聊消息仍被拦、群历史已累积、历史条目无 `<@` 残留、
空 ext 的表情变 `[表情]`、命名表情解码成名字、老格式表情仍查表、历史里有附件摘要。

### 实测结果（qqbot 0.5.3 + qqbot-nodejs 1.0.5，Node 24.21.0）

```
qqbot=0.5.3 sdk=1.0.5 chain=14
PASS  补丁已安装
PASS  链头部是 guard
PASS  补丁未改变原链长度（懒注入时机正确）
PASS  关键词消息被处理
PASS  关键词消息 wasMentioned=true
PASS  模型收到的是干净文本（无 <@ 标记）
PASS  无关键词的消息被门控拦下
PASS  群历史已累积
PASS  history store 已包装（附件摘要生效）
PASS  历史条目无 <@ 残留
PASS  空 ext 的表情标签变成 [表情]（历史里）
PASS  空 ext 不猜 faceId 对照表
PASS  命名表情解码成名字（264 → 捂脸）
PASS  老格式 [<face,id=1/>] 仍查表
PASS  历史里带附件摘要
PASS  历史里补上附件真实路径
PASS  附件路径是 POSIX 风格绝对路径
PASS  附件在 guard 里就预下载（不等 mentionGate）
PASS  预下载路径直接进历史（不靠 glob 兜底）
PASS  没有本地文件时不硬写路径
PASS  表情标签不再以占位符形式出现
```

全量模式（`requireMention: false`，群消息全收）下同样有效：history 为
`["闲聊一句","YONGJIE 关键词","真 @ 一句"," [图片「a.png」]"]`，关键词消息被标成 `wasMentioned=true`。
注意全量模式本来就全放行，这里的差别只是「标记成在跟我说话」——模型会看到 `(@you)` 并拿到群历史。

## 必须配套的一项配置

群聊要「只有 @ 或命中关键词才回」，**必须**把 qqbot 的 `requireMention` 设为 `true`
（`cordis.patch.yml` 里 `im-qqbot` 条目）：

```yaml
- id: im-qqbot
  config:
    requireMention: true
```

原因：本插件的做法是把命中关键词的消息「伪装成 @」再交给下游 `mentionGate`；若 `requireMention: false`，
门控对所有群消息一律放行，插件就只剩「补标记」作用，群里每句话都会触发回复。

未 @ 的消息不会丢上下文：`dsh-qqbot/dist/gateway/middleware-setup.js:29` 把 `historyBuffer` 放在
`mentionGate`（`:41`）**之前**，且带 `recordOnSkip: true`，被门控拦下的消息照样计入群历史。

## 已知风险

1. **模块实例一致性**：补丁打在 `@tencent-connect/qqbot-nodejs` 的 `QQBot.prototype` 上，必须和 qqbot 解析到
   同一个文件。本插件按 Node 的 `node_modules` 向上查找规则、从 qqbot 安装目录出发定位 SDK，正常情况下即同一实例；
   若装了多份 SDK 且版本不同，可能出现补丁打在另一份上而静默失效（此时 `/消息` 行为与未装插件一致）。
2. **`node_modules` 解析**：`qqbot-nodejs` 的 `exports` 只有 `import` 条件，`createRequire().resolve()` 在 Node 24 会抛
   `ERR_PACKAGE_PATH_NOT_EXPORTED`（实测）。本插件因此手工读 package.json 的 `exports['.']`，不依赖该 API。
3. **历史带标记（已解决，留档）**：早期版本往正文前置 `<@appId>` 来伪造提及，导致群历史条目里带
   `<@102000000> …` 并被原样拼进 prompt。现在改为伪造 `mentions[].is_you`，并把真实 @ 的标记搬进
   mentions 后从正文摘掉，历史是干净原文。代价是多改一个字段（`msg.mentions`），见「已知风险 1」同款顾虑。
4. **附件会被下载两次（仅触发消息）**：关键词触发的消息里若有附件，guard 先下一次，随后
   `attachmentProcessor` 又下一次——media 目录里会多一个同内容的随机名副本。这是为了“没触发的消息也能在
   历史里点开”付出的代价；`historyMedia: false` 可以关掉预下载（回到只有文件名）。
5. **历史里的附件路径只在 24 小时内有效**：上游把附件下载到 `~/.dsh-qqbot/media`，文件名是
   `<原名>_<时间戳>_<随机><ext>`（`attachment.js:60` `uniqueFilename`），后缀随机，**落库时算不出来**，
   而且下载发生在中间件链之后——所以本插件改成在读历史时按 `<原名>_*` 前缀匹配、取 mtime 最新的那个来补路径
   （`resolveMediaPath`）。代价与边界：
   - 媒体默认 24 小时过期（`config.media.ttlHours` 默认 24，`0`=永不过期，每小时扫一次），过期后历史里的
     路径点开就是空的——路径只当“可能还在”的线索，别当保证；
   - 只保留最近 200 条带附件的消息摘要（`notes` 上限），更早的条目退化成纯文字；
   - 文件名重复（同名文件在同一次会话里发多次）时取最新的那个，可能张冠李戴。
   本插件不复制、不移动用户的媒体文件。
6. **表情 vs 收藏表情包（实测结论）**：`faceId` 是系统表情编号，`ext.text` 才是语义来源——
   系统表情会带名字（如 `faceId=264` → `{"text":"捂脸"}`）。**收藏的表情包不走 faceId**：QQ 把它作为
   图片附件下发（落到 `~/.dsh-qqbot/media/`），同时附一个空文本的 face 标签（`faceType=6,faceId="0"`）。
   所以本插件对空 `ext.text` 只给 `[表情]`，不再按 faceId 表猜 emoji（早期版本把 0 映射成 😊 是错的）。
   若想换措辞改 `normalizeFaces` 的兜底值。
7. **版本漂移**：只用 qqbot/SDK 的四个公开面 —— `middlewares`、`handleInboundMessage`、`ctx.bot.appId`、
   `ctx.state.mention`，外加 `history-store` 的 `getHistoryStore()`（拿不到就只打 warn，附件摘要自动关）。
   白名单外的版本仍会尝试安装并打 warn，出问题先跑 `selfcheck.mjs`。

## 边界

- 不改 qqbot 源码，不写 `node_modules`，不碰 App 的 Java 层。
- 媒体缓存、脚本、手册等其余增强项不在本插件范围内（另行安排）。

## License

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 anwesc。
