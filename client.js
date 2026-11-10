window.__ModuleLoader__.load({
  id: 'dsh-local-frames',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STYLE_ID = 'dsh-local-frames-ui-style';
    const CSS = `
.lf-root { display:flex; flex-direction:column; gap:14px; padding:4px 0 24px; color:var(--dsw-alias-label-primary,#1f2329); }
.lf-title { margin:0; font-size:18px; font-weight:600; }
.lf-card { border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:10px; background:var(--dsw-alias-bg-layer-1,#fff); padding:14px 16px; display:flex; flex-direction:column; gap:8px; }
.lf-card h3 { margin:0; font-size:14px; font-weight:600; }
.lf-muted { margin:0; color:var(--dsw-alias-label-secondary,#646a73); font-size:13px; line-height:1.6; }
.lf-hint { margin:0; color:var(--dsw-alias-label-tertiary,#8f959e); font-size:12px; line-height:1.5; }
.lf-note { border-left:3px solid var(--dsw-alias-brand-primary,#3370ff); padding:2px 0 2px 10px; }
`;

    function Paragraph(text, extraClass) {
      return h('p', { className: extraClass ? `lf-muted ${extraClass}` : 'lf-muted' }, text);
    }

    function SettingsPage() {
      return h(
        'div',
        { className: 'lf-root' },
        h('h2', { className: 'lf-title' }, '本地视频帧 · 设置'),
        h(
          'div',
          { className: 'lf-card' },
          h('h3', null, '设置页骨架'),
          Paragraph('模型、数据目录上限、每任务预算、抽帧间隔与允许读取的根目录白名单将在后续阶段接入本页。'),
          h('p', { className: 'lf-hint' }, '当前阶段只完成插件骨架；本页不写入任何设置。'),
        ),
      );
    }

    function ProgressPage() {
      return h(
        'div',
        { className: 'lf-root' },
        h('h2', { className: 'lf-title' }, '本地视频帧 · 进度'),
        h(
          'div',
          { className: 'lf-card' },
          h('h3', null, '进度页骨架'),
          Paragraph('对象列表、任务进度、文件漏斗、ERROR 文件清单、数据目录占用与导出入口将在后续阶段接入本页。'),
          Paragraph('关窗口不会停止采集，要停请点暂停。', 'lf-note'),
        ),
      );
    }

    function installStyle() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const name = 'local-frames';
    const inject = ['slots'];

    function apply(ctx) {
      if (typeof document === 'undefined') return;
      installStyle();
      ctx.slots.inject('settings.section', () => {
        const unregister = ctx.slots.register(
          {
            name: 'settings.section',
            id: 'local-frames-settings',
            order: 100,
            label: '本地视频帧 · 设置',
          },
          SettingsPage,
        );
        return () => unregister();
      });
      ctx.slots.inject('settings.section', () => {
        const unregister = ctx.slots.register(
          {
            name: 'settings.section',
            id: 'local-frames-progress',
            order: 101,
            label: '本地视频帧 · 进度',
          },
          ProgressPage,
        );
        return () => unregister();
      });
      ctx.effect(() => () => {
        document.getElementById(STYLE_ID)?.remove();
      }, 'local-frames-ui: style');
    }

    return { name, inject, apply };
  },
});
