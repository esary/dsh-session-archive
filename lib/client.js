/* dsh-session-archive client bundle — 设置面板卡片（手写，无构建链）。
 * 结构对齐 dsh-session-pruner client（Apache-2.0 参考架构）与官方 PluginCard。 */
window.__ModuleLoader__.load({
  id: 'dsh-session-archive',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const { createElement: h, useEffect, useState } = require('react');

    const NS = 'dsh-session-archive';
    const ALIAS = (k, fb) => 'var(--dsw-alias-' + k + ', ' + fb + ')';
    const V = {
      border: ALIAS('border-l2', 'rgba(196,211,232,0.16)'),
      bgCard: ALIAS('bg-layer-3', '#1d2735'),
      bgOpen: ALIAS('bg-layer-2', '#1a2331'),
      text1: ALIAS('label-primary', '#f2f6fc'),
      text2: ALIAS('label-secondary', '#9daabd'),
      text3: ALIAS('label-tertiary', '#718096'),
      error: ALIAS('label-error', '#ff8592'),
    };

    function Field(props) {
      const { id, label, hint, value, onEdit, numeric, invalid } = props;
      return h('div', { style: { flexDirection: 'column', gap: 6, padding: '10px 0', display: 'flex' } },
        h('label', { htmlFor: id, style: { color: V.text1, fontSize: 13, fontWeight: 500 } }, label),
        h('input', {
          id, type: 'text', inputMode: numeric ? 'numeric' : undefined, value,
          onChange: (e) => onEdit(e.target.value),
          style: { border: '1px solid ' + (invalid ? V.error : V.border), background: V.bgCard, height: 34, font: 'inherit', color: V.text1, borderRadius: 8, padding: '0 12px', fontSize: 13, outline: 'none' },
        }),
        hint ? h('p', { style: { color: V.text3, margin: 0, fontSize: 12 } }, hint) : null);
    }

    function ArchiveCard(props) {
      const scope = props.scope;
      const [snap, setSnap] = useState(() => scope.getSnapshot());
      const [open, setOpen] = useState(false);
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [status, setStatus] = useState(null);
      const [running, setRunning] = useState(false);
      useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
      // 状态行：30s 轮询 host /status 路由
      useEffect(() => {
        let alive = true;
        const poll = async () => {
          try {
            const r = await fetch('/plugins/dsh-session-archive/status');
            if (alive && r.ok) setStatus(await r.json());
          } catch { /* host 未就绪静默 */ }
        };
        poll();
        const t = setInterval(poll, 30000);
        return () => { alive = false; clearInterval(t) };
      }, []);
      const v = draft ?? (snap.values ?? {});
      const set = (k) => (val) => setDraft({ ...v, [k]: val });
      const save = async () => {
        setSaving(true);
        try {
          await scope.save(draft);
          setDraft(null);
        } finally { setSaving(false) }
      };
      const discard = () => setDraft(null);
      const runOnce = async () => {
        setRunning(true);
        try { await fetch('/plugins/dsh-session-archive/run-once', { method: 'POST' }); } finally { setRunning(false) }
      };
      const dirty = draft !== null;
      const num = (x, fb) => (x === undefined || x === null || x === '' ? fb : x);
      return h('div', { style: { border: '1px solid ' + V.border, borderRadius: 10, background: open ? V.bgOpen : V.bgCard, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { onClick: () => setOpen(!open), style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' } },
          h('div', { style: { flex: 1 } },
            h('div', { style: { color: V.text1, fontSize: 13, fontWeight: 600 } }, '会话闲置归档'),
            h('div', { style: { color: V.text3, fontSize: 12 } }, '闲置会话自动归档到 sessions-archive（脑与 pin 保护，永不自动删除）')),
          h('span', { style: { color: V.text2, fontSize: 12 } }, open ? '▾' : '▸')),
        !open ? null : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          Field({ id: 'sa-idle', label: '闲置归档阈值（天）', hint: '日志超过 N 天未写入即归档（默认 2，11-05 定）', value: String(num(v.idleDays, 2)), onEdit: set('idleDays'), numeric: true, invalid: dirty && (!/^[1-9]\d*$/.test(String(v.idleDays ?? '')) ) }),
          Field({ id: 'sa-interval', label: '扫描间隔（分钟）', hint: '事件驱动为主路径，此为对账兜底', value: String(num(v.intervalMinutes, 60)), onEdit: set('intervalMinutes'), numeric: true }),
          Field({ id: 'sa-grace', label: 'one-shot 完成归档宽限（分钟）', hint: '子代理跑完等多久再归档', value: String(num(v.oneShotMinAgeMinutes, 3)), onEdit: set('oneShotMinAgeMinutes'), numeric: true }),
          Field({ id: 'sa-pin', label: 'Pin 白名单（逗号分隔）', hint: '永不归档的会话 id（完整或短 id 都认）；账本 lead 自动 pin 无需填', value: Array.isArray(v.pinnedIds) ? v.pinnedIds.join(', ') : '', onEdit: (s) => set('pinnedIds')(s.split(',').map((x) => x.trim()).filter(Boolean)) }),
          Field({ id: 'sa-cap', label: '容量保底（0=关）', hint: '超限按最旧回收；默认关闭', value: String(num(v.maxSessions, 0)), onEdit: set('maxSessions'), numeric: true }),
          Field({ id: 'sa-retention', label: '归档保留期（天，0=永久）', hint: '到期只在状态行提醒，绝不自动删除', value: String(num(v.retentionDays, 0)), onEdit: set('retentionDays'), numeric: true }),
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0' } },
            dirty ? h('button', { onClick: discard, style: { font: 'inherit', color: V.text2, background: 'transparent', border: '1px solid ' + V.border, borderRadius: 8, padding: '6px 14px', cursor: 'pointer' } }, '放弃') : null,
            h('button', { onClick: save, disabled: !dirty || saving, style: { font: 'inherit', color: V.text1, background: '#2d5aff22', border: '1px solid #2d5aff', borderRadius: 8, padding: '6px 14px', cursor: dirty ? 'pointer' : 'not-allowed' } }, saving ? '保存中…' : '保存'),
            h('button', { onClick: runOnce, disabled: running, style: { font: 'inherit', color: V.text1, background: 'transparent', border: '1px solid ' + V.border, borderRadius: 8, padding: '6px 14px', cursor: 'pointer', marginLeft: 'auto' } }, running ? '扫描中…' : '立即扫描')),
          status ? h('div', { style: { borderTop: '1px solid ' + V.border, paddingTop: 10, color: V.text2, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', null, '上次扫描 ' + (status.generatedAt ? new Date(status.generatedAt).toLocaleTimeString() : '—') + '：' + (status.total ?? '?') + ' 个会话，归档 ' + (status.archivedCount ?? 0) + ' 个'),
            h('div', null, '归档累计 ' + (status.archiveCount ?? 0) + ' 个 ｜ 闲置阈值 ' + (status.idleDays ?? '?') + ' 天'),
            (status.expiredList?.length ? h('div', { style: { color: V.error } }, '保留期到期提醒（不删）：' + status.expiredList.length + ' 个') : null)) : null));
    }

    return {
      id: NS,
      settingsSection: {
        title: '会话闲置归档',
        component: (props) => h(ArchiveCard, props),
      },
    };
  },
});
