/**
 * qqbot-guard 的客户端半侧：在 DSH「设置」里加一个「QQ 守护」板块。
 *
 * 布局思路（移动端优先）：
 * - 每个分组是一张可折叠卡片，标题下面带一行「当前值摘要」，收起时也知道里面是什么；
 * - 开关和数字用紧凑行（说明在左、控件在右），短数字两列并排，不再一项占一大块；
 * - 关键词、下拉、路径这类需要横向空间的内容才整行铺开；
 * - 顶部一条运行状态，底部粘一条保存栏，随时能看到「有未保存的改动」。
 *
 * 手写、不打包：DSH 的模块加载器按约定加载 `client.js`（package.json 的 `exports["./client"]`），
 * 内容就是 `window.__ModuleLoader__.load({ id, factory })` 包一层 CJS 工厂；
 * React 由宿主通过 `require('react')` 提供，所以这里不需要 node_modules。
 *
 * 数据全部走宿主同源的 `/qqbot-guard/config`（服务端在 index.js 的 installConfigApi 里注册），
 * 保存后 guard 端会按文件 mtime 热重载，下一条群消息就生效；只有「总开关」与附件下载相关
 * 的项需要重启插件才生效，UI 上会单独标「需重启」。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qqbot-guard',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const NS = 'qqbot-guard';
    const API = '/qqbot-guard/config';
    const OPEN_KEY = 'dsh-qqbot-guard:open-cards';

    const zh = {
      nav: 'QQ 守护',
      title: 'QQ 守护',
      intro: '群消息不 @ 也能触发 QQ 机器人：正文命中关键词时自动补一条「被 @」标记，并顺带带上群历史。',
      keywords: '关键词',
      keywordsHint: '一行一个；正文包含任一词就当作在跟你说话。留空表示关闭关键词放行。',
      switches: '开关',
      enabled: '启用守护',
      enabledHint: '关掉后 qqbot 恢复原样。修改后需要重启插件才生效。',
      faces: '表情转文字',
      facesHint: '把新版表情标签换成 emoji，历史里不再是一串标签。',
      historyAttachments: '历史附件摘要',
      historyAttachmentsHint: '群历史只存正文，开启后补一句附件说明。',
      historyMedia: '预下载历史附件',
      historyMediaHint: '没触发关键词的群消息也把图片/文件落盘；重启后生效。',
      ignoreCase: '忽略大小写',
      verbose: '诊断日志',
      followUp: '续聊窗口',
      groupBurst: '批量与回复',
      groupSticker: '附和表情',
      groupFlood: '刷屏保护',
      groupJudge: '判定模型与失败策略',
      groupHistory: '判定记录',
      historyEmpty: '还没有判定记录。群里有消息触发续聊后，这里会显示最近 10 次判定。',
      historyHint: '判错了就点一下：纠正会当作例子带进下一次判定（最多 5 条，跟插件配置一起保存）。',
      historyCount: '条记录',
      corrTag: '已纠正',
      corrReply: '该回',
      corrIgnore: '不该回',
      corrRemove: '移除',
      verdictReply: '该回',
      verdictAck: '围观',
      verdictIgnore: '不回',
      topicAnchor: '话题锚点',
      topicAnchorHint: '开窗时让模型用一句话概括当前话题，判定时带上它；群里换了话题更容易判 0。',
      cardWake: '唤醒与开关',
      cardHandling: '消息处理',
      restartTag: '需重启',
      summaryOn: '已开启',
      summaryOff: '已关闭',
      keywordUnit: '个关键词',
      expandAll: '展开全部',
      collapseAll: '收起全部',
      dirty: '有未保存的改动',
      upToDate: '已是最新',
      quoteShort: '引用',
      ackShortRenew: '只续期',
      ackShortReply: '照常回',
      ackShortIgnore: '忽略',
      replyShortAuto: '自动判断',
      replyShortBatch: '合并回复',
      replyShortEach: '逐条回复',
      floodShortSelect: '只回相关',
      floodShortSkip: '整段不回',
      judgeShortSkip: '失败不回',
      judgeShortReply: '失败照回',
      unitMinutes: '分钟',
      unitSeconds: '秒',
      unitMessages: '条',
      summaryPerBatch: '每批',
      summaryMaxWait: '最长等',
      summaryCooldown: '冷却',
      autoDetect: '自动探测',
      followUpHint:
        '关键词或 @ 唤醒后，群里没 @ 的消息也会先问一次小模型「还是同一个话题吗」：是就继续回，不是就不吭声。超过设定时间没有相关消息就休眠。',
      followUpEnabled: '启用续聊',
      followUpEnabledHint: '关掉后只有关键词和 @ 能唤醒。',
      followUpQuoteReply: '回复时带引用框',
      followUpQuoteReplyHint:
        '引用被回复的那条消息，方便看上下文。合并回复默认不带引用框，逐条回复才会挂。',
      followUpReplyMode: '回复形态',
      followUpReplyModeHint:
        'auto 让模型判断：同一话题能一条讲完就合并成一条，讲不完再逐条；拿不准按逐条。',
      followUpReplyModeAuto: '自动判断（auto）',
      followUpReplyModeBatch: '总是合并（batch）',
      followUpReplyModeEach: '总是逐条（each）',
      followUpAckMode: '笑声/附和怎么处理',
      followUpAckModeHint: '「哈哈哈」「收到」这类不单独回，只把窗口续上；想让它们也回就改成 reply。',
      followUpAckRenew: '只续期（renew）',
      followUpAckReply: '照常判定回复（reply）',
      followUpAckIgnore: '完全忽略（ignore）',
      followUpAckFastPath: '短附和直接续期，不调判定',
      followUpAckFastPathHint: '纯笑声、+1、表情这类不花模型调用；不确定时关掉。',
      followUpSticker: '附和时发一张表情',
      followUpStickerHint: '判定为「哈哈哈/收到」这类附和时，只发一张内置表情代替冷场；只发表情，不回文本。',
      followUpStickerCooldown: '同群表情最小间隔（毫秒）',
      followUpStickerDir: '自定义表情目录',
      followUpStickerDirHint: '留空用内置的 9 张鲸鱼娘（同人二创，仅限个人非商业）；也可以填自己的 png/jpg/gif/webp 目录。',
      followUpStickerDirPlaceholder: '留空 = 内置表情',
      followUpWindow: '静默休眠（分钟）',
      followUpWindowHint: '这段时间里没有相关消息就关窗；再想聊得重新 @ 或发关键词。',
      followUpBurst: '批量汇总窗口（毫秒）',
      followUpBurstHint:
        '这段时间内连着发的消息合并成一次判定，省 token；判定还会给出「合并成一条」还是「逐条回」。0 表示不合并。',
      followUpBurstMax: '每批最多合并（条）',
      followUpBurstMaxWait: '最长等待（毫秒）',
      followUpBurstMaxWaitHint: '群里一直说话时，从第一条起最多等这么久就结算',
      followUpFlood: '刷屏保护',
      followUpFloodHint:
        '短时间消息太多时不再逐条判定，避免排队越拖越长、回复全是过期的。@ 和关键词不受影响。',
      followUpFloodWindow: '刷屏统计窗口（毫秒）',
      followUpFloodMax: '窗口内超过（条）',
      followUpFloodCooldown: '静默冷却（毫秒）',
      followUpFloodAction: '刷屏时',
      followUpFloodSelect: '只回相关（select）',
      followUpFloodSkip: '整段不回（skip）',
      followUpSelectMin: '超过几条开始挑选',
      followUpMaxTurns: '单次最多回复（条）',
      followUpMaxTurnsHint: '0 表示不限。达到上限后本条照回，随后关窗。',
      followUpJudgeProvider: '判定模型 provider',
      followUpJudgeModel: '判定模型 model',
      followUpJudgeHint: '留空则按这个群实际用的模型解析；两个都填才覆盖。',
      followUpJudgeTimeout: '判定超时（毫秒）',
      followUpOnError: '判定失败时',
      followUpOnErrorHint: '推荐 skip：宁可冷场，也别把无关话题吸进来。',
      followUpOnErrorSkip: '不回复（skip）',
      followUpOnErrorReply: '照常回复（reply）',
      followUpWindows: '活动窗口',
      advanced: '高级',
      qqbotPackage: 'qqbot 安装目录',
      qqbotPackageHint: '留空自动探测；一般不用填。',
      maxMB: '预下载上限（MB）',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，下一条消息生效',
      reload: '重新加载',
      loading: '读取配置中…',
      failed: '读取失败',
      status: '运行状态',
      location: 'qqbot 位置',
      notFound: '没找到',
      installed: '补丁已挂载',
      notInstalled: '补丁未挂载',
      restartNeeded: '总开关/预下载的改动需要重启插件才生效。',
      overridden: '这些字段被 cordis 配置覆盖，改这里不会生效：',
      file: '配置文件',
    };

    const en = {
      nav: 'QQ Guard',
      title: 'QQ Guard',
      intro: 'Let group messages reach the QQ bot without an @ mention: keyword hits get a synthetic mention and pull in group history.',
      keywords: 'Keywords',
      keywordsHint: 'One per line. Any hit counts as talking to you. Leave empty to disable keyword gating.',
      switches: 'Switches',
      enabled: 'Enable guard',
      enabledHint: 'When off, qqbot behaves as stock. Takes effect after the plugin restarts.',
      faces: 'Emoji tags to text',
      facesHint: 'Rewrite <faceType=…> tags into emoji in history.',
      historyAttachments: 'History attachment notes',
      historyAttachmentsHint: 'Append a short attachment note when reading group history.',
      historyMedia: 'Prefetch history media',
      historyMediaHint: 'Download media for messages that never triggered a keyword.',
      ignoreCase: 'Ignore case',
      verbose: 'Diagnostic logs',
      groupBurst: 'Batching & replies',
      groupSticker: 'Reaction stickers',
      groupFlood: 'Flood protection',
      groupJudge: 'Judge model & failures',
      groupHistory: 'Judge log',
      historyEmpty: 'No decisions yet. Once a message opens a follow-up window, the last 10 decisions show up here.',
      historyHint: 'Wrong call? Tap to correct it; corrections ride along as examples (up to 5, saved with the plugin config).',
      historyCount: 'decisions',
      corrTag: 'Corrected',
      corrReply: 'Reply',
      corrIgnore: 'Skip',
      corrRemove: 'Remove',
      verdictReply: 'reply',
      verdictAck: 'ack',
      verdictIgnore: 'skip',
      topicAnchor: 'Topic anchor',
      topicAnchorHint: 'Summarize the current topic when a window opens and feed it to the judge, so a change of subject is easier to skip.',
      cardWake: 'Wake-up & keywords',
      cardHandling: 'Message handling',
      restartTag: 'restart',
      summaryOn: 'On',
      summaryOff: 'Off',
      keywordUnit: 'keywords',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      dirty: 'Unsaved changes',
      upToDate: 'Up to date',
      quoteShort: 'quote',
      ackShortRenew: 'renew only',
      ackShortReply: 'reply',
      ackShortIgnore: 'ignore',
      replyShortAuto: 'auto',
      replyShortBatch: 'combined',
      replyShortEach: 'separate',
      floodShortSelect: 'related only',
      floodShortSkip: 'silent',
      judgeShortSkip: 'stay quiet',
      judgeShortReply: 'reply anyway',
      unitMinutes: 'min',
      unitSeconds: 's',
      unitMessages: 'msgs',
      summaryPerBatch: 'per batch',
      summaryMaxWait: 'wait max',
      summaryCooldown: 'cooldown',
      autoDetect: 'auto-detect',
      followUpHint:
        'After a keyword or @ wakes the bot, un-mentioned group messages are checked once with a small model: same topic → keep replying, otherwise stay quiet. The window sleeps after the configured silence.',
      followUpEnabled: 'Enable follow-up',
      followUpEnabledHint: 'When off, only keywords and @ can wake the bot.',
      followUpQuoteReply: 'Quote the message being replied to',
      followUpQuoteReplyHint:
        'Quote the message being answered for context. Combined batch replies omit the quote block.',
      followUpReplyMode: 'Reply shape',
      followUpReplyModeHint:
        'auto lets the judge decide: one combined reply when it can cover the batch, otherwise one per message; unsure means separate.',
      followUpReplyModeAuto: 'Auto',
      followUpReplyModeBatch: 'Always combine (batch)',
      followUpReplyModeEach: 'Always separate (each)',
      followUpAckMode: 'Laughter / acknowledgements',
      followUpAckModeHint:
        'Short reactions like “haha” or “got it” renew the window without a reply; switch to reply to answer them too.',
      followUpAckRenew: 'Renew only (renew)',
      followUpAckReply: 'Judge and reply (reply)',
      followUpAckIgnore: 'Ignore (ignore)',
      followUpAckFastPath: 'Renew short reactions without judging',
      followUpAckFastPathHint: 'Pure laughter, +1 or emoji skip the model call; turn off if unsure.',
      followUpSticker: 'Send a sticker for short reactions',
      followUpStickerHint: 'When the scene is just laughter or acknowledgement, send one built-in sticker instead of text.',
      followUpStickerCooldown: 'Sticker cooldown per group (ms)',
      followUpStickerDir: 'Custom sticker folder',
      followUpStickerDirHint: 'Leave empty for the 9 built-in whale-maid stickers (fan art, personal non-commercial use only), or point at your own png/jpg/gif/webp folder.',
      followUpStickerDirPlaceholder: 'Empty = built-in stickers',
      followUpWindow: 'Sleep after silence (minutes)',
      followUpWindowHint: 'No related message for this long closes the window; wake it again with @ or a keyword.',
      followUpBurst: 'Batch window (ms)',
      followUpBurstHint:
        'Messages arriving within this window are judged together to save tokens; the judge also decides whether to send one combined reply or separate replies. 0 disables batching.',
      followUpBurstMax: 'Max messages per batch',
      followUpBurstMaxWait: 'Max wait (ms)',
      followUpBurstMaxWaitHint: 'During continuous chat, settle at most this long after the first message',
      followUpFlood: 'Flood protection',
      followUpFloodHint:
        'During a burst, stop judging every message so the queue cannot grow and replies cannot go stale. @ mentions and keywords still work.',
      followUpFloodWindow: 'Flood window (ms)',
      followUpFloodMax: 'Trigger above (messages)',
      followUpFloodCooldown: 'Silent cooldown (ms)',
      followUpFloodAction: 'During a flood',
      followUpFloodSelect: 'Reply only to related (select)',
      followUpFloodSkip: 'Stay silent (skip)',
      followUpSelectMin: 'Pick above (messages)',
      followUpMaxTurns: 'Max replies per window',
      followUpMaxTurnsHint: '0 means unlimited. The turn that reaches the cap still gets a reply, then the window closes.',
      followUpJudgeProvider: 'Judge provider',
      followUpJudgeModel: 'Judge model',
      followUpJudgeHint: 'Leave empty to use the model this group actually runs; set both to override.',
      followUpJudgeTimeout: 'Judge timeout (ms)',
      followUpOnError: 'When judging fails',
      followUpOnErrorHint: 'skip is recommended: better to stay quiet than absorb an unrelated topic.',
      followUpOnErrorSkip: 'Stay quiet (skip)',
      followUpOnErrorReply: 'Reply anyway (reply)',
      followUpWindows: 'Active windows',
      advanced: 'Advanced',
      qqbotPackage: 'qqbot install dir',
      qqbotPackageHint: 'Leave empty to auto-detect.',
      maxMB: 'Prefetch limit (MB)',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved — applies to the next message',
      reload: 'Reload',
      loading: 'Loading…',
      failed: 'Failed to load',
      status: 'Status',
      location: 'qqbot location',
      notFound: 'not found',
      installed: 'Patch mounted',
      notInstalled: 'Patch not mounted',
      restartNeeded: 'Changes to the master switch or prefetch need a plugin restart.',
      overridden: 'These fields are set by the cordis config and ignore this page:',
      file: 'Config file',
    };

    const BORDER = 'var(--dsh-border, rgba(127,127,127,.28))';
    const ACCENT = 'var(--dsh-accent, #4c6ef5)';
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    const SURFACE = 'var(--dsh-surface, transparent)';

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 14, padding: '2px 2px 6px' },
      intro: { margin: 0, fontSize: 13, lineHeight: 1.7, opacity: 0.86 },

      statusStrip: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        borderRadius: 12,
        background: 'rgba(127,127,127,.07)',
      },
      statusRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      pathLine: {
        margin: 0,
        fontSize: 11.5,
        lineHeight: 1.5,
        opacity: 0.6,
        fontFamily: MONO,
        wordBreak: 'break-all',
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 9px',
        borderRadius: 999,
        fontSize: 12,
        border: `1px solid ${BORDER}`,
        opacity: 0.9,
        whiteSpace: 'nowrap',
      },

      toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 },
      linkButton: {
        border: 0,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        opacity: 0.6,
        cursor: 'pointer',
        padding: '2px 4px',
      },

      card: { border: `1px solid ${BORDER}`, borderRadius: 14, overflow: 'hidden' },
      cardHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '12px 14px',
        border: 0,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      cardHeaderText: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 },
      cardTitle: { fontSize: 13.5, fontWeight: 700 },
      cardSummary: {
        fontSize: 11.5,
        opacity: 0.55,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      chevron: {
        flex: '0 0 auto',
        width: 7,
        height: 7,
        marginTop: -3,
        marginRight: 2,
        borderRight: '1.6px solid currentColor',
        borderBottom: '1.6px solid currentColor',
        opacity: 0.4,
        transition: 'transform .18s ease, opacity .18s ease',
      },
      cardBody: { display: 'flex', flexDirection: 'column', gap: 14, padding: '2px 14px 14px' },

      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '2px 0',
      },
      rowText: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      control: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' },
      labelLine: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      label: { fontSize: 13, fontWeight: 600 },
      hint: { margin: 0, fontSize: 12, lineHeight: 1.55, opacity: 0.66 },
      tag: {
        fontSize: 10.5,
        lineHeight: 1.4,
        padding: '1px 6px',
        borderRadius: 6,
        border: `1px dashed ${BORDER}`,
        opacity: 0.6,
        whiteSpace: 'nowrap',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11.5,
        background: 'rgba(127,127,127,.12)',
        opacity: 0.85,
      },

      judgeRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '7px 0',
        borderTop: `1px solid ${BORDER}`,
      },
      judgeTime: {
        flex: '0 0 auto',
        paddingTop: 2,
        fontSize: 11,
        opacity: 0.5,
        fontVariantNumeric: 'tabular-nums',
      },
      judgeText: {
        flex: '1 1 auto',
        minWidth: 0,
        fontSize: 12.5,
        lineHeight: 1.5,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      judgeActions: { flex: '0 0 auto', display: 'flex', gap: 6 },
      verdict: {
        flex: '0 0 auto',
        padding: '1px 6px',
        borderRadius: 6,
        fontSize: 11,
        background: 'rgba(127,127,127,.14)',
        opacity: 0.85,
        whiteSpace: 'nowrap',
      },
      verdictReply: {
        background: 'rgba(64,160,96,.16)',
        color: 'rgba(64,160,96,.95)',
        opacity: 1,
      },
      miniButton: {
        padding: '3px 8px',
        borderRadius: 7,
        border: `1px solid ${BORDER}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 11.5,
        cursor: 'pointer',
      },

      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))',
        gap: 12,
      },
      textarea: {
        width: '100%',
        minHeight: 88,
        boxSizing: 'border-box',
        padding: '10px 12px',
        borderRadius: 10,
        border: `1px solid ${BORDER}`,
        background: SURFACE,
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        lineHeight: 1.6,
        resize: 'vertical',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        height: 36,
        padding: '0 12px',
        borderRadius: 10,
        border: `1px solid ${BORDER}`,
        background: SURFACE,
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
      },
      select: {
        width: '100%',
        boxSizing: 'border-box',
        height: 36,
        padding: '0 34px 0 10px',
        borderRadius: 10,
        border: `1px solid ${BORDER}`,
        background: SURFACE,
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' fill='none' stroke='%23888a8f' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 12px center',
        backgroundSize: '11px 8px',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        appearance: 'none',
        WebkitAppearance: 'none',
        cursor: 'pointer',
      },
      numberInput: {
        width: 96,
        boxSizing: 'border-box',
        height: 34,
        padding: '0 10px',
        borderRadius: 9,
        border: `1px solid ${BORDER}`,
        background: SURFACE,
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
      },

      footer: {
        position: 'sticky',
        bottom: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        flexWrap: 'wrap',
        padding: '10px 2px',
        borderTop: `1px solid ${BORDER}`,
        background: 'var(--dsh-surface, rgba(127,127,127,.08))',
        backdropFilter: 'blur(8px)',
      },
      footerState: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 auto' },
      footerActions: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' },
      button: {
        padding: '8px 18px',
        borderRadius: 10,
        border: `1px solid ${BORDER}`,
        background: ACCENT,
        color: '#fff',
        font: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      },
      buttonDisabled: {
        background: 'rgba(127,127,127,.16)',
        borderColor: BORDER,
        color: 'inherit',
        opacity: 0.75,
        cursor: 'default',
      },
      buttonGhost: {
        padding: '8px 14px',
        borderRadius: 10,
        border: `1px solid ${BORDER}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      notice: { fontSize: 12.5, lineHeight: 1.6, margin: 0 },
      mono: { fontFamily: MONO, fontSize: 12, wordBreak: 'break-all' },
    };

    /** 哪些字段属于布尔值 / 数值 / 字符串，保存时按这个顺序拼 body（保证脏检查稳定）。 */
    const BOOL_KEYS = [
      'enabled',
      'ignoreCase',
      'faces',
      'historyAttachments',
      'historyMedia',
      'verbose',
      'strictVersion',
      'followUpEnabled',
      'followUpQuoteReply',
      'followUpAckFastPath',
      'followUpStickerEnabled',
      'followUpTopicAnchor',
    ];
    const NUM_KEYS = [
      'historyMediaMaxMB',
      'followUpWindowMinutes',
      'followUpBurstMs',
      'followUpBurstMax',
      'followUpBurstMaxWaitMs',
      'followUpMaxTurns',
      'followUpJudgeTimeoutMs',
      'followUpFloodWindowMs',
      'followUpFloodMax',
      'followUpFloodCooldownMs',
      'followUpSelectMin',
      'followUpStickerCooldownMs',
    ];
    const STR_KEYS = [
      'followUpReplyMode',
      'followUpAckMode',
      'followUpFloodAction',
      'followUpOnJudgeError',
      'followUpJudgeProvider',
      'followUpJudgeModel',
      'followUpStickerDir',
      'qqbotPackage',
    ];

    const HANDLING_TOGGLES = [
      ['faces', 'facesHint', false],
      ['historyAttachments', 'historyAttachmentsHint', false],
      ['historyMedia', 'historyMediaHint', true],
      ['ignoreCase', null, false],
      ['verbose', null, false],
    ];

    const REPLY_SHORT = { auto: 'replyShortAuto', batch: 'replyShortBatch', each: 'replyShortEach' };
    const ACK_SHORT = { renew: 'ackShortRenew', reply: 'ackShortReply', ignore: 'ackShortIgnore' };
    const FLOOD_SHORT = { select: 'floodShortSelect', skip: 'floodShortSkip' };

    const DEFAULT_OPEN = {
      wake: true,
      handling: false,
      follow: true,
      sticker: false,
      burst: false,
      flood: false,
      judge: false,
      history: false,
      advanced: false,
    };

    function parseKeywords(text) {
      return String(text ?? '')
        .split(/\r?\n|,|，/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    function buildBody(config, keywords) {
      const cfg = config ?? {};
      const body = { triggers: parseKeywords(keywords) };
      for (const key of BOOL_KEYS) if (typeof cfg[key] === 'boolean') body[key] = cfg[key];
      for (const key of NUM_KEYS) if (cfg[key] !== undefined) body[key] = Number(cfg[key]);
      for (const key of STR_KEYS) if (typeof cfg[key] === 'string') body[key] = cfg[key];
      if (Array.isArray(cfg.followUpJudgeExamples)) {
        body.followUpJudgeExamples = cfg.followUpJudgeExamples
          .slice(0, 5)
          .map((item) => ({
            text: String(item?.text ?? '').slice(0, 120),
            verdict: item?.verdict === 'ignore' ? 'ignore' : 'reply',
          }))
          .filter((item) => item.text);
      }
      return body;
    }

    function sec(ms) {
      const n = Number(ms) || 0;
      return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}s`;
    }

    function readOpenCards() {
      try {
        const raw = globalThis.localStorage?.getItem(OPEN_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') return { ...DEFAULT_OPEN, ...parsed };
        }
      } catch {
        /* 隐私模式 / 存储被禁：用默认值即可 */
      }
      return DEFAULT_OPEN;
    }

    function writeOpenCards(next) {
      try {
        globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
    }

    /** 折叠状态记在 localStorage 里，下次打开设置页保持上次的样子。 */
    function useOpenCards() {
      const [open, setOpen] = useState(readOpenCards);
      const toggle = useCallback((key) => {
        setOpen((prev) => {
          const next = { ...prev, [key]: !prev[key] };
          writeOpenCards(next);
          return next;
        });
      }, []);
      const setAll = useCallback((value) => {
        setOpen(() => {
          const next = {};
          for (const key of Object.keys(DEFAULT_OPEN)) next[key] = value;
          writeOpenCards(next);
          return next;
        });
      }, []);
      return { open, toggle, setAll };
    }

    function Toggle({ id, checked, onChange, disabled }) {
      return h(
        'button',
        {
          id,
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          disabled,
          onClick: () => onChange(!checked),
          style: {
            position: 'relative',
            flex: '0 0 auto',
            width: 38,
            height: 22,
            padding: 0,
            border: 0,
            borderRadius: 999,
            background: checked ? ACCENT : 'rgba(127,127,127,.34)',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            transition: 'background .16s ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 18,
            height: 18,
            borderRadius: 999,
            background: '#fff',
            boxShadow: '0 1px 3px rgba(0,0,0,.3)',
            transition: 'left .16s ease',
          },
        }),
      );
    }

    /** 紧凑行：说明在左、控件在右。开关和数字用它。 */
    function Row({ id, label, hint, tag, control }) {
      return h(
        'div',
        { style: S.row },
        h(
          'div',
          { style: S.rowText },
          h(
            'label',
            { htmlFor: id, style: S.labelLine },
            h('span', { style: S.label }, label),
            tag ? h('span', { style: S.tag }, tag) : null,
          ),
          hint ? h('p', { style: S.hint }, hint) : null,
        ),
        h('div', { style: S.control }, control),
      );
    }

    function Field({ id, label, hint, extra, children }) {
      return h(
        'div',
        { style: S.field },
        h(
          'div',
          { style: S.labelLine },
          h('label', { htmlFor: id, style: S.label }, label),
          extra || null,
        ),
        children,
        hint ? h('p', { style: S.hint }, hint) : null,
      );
    }

    function NumberRow({ id, label, hint, value, min, max, onChange }) {
      return h(Row, {
        id,
        label,
        hint,
        control: h('input', {
          id,
          type: 'number',
          min,
          max,
          inputMode: 'numeric',
          style: S.numberInput,
          value: value ?? '',
          onChange: (event) => onChange(Number(event.target.value)),
        }),
      });
    }

    /** 网格里的小数字格：标签在上、输入框铺满，用来两列并排。 */
    function NumberCell({ id, label, hint, value, min, max, onChange }) {
      return h(
        Field,
        { id, label, hint },
        h('input', {
          id,
          type: 'number',
          min,
          max,
          inputMode: 'numeric',
          style: { ...S.numberInput, width: '100%' },
          value: value ?? '',
          onChange: (event) => onChange(Number(event.target.value)),
        }),
      );
    }

    function SelectField({ id, label, hint, value, options, onChange }) {
      return h(
        Field,
        { id, label, hint },
        h(
          'select',
          { id, style: S.select, value, onChange: (event) => onChange(event.target.value) },
          options.map(([optionValue, text]) => h('option', { key: optionValue, value: optionValue }, text)),
        ),
      );
    }

    function TextField({ id, label, hint, placeholder, value, onChange }) {
      return h(
        Field,
        { id, label, hint },
        h('input', {
          id,
          type: 'text',
          style: S.input,
          placeholder,
          value: value ?? '',
          onChange: (event) => onChange(event.target.value),
        }),
      );
    }

    /** 可折叠卡片：标题 + 当前值摘要，收起也知道里面是什么。 */
    function Card({ cardId, title, summary, open, onToggle, children }) {
      const bodyId = `qqbot-guard-card-${cardId}`;
      return h(
        'section',
        { style: S.card },
        h(
          'button',
          {
            type: 'button',
            style: S.cardHeader,
            onClick: () => onToggle(cardId),
            'aria-expanded': open,
            'aria-controls': bodyId,
          },
          h(
            'span',
            { style: S.cardHeaderText },
            h('span', { style: S.cardTitle }, title),
            summary ? h('span', { style: S.cardSummary }, summary) : null,
          ),
          h('span', { style: { ...S.chevron, transform: open ? 'rotate(45deg)' : 'rotate(-45deg)' } }),
        ),
        open
          ? h('div', { id: bodyId, style: S.cardBody }, children)
          : null,
      );
    }

    function Section({ t }) {
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [file, setFile] = useState('');
      const [status, setStatus] = useState({});
      const [config, setConfig] = useState(null);
      const [keywords, setKeywords] = useState('');
      const [overridden, setOverridden] = useState([]);
      const [baseline, setBaseline] = useState(null);
      const { open, toggle, setAll } = useOpenCards();

      const applyPayload = useCallback((payload) => {
        const cfg = payload?.config ?? {};
        const list = Array.isArray(cfg.triggers) ? cfg.triggers.join('\n') : '';
        setConfig(cfg);
        setFile(payload?.file ?? '');
        setStatus(payload?.status ?? {});
        setOverridden(Array.isArray(payload?.overridden) ? payload.overridden : []);
        setKeywords(list);
        setBaseline(JSON.stringify(buildBody(cfg, list)));
        setNotice('');
      }, []);

      const load = useCallback(async () => {
        setError('');
        try {
          const response = await fetch(API, { headers: { accept: 'application/json' } });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
          applyPayload(payload);
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setLoading(false);
        }
      }, [applyPayload]);

      useEffect(() => {
        void load();
      }, [load]);

      const patch = useCallback((key, value) => {
        setConfig((prev) => ({ ...(prev ?? {}), [key]: value }));
        setNotice('');
      }, []);

      const body = useMemo(() => buildBody(config, keywords), [config, keywords]);
      const dirty = baseline !== null && JSON.stringify(body) !== baseline;

      const save = useCallback(async () => {
        if (!config) return;
        setSaving(true);
        setError('');
        setNotice('');
        try {
          const response = await fetch(API, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(buildBody(config, keywords)),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
          applyPayload(payload);
          setNotice(t('saved'));
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setSaving(false);
        }
      }, [applyPayload, config, keywords, t]);

      const statusBits = useMemo(() => {
        if (!status) return [];
        const bits = [];
        if (status.installed) bits.push({ key: 'installed', text: t('installed'), tone: 'ok' });
        else if (status.reason) bits.push({ key: 'idle', text: status.reason, tone: 'warn' });
        return bits;
      }, [status, t]);

      const judgeRecent = Array.isArray(status?.followUpJudge?.recent) ? status.followUpJudge.recent : [];
      const judgeExamples = Array.isArray(config?.followUpJudgeExamples) ? config.followUpJudgeExamples : [];
      const historySummary = judgeRecent.length
        ? `${judgeRecent.length} ${t('historyCount')}${
            judgeExamples.length ? ` · ${t('corrTag')} ${judgeExamples.length}/5` : ''
          }`
        : t('historyEmpty');

      const addJudgeExample = useCallback((entry, verdict) => {
        const text = String(entry?.text ?? '').slice(0, 120);
        if (!text) return;
        setConfig((prev) => {
          const list = Array.isArray(prev?.followUpJudgeExamples) ? prev.followUpJudgeExamples : [];
          return {
            ...(prev ?? {}),
            followUpJudgeExamples: [{ text, verdict }, ...list.filter((item) => item.text !== text)].slice(0, 5),
          };
        });
        setNotice('');
      }, []);

      const removeJudgeExample = useCallback((text) => {
        setConfig((prev) => {
          const list = Array.isArray(prev?.followUpJudgeExamples) ? prev.followUpJudgeExamples : [];
          return { ...(prev ?? {}), followUpJudgeExamples: list.filter((item) => item.text !== text) };
        });
        setNotice('');
      }, []);

      if (loading) {
        return h('div', { style: S.root }, h('p', { style: S.hint }, t('loading')));
      }

      if (!config) {
        return h(
          'div',
          { style: S.root },
          h('p', { style: S.notice, role: 'alert' }, `${t('failed')}: ${error || 'unknown'}`),
          h('button', { type: 'button', style: S.buttonGhost, onClick: () => void load() }, t('reload')),
        );
      }

      const count = parseKeywords(keywords).length;
      const handlingOn = HANDLING_TOGGLES.filter(([key]) => config[key] !== false).length;
      const followOn = config.followUpEnabled !== false;
      const stickerOn = config.followUpStickerEnabled !== false;
      const floodAction = config.followUpFloodAction ?? 'select';
      const replyMode = config.followUpReplyMode ?? 'auto';
      const ackMode = config.followUpAckMode ?? 'renew';
      const onError = config.followUpOnJudgeError ?? 'skip';

      const wakeSummary = `${config.enabled !== false ? t('summaryOn') : t('summaryOff')} · ${count} ${t('keywordUnit')}`;
      const handlingSummary = `${t('summaryOn')} ${handlingOn}/${HANDLING_TOGGLES.length}`;
      const followSummary = followOn
        ? `${config.followUpWindowMinutes ?? 10} ${t('unitMinutes')} · ${t(REPLY_SHORT[replyMode] ?? 'replyShortAuto')}${
            config.followUpQuoteReply !== false ? ` · ${t('quoteShort')}` : ''
          }`
        : t('summaryOff');
      const stickerSummary = stickerOn
        ? `${t(ACK_SHORT[ackMode] ?? 'ackShortRenew')} · ${sec(config.followUpStickerCooldownMs ?? 4000)}`
        : t('summaryOff');
      const burstSummary = `${sec(config.followUpBurstMs ?? 1200)} · ${t('summaryPerBatch')} ${
        config.followUpBurstMax ?? 12
      } ${t('unitMessages')} · ${t('summaryMaxWait')} ${sec(config.followUpBurstMaxWaitMs ?? 4000)}`;
      const floodSummary = `${t(FLOOD_SHORT[floodAction] ?? 'floodShortSelect')} · ${sec(
        config.followUpFloodWindowMs ?? 10000,
      )} ${config.followUpFloodMax ?? 15} ${t('unitMessages')} · ${t('summaryCooldown')} ${sec(
        config.followUpFloodCooldownMs ?? 25000,
      )}`;
      const judgeSummary = `${sec(config.followUpJudgeTimeoutMs ?? 6000)} · ${
        config.followUpJudgeProvider || 'auto'
      } · ${t(onError === 'reply' ? 'judgeShortReply' : 'judgeShortSkip')}`;
      const advancedSummary = `${config.qqbotPackage || t('autoDetect')} · ${config.historyMediaMaxMB ?? 20} MB`;

      let stateText = null;
      if (error) {
        stateText = h('span', { style: { ...S.notice, color: 'rgba(214,80,80,.95)' }, role: 'alert' }, error);
      } else if (dirty) {
        stateText = h('span', { style: { ...S.notice, color: 'rgba(214,140,60,.95)' }, role: 'status' }, t('dirty'));
      } else if (notice) {
        stateText = h('span', { style: { ...S.notice, color: 'rgba(64,160,96,.95)' }, role: 'status' }, notice);
      } else if (baseline !== null) {
        stateText = h('span', { style: { ...S.hint, opacity: 0.5 } }, t('upToDate'));
      }

      return h(
        'div',
        { style: S.root },
        h('p', { style: S.intro }, t('intro')),

        // 运行状态：一条紧凑的条，不再占一整张卡
        h(
          'div',
          { style: S.statusStrip },
          h(
            'div',
            { style: S.statusRow },
            statusBits.map((bit) =>
              h(
                'span',
                {
                  key: bit.key,
                  style: {
                    ...S.badge,
                    borderColor: bit.tone === 'ok' ? 'rgba(64,160,96,.55)' : 'rgba(214,140,60,.55)',
                  },
                },
                bit.text,
              ),
            ),
            status?.followUpWindows !== undefined
              ? h('span', { style: S.badge }, `${t('followUpWindows')} ${status.followUpWindows}`)
              : null,
          ),
          h('p', { style: S.pathLine }, `${t('location')}: ${status?.qqbot || t('notFound')}`),
          file ? h('p', { style: S.pathLine }, `${t('file')}: ${file}`) : null,
        ),

        h(
          'div',
          { style: S.toolbar },
          h('button', { type: 'button', style: S.linkButton, onClick: () => setAll(true) }, t('expandAll')),
          h('span', { style: { opacity: 0.3, fontSize: 12 } }, '·'),
          h('button', { type: 'button', style: S.linkButton, onClick: () => setAll(false) }, t('collapseAll')),
        ),

        // 唤醒与开关
        h(
          Card,
          {
            cardId: 'wake',
            title: t('cardWake'),
            summary: wakeSummary,
            open: open.wake,
            onToggle: toggle,
          },
          h(Row, {
            id: 'qqbot-guard-enabled',
            label: t('enabled'),
            hint: t('enabledHint'),
            tag: t('restartTag'),
            control: h(Toggle, {
              id: 'qqbot-guard-enabled',
              checked: config.enabled !== false,
              onChange: (value) => patch('enabled', value),
            }),
          }),
          h(
            Field,
            {
              id: 'qqbot-guard-keywords',
              label: t('keywords'),
              hint: t('keywordsHint'),
              extra: h('span', { style: S.chip }, `${count} ${t('keywordUnit')}`),
            },
            h('textarea', {
              id: 'qqbot-guard-keywords',
              style: S.textarea,
              value: keywords,
              spellCheck: false,
              placeholder: '大肥鱼\n肥鱼\n鱼鱼',
              onChange: (event) => {
                setKeywords(event.target.value);
                setNotice('');
              },
            }),
          ),
        ),

        // 消息处理
        h(
          Card,
          {
            cardId: 'handling',
            title: t('cardHandling'),
            summary: handlingSummary,
            open: open.handling,
            onToggle: toggle,
          },
          HANDLING_TOGGLES.map(([key, hintKey, needsRestart]) =>
            h(Row, {
              key,
              id: `qqbot-guard-${key}`,
              label: t(key),
              hint: hintKey ? t(hintKey) : null,
              tag: needsRestart ? t('restartTag') : null,
              control: h(Toggle, {
                id: `qqbot-guard-${key}`,
                checked: config[key] !== false,
                onChange: (value) => patch(key, value),
              }),
            }),
          ),
        ),

        // 续聊窗口
        h(
          Card,
          {
            cardId: 'follow',
            title: t('followUp'),
            summary: followSummary,
            open: open.follow,
            onToggle: toggle,
          },
          h(Row, {
            id: 'qqbot-guard-followup',
            label: t('followUpEnabled'),
            hint: t('followUpEnabledHint'),
            control: h(Toggle, {
              id: 'qqbot-guard-followup',
              checked: followOn,
              onChange: (value) => patch('followUpEnabled', value),
            }),
          }),
          h(
            'div',
            { style: S.grid },
            h(NumberCell, {
              id: 'qqbot-guard-followup-window',
              label: t('followUpWindow'),
              hint: t('followUpWindowHint'),
              value: config.followUpWindowMinutes ?? 10,
              min: 1,
              max: 1440,
              onChange: (value) => patch('followUpWindowMinutes', value),
            }),
            h(NumberCell, {
              id: 'qqbot-guard-followup-turns',
              label: t('followUpMaxTurns'),
              hint: t('followUpMaxTurnsHint'),
              value: config.followUpMaxTurns ?? 0,
              min: 0,
              max: 1000,
              onChange: (value) => patch('followUpMaxTurns', value),
            }),
          ),
          h(SelectField, {
            id: 'qqbot-guard-followup-reply-mode',
            label: t('followUpReplyMode'),
            hint: t('followUpReplyModeHint'),
            value: replyMode,
            options: [
              ['auto', t('followUpReplyModeAuto')],
              ['batch', t('followUpReplyModeBatch')],
              ['each', t('followUpReplyModeEach')],
            ],
            onChange: (value) => patch('followUpReplyMode', value),
          }),
          h(Row, {
            id: 'qqbot-guard-followup-quote',
            label: t('followUpQuoteReply'),
            hint: t('followUpQuoteReplyHint'),
            control: h(Toggle, {
              id: 'qqbot-guard-followup-quote',
              checked: config.followUpQuoteReply !== false,
              onChange: (value) => patch('followUpQuoteReply', value),
            }),
          }),
          h(Row, {
            id: 'qqbot-guard-followup-sticker',
            label: t('followUpSticker'),
            hint: t('followUpStickerHint'),
            control: h(Toggle, {
              id: 'qqbot-guard-followup-sticker',
              checked: stickerOn,
              onChange: (value) => patch('followUpStickerEnabled', value),
            }),
          }),
        ),

        // 附和表情
        h(
          Card,
          {
            cardId: 'sticker',
            title: t('groupSticker'),
            summary: stickerSummary,
            open: open.sticker,
            onToggle: toggle,
          },
          h(SelectField, {
            id: 'qqbot-guard-followup-ack-mode',
            label: t('followUpAckMode'),
            hint: t('followUpAckModeHint'),
            value: ackMode,
            options: [
              ['renew', t('followUpAckRenew')],
              ['reply', t('followUpAckReply')],
              ['ignore', t('followUpAckIgnore')],
            ],
            onChange: (value) => patch('followUpAckMode', value),
          }),
          h(Row, {
            id: 'qqbot-guard-followup-ack-fast',
            label: t('followUpAckFastPath'),
            hint: t('followUpAckFastPathHint'),
            control: h(Toggle, {
              id: 'qqbot-guard-followup-ack-fast',
              checked: config.followUpAckFastPath !== false,
              onChange: (value) => patch('followUpAckFastPath', value),
            }),
          }),
          stickerOn
            ? h(
                'div',
                { style: S.grid },
                h(NumberCell, {
                  id: 'qqbot-guard-followup-sticker-cooldown',
                  label: t('followUpStickerCooldown'),
                  value: config.followUpStickerCooldownMs ?? 4000,
                  min: 1000,
                  max: 600000,
                  onChange: (value) => patch('followUpStickerCooldownMs', value),
                }),
              )
            : null,
          stickerOn
            ? h(TextField, {
                id: 'qqbot-guard-followup-sticker-dir',
                label: t('followUpStickerDir'),
                hint: t('followUpStickerDirHint'),
                placeholder: t('followUpStickerDirPlaceholder'),
                value: config.followUpStickerDir ?? '',
                onChange: (value) => patch('followUpStickerDir', value),
              })
            : null,
        ),

        // 批量与回复
        h(
          Card,
          {
            cardId: 'burst',
            title: t('groupBurst'),
            summary: burstSummary,
            open: open.burst,
            onToggle: toggle,
          },
          h(
            'div',
            { style: S.grid },
            h(NumberCell, {
              id: 'qqbot-guard-followup-burst',
              label: t('followUpBurst'),
              value: config.followUpBurstMs ?? 1200,
              min: 0,
              max: 5000,
              onChange: (value) => patch('followUpBurstMs', value),
            }),
            h(NumberCell, {
              id: 'qqbot-guard-followup-burst-max',
              label: t('followUpBurstMax'),
              value: config.followUpBurstMax ?? 12,
              min: 2,
              max: 50,
              onChange: (value) => patch('followUpBurstMax', value),
            }),
          ),
          h(NumberRow, {
            id: 'qqbot-guard-followup-burst-max-wait',
            label: t('followUpBurstMaxWait'),
            hint: t('followUpBurstMaxWaitHint'),
            value: config.followUpBurstMaxWaitMs ?? 4000,
            min: 1000,
            max: 20000,
            onChange: (value) => patch('followUpBurstMaxWaitMs', value),
          }),
          h('p', { style: S.hint }, t('followUpBurstHint')),
        ),

        // 刷屏保护
        h(
          Card,
          {
            cardId: 'flood',
            title: t('groupFlood'),
            summary: floodSummary,
            open: open.flood,
            onToggle: toggle,
          },
          h(SelectField, {
            id: 'qqbot-guard-followup-flood',
            label: t('followUpFloodAction'),
            hint: t('followUpFloodHint'),
            value: floodAction,
            options: [
              ['select', t('followUpFloodSelect')],
              ['skip', t('followUpFloodSkip')],
            ],
            onChange: (value) => patch('followUpFloodAction', value),
          }),
          h(
            'div',
            { style: S.grid },
            h(NumberCell, {
              id: 'qqbot-guard-followup-flood-window',
              label: t('followUpFloodWindow'),
              value: config.followUpFloodWindowMs ?? 10000,
              min: 1000,
              max: 60000,
              onChange: (value) => patch('followUpFloodWindowMs', value),
            }),
            h(NumberCell, {
              id: 'qqbot-guard-followup-flood-max',
              label: t('followUpFloodMax'),
              value: config.followUpFloodMax ?? 15,
              min: 1,
              max: 200,
              onChange: (value) => patch('followUpFloodMax', value),
            }),
            h(NumberCell, {
              id: 'qqbot-guard-followup-flood-cooldown',
              label: t('followUpFloodCooldown'),
              value: config.followUpFloodCooldownMs ?? 25000,
              min: 1000,
              max: 600000,
              onChange: (value) => patch('followUpFloodCooldownMs', value),
            }),
            floodAction === 'select'
              ? h(NumberCell, {
                  id: 'qqbot-guard-followup-select-min',
                  label: t('followUpSelectMin'),
                  value: config.followUpSelectMin ?? 5,
                  min: 2,
                  max: 50,
                  onChange: (value) => patch('followUpSelectMin', value),
                })
              : null,
          ),
        ),

        // 判定模型与失败策略
        h(
          Card,
          {
            cardId: 'judge',
            title: t('groupJudge'),
            summary: judgeSummary,
            open: open.judge,
            onToggle: toggle,
          },
          h(NumberRow, {
            id: 'qqbot-guard-followup-timeout',
            label: t('followUpJudgeTimeout'),
            value: config.followUpJudgeTimeoutMs ?? 6000,
            min: 500,
            max: 60000,
            onChange: (value) => patch('followUpJudgeTimeoutMs', value),
          }),
          h(
            'div',
            { style: S.grid },
            h(TextField, {
              id: 'qqbot-guard-followup-provider',
              label: t('followUpJudgeProvider'),
              placeholder: 'auto',
              value: config.followUpJudgeProvider ?? '',
              onChange: (value) => patch('followUpJudgeProvider', value),
            }),
            h(TextField, {
              id: 'qqbot-guard-followup-model',
              label: t('followUpJudgeModel'),
              placeholder: 'auto',
              value: config.followUpJudgeModel ?? '',
              onChange: (value) => patch('followUpJudgeModel', value),
            }),
          ),
          h('p', { style: S.hint }, t('followUpJudgeHint')),
          h(Row, {
            id: 'qqbot-guard-followup-topic',
            label: t('topicAnchor'),
            hint: t('topicAnchorHint'),
            control: h(Toggle, {
              id: 'qqbot-guard-followup-topic',
              checked: config.followUpTopicAnchor !== false,
              onChange: (value) => patch('followUpTopicAnchor', value),
            }),
          }),
          h(SelectField, {
            id: 'qqbot-guard-followup-error',
            label: t('followUpOnError'),
            hint: t('followUpOnErrorHint'),
            value: onError,
            options: [
              ['skip', t('followUpOnErrorSkip')],
              ['reply', t('followUpOnErrorReply')],
            ],
            onChange: (value) => patch('followUpOnJudgeError', value),
          }),
        ),

        // 判定记录与纠正
        h(
          Card,
          {
            cardId: 'history',
            title: t('groupHistory'),
            summary: historySummary,
            open: open.history,
            onToggle: toggle,
          },
          judgeRecent.length === 0
            ? h('p', { style: S.hint }, t('historyEmpty'))
            : h(
                'div',
                null,
                judgeRecent
                  .slice()
                  .reverse()
                  .map((entry) =>
                    h(
                      'div',
                      { key: entry.id, style: S.judgeRow },
                      h(
                        'span',
                        { style: S.judgeTime },
                        new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                      ),
                      h(
                        'span',
                        {
                          style: {
                            ...S.verdict,
                            ...(entry.verdict === 'reply' ? S.verdictReply : null),
                          },
                        },
                        t(
                          entry.verdict === 'reply'
                            ? 'verdictReply'
                            : entry.verdict === 'ack'
                              ? 'verdictAck'
                              : 'verdictIgnore',
                        ),
                      ),
                      h('span', { style: S.judgeText, title: entry.text }, entry.text),
                      h(
                        'span',
                        { style: S.judgeActions },
                        h(
                          'button',
                          { type: 'button', style: S.miniButton, onClick: () => addJudgeExample(entry, 'reply') },
                          t('corrReply'),
                        ),
                        h(
                          'button',
                          { type: 'button', style: S.miniButton, onClick: () => addJudgeExample(entry, 'ignore') },
                          t('corrIgnore'),
                        ),
                      ),
                    ),
                  ),
              ),
          judgeExamples.length > 0
            ? h(
                'div',
                null,
                h('p', { style: S.hint }, `${t('corrTag')} ${judgeExamples.length}/5`),
                judgeExamples.map((item) =>
                  h(
                    'div',
                    { key: item.text, style: S.judgeRow },
                    h('span', { style: S.judgeText, title: item.text }, item.text),
                    h(
                      'span',
                      { style: S.judgeActions },
                      h(
                        'button',
                        { type: 'button', style: S.miniButton, onClick: () => removeJudgeExample(item.text) },
                        t('corrRemove'),
                      ),
                    ),
                  ),
                ),
              )
            : null,
          h('p', { style: S.hint }, t('historyHint')),
        ),

        // 高级
        h(
          Card,
          {
            cardId: 'advanced',
            title: t('advanced'),
            summary: advancedSummary,
            open: open.advanced,
            onToggle: toggle,
          },
          h(TextField, {
            id: 'qqbot-guard-pkg',
            label: t('qqbotPackage'),
            hint: t('qqbotPackageHint'),
            placeholder: 'auto',
            value: config.qqbotPackage ?? '',
            onChange: (value) => patch('qqbotPackage', value),
          }),
          h(NumberRow, {
            id: 'qqbot-guard-maxmb',
            label: t('maxMB'),
            value: config.historyMediaMaxMB ?? 20,
            min: 1,
            max: 1024,
            onChange: (value) => patch('historyMediaMaxMB', value),
          }),
        ),

        h('p', { style: S.hint }, t('restartNeeded')),
        overridden.length > 0
          ? h(
              'p',
              { style: { ...S.notice, color: 'rgba(214,140,60,.95)' } },
              `${t('overridden')} ${overridden.join(', ')}`,
            )
          : null,

        // 粘底保存栏
        h(
          'div',
          { style: S.footer },
          h('div', { style: S.footerState }, stateText),
          h(
            'div',
            { style: S.footerActions },
            h('button', { type: 'button', style: S.buttonGhost, onClick: () => void load() }, t('reload')),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.button, ...(saving || !dirty ? S.buttonDisabled : null) },
                disabled: saving || !dirty,
                onClick: () => void save(),
              },
              saving ? t('saving') : t('save'),
            ),
          ),
        ),
      );
    }

    const name = 'dsh-qqbot-guard';
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`);
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NS,
            order: 65,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t, locale: ctx.locale }),
          },
          () => h(Section, { t }),
        ),
      );
    }

    return { name, inject, apply };
  },
});
