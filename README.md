# qqbot-guard

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/anwesc/dsh-qqbot-guard)

给 QQ 机器人补上「群聊里该有的样子」：发一句关键词就能叫醒，叫醒后不用每条都 @，
能顺着话题接着聊；话题散了自动闭嘴；刷屏时只回相关的那几条；
连着好几条追问时，能一条讲完就合成一条回，讲不完再逐条回。

所有开关都在 DSH 的 **设置 → QQ 守护** 里，保存即生效，不用重启。

> 这是 qqbot 的增强插件，不是另一个机器人。`@tencent-connect/dsh-qqbot` 仍要单独安装；
> 本插件只在进程内打补丁，不改 qqbot 和 SDK 的任何文件。

---

## 30 秒上手

1. **装好 qqbot**（插件市场搜 `@tencent-connect/dsh-qqbot`）。
2. **装本插件**：市场里搜 `dsh-qqbot-guard`，或执行
   `dsh plugin --profile web add dsh-qqbot-guard`。
3. 在群里发一句 **大肥鱼**（或 `肥鱼` / `鱼鱼`，可在设置页改）。
4. 机器人回复后，**不用再 @**，直接接着聊就行；10 分钟没有相关话题，它会自己休眠。

### 两个前提，缺一不可

| # | 要什么 | 在哪设置 | 缺了会怎样 |
| --- | --- | --- | --- |
| 1 | 机器人能拿到群内**全部**消息 | QQ 群 → 机器人设置 → 「机器人可获取的群聊消息范围」→ 选「获取群内全部消息」 | 不 @ 的消息根本不会推给机器人，关键词自然没反应 |
| 2 | qqbot 开启「群聊仅回复 @ 机器人的消息」（`requireMention: true`） | DSH 的 qqbot 插件设置页打开该开关 | 群里每句话都会触发回复，插件只剩「补标记」作用 |

第 2 条打开后，界面会提示「开启后，机器人仅可回复 @ 机器人的群聊消息」——这正是本插件要绕过去的那道门。

---

## 它能做什么

| 场景 | 效果 |
| --- | --- |
| 群友不 @，只发关键词 | 机器人被叫醒并回复，和真 @ 一样 |
| 叫醒后大家接着讨论 | 不 @ 也会回，直到 10 分钟没有相关话题 |
| 群里连着发好几条 | 合并成一次判断：能一条讲完就**合成一条回**，讲不完/拿不准就逐条回 |
| 有人刷屏 | 10 秒超过 15 条进入冷却，只回判定挑中的相关消息，其余安静 |
| 有人发「哈哈哈」「收到」 | 默认只续期 + 发一张内置表情（只发表情、不回文本）；`followUpAckMode` / `followUpStickerEnabled` 可改 |
| 聊到一半跑题 | 判定为无关就不回，群里看不到任何「我不接这句」的痕迹 |
| 消息里有图片/语音/文件 | 群历史里会带 `[图片「a.png」@路径]` 之类的摘要，模型能接着聊 |
| 想让回复带引用框 | 默认就开（`followUpQuoteReply`）；合并回复不带引用框，失败自动退回普通发送 |

以上能力从 1.2.0 起；**1.2.1** 修正了判定模型按群会话解析、并给判定输出留足 token；
**1.3.0** 让判定同时给出「合并成一条 / 逐条回」，并把语气型附和（「哈哈哈」「收到」）按场景内处理——默认只回一张表情；同一版把设置页整页重排：8 张可折叠卡片 + 标题下数值摘要 + 紧凑行/两列数字，整页高度大约减半。

---

## 设置页

![设置 → QQ 守护](docs/settings-qqguard.png)

- **状态行**：补丁有没有挂上、当前有几个活动窗口、qqbot 装在哪、配置文件路径。
- **8 张可折叠卡片**：标题下面一行就是当前值摘要（比如「10 分钟 · 自动判断 · 引用」「只回相关 · 10s 15 条 · 冷却 25s」），收起也知道里面是什么。默认展开「唤醒与开关」和「续聊窗口」，折叠状态会记住，右上角可一键展开/收起全部。
- **一行一件事**：开关和数字是「说明在左、控件在右」的紧凑行，短数字两列并排；只有关键词、下拉、路径这类需要横向空间的才整行铺开。
- **粘底保存栏**：有改动才能点保存，状态会实时显示「有未保存的改动」。
- **保存即生效**：写入 `$DSH_HOME/qqbot-guard.json`（原子写，不会写坏），下一条消息就按新配置走。

| 卡片 | 管什么 |
| --- | --- |
| 唤醒与开关 | 总开关、关键词、忽略大小写、诊断日志 |
| 消息处理 | 表情转文字、历史附件摘要、预下载附件 |
| 续聊窗口 | 静默分钟数、回复形态、引用框、单次上限 |
| 附和表情 | 笑声/附和怎么处理、表情最小间隔、自定义目录 |
| 批量与回复 | 汇总窗口、每批合并上限、最长等待 |
| 刷屏保护 | 刷屏时怎么办、统计窗口、冷却、挑选门槛 |
| 判定模型与失败策略 | 判定超时、provider/model、失败怎么办 |
| 高级 | qqbot 安装目录、预下载上限 |

> 喜欢手改文件的也可以直接编辑 `$DSH_HOME/qqbot-guard.json`；
> App 里是 `/root/.dsh/qqbot-guard.json`，首次启动会自动生成。

---

## 常见问题

**发关键词没反应？**
先核对上面两个前提，再看设置页状态行：qqbot 没定位到、或 SDK 版本不在白名单，都会导致补丁不生效。
状态行里的 `reason` 会直接写原因。

**叫醒了，但不 @ 还是不回？**
按顺序排查：

1. 距上次相关消息是否已超过 10 分钟（窗口默认 10 分钟，可在设置页改）；
2. 这句话是不是被判成了「无关」——判定是模型判断，不是关键词匹配，跑题、纯表情、纯附件都可能不回；
3. 看接口里的判定统计：`GET /qqbot-guard/config` → `status.followUpJudge`，
   `calls` 是调用次数，`errors` 是失败次数，`lastError` 是最近一次失败原因；
   表情没发出来时看 `status.followUpSticker`：`lastMood` 是这次想挑的情绪、`lastFile` 是选中/发出的图、`lastSkip` 是跳过原因（`cooldown` / `no-images` / `error: …`）；
4. 判定失败默认**不回**（`followUpOnJudgeError = skip`），这是刻意的保守策略，可改成 `reply`。

**想让它对判定失败也回？**
设置页把「判定失败时」改成 `reply`。代价是模型抽风时可能把无关话题吸进来。

**重启 DSH 后还要重新叫醒吗？**
要。续聊窗口只存在内存里，重启就没了；重新发关键词或 @ 一次即可。
会话本身不会丢，qqbot 下次会接着用磁盘上的历史。

**会不会很吵、很贵？**
只有进入窗口、且没走「@ / 关键词 / 引用机器人」快通道的消息才会判定一次，一次调用几十个 token。
「哈哈哈」「收到」这类短附和默认不调模型、直接续期，并回一张内置表情（同一群两次至少隔 4 秒）；连发多条也只判一次。表情会按内容挑：判定模型回情绪词（`1 happy`、`1 melon`）就按情绪找，没给就按文字关键词猜，认不出才随机。
刷屏保护会把大批量消息压成一次「挑编号」，不会逐条烧。

**回复能带引用框吗？**
能，默认开：`followUpQuoteReply` 会让插件用被动回复的 `msg_id` 构造 `message_reference`。
平台偶尔不接受时会自动退回普通发送（打一条 warn，回复不会丢）。
合并回复默认不带引用框（一次答多条时引用哪条都不合适），逐条回复才会挂。

**为什么只收到一张表情？**
那是判定为「场景内附和」时的回应：只发表情、不回文本，避免每句「哈哈哈」都接一段话。表情会尽量贴合内容（笑、吃瓜、无语、问号…），不是纯随机。
内置 9 张鲸鱼娘（同人二创、**仅限个人非商业**）；也可以换成自己的图片目录（png/jpg/gif/webp）。

**想用现成的「大肥鱼」GIF 表情包？**
社区有一个做得更全的版本：[diwer/ai-biaoqingbao](https://github.com/diwer/ai-biaoqingbao)（100 个中文 GIF）。
它的许可是 **CC BY-NC-SA 4.0、仅限非商业**，所以本项目不打包它；个人自用可以这样接进来：

1. 下载 [240px 轻量包](https://github.com/diwer/ai-biaoqingbao/raw/master/downloads/dafeiyu-240.zip) 并解压；
2. 把 `followUpStickerDir` 指到解压目录（设置页「附和表情」里的目录框也能填），重启 DSH；
3. 保留原作者的 `NOTICE.txt` 署名，不要用于商业用途或再次分发。

程序不区分来源，目录里放 png/jpg/gif/webp 都会随机挑一张。
不想要就关 `followUpStickerEnabled`，或把 `followUpAckMode` 改成 `reply` 让它正常接话。

---

## 它是怎么做到的（够用版）

- **关键词当 @ 用**：命中关键词时给消息补一个 `mentions.is_you`，qqbot 的门控就会放行，群历史也会自动带上。
  不改正文，所以历史里不会残留 `<@机器人>` 标记。
- **续聊窗口**：开窗后每条消息先过「快通道」（真实 @、引用机器人、关键词）或问一次小模型「还是这个话题吗」。
  相关就放行并续期，无关就什么都不做，交给 qqbot 的 `mentionGate` 拦停——群里零输出。
- **批量汇总**：安静 1.2 秒就结算，连发时按「续约」延长，但从第一条起最多等 4 秒。一批只判一次。判定会同时给出「相关性 + 回复形态」：
  `2m` 一条能讲完 → 只放行最后一条进 agent，其余留在群历史里，于是模型写一条合并回复；
  `2e` 讲不完 → 逐条放行、各自回复；`1` 场景内附和 → 只续期 + 发一张表情（`followUpStickerEnabled`）；`0` → 静默。
  合并回复刻意不带引用框，逐条回复可继续用 `followUpQuoteReply` 的引用。
- **刷屏保护**：统计窗口内消息数，超阈值进入冷却；冷却期默认只回「挑编号」挑中的那几条，
  其余静默；已经在排队的旧消息会被丢弃，不会冷却一结束就倒出来。
- **历史补全**：在链头预下载附件、把表情占位符还原成名字，再包装历史读取，让模型看得到图/语音/文件。

判定模型**跟着这个群会话实际用的模型**走：群内 `/model` 覆盖 > `settings.yaml` 的
`agent-default-model` > 宿主默认 > 兜底 `deepseek-official/deepseek-v4-flash`。
（插件看不到 qqbot 插件配置里写死的 provider/model 这一层；想固定判定模型，就在设置页填
provider/model，两项都填才覆盖，只填一半不会乱拼。宿主的 `reasoningEffort` 会一起带上。）

---

## 进阶配置

### 配置文件与优先级

`DEFAULT_CONFIG` < 外部 JSON 文件 < `cordis.patch.yml` 里的 `config`。

配置文件依次取：`$DSH_QQBOT_GUARD_CONFIG` → `$DSH_HOME/qqbot-guard.json` → `~/.dsh/qqbot-guard.json`。
JSON 解析失败只打一条 warn 然后忽略，不会让插件挂掉。

也可以写进 profile 的 patch（能写 YAML 时）：

```yaml
- id: qqbot-guard
  name: 'dsh-qqbot-guard'
  config:
    triggers:
      - '大肥鱼'
      - '小鱼'
      - '鱼鱼'
    verbose: true
```

> 新增插件行只能用 `- insert:`；普通 patch 只能改已存在的 id，找不到会静默跳过。

### 配置项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时插件什么都不做 |
| `triggers` | `['大肥鱼', '肥鱼', '鱼鱼']` | 关键词列表，正文包含任一词即视为叫醒 |
| `ignoreCase` | `true` | 关键词是否忽略大小写 |
| `qqbotPackage` | `''` | qqbot 安装目录；留空自动探测（一般不用写） |
| `configFile` | `''` | 外部 JSON 配置路径；留空走默认位置 |
| `faces` | `true` | 把 `<faceType=…>` 占位符还原成表情名（如「捂脸」） |
| `historyAttachments` | `true` | 群历史里补附件摘要与路径 |
| `strictVersion` | `false` | SDK 版本超出 `>=1.0.5 <2.0.0` 时是否放弃安装 |
| `verbose` | `true` | 是否打印诊断日志 |
| `followUpEnabled` | `true` | 续聊窗口总开关 |
| `followUpWindowMinutes` | `10` | 多久没有相关消息就休眠（1~1440 分钟） |
| `followUpBurstMs` | `1200` | 批量汇总窗口：安静这么久就结算；一次判定同时决定合并/逐条（0~5000 毫秒，`0` 不合并） |
| `followUpBurstMaxWaitMs` | `4000` | 续约式批量的硬上限：从第一条起最多等多久（1000~20000 毫秒） |
| `followUpBurstMax` | `12` | 一批最多合并多少条，攒满立即判（2~50） |
| `followUpReplyMode` | `'auto'` | `auto` 由模型判合并/逐条；`batch` 总是合并；`each` 总是逐条 |
| `followUpAckMode` | `'renew'` | 「哈哈哈」「收到」这类：`renew` 只续期、`reply` 照常回、`ignore` 不理会 |
| `followUpAckFastPath` | `true` | 短附和是否跳过模型调用（`renew` 模式下生效） |
| `followUpStickerEnabled` | `true` | 场景内附和时发一张表情，代替文本回复 |
| `followUpStickerDir` | `''` | 自定义表情目录（png/jpg/gif/webp）；留空用内置的 9 张鲸鱼娘 |
| `followUpStickerCooldownMs` | `4000` | 同一个群两次表情的最小间隔（1000~600000 毫秒） |
| `followUpFloodWindowMs` | `10000` | 刷屏统计窗口（1000~60000 毫秒） |
| `followUpFloodMax` | `15` | 窗口内多少条算刷屏（1~200） |
| `followUpFloodCooldownMs` | `25000` | 刷屏后静默多久（1000~600000 毫秒） |
| `followUpFloodAction` | `'select'` | 刷屏时 `select` 只回挑中的，`skip` 整段不回 |
| `followUpSelectMin` | `5` | 一批达到多少条就让模型挑编号（2~50） |
| `followUpQuoteReply` | `true` | 逐条回复带引用框；合并回复不带；失败自动退回普通发送 |
| `followUpMaxTurns` | `0` | 单次唤醒最多回多少条；`0` 不限（0~1000） |
| `followUpJudgeProvider` / `followUpJudgeModel` | `''` | 判定模型；都留空按群会话解析，两项都填才覆盖 |
| `followUpJudgeTimeoutMs` | `6000` | 单次判定超时（500~60000 毫秒） |
| `followUpOnJudgeError` | `'skip'` | 判定失败时：`skip` 不回（推荐），`reply` 照常回 |

### qqbot 装在哪

一般**不用写** `qqbotPackage`，插件会按下面的顺序自动找（命中即停）：

1. `config.qqbotPackage` / `DSH_QQBOT_DIR`；
2. 本插件自己所在的 `node_modules`（profile 布局，通常和 qqbot 同目录）；
3. `<home>/profiles/*/node_modules`（含 pnpm store）；
4. `<home>/node_modules`、`<home>/plugins/*/node_modules`；
5. 从 `cwd` 按 Node 规则向上找。

真找不到时，日志会列出试过的每一处路径，照着补 `qqbotPackage` 即可。

---

## 开发

```bash
node --test --test-isolation=none *.test.mjs   # 单元 + 端到端回归，不需要真装 qqbot
node selfcheck.mjs                             # 对着真实 qqbot 跑 22 项自检
```

`followup.test.mjs` 覆盖续聊窗口的全部行为：开窗/续期/超时、判定解析、回复形态（合并/逐条）、
模型路由、失败策略、批量与串行放行、附和快通道、附和表情、刷屏断路器、`select` 挑编号、引用回复、配置边界。

实测环境：qqbot 0.5.5 + qqbot-nodejs 1.0.5，Node 24（CI 同时跑 Node 22），
`selfcheck` 22 项全 PASS，测试 77 个用例全过。

### 已知限制

- 补丁打在 `QQBot.prototype` 上，必须和 qqbot 解析到同一个 SDK 实例；装多份不同版本 SDK 时可能静默失效。
- 历史里的附件路径只保证 24 小时内有效（媒体默认 24 小时过期），且只保留最近 200 条附件摘要。
- 判定是模型判断，不是确定性规则：可能多回一句，也可能冷场；默认失败策略偏保守。
- 续聊窗口只存在内存里，DSH 重启后需要重新唤醒。
- 合并回复依赖 qqbot 的群历史（`historyLimit` 默认 10 条）：一批超过 10 条时，最早那几条可能没进模型上下文，合并回复只能覆盖最近 10 条。
- 不改 qqbot 源码、不写 `node_modules`、不碰 App 的 Java 层。

## License

代码：MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 anwesc。

内置表情 `assets/stickers/whale-chan/`（9 张鲸鱼娘）：**CC BY-NC-SA 4.0，仅限个人非商业使用**，不属于上面的 MIT 授权；形象来自「上善无形」与「ZipZipPipe」的同人二创。商用请删除该目录或关闭附和表情，改用 `followUpStickerDir` 指向自己的图片。

详见 `assets/stickers/whale-chan/NOTICE.txt`。
