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
.lf-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.lf-field { display:flex; flex-direction:column; gap:4px; font-size:13px; }
.lf-field input, .lf-field select { border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:8px; padding:6px 8px; font:inherit; background:transparent; color:inherit; min-width:180px; }
.lf-button { border:1px solid var(--dsw-alias-border-l1,#e5e6eb); background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; border-radius:8px; padding:6px 10px; cursor:pointer; font:inherit; }
.lf-error { color:#c2410c; font-size:13px; margin:0; }
.lf-table { width:100%; border-collapse:collapse; font-size:13px; }
.lf-table th, .lf-table td { text-align:left; border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb); padding:6px 4px; vertical-align:top; }
.lf-ok { color:#15803d; }
.lf-bad { color:#c2410c; }
`;

    function Paragraph(text, extraClass) {
      return h('p', { className: extraClass ? `lf-muted ${extraClass}` : 'lf-muted' }, text);
    }

    async function request(path, body) {
      const response = await fetch(path, body === undefined
        ? { headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          });
      const payload = await response.json();
      if (!response.ok || payload.status === 'ERROR') {
        throw new Error(typeof payload.message === 'string' ? payload.message : '请求失败');
      }
      return payload;
    }

    function useStatus() {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const reload = React.useCallback(() => {
        request('/api/local-frames/status')
          .then((payload) => {
            setStatus(payload.data);
            setError('');
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      }, []);
      React.useEffect(() => {
        reload();
      }, [reload]);
      return { status, error, setError, reload };
    }

    function isAbsolutePath(value) {
      return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value);
    }

    function SettingsPage() {
      const { status, error, setError, reload } = useStatus();
      const [models, setModels] = React.useState([]);
      const [limit, setLimit] = React.useState('50');
      const [budget, setBudget] = React.useState('3000');
      const [interval, setIntervalSeconds] = React.useState('2');
      const [exportDir, setExportDir] = React.useState('');
      const [root, setRoot] = React.useState('');
      const [message, setMessage] = React.useState('');
      React.useEffect(() => {
        request('/api/local-frames/models')
          .then((payload) => setModels(payload.data.models ?? []))
          .catch(() => setModels([]));
      }, []);
      React.useEffect(() => {
        if (status === null) return;
        setLimit(String(status.settings.dataDirLimitGb));
        setBudget(String(status.settings.budgetPerTask));
        setIntervalSeconds(String(status.settings.frameIntervalSeconds));
        setExportDir(status.settings.exportDir ?? '');
      }, [status]);
      const save = (patch, options) => {
        setMessage('');
        setError('');
        request('/api/local-frames/settings', patch)
          .then(() => {
            setMessage('已保存');
            if (options && options.clearRoot) setRoot('');
            reload();
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      };
      const settings = status?.settings;
      const defaultExportDir = status?.dataDir?.path ? `${status.dataDir.path}/exports` : '数据目录/exports';
      const modelValue = settings?.model === null || settings?.model === undefined
        ? ''
        : `${settings.model.provider}\n${settings.model.model}`;
      return h(
        'div',
        { className: 'lf-root' },
        h('h2', { className: 'lf-title' }, '本地视频帧 · 设置'),
        error ? h('p', { className: 'lf-error' }, error) : null,
        message ? h('p', { className: 'lf-ok' }, message) : null,
        h(
          'div',
          { className: 'lf-card' },
          h('h3', null, '模型'),
          h(
            'label',
            { className: 'lf-field' },
            '视觉模型',
            h(
              'select',
              {
                value: modelValue,
                onChange: (event) => {
                  const value = event.target.value;
                  if (value === '') {
                    save({ model: null });
                    return;
                  }
                  const [provider, model] = value.split('\n');
                  save({ model: { provider, model } });
                },
              },
              h('option', { value: '' }, '未选择'),
              models.map((model) =>
                h(
                  'option',
                  { key: `${model.provider}/${model.model}`, value: `${model.provider}\n${model.model}` },
                  `${model.provider} / ${model.name || model.model}`,
                ),
              ),
            ),
          ),
          h('p', { className: 'lf-hint' }, '只使用一个模型。密钥留在 DSH 模型页，不会写入本插件。'),
        ),
        h(
          'div',
          { className: 'lf-card' },
          h('h3', null, '数据与抽帧'),
          Paragraph(`数据目录（只读）：${status?.dataDir?.path ?? '读取中'}`),
          h(
            'label',
            { className: 'lf-field' },
            '导出目录（绝对路径）',
            h('input', {
              value: exportDir,
              placeholder: '留空使用默认目录',
              onChange: (event) => setExportDir(event.target.value),
            }),
          ),
          h('p', { className: 'lf-hint' }, `留空时导出到默认目录：${defaultExportDir}`),
          h(
            'div',
            { className: 'lf-row' },
            h('label', { className: 'lf-field' }, '磁盘上限 GB', h('input', { value: limit, onChange: (event) => setLimit(event.target.value) })),
            h('label', { className: 'lf-field' }, '每任务预算', h('input', { value: budget, onChange: (event) => setBudget(event.target.value) })),
            h('label', { className: 'lf-field' }, '抽帧间隔（秒）', h('input', { value: interval, onChange: (event) => setIntervalSeconds(event.target.value) })),
            h(
              'button',
              {
                className: 'lf-button',
                type: 'button',
                onClick: () => {
                  if (settings === null || settings === undefined) {
                    setError('设置尚未载入，请稍候再试');
                    return;
                  }
                  const nextRoot = root.trim();
                  const dir = exportDir.trim();
                  if (nextRoot.length > 0 && !isAbsolutePath(nextRoot)) {
                    setError(`白名单根目录必须是绝对路径：${nextRoot}`);
                    return;
                  }
                  if (dir.length > 0 && !isAbsolutePath(dir)) {
                    setError(`导出目录必须是绝对路径：${dir}`);
                    return;
                  }
                  save(
                    {
                      dataDirLimitGb: Number(limit),
                      budgetPerTask: Number(budget),
                      frameIntervalSeconds: Number(interval),
                      exportDir: dir.length > 0 ? dir : null,
                      allowRoots: nextRoot.length > 0 ? [...settings.allowRoots, nextRoot] : settings.allowRoots,
                    },
                    { clearRoot: nextRoot.length > 0 },
                  );
                },
              },
              '保存',
            ),
          ),
        ),
        h(
          'div',
          { className: 'lf-card' },
          h('h3', null, '允许读取的视频根目录'),
          Paragraph('白名单为空时拒绝一切导入。'),
          h(
            'ul',
            null,
            (settings?.allowRoots ?? []).map((entry) =>
              h(
                'li',
                { key: entry },
                entry,
                ' ',
                h(
                  'button',
                  {
                    className: 'lf-button',
                    type: 'button',
                    onClick: () => save({ allowRoots: settings.allowRoots.filter((item) => item !== entry) }),
                  },
                  '删除',
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'lf-row' },
            h('input', { value: root, placeholder: '绝对路径', onChange: (event) => setRoot(event.target.value) }),
            h(
              'button',
              {
                className: 'lf-button',
                type: 'button',
                onClick: () => {
                  const next = root.trim();
                  if (next.length === 0) {
                    setError('请输入白名单根目录（绝对路径）');
                    return;
                  }
                  if (!isAbsolutePath(next)) {
                    setError(`白名单根目录必须是绝对路径：${next}`);
                    return;
                  }
                  if (settings === null || settings === undefined) {
                    setError('设置尚未载入，请稍候再试');
                    return;
                  }
                  save({ allowRoots: [...settings.allowRoots, next] }, { clearRoot: true });
                },
              },
              '添加',
            ),
          ),
        ),
        h(
          'div',
          { className: 'lf-card' },
          h('h3', null, '环境'),
          h(
            'table',
            { className: 'lf-table' },
            h('tbody', null, (status?.environment?.checks ?? []).map((check) =>
              h(
                'tr',
                { key: check.id },
                h('td', null, check.label),
                h('td', { className: check.status === 'OK' ? 'lf-ok' : 'lf-bad' }, check.status),
                h('td', null, check.version || check.detail || ''),
                h('td', null, check.install || ''),
              ),
            )),
          ),
          h(
            'button',
            {
              className: 'lf-button',
              type: 'button',
              onClick: () => {
                request('/api/local-frames/environment/recheck', {})
                  .then(() => reload())
                  .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
              },
            },
            '重新检查',
          ),
        ),
      );
    }

    function ProgressPage() {
      const { status, error, setError, reload } = useStatus();
      const [path, setPath] = React.useState('');
      const [recursive, setRecursive] = React.useState(true);
      const [message, setMessage] = React.useState('');
      const lastPathFilled = React.useRef(false);
      React.useEffect(() => {
        if (lastPathFilled.current || status === null) return;
        lastPathFilled.current = true;
        const lastImportPath = status.settings?.lastImportPath;
        if (typeof lastImportPath === 'string' && lastImportPath.length > 0) setPath(lastImportPath);
      }, [status]);
      React.useEffect(() => {
        const timer = setInterval(reload, 3000);
        return () => clearInterval(timer);
      }, [reload]);
      const task = status?.task;
      const funnel = status?.funnel;
      const act = (action) => {
        if (task === null || task === undefined) return;
        request('/api/local-frames/control', { taskId: task.task_id, action })
          .then((payload) => {
            setMessage(payload.message || '已更新');
            reload();
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      };
      return h(
        'div',
        { className: 'lf-root' },
        h('h2', { className: 'lf-title' }, '本地视频帧 · 进度'),
        Paragraph('关窗口不会停止采集，要停请点暂停。', 'lf-note'),
        error ? h('p', { className: 'lf-error' }, error) : null,
        message ? h('p', { className: 'lf-ok' }, message) : null,
        h(
          'div',
          { className: 'lf-card' },
          h('h3', null, '对象'),
          (status?.targets ?? []).length === 0
            ? Paragraph('还没有对象。请让 agent 调用 lf_target_add。')
            : h(
                'ul',
                null,
                status.targets.map((target) =>
                  h(
                    'li',
                    { key: target.target_id },
                    `${target.name}${target.archived ? '（已归档）' : ''}：${target.definition}`,
                    target.archived
                      ? null
                      : h(
                          'button',
                          {
                            className: 'lf-button',
                            type: 'button',
                            onClick: () => {
                              request('/api/local-frames/targets/archive', { targetId: target.target_id })
                                .then(() => reload())
                                .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
                            },
                          },
                          '归档',
                        ),
                  ),
                ),
              ),
        ),
        h(
          'div',
          { className: 'lf-card' },
          h('h3', null, '任务'),
          Paragraph(task === null || task === undefined ? '当前没有任务' : `${task.task_id} · ${task.status}`),
          status?.pause?.reason ? Paragraph(`暂停原因：${status.pause.reason}`) : null,
          funnel
            ? h(
                'table',
                { className: 'lf-table' },
                h(
                  'tbody',
                  null,
                  [
                    ['导入', funnel.imported],
                    ['探测成功', funnel.probed],
                    ['抽帧', funnel.frames],
                    ['重复跳过', funnel.duplicatesSkipped],
                    ['已打标', funnel.judged],
                    ['可导出', funnel.exportable],
                    ['ERROR 文件', funnel.errors],
                  ].map(([label, value]) => h('tr', { key: label }, h('td', null, label), h('td', null, String(value)))),
                ),
              )
            : null,
          h(
            'div',
            { className: 'lf-row' },
            h('button', { className: 'lf-button', type: 'button', onClick: () => act('pause') }, '暂停'),
            h('button', { className: 'lf-button', type: 'button', onClick: () => act('resume') }, '继续'),
            h('button', { className: 'lf-button', type: 'button', onClick: () => act('cancel') }, '取消'),
            h(
              'button',
              {
                className: 'lf-button',
                type: 'button',
                onClick: () => {
                  const body = task === null || task === undefined ? {} : { taskId: task.task_id };
                  request('/api/local-frames/export', body)
                    .then((payload) => {
                      setMessage(`已导出到 ${payload.data.directory}`);
                      reload();
                    })
                    .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
                },
              },
              '导出',
            ),
          ),
        ),
        h(
          'div',
          { className: 'lf-card' },
          h('h3', null, 'ERROR 文件'),
          (status?.errors ?? []).length === 0
            ? Paragraph('没有错误文件')
            : h(
                'ul',
                null,
                status.errors.map((item) => h('li', { key: item.item_id }, `${item.local_path} · ${item.error_code || ''}`)),
              ),
          Array.isArray(task?.progress?.csvErrors) && task.progress.csvErrors.length > 0
            ? h(
                'div',
                null,
                h('h3', null, 'CSV 解析失败'),
                h(
                  'ul',
                  null,
                  task.progress.csvErrors.map((item) => h('li', { key: `${item.path}:${item.message}` }, `${item.path} · ${item.message}`)),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'lf-card' },
          h('h3', null, '添加视频或目录'),
          h(
            'div',
            { className: 'lf-row' },
            h('input', { value: path, placeholder: '绝对路径', onChange: (event) => setPath(event.target.value) }),
            h(
              'label',
              { className: 'lf-field' },
              h('span', null, '递归'),
              h('input', { type: 'checkbox', checked: recursive, onChange: (event) => setRecursive(event.target.checked) }),
            ),
            h(
              'button',
              {
                className: 'lf-button',
                type: 'button',
                onClick: () => {
                  request('/api/local-frames/videos/add', { path: path.trim(), recursive })
                    .then((payload) => {
                      setMessage(payload.message || '已添加');
                      reload();
                    })
                    .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
                },
              },
              '添加',
            ),
          ),
          Paragraph(
            status?.dataDir
              ? `数据目录占用 ${status.dataDir.usedBytes} 字节，上限 ${status.dataDir.limitGb} GB，剩余 ${status.dataDir.freeGb ?? '未知'} GB`
              : '数据目录占用读取中',
          ),
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
