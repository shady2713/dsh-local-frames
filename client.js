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
.lf-button:disabled { cursor:default; opacity:0.6; }
.lf-error { color:#c2410c; font-size:13px; margin:0; }
.lf-table { width:100%; border-collapse:collapse; font-size:13px; }
.lf-table th, .lf-table td { text-align:left; border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb); padding:6px 4px; vertical-align:top; }
.lf-pool-table select { border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:8px; padding:6px 8px; font:inherit; background:transparent; color:inherit; min-width:220px; }
.lf-pool-table input { border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:8px; padding:6px 8px; font:inherit; background:transparent; color:inherit; width:80px; }
.lf-ok { color:#15803d; }
.lf-bad { color:#c2410c; }
.lf-toast { display:flex; flex-direction:column; gap:8px; border:1px solid; border-radius:10px; padding:12px 14px; font-size:14px; font-weight:600; }
.lf-toast-ok { border-color:#15803d; background:#f0fdf4; color:#166534; }
.lf-toast-error { border-color:#c2410c; background:#fff7ed; color:#9a3412; }
.lf-toast-path { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; font-weight:400; word-break:break-all; color:var(--dsw-alias-label-secondary,#646a73); }
.lf-toast-actions { display:flex; flex-wrap:wrap; gap:8px; }
.lf-checks { display:flex; flex-wrap:wrap; gap:10px 16px; }
.lf-check { display:flex; align-items:center; gap:6px; font-size:13px; }
.lf-check input { margin:0; }
.lf-section { display:flex; flex-direction:column; gap:10px; }
.lf-section-title { margin:0; font-size:15px; font-weight:600; }
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
      React.useEffect(() => {
        const timer = setInterval(reload, 3000);
        return () => clearInterval(timer);
      }, [reload]);
      return { status, error, setError, reload };
    }

    function useTasks() {
      const [tasks, setTasks] = React.useState([]);
      const reload = React.useCallback(() => {
        request('/api/local-frames/tasks')
          .then((payload) => setTasks(Array.isArray(payload.data?.tasks) ? payload.data.tasks : []))
          .catch(() => undefined);
      }, []);
      React.useEffect(() => {
        reload();
        const timer = setInterval(reload, 3000);
        return () => clearInterval(timer);
      }, [reload]);
      return { tasks, reload };
    }

    function isAbsolutePath(value) {
      return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value);
    }

    function formatTime(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function stateLabel(item) {
      switch (item.state) {
        case 'NEW': return '等待处理';
        case 'PROBED': return '已探测时长';
        case 'FRAMED': return '抽帧/打标中';
        case 'DONE': return '完成';
        case 'ERROR': return `失败${item.error_code ? `（${item.error_code}）` : ''}`;
        case 'SKIPPED': return '已跳过（先前已处理）';
        default: return item.state;
      }
    }

    /** Task status: an in-progress import must never read as finished. */
    function taskStatusLabel(status) {
      return status === 'INGESTING' ? '入库中' : status;
    }

    function LocalFramesPage() {
      const { status, error, setError, reload } = useStatus();
      const { tasks } = useTasks();
      const [models, setModels] = React.useState([]);
      const [limit, setLimit] = React.useState('50');
      const [budget, setBudget] = React.useState('3000');
      const [interval, setIntervalSeconds] = React.useState('2');
      const [poolRows, setPoolRows] = React.useState([]);
      const [poolDirty, setPoolDirty] = React.useState(false);
      const poolSyncedRef = React.useRef('');
      const [objectsPerCall, setObjectsPerCall] = React.useState('24');
      const [visionCallTimeout, setVisionCallTimeout] = React.useState('120');
      const [exportDir, setExportDir] = React.useState('');
      const [root, setRoot] = React.useState('');
      const [message, setMessage] = React.useState('');
      const [path, setPath] = React.useState('');
      const [recursive, setRecursive] = React.useState(true);
      const [force, setForce] = React.useState(false);
      const [selectedTargets, setSelectedTargets] = React.useState([]);
      const [exportTaskId, setExportTaskId] = React.useState(null);
      const [exportZip, setExportZip] = React.useState(false);
      const [exportByObject, setExportByObject] = React.useState(false);
      const [exporting, setExporting] = React.useState(false);
      const [toast, setToast] = React.useState(null);
      const lastPathFilled = React.useRef(false);
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
        setObjectsPerCall(String(status.settings.objectsPerCall));
        setVisionCallTimeout(String(status.settings.visionCallTimeoutSeconds));
        setExportDir(status.settings.exportDir ?? '');
      }, [status]);
      // The model list is the editable copy; the status snapshot syncs it back
      // after a save. Unsaved edits win over the 3-second status polling.
      React.useEffect(() => {
        if (status === null) return;
        const pool = Array.isArray(status.settings?.modelPool) ? status.settings.modelPool : [];
        const incoming = JSON.stringify(pool);
        if (incoming === poolSyncedRef.current) {
          setPoolDirty(false);
          return;
        }
        if (poolDirty) return;
        poolSyncedRef.current = incoming;
        setPoolRows(pool.map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          concurrency: String(entry.concurrency),
        })));
      }, [status, poolDirty]);
      React.useEffect(() => {
        if (lastPathFilled.current || status === null) return;
        lastPathFilled.current = true;
        const lastImportPath = status.settings?.lastImportPath;
        if (typeof lastImportPath === 'string' && lastImportPath.length > 0) setPath(lastImportPath);
      }, [status]);
      const settings = status?.settings;
      const defaultExportDir = status?.dataDir?.path ? `${status.dataDir.path}/exports` : '数据目录/exports';
      const poolTotal = poolRows.reduce((sum, row) => {
        const value = Number(row.concurrency);
        return sum + (Number.isInteger(value) ? value : 0);
      }, 0);
      const task = status?.task;
      const funnel = status?.funnel;
      const taskTargetIds = Array.isArray(task?.target_ids) ? task.target_ids : [];
      const currentTaskTargets = (status?.targets ?? [])
        .filter((target) => !target.archived && (taskTargetIds.length === 0 || taskTargetIds.includes(target.target_id)))
        .map((target) => ({ target_id: target.target_id, name: target.name }));
      const selectedExportTask = tasks.find((entry) => entry.task_id === exportTaskId) ?? null;
      const exportTargets = selectedExportTask === null ? currentTaskTargets : selectedExportTask.targets ?? [];
      const recentExports = status?.settings?.recentExports ?? [];
      React.useEffect(() => {
        setExportTaskId((current) => {
          if (current !== null && tasks.some((entry) => entry.task_id === current)) return current;
          const active = tasks.find((entry) => entry.task_id === status?.task?.task_id);
          if (active !== undefined) return active.task_id;
          const done = tasks.find((entry) => entry.status === 'DONE');
          return done === undefined ? (tasks[0]?.task_id ?? null) : done.task_id;
        });
      }, [tasks, status?.task?.task_id]);
      React.useEffect(() => {
        setSelectedTargets([]);
      }, [exportTaskId]);
      const toggleTarget = (targetId) => {
        setSelectedTargets((current) =>
          current.includes(targetId) ? current.filter((id) => id !== targetId) : [...current, targetId],
        );
      };
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
      const addPoolRow = () => {
        setMessage('');
        setError('');
        setPoolDirty(true);
        setPoolRows((current) => {
          if (current.length >= 5) return current;
          const used = new Set(current.map((row) => `${row.provider}\n${row.model}`));
          const available = models.find((entry) => !used.has(`${entry.provider}\n${entry.model}`));
          return [
            ...current,
            available === undefined
              ? { provider: '', model: '', concurrency: '2' }
              : { provider: available.provider, model: available.model, concurrency: '2' },
          ];
        });
      };
      const updatePoolRow = (index, patch) => {
        setPoolDirty(true);
        setPoolRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
      };
      const removePoolRow = (index) => {
        setPoolDirty(true);
        setPoolRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
      };
      const savePool = () => {
        if (settings === null || settings === undefined) {
          setError('设置尚未载入，请稍候再试');
          return;
        }
        setMessage('');
        setError('');
        const modelPool = poolRows.map((row) => ({
          provider: row.provider,
          model: row.model,
          concurrency: Number(row.concurrency),
        }));
        request('/api/local-frames/settings', { modelPool })
          .then((payload) => {
            const saved = Array.isArray(payload.data?.modelPool) ? payload.data.modelPool : modelPool;
            poolSyncedRef.current = JSON.stringify(saved);
            setPoolRows(saved.map((entry) => ({
              provider: entry.provider,
              model: entry.model,
              concurrency: String(entry.concurrency),
            })));
            // Keep local edits authoritative until the status poll reflects the save.
            setPoolDirty(true);
            setMessage('已保存');
            reload();
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      };
      const saveSettings = () => {
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
            objectsPerCall: Number(objectsPerCall),
            visionCallTimeoutSeconds: Number(visionCallTimeout),
            exportDir: dir.length > 0 ? dir : null,
            allowRoots: nextRoot.length > 0 ? [...settings.allowRoots, nextRoot] : settings.allowRoots,
          },
          { clearRoot: nextRoot.length > 0 },
        );
      };
      const performExport = (taskId, targetIds) => {
        if (exporting) return;
        setExporting(true);
        setMessage('');
        setError('');
        const body = { zip: exportZip, byObject: exportByObject };
        if (typeof taskId === 'string' && taskId.length > 0) body.taskId = taskId;
        if (Array.isArray(targetIds) && targetIds.length > 0) body.targetIds = targetIds;
        request('/api/local-frames/export', body)
          .then((payload) => {
            const data = payload.data ?? {};
            setToast({
              kind: 'ok',
              text: `已导出 ${data.images ?? 0} 帧（train ${data.train ?? 0} / val ${data.val ?? 0}）`,
              path: typeof data.directory === 'string' ? data.directory : '',
            });
            reload();
          })
          .catch((reason) => {
            setToast({ kind: 'error', text: `导出失败：${reason instanceof Error ? reason.message : String(reason)}`, path: '' });
          })
          .finally(() => setExporting(false));
      };
      const runExport = () => {
        performExport(selectedExportTask?.task_id ?? task?.task_id ?? null, selectedTargets);
      };
      const exportFromList = (taskId) => {
        setExportTaskId(taskId);
        performExport(taskId, []);
      };
      const openExport = (directory) => {
        request('/api/local-frames/export/open', { path: directory })
          .then(() =>
            setToast((current) =>
              current === null ? current : { ...current, kind: 'ok', text: '已在主机打开导出目录', path: directory },
            ),
          )
          .catch((reason) => {
            setToast({
              kind: 'error',
              text: `打开目录失败：${reason instanceof Error ? reason.message : String(reason)}。可复制路径后手动打开。`,
              path: directory,
            });
          });
      };
      const copyExportPath = (directory) => {
        if (
          typeof navigator === 'undefined' ||
          navigator.clipboard === undefined ||
          typeof navigator.clipboard.writeText !== 'function'
        ) {
          setToast({ kind: 'error', text: '当前浏览器不支持剪贴板，请手动复制路径。', path: directory });
          return;
        }
        navigator.clipboard
          .writeText(directory)
          .then(() => setToast({ kind: 'ok', text: '已复制路径', path: directory }))
          .catch(() => setToast({ kind: 'error', text: '复制失败，请手动复制路径。', path: directory }));
      };
      const act = (action) => {
        if (task === null || task === undefined) return;
        request('/api/local-frames/control', { taskId: task.task_id, action })
          .then((payload) => {
            setMessage(payload.message || '已更新');
            reload();
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      };
      const retryFailed = (taskId, payload) => {
        setMessage('');
        setError('');
        request('/api/local-frames/retry', { taskId, ...payload })
          .then((response) => {
            setMessage(response.message || '已重试');
            reload();
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      };
      return h(
        'div',
        { className: 'lf-root' },
        h('h2', { className: 'lf-title' }, '本地视频帧'),
        Paragraph('关窗口不会停止采集，要停请点暂停。', 'lf-note'),
        error ? h('p', { className: 'lf-error' }, error) : null,
        message ? h('p', { className: 'lf-ok' }, message) : null,
        toast
          ? h(
              'div',
              { className: `lf-toast ${toast.kind === 'ok' ? 'lf-toast-ok' : 'lf-toast-error'}`, role: 'status' },
              h('div', null, toast.text),
              toast.path ? h('div', { className: 'lf-toast-path' }, toast.path) : null,
              h(
                'div',
                { className: 'lf-toast-actions' },
                toast.path
                  ? h('button', { className: 'lf-button', type: 'button', onClick: () => openExport(toast.path) }, '打开目录')
                  : null,
                toast.path
                  ? h('button', { className: 'lf-button', type: 'button', onClick: () => copyExportPath(toast.path) }, '复制路径')
                  : null,
                h('button', { className: 'lf-button', type: 'button', onClick: () => setToast(null) }, '关闭'),
              ),
            )
          : null,
        h(
          'section',
          { className: 'lf-section' },
          h('h3', { className: 'lf-section-title' }, '环境 / 设置'),
          h(
            'div',
            { className: 'lf-card' },
            h('h3', null, '模型'),
            Paragraph('模型池最多 5 个模型，每个模型有独立的调用并发。一帧在整个判定期间只交给其中一个模型（粘性分配，不投票、不换模型）。'),
            h(
              'table',
              { className: 'lf-table lf-pool-table' },
              h('thead', null, h('tr', null, h('th', null, 'DSH 视觉模型'), h('th', null, '并发（1–8）'), h('th', null, ''))),
              h(
                'tbody',
                null,
                poolRows.length === 0
                  ? h('tr', null, h('td', { colSpan: 3 }, '模型池为空：可以保存，但不会开始判定。'))
                  : poolRows.map((row, index) => {
                      const value = row.provider.length === 0 ? '' : `${row.provider}\n${row.model}`;
                      const known = models.some((entry) => entry.provider === row.provider && entry.model === row.model);
                      return h(
                        'tr',
                        { key: index },
                        h(
                          'td',
                          null,
                          h(
                            'select',
                            {
                              value,
                              onChange: (event) => {
                                const next = event.target.value;
                                if (next === '') {
                                  updatePoolRow(index, { provider: '', model: '' });
                                  return;
                                }
                                const [provider, model] = next.split('\n');
                                updatePoolRow(index, { provider, model });
                              },
                            },
                            h('option', { value: '' }, '未选择'),
                            row.provider.length > 0 && !known
                              ? h('option', { value }, `${row.provider} / ${row.model}`)
                              : null,
                            models.map((entry) =>
                              h(
                                'option',
                                { key: `${entry.provider}/${entry.model}`, value: `${entry.provider}\n${entry.model}` },
                                `${entry.provider} / ${entry.name || entry.model}`,
                              ),
                            ),
                          ),
                        ),
                        h(
                          'td',
                          null,
                          h('input', {
                            type: 'number',
                            min: 1,
                            max: 8,
                            step: 1,
                            value: row.concurrency,
                            onChange: (event) => updatePoolRow(index, { concurrency: event.target.value }),
                          }),
                        ),
                        h(
                          'td',
                          null,
                          h(
                            'button',
                            { className: 'lf-button', type: 'button', onClick: () => removePoolRow(index) },
                            '删除',
                          ),
                        ),
                      );
                    }),
              ),
            ),
            h(
              'div',
              { className: 'lf-row' },
              h(
                'button',
                { className: 'lf-button', type: 'button', disabled: poolRows.length >= 5, onClick: addPoolRow },
                '添加模型',
              ),
              h('button', { className: 'lf-button', type: 'button', onClick: savePool }, '保存模型池'),
              h('span', { className: poolTotal > 16 ? 'lf-bad' : 'lf-hint' }, `并发合计 ${poolTotal} / 16`),
            ),
            h('p', { className: 'lf-hint' }, '密钥留在 DSH 模型页，不会写入本插件。'),
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
              h(
                'label',
                { className: 'lf-field' },
                '抽帧间隔（秒，1–3600，默认 2）',
                h('input', {
                  type: 'number',
                  min: 1,
                  max: 3600,
                  value: interval,
                  onChange: (event) => setIntervalSeconds(event.target.value),
                }),
              ),
              h(
                'label',
                { className: 'lf-field' },
                '每批对象数（1–300）',
                h('input', {
                  type: 'number',
                  min: 1,
                  max: 300,
                  value: objectsPerCall,
                  onChange: (event) => setObjectsPerCall(event.target.value),
                }),
              ),
              h(
                'label',
                { className: 'lf-field' },
                '判定超时（60–300 秒）',
                h('input', {
                  type: 'number',
                  min: 60,
                  max: 300,
                  value: visionCallTimeout,
                  onChange: (event) => setVisionCallTimeout(event.target.value),
                }),
              ),
              h('button', { className: 'lf-button', type: 'button', onClick: saveSettings }, '保存'),
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
        ),
        h(
          'section',
          { className: 'lf-section' },
          h('h3', { className: 'lf-section-title' }, '对象'),
          h(
            'div',
            { className: 'lf-card' },
            (status?.targets ?? []).filter((target) => !target.archived).length === 0
              ? Paragraph('还没有对象。请让 agent 调用 lf_target_add。')
              : h(
                  'ul',
                  null,
                  (status.targets ?? [])
                    .filter((target) => !target.archived)
                    .map((target) => {
                      const aliases = Object.values(target.aliases ?? {}).flat().filter((entry) => typeof entry === 'string');
                      return h(
                        'li',
                        { key: target.target_id },
                        `${target.name}：${target.definition}${aliases.length > 0 ? `（别名：${aliases.join('、')}）` : ''}`,
                      );
                    }),
                ),
          ),
        ),
        h(
          'section',
          { className: 'lf-section' },
          h('h3', { className: 'lf-section-title' }, '当前任务进度'),
          h(
            'div',
            { className: 'lf-card' },
            h('h3', null, '任务'),
            Paragraph(task === null || task === undefined ? '当前没有任务' : `${task.task_id} · ${taskStatusLabel(task.status)}`),
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
                      ['已跳过（先前已处理）', funnel.skipped],
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
            ),
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
                'label',
                { className: 'lf-field' },
                h('span', null, '强制重跑（忽略先前已处理跳过）'),
                h('input', { type: 'checkbox', checked: force, onChange: (event) => setForce(event.target.checked) }),
              ),
              h(
                'button',
                {
                  className: 'lf-button',
                  type: 'button',
                  onClick: () => {
                    request('/api/local-frames/videos/add', { path: path.trim(), recursive, force })
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
          h(
            'div',
            { className: 'lf-card' },
            h('h3', null, '处理顺序'),
            (status?.items ?? []).length === 0
              ? Paragraph('还没有视频')
              : h(
                  'ol',
                  null,
                  status.items.map((item) =>
                    h(
                      'li',
                      { key: item.item_id, className: item.state === 'ERROR' ? 'lf-bad' : item.skipped ? 'lf-muted' : undefined },
                      `#${item.position} ${item.title || item.local_path} · ${stateLabel(item)}`,
                    ),
                  ),
                ),
            Paragraph('按导入顺序处理；目录内按路径字典序。'),
          ),
          h(
            'div',
            { className: 'lf-card' },
            h('h3', null, 'ERROR 文件'),
            h(
              'div',
              { className: 'lf-row' },
              h('button', { className: 'lf-button', type: 'button', disabled: task === null || task === undefined, onClick: () => retryFailed(task.task_id, { all: true }) }, '重试全部失败项'),
            ),
            (status?.errors ?? []).length === 0
              ? Paragraph('没有错误文件')
              : h(
                  'ul',
                  null,
                  status.errors.map((item) =>
                    h(
                      'li',
                      { key: item.item_id },
                      `${item.local_path} · ${item.error_code || ''} `,
                      h(
                        'button',
                        {
                          className: 'lf-button',
                          type: 'button',
                          onClick: () => retryFailed(task.task_id, { itemIds: [item.item_id] }),
                        },
                        '重试',
                      ),
                    ),
                  ),
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
            h('h3', null, '失败帧'),
            (status?.failedFrames ?? []).length === 0
              ? Paragraph('没有失败帧')
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'lf-row' },
                    h(
                      'button',
                      {
                        className: 'lf-button',
                        type: 'button',
                        onClick: () =>
                          retryFailed(task.task_id, {
                            frameIds: (status.failedFrames ?? []).map((frame) => frame.frame_id),
                          }),
                      },
                      '批量重试失败帧',
                    ),
                  ),
                  h(
                    'ul',
                    null,
                    (status.failedFrames ?? []).map((frame) =>
                      h(
                        'li',
                        { key: frame.frame_id },
                        `${frame.title || frame.local_path} · ${frame.t_ms} ms · ${frame.error || ''} `,
                        h(
                          'button',
                          {
                            className: 'lf-button',
                            type: 'button',
                            onClick: () => retryFailed(task.task_id, { frameIds: [frame.frame_id] }),
                          },
                          '重试',
                        ),
                      ),
                    ),
                  ),
                ),
            Paragraph('重试只重新处理失败的时间点或视频，已完成的帧与标签保留；原视频只读。'),
          ),
        ),
        h(
          'section',
          { className: 'lf-section' },
          h('h3', { className: 'lf-section-title' }, '任务列表'),
          h(
            'div',
            { className: 'lf-card' },
            tasks.length === 0
              ? Paragraph('还没有任务')
              : h(
                  'table',
                  { className: 'lf-table' },
                  h(
                    'thead',
                    null,
                    h('tr', null, ['任务', '状态', '创建', '更新', '漏斗', '失败数', '操作'].map((label) => h('th', { key: label }, label))),
                  ),
                  h(
                    'tbody',
                    null,
                    tasks.map((entry) => {
                      const stats = entry.funnel ?? {};
                      const failures = (stats.errors ?? 0) + (entry.failedFrames ?? 0);
                      return h(
                        'tr',
                        { key: entry.task_id },
                        h('td', { className: 'lf-toast-path' }, entry.task_id),
                        h('td', null, taskStatusLabel(entry.status)),
                        h('td', null, formatTime(entry.created_at)),
                        h('td', null, formatTime(entry.updated_at)),
                        h(
                          'td',
                          null,
                          `导入 ${stats.imported ?? 0} · 抽帧 ${stats.frames ?? 0} · 打标 ${stats.judged ?? 0} · 可导出 ${stats.exportable ?? 0}`,
                        ),
                        h('td', { className: failures > 0 ? 'lf-bad' : undefined }, String(failures)),
                        h(
                          'td',
                          null,
                          h(
                            'div',
                            { className: 'lf-row' },
                            entry.status === 'DONE'
                              ? h(
                                  'button',
                                  {
                                    className: 'lf-button',
                                    type: 'button',
                                    disabled: exporting,
                                    onClick: () => exportFromList(entry.task_id),
                                  },
                                  exporting ? '导出中…' : '导出',
                                )
                              : null,
                            failures > 0 && entry.status !== 'CANCELLED'
                              ? h(
                                  'button',
                                  {
                                    className: 'lf-button',
                                    type: 'button',
                                    onClick: () => retryFailed(entry.task_id, { all: true }),
                                  },
                                  '重试失败项',
                                )
                              : null,
                          ),
                        ),
                      );
                    }),
                  ),
                ),
            Paragraph('导出任务列表中的已完成任务只复用已有帧与标签，不重新抽帧、不调用模型。'),
          ),
        ),
        h(
          'section',
          { className: 'lf-section' },
          h('h3', { className: 'lf-section-title' }, '导出'),
          h(
            'div',
            { className: 'lf-card' },
            Paragraph('只复用已完成任务的帧与标签，不重新抽帧、不调用模型；不勾选对象时导出任务全部对象。'),
            h(
              'label',
              { className: 'lf-field' },
              '导出任务',
              h(
                'select',
                {
                  value: exportTaskId ?? '',
                  onChange: (event) => setExportTaskId(event.target.value === '' ? null : event.target.value),
                },
                h('option', { value: '' }, task === null || task === undefined ? '当前任务（无）' : `当前任务（${task.task_id}）`),
                tasks.map((entry) => h('option', { key: entry.task_id, value: entry.task_id }, `${entry.task_id} · ${taskStatusLabel(entry.status)}`)),
              ),
            ),
            exportTargets.length === 0
              ? Paragraph('所选任务没有可导出的对象。')
              : h(
                  'div',
                  { className: 'lf-checks' },
                  exportTargets.map((target) =>
                    h(
                      'label',
                      { key: target.target_id, className: 'lf-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: selectedTargets.includes(target.target_id),
                        onChange: () => toggleTarget(target.target_id),
                      }),
                      target.name,
                    ),
                  ),
                ),
            h(
              'div',
              { className: 'lf-row' },
              h(
                'label',
                { className: 'lf-check' },
                h('input', { type: 'checkbox', checked: exportZip, onChange: (event) => setExportZip(event.target.checked) }),
                '导出为 zip',
              ),
              h(
                'label',
                { className: 'lf-check' },
                h('input', {
                  type: 'checkbox',
                  checked: exportByObject,
                  onChange: (event) => setExportByObject(event.target.checked),
                }),
                '按对象分目录（images/<对象>/）',
              ),
              h('button', { className: 'lf-button', type: 'button', disabled: exporting, onClick: runExport }, exporting ? '导出中…' : '导出'),
            ),
            Paragraph('每次导出都新建目录或 zip，不会覆盖之前的导出；写入页面设置区配置的导出目录。'),
          ),
          h(
            'div',
            { className: 'lf-card' },
            h('h3', null, '最近导出'),
            recentExports.length === 0
              ? Paragraph('还没有导出记录')
              : h(
                  'table',
                  { className: 'lf-table' },
                  h('thead', null, h('tr', null, ['时间', '对象', '数量', '路径'].map((label) => h('th', { key: label }, label)))),
                  h(
                    'tbody',
                    null,
                    recentExports.map((record) =>
                      h(
                        'tr',
                        { key: record.directory },
                        h('td', null, formatTime(record.exported_at)),
                        h('td', null, (record.target_names ?? []).join('、') || '全部对象'),
                        h('td', null, `${record.images ?? 0}${record.zip ? '（zip）' : ''}`),
                        h('td', { className: 'lf-toast-path' }, record.directory),
                      ),
                    ),
                  ),
                ),
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
            id: 'local-frames',
            order: 100,
            label: '本地视频帧',
          },
          LocalFramesPage,
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
