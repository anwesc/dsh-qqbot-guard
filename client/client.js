/**
 * qqbot-guard 的客户端半侧：在 DSH「设置」里加一个「QQ 守护」板块。
 *
 * 手写、不打包：DSH 的模块加载器按约定加载 `client.js`（package.json 的 `exports["./client"]`），
 * 内容就是 `window.__ModuleLoader__.load({ id, factory })` 包一层 CJS 工厂；
 * React 由宿主通过 `require('react')` 提供，所以这里不需要 node_modules。
 *
 * 数据全部走宿主同源的 `/qqbot-guard/config`（服务端在 index.js 的 installConfigApi 里注册），
 * 保存后 guard 端会按文件 mtime 热重载，下一条群消息就生效；只有「总开关」与附件下载相关
 * 的项需要重启插件才生效，UI 上会单独提示。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qqbot-guard',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const NS = 'qqbot-guard';
    const API = '/qqbot-guard/config';

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
      followUpHint:
        '关键词或 @ 唤醒后，群里没 @ 的消息也会先问一次小模型「还是同一个话题吗」：是就继续回，不是就不吭声。超过设定时间没有相关消息就休眠。',
      followUpEnabled: '启用续聊',
      followUpEnabledHint: '关掉后只有关键词和 @ 能唤醒。',
      followUpQuoteReply: '回复时带引用框',
      followUpQuoteReplyHint: '引用被回复的那条消息，方便看上下文；平台对「被动回复 + 引用」的支持需要先试一条。',
      followUpWindow: '静默休眠（分钟）',
      followUpWindowHint: '这段时间里没有相关消息就关窗；再想聊得重新 @ 或发关键词。',
      followUpBurst: '批量汇总窗口（毫秒）',
      followUpBurstHint:
        '这段时间内连着发的消息合并成一次判定，省 token；判定通过后仍逐条分别回复。0 表示不合并。',
      followUpBurstMax: '每批最多合并（条）',
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
      followUp: 'Follow-up window',
      followUpHint:
        'After a keyword or @ wakes the bot, un-mentioned group messages are checked once with a small model: same topic → keep replying, otherwise stay quiet. The window sleeps after the configured silence.',
      followUpEnabled: 'Enable follow-up',
      followUpEnabledHint: 'When off, only keywords and @ can wake the bot.',
      followUpQuoteReply: 'Quote the message being replied to',
      followUpQuoteReplyHint:
        'Show a quote block for the message being answered; platform support for passive reply + quote needs one live test.',
      followUpWindow: 'Sleep after silence (minutes)',
      followUpWindowHint: 'No related message for this long closes the window; wake it again with @ or a keyword.',
      followUpBurst: 'Batch window (ms)',
      followUpBurstHint:
        'Messages arriving within this window are judged together to save tokens; each is still replied to separately. 0 disables batching.',
      followUpBurstMax: 'Max messages per batch',
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

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 2px 28px' },
      intro: { margin: 0, fontSize: 13, lineHeight: 1.7, opacity: 0.86 },
      card: {
        border: '1px solid var(--dsh-border, rgba(127,127,127,.28))',
        borderRadius: 12,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      cardTitle: {
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        opacity: 0.62,
        margin: 0,
      },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 13, fontWeight: 600 },
      hint: { fontSize: 12, lineHeight: 1.6, opacity: 0.68, margin: 0 },
      textarea: {
        width: '100%',
        minHeight: 96,
        boxSizing: 'border-box',
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsh-border, rgba(127,127,127,.32))',
        background: 'var(--dsh-surface, transparent)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        lineHeight: 1.6,
        resize: 'vertical',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsh-border, rgba(127,127,127,.32))',
        background: 'var(--dsh-surface, transparent)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '6px 0',
        borderTop: '1px solid var(--dsh-border, rgba(127,127,127,.16))',
      },
      rowText: { display: 'flex', flexDirection: 'column', gap: 2 },
      switchWrap: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' },
      footer: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
      button: {
        padding: '8px 18px',
        borderRadius: 10,
        border: '1px solid var(--dsh-border, rgba(127,127,127,.32))',
        background: 'var(--dsh-accent, #4c6ef5)',
        color: '#fff',
        font: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      },
      buttonGhost: {
        padding: '8px 14px',
        borderRadius: 10,
        border: '1px solid var(--dsh-border, rgba(127,127,127,.32))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 9px',
        borderRadius: 999,
        fontSize: 12,
        border: '1px solid var(--dsh-border, rgba(127,127,127,.32))',
        opacity: 0.9,
      },
      notice: { fontSize: 12.5, lineHeight: 1.6, margin: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, wordBreak: 'break-all' },
    };

    const TOGGLE_ROWS = [
      ['faces', 'faces', 'facesHint', false],
      ['historyAttachments', 'historyAttachments', 'historyAttachmentsHint', false],
      ['historyMedia', 'historyMedia', 'historyMediaHint', true],
      ['ignoreCase', 'ignoreCase', null, false],
      ['verbose', 'verbose', null, false],
    ];

    function Toggle({ id, checked, onChange, disabled }) {
      return h('input', {
        id,
        type: 'checkbox',
        checked,
        disabled,
        onChange: (event) => onChange(event.target.checked),
        style: { width: 16, height: 16, cursor: disabled ? 'default' : 'pointer' },
      });
    }

    function NumberField({ id, label, hint, value, min, max, onChange }) {
      return h(
        'div',
        { style: S.field },
        h('label', { style: S.label, htmlFor: id }, label),
        h('input', {
          id,
          type: 'number',
          min,
          max,
          style: S.input,
          value: value ?? '',
          onChange: (event) => onChange(Number(event.target.value)),
        }),
        hint ? h('p', { style: S.hint }, hint) : null,
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

      const applyPayload = useCallback((payload) => {
        const cfg = payload?.config ?? {};
        setConfig(cfg);
        setFile(payload?.file ?? '');
        setStatus(payload?.status ?? {});
        setOverridden(Array.isArray(payload?.overridden) ? payload.overridden : []);
        setKeywords(Array.isArray(cfg.triggers) ? cfg.triggers.join('\n') : '');
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

      const save = useCallback(async () => {
        if (!config) return;
        setSaving(true);
        setError('');
        setNotice('');
        try {
          const body = {
            triggers: keywords
              .split(/\r?\n|,|，/)
              .map((s) => s.trim())
              .filter(Boolean),
          };
          for (const key of [
            'enabled',
            'ignoreCase',
            'faces',
            'historyAttachments',
            'historyMedia',
            'verbose',
            'strictVersion',
            'followUpEnabled',
            'followUpQuoteReply',
          ]) {
            if (typeof config[key] === 'boolean') body[key] = config[key];
          }
          if (config.historyMediaMaxMB !== undefined) body.historyMediaMaxMB = config.historyMediaMaxMB;
          for (const key of [
            'followUpWindowMinutes',
            'followUpBurstMs',
            'followUpBurstMax',
            'followUpMaxTurns',
            'followUpJudgeTimeoutMs',
            'followUpFloodWindowMs',
            'followUpFloodMax',
            'followUpFloodCooldownMs',
            'followUpSelectMin',
          ]) {
            if (config[key] !== undefined) body[key] = Number(config[key]);
          }
          for (const key of ['followUpJudgeProvider', 'followUpJudgeModel']) {
            if (typeof config[key] === 'string') body[key] = config[key];
          }
          if (typeof config.followUpOnJudgeError === 'string') {
            body.followUpOnJudgeError = config.followUpOnJudgeError;
          }
          if (typeof config.followUpFloodAction === 'string') {
            body.followUpFloodAction = config.followUpFloodAction;
          }
          if (typeof config.qqbotPackage === 'string') body.qqbotPackage = config.qqbotPackage;
          const response = await fetch(API, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
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

      return h(
        'div',
        { style: S.root },
        h('p', { style: S.intro }, t('intro')),

        h(
          'section',
          { style: S.card },
          h('h3', { style: S.cardTitle }, t('status')),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            statusBits.map((bit) =>
              h('span', {
                key: bit.key,
                style: { ...S.badge, borderColor: bit.tone === 'ok' ? 'rgba(64,160,96,.55)' : 'rgba(214,140,60,.55)' },
              }, bit.text),
            ),
          ),
          h(
            'p',
            { style: S.hint },
            h('span', null, `${t('location')}: `),
            h('span', { style: S.mono }, status?.qqbot || t('notFound')),
          ),
          file
            ? h(
                'p',
                { style: S.hint },
                h('span', null, `${t('file')}: `),
                h('span', { style: S.mono }, file),
              )
            : null,
        ),

        h(
          'section',
          { style: S.card },
          h('h3', { style: S.cardTitle }, t('keywords')),
          h('textarea', {
            style: S.textarea,
            value: keywords,
            spellCheck: false,
            placeholder: '大肥鱼\n肥鱼\n鱼鱼',
            onChange: (event) => {
              setKeywords(event.target.value);
              setNotice('');
            },
          }),
          h('p', { style: S.hint }, t('keywordsHint')),
        ),

        h(
          'section',
          { style: S.card },
          h('h3', { style: S.cardTitle }, t('switches')),
          h(
            'div',
            { style: { ...S.row, borderTop: 'none' } },
            h(
              'label',
              { htmlFor: 'qqbot-guard-enabled', style: S.rowText },
              h('span', { style: S.label }, t('enabled')),
              h('span', { style: S.hint }, t('enabledHint')),
            ),
            h(Toggle, {
              id: 'qqbot-guard-enabled',
              checked: config.enabled !== false,
              onChange: (value) => patch('enabled', value),
            }),
          ),
          TOGGLE_ROWS.map(([key, labelKey, hintKey]) =>
            h(
              'div',
              { key, style: S.row },
              h(
                'label',
                { htmlFor: `qqbot-guard-${key}`, style: S.rowText },
                h('span', { style: S.label }, t(labelKey)),
                hintKey ? h('span', { style: S.hint }, t(hintKey)) : null,
              ),
              h(Toggle, {
                id: `qqbot-guard-${key}`,
                checked: config[key] !== false,
                onChange: (value) => patch(key, value),
              }),
            ),
          ),
        ),

        h(
          'section',
          { style: S.card },
          h('h3', { style: S.cardTitle }, t('followUp')),
          h('p', { style: S.hint }, t('followUpHint')),
          h(
            'div',
            { style: { ...S.row, borderTop: 'none' } },
            h(
              'label',
              { htmlFor: 'qqbot-guard-followup', style: S.rowText },
              h('span', { style: S.label }, t('followUpEnabled')),
              h('span', { style: S.hint }, t('followUpEnabledHint')),
            ),
            h(Toggle, {
              id: 'qqbot-guard-followup',
              checked: config.followUpEnabled !== false,
              onChange: (value) => patch('followUpEnabled', value),
            }),
          ),
          h(
            'div',
            { style: S.row },
            h(
              'label',
              { htmlFor: 'qqbot-guard-followup-quote', style: S.rowText },
              h('span', { style: S.label }, t('followUpQuoteReply')),
              h('span', { style: S.hint }, t('followUpQuoteReplyHint')),
            ),
            h(Toggle, {
              id: 'qqbot-guard-followup-quote',
              checked: config.followUpQuoteReply === true,
              onChange: (value) => patch('followUpQuoteReply', value),
            }),
          ),
          h(NumberField, {
            id: 'qqbot-guard-followup-window',
            label: t('followUpWindow'),
            hint: t('followUpWindowHint'),
            value: config.followUpWindowMinutes ?? 10,
            min: 1,
            max: 1440,
            onChange: (value) => patch('followUpWindowMinutes', value),
          }),
          h(NumberField, {
            id: 'qqbot-guard-followup-burst',
            label: t('followUpBurst'),
            hint: t('followUpBurstHint'),
            value: config.followUpBurstMs ?? 1200,
            min: 0,
            max: 5000,
            onChange: (value) => patch('followUpBurstMs', value),
          }),
          h(NumberField, {
            id: 'qqbot-guard-followup-burst-max',
            label: t('followUpBurstMax'),
            value: config.followUpBurstMax ?? 12,
            min: 2,
            max: 50,
            onChange: (value) => patch('followUpBurstMax', value),
          }),
          h(
            'div',
            { style: S.field },
            h('label', { style: S.label, htmlFor: 'qqbot-guard-followup-flood' }, t('followUpFlood')),
            h(
              'select',
              {
                id: 'qqbot-guard-followup-flood',
                style: S.input,
                value: config.followUpFloodAction ?? 'select',
                onChange: (event) => patch('followUpFloodAction', event.target.value),
              },
              h('option', { value: 'select' }, t('followUpFloodSelect')),
              h('option', { value: 'skip' }, t('followUpFloodSkip')),
            ),
            h('p', { style: S.hint }, t('followUpFloodHint')),
          ),
          h(NumberField, {
            id: 'qqbot-guard-followup-flood-window',
            label: t('followUpFloodWindow'),
            value: config.followUpFloodWindowMs ?? 10000,
            min: 1000,
            max: 60000,
            onChange: (value) => patch('followUpFloodWindowMs', value),
          }),
          h(NumberField, {
            id: 'qqbot-guard-followup-flood-max',
            label: t('followUpFloodMax'),
            value: config.followUpFloodMax ?? 15,
            min: 1,
            max: 200,
            onChange: (value) => patch('followUpFloodMax', value),
          }),
          h(NumberField, {
            id: 'qqbot-guard-followup-flood-cooldown',
            label: t('followUpFloodCooldown'),
            value: config.followUpFloodCooldownMs ?? 25000,
            min: 1000,
            max: 600000,
            onChange: (value) => patch('followUpFloodCooldownMs', value),
          }),
          (config.followUpFloodAction ?? 'select') === 'select'
            ? h(NumberField, {
                id: 'qqbot-guard-followup-select-min',
                label: t('followUpSelectMin'),
                value: config.followUpSelectMin ?? 5,
                min: 2,
                max: 50,
                onChange: (value) => patch('followUpSelectMin', value),
              })
            : null,
          h(NumberField, {
            id: 'qqbot-guard-followup-turns',
            label: t('followUpMaxTurns'),
            hint: t('followUpMaxTurnsHint'),
            value: config.followUpMaxTurns ?? 0,
            min: 0,
            max: 1000,
            onChange: (value) => patch('followUpMaxTurns', value),
          }),
          h(NumberField, {
            id: 'qqbot-guard-followup-timeout',
            label: t('followUpJudgeTimeout'),
            value: config.followUpJudgeTimeoutMs ?? 6000,
            min: 500,
            max: 60000,
            onChange: (value) => patch('followUpJudgeTimeoutMs', value),
          }),
          h(
            'div',
            { style: S.field },
            h('label', { style: S.label, htmlFor: 'qqbot-guard-followup-provider' }, t('followUpJudgeProvider')),
            h('input', {
              id: 'qqbot-guard-followup-provider',
              style: S.input,
              value: config.followUpJudgeProvider ?? '',
              placeholder: 'auto',
              onChange: (event) => patch('followUpJudgeProvider', event.target.value),
            }),
          ),
          h(
            'div',
            { style: S.field },
            h('label', { style: S.label, htmlFor: 'qqbot-guard-followup-model' }, t('followUpJudgeModel')),
            h('input', {
              id: 'qqbot-guard-followup-model',
              style: S.input,
              value: config.followUpJudgeModel ?? '',
              placeholder: 'auto',
              onChange: (event) => patch('followUpJudgeModel', event.target.value),
            }),
            h('p', { style: S.hint }, t('followUpJudgeHint')),
          ),
          h(
            'div',
            { style: S.field },
            h('label', { style: S.label, htmlFor: 'qqbot-guard-followup-error' }, t('followUpOnError')),
            h(
              'select',
              {
                id: 'qqbot-guard-followup-error',
                style: S.input,
                value: config.followUpOnJudgeError ?? 'skip',
                onChange: (event) => patch('followUpOnJudgeError', event.target.value),
              },
              h('option', { value: 'skip' }, t('followUpOnErrorSkip')),
              h('option', { value: 'reply' }, t('followUpOnErrorReply')),
            ),
            h('p', { style: S.hint }, t('followUpOnErrorHint')),
          ),
          config.followUpEnabled !== false && status?.followUpWindows !== undefined
            ? h(
                'p',
                { style: S.hint },
                `${t('followUpWindows')}: ${status.followUpWindows}`,
              )
            : null,
        ),

        h(
          'section',
          { style: S.card },
          h('h3', { style: S.cardTitle }, t('advanced')),
          h(
            'div',
            { style: S.field },
            h('label', { style: S.label, htmlFor: 'qqbot-guard-pkg' }, t('qqbotPackage')),
            h('input', {
              id: 'qqbot-guard-pkg',
              style: S.input,
              value: config.qqbotPackage ?? '',
              placeholder: 'auto',
              onChange: (event) => patch('qqbotPackage', event.target.value),
            }),
            h('p', { style: S.hint }, t('qqbotPackageHint')),
          ),
          h(
            'div',
            { style: S.field },
            h('label', { style: S.label, htmlFor: 'qqbot-guard-maxmb' }, t('maxMB')),
            h('input', {
              id: 'qqbot-guard-maxmb',
              type: 'number',
              min: 1,
              max: 1024,
              style: S.input,
              value: config.historyMediaMaxMB ?? 20,
              onChange: (event) => patch('historyMediaMaxMB', Number(event.target.value)),
            }),
          ),
        ),

        h(
          'div',
          { style: S.footer },
          h(
            'button',
            { type: 'button', style: { ...S.button, opacity: saving ? 0.6 : 1 }, disabled: saving, onClick: () => void save() },
            saving ? t('saving') : t('save'),
          ),
          h('button', { type: 'button', style: S.buttonGhost, onClick: () => void load() }, t('reload')),
          notice ? h('span', { style: { ...S.notice, color: 'rgba(64,160,96,.95)' } }, notice) : null,
          error ? h('span', { style: { ...S.notice, color: 'rgba(214,80,80,.95)' }, role: 'alert' }, error) : null,
        ),
        h('p', { style: S.hint }, t('restartNeeded')),
        overridden.length > 0
          ? h(
              'p',
              { style: { ...S.notice, color: 'rgba(214,140,60,.95)' } },
              `${t('overridden')} ${overridden.join(', ')}`,
            )
          : null,
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
