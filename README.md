# qqbot-guard

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/anwesc/dsh-qqbot-guard)

给 QQ 机器人补上「群聊里该有的样子」：发一句关键词就能叫醒，叫醒后不用每条都 @，
能顺着话题接着聊；话题散了自动闭嘴；刷屏时只回相关的那几条。

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
| 群里连着发好几条 | 合并成一次判断，但**仍然逐条回复**，不会只回一条 |
| 有人刷屏 | 10 秒超过 15 条进入冷却，只回判定挑中的相关消息，其余安静 |
| 聊到一半跑题 | 判定为无关就不回，群里看不到任何「我不接这句」的痕迹 |
| 消息里有图片/语音/文件 | 群历史里会带 `[图片「a.png」@路径]` 之类的摘要，模型能接着聊 |
| 想让回复带引用框 | 打开 `followUpQuoteReply`（默认关），失败会自动退回普通发送 |

以上能力从 1.2.0 起；**1.2.1** 修正了判定模型按群会话解析、并给判定输出留足 token。

---

## 设置页

![设置 → QQ 守护](docs/settings-qqguard.png)

- **状态行**：qqbot 有没有找到、装在哪、SDK 版本、历史补丁是否生效。
- **关键词**：一行一个，自动去重；开关直接点。
- **续聊窗口**：静默分钟数、批量汇总、刷屏保护、单次回复上限、判定模型、失败策略。
- **保存即生效**：写入 `$DSH_HOME/qqbot-guard.json`（原子写，不会写坏），下一条消息就按新配置走。

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
4. 判定失败默认**不回**（`followUpOnJudgeError = skip`），这是刻意的保守策略，可改成 `reply`。

**想让它对判定失败也回？**
设置页把「判定失败时」改成 `reply`。代价是模型抽风时可能把无关话题吸进来。

**重启 DSH 后还要重新叫醒吗？**
要。续聊窗口只存在内存里，重启就没了；重新发关键词或 @ 一次即可。
会话本身不会丢，qqbot 下次会接着用磁盘上的历史。

**会不会很吵、很贵？**
只有进入窗口、且没走「@ / 关键词 / 引用机器人」快通道的消息才会判定一次，一次调用几十个 token。
刷屏保护会把大批量消息压成一次「挑编号」，不会逐条烧。

**回复能带引用框吗？**
能，但默认关：打开 `followUpQuoteReply` 后，插件会用被动回复的 `msg_id` 构造 `message_reference`。
平台不接受时会自动退回普通发送（打一条 warn，回复不会丢），建议先在一个群里试一条。

---

## 它是怎么做到的（够用版）

- **关键词当 @ 用**：命中关键词时给消息补一个 `mentions.is_you`，qqbot 的门控就会放行，群历史也会自动带上。
  不改正文，所以历史里不会残留 `<@机器人>` 标记。
- **续聊窗口**：开窗后每条消息先过「快通道」（真实 @、引用机器人、关键词）或问一次小模型「还是这个话题吗」。
  相关就放行并续期，无关就什么都不做，交给 qqbot 的 `mentionGate` 拦停——群里零输出。
- **批量汇总**：1.2 秒内连发的消息合成一批只判一次；判定通过后**逐条**放行，
  插件内部串行排队，避免被上游合并成一条回复。
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
| `followUpBurstMs` | `1200` | 批量汇总窗口；`0` 表示不合并（0~5000 毫秒） |
| `followUpBurstMax` | `12` | 一批最多合并多少条，攒满立即判（2~50） |
| `followUpFloodWindowMs` | `10000` | 刷屏统计窗口（1000~60000 毫秒） |
| `followUpFloodMax` | `15` | 窗口内多少条算刷屏（1~200） |
| `followUpFloodCooldownMs` | `25000` | 刷屏后静默多久（1000~600000 毫秒） |
| `followUpFloodAction` | `'select'` | 刷屏时 `select` 只回挑中的，`skip` 整段不回 |
| `followUpSelectMin` | `5` | 一批达到多少条就让模型挑编号（2~50） |
| `followUpQuoteReply` | `false` | 群聊回复带引用框；失败自动退回普通发送 |
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

`followup.test.mjs` 覆盖续聊窗口的全部行为：开窗/续期/超时、判定解析、模型路由、失败策略、
批量与串行放行、刷屏断路器、`select` 挑编号、引用回复、配置边界。

实测环境：qqbot 0.5.5 + qqbot-nodejs 1.0.5，Node 24（CI 同时跑 Node 22），
`selfcheck` 22 项全 PASS，测试 65 个用例全过。

### 已知限制

- 补丁打在 `QQBot.prototype` 上，必须和 qqbot 解析到同一个 SDK 实例；装多份不同版本 SDK 时可能静默失效。
- 历史里的附件路径只保证 24 小时内有效（媒体默认 24 小时过期），且只保留最近 200 条附件摘要。
- 判定是模型判断，不是确定性规则：可能多回一句，也可能冷场；默认失败策略偏保守。
- 续聊窗口只存在内存里，DSH 重启后需要重新唤醒。
- 不改 qqbot 源码、不写 `node_modules`、不碰 App 的 Java 层。

## License

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 anwesc。
