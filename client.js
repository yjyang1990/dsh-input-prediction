window.__ModuleLoader__.load({
  id: 'dsh-input-prediction',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState, useSyncExternalStore } = React;
    const PREDICTION_PATH = '/api/dsh-input-prediction';
    const POLL_MS = 600;
    const DRAFT_MS = 150;
    // Same keys Codex accepts a prediction with; none of them sends the message.
    const ACCEPT_KEYS = new Set(['Tab', 'ArrowRight', 'Enter']);
    // Codex hides the "Press Tab" badge for good once any prediction was accepted.
    let hasAcceptedPrediction = false;

    const STYLE = `
      .dship-anchor { display: none; }
      .dship-prediction {
        position: absolute;
        inset: 12px 8px auto 14px;
        color: var(--dsw-alias-label-caption);
        font-family: var(--dsw-font-family);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        pointer-events: none;
        user-select: none;
        z-index: 2;
      }
      .dship-prediction__badge {
        display: inline-block;
        margin-left: 6px;
        padding: 2px 7px;
        border-radius: 7px;
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-tertiary);
        font-size: 12px;
        line-height: 16px;
        white-space: nowrap;
        vertical-align: 1px;
      }
      [data-composer-card]:has(.dship-prediction) [data-composer-placeholder] { visibility: hidden; }
      [data-composer-card]:has(.dship-prediction) [contenteditable="true"] p:last-child::after { content: none; }
    `;

    function installStyle() {
      const id = 'dsh-input-prediction-style';
      if (document.querySelector(`style[data-plugin-css="${id}"]`)) return;
      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-input-prediction';
      style.dataset.pluginCss = id;
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    function editorOf(anchor) {
      const card = anchor?.closest?.('[data-composer-card]');
      return card?.querySelector('[contenteditable="true"]') || null;
    }

    function editorIsEmpty(editor) {
      if (!editor) return false;
      if (editor.querySelector('[data-lexical-decorator], img')) return false;
      const text = editor.innerText.replace(/[\u00a0\u200b\u200c\u200d\ufeff\s]/g, '');
      return text === '';
    }

    function triggerMenuOpen() {
      return [...document.querySelectorAll('[role="listbox"]')]
        .some((element) => element.getClientRects().length > 0);
    }

    function PredictionOverlay({ inputActions, locked, sessionId, useInput, useSession }) {
      // Hide immediately once a message is being submitted or a turn is running.
      const phase = typeof useInput === 'function' ? useInput((s) => s?.phase) : undefined;
      const running = typeof useSession === 'function' ? useSession((s) => s?.running) : false;
      const busy = running === true || phase === 'adjudicating' || phase === 'submitting';
      const anchorRef = useRef(null);
      const composingRef = useRef(false);
      const [empty, setEmpty] = useState(false);
      const [composing, setComposing] = useState(false);
      // { key, text, dismissed } for the session's latest completed turn.
      const [current, setCurrent] = useState(null);

      useEffect(() => { installStyle(); }, []);

      useEffect(() => {
        setCurrent(null);
      }, [sessionId]);

      // Codex only shows the suggestion while the composer is empty and not composing (IME).
      useEffect(() => {
        const update = () => setEmpty(editorIsEmpty(editorOf(anchorRef.current)));
        update();
        const timer = setInterval(update, DRAFT_MS);
        const onStart = () => { composingRef.current = true; setComposing(true); };
        const onEnd = () => { composingRef.current = false; setComposing(false); update(); };
        document.addEventListener('input', update, true);
        document.addEventListener('compositionstart', onStart, true);
        document.addEventListener('compositionend', onEnd, true);
        return () => {
          clearInterval(timer);
          document.removeEventListener('input', update, true);
          document.removeEventListener('compositionstart', onStart, true);
          document.removeEventListener('compositionend', onEnd, true);
        };
      }, []);

      // Poll server state: ready after a turn completes, none once a new turn starts.
      useEffect(() => {
        if (!sessionId) return undefined;
        let alive = true;
        const controller = new AbortController();
        const poll = async () => {
          try {
            const response = await fetch(
              `${PREDICTION_PATH}?sessionId=${encodeURIComponent(sessionId)}`,
              { signal: controller.signal },
            );
            if (!response.ok || !alive) return;
            const state = await response.json();
            if (!alive) return;
            if (state?.status === 'none') {
              setCurrent(null);
              return;
            }
            if (state?.status !== 'ready') return;
            const key = `${sessionId}\u0000${state.completionSeq}`;
            const text = typeof state.prediction === 'string' ? state.prediction.trim() : '';
            setCurrent((prev) => (prev?.key === key
              ? prev
              : (text ? { key, text, dismissed: false } : null)));
          } catch {
            // Keep the last state; the next poll retries.
          }
        };
        poll();
        const timer = setInterval(poll, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
          controller.abort();
        };
      }, [sessionId]);

      const visible = Boolean(
        current && !current.dismissed && !locked && !busy && empty && !composing,
      );

      useEffect(() => {
        if (!visible) return undefined;
        const onKeyDown = (event) => {
          const editor = editorOf(anchorRef.current);
          if (!editor || !editor.contains(event.target)) return;
          if (event.isComposing || event.keyCode === 229 || composingRef.current) return;
          if (!editorIsEmpty(editor)) return;
          if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === 'Escape' && !triggerMenuOpen()) {
            event.preventDefault();
            event.stopPropagation();
            setCurrent((prev) => (prev ? { ...prev, dismissed: true } : prev));
            return;
          }
          if (!ACCEPT_KEYS.has(event.key) || triggerMenuOpen()) return;
          event.preventDefault();
          event.stopPropagation();
          const text = current.text;
          if (typeof inputActions?.setDraft === 'function') {
            inputActions.setDraft(text);
          } else {
            editor.focus();
            document.execCommand('insertText', false, text);
          }
          editor.focus({ preventScroll: true });
          hasAcceptedPrediction = true;
        };
        // Clicking the ghost text should focus the composer without hiding it.
        const onMouseDown = (event) => {
          const editor = editorOf(anchorRef.current);
          if (event.button !== 0 || !editor || !editor.contains(event.target)) return;
          event.preventDefault();
          editor.focus({ preventScroll: true });
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('mousedown', onMouseDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('mousedown', onMouseDown, true);
        };
      }, [visible, current, inputActions]);

      return h(
        React.Fragment,
        null,
        h('span', { ref: anchorRef, className: 'dship-anchor' }),
        visible && h(
          'div',
          { className: 'dship-prediction', 'aria-hidden': true, 'data-dsh-input-prediction': true },
          h('span', null, current.text),
          !hasAcceptedPrediction && h('span', { className: 'dship-prediction__badge' }, '按 Tab 接受'),
        ),
      );
    }


    // ---- Plugin page config (plugins.row.config) ----
    const CONFIG_NS = 'dsh-input-prediction';
    const ROW_KEY = 'dsh-input-prediction#dsh-input-prediction';
    const CONFIG_STYLE = `
      .dship-config { display: grid; gap: 14px; max-width: 560px; font-family: var(--dsw-font-family); }
      .dship-config label { display: grid; gap: 6px; color: var(--dsw-alias-label-primary); font-size: 13px; }
      .dship-config small { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .dship-config select, .dship-config input[type="number"], .dship-config input[type="text"] {
        height: 32px; padding: 0 8px; border-radius: 8px; font: inherit;
        border: 1px solid var(--dsw-alias-border-primary, rgba(127,127,127,.35));
        background: var(--dsw-alias-bg-primary, transparent); color: inherit;
      }
      .dship-config .dship-check { display: flex; align-items: center; gap: 8px; }
      .dship-config .dship-actions { display: flex; align-items: center; gap: 10px; }
      .dship-config button {
        height: 32px; padding: 0 14px; border-radius: 8px; border: 0; cursor: pointer; font: inherit;
        background: var(--dsw-alias-interactive-bg-primary, #2563eb); color: var(--dsw-alias-label-on-primary, #fff);
      }
      .dship-config button[disabled] { opacity: .5; cursor: default; }
      .dship-config .dship-status { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
    `;

    function installConfigStyle() {
      const id = 'dsh-input-prediction-config-style';
      if (document.querySelector(`style[data-plugin-css="${id}"]`)) return;
      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-input-prediction';
      style.dataset.pluginCss = id;
      style.textContent = CONFIG_STYLE;
      document.head.appendChild(style);
    }

    // One <select> value carries both halves of the route.
    const ROUTE_SEP = '\u0000';
    const routeValue = (provider, model) => (model ? `${provider || ''}${ROUTE_SEP}${model}` : '');
    function parseRoute(value) {
      const index = value.indexOf(ROUTE_SEP);
      return index < 0
        ? { predictionProvider: '', predictionModel: '' }
        : { predictionProvider: value.slice(0, index), predictionModel: value.slice(index + 1) };
    }

    function effortsOf(groups, provider, model) {
      const seen = new Map();
      for (const group of groups) {
        if (provider && group.id !== provider) continue;
        for (const item of group.models || []) {
          if (model && item.id !== model) continue;
          for (const effort of item.reasoning?.efforts || []) {
            if (!seen.has(effort.id)) seen.set(effort.id, effort.name || effort.id);
          }
        }
      }
      return [...seen.entries()];
    }

    function ConfigPage({ scope, loadCatalog, subscribeCatalog }) {
      const snap = useSyncExternalStore(scope.subscribe.bind(scope), () => scope.getSnapshot());
      const [groups, setGroups] = useState([]);
      const [catalogState, setCatalogState] = useState('loading');
      const [draft, setDraft] = useState(null);
      const [saveState, setSaveState] = useState('');

      useEffect(() => { installConfigStyle(); }, []);
      useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const res = await loadCatalog();
            if (!alive) return;
            if (res?.ok) {
              setGroups(res.value.groups || []);
              setCatalogState('ready');
            } else setCatalogState('error');
          } catch {
            if (alive) setCatalogState('error');
          }
        };
        load();
        const off = subscribeCatalog(load);
        return () => { alive = false; off?.(); };
      }, []);

      if (snap.status !== 'ready') {
        return h('div', { className: 'dship-config' },
          h('span', { className: 'dship-status' }, snap.status === 'unavailable' ? '插件未加载，暂时无法配置。' : '正在读取配置…'));
      }
      const saved = {
        enabled: snap.value?.enabled !== false,
        predictionProvider: snap.value?.predictionProvider || '',
        predictionModel: snap.value?.predictionModel || '',
        reasoningEffort: snap.value?.reasoningEffort || '',
        maxTokens: snap.value?.maxTokens || 160,
        timeoutMs: snap.value?.timeoutMs || 30000,
      };
      const value = draft || saved;
      const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
      const edit = (patch) => { setSaveState(''); setDraft({ ...value, ...patch }); };
      const disabled = !snap.writable || saveState === 'saving';

      const selected = routeValue(value.predictionProvider, value.predictionModel);
      const knownModel = !selected || groups.some((g) => (g.models || []).some((m) => routeValue(g.id, m.id) === selected));
      // Older configs saved only the model; the host matches its provider at call time.
      const unknownLabel = value.predictionProvider
        ? `${value.predictionProvider}/${value.predictionModel}（未在模型列表中）`
        : `${value.predictionModel}（自动匹配 Provider）`;
      const efforts = effortsOf(groups, value.predictionProvider, value.predictionModel);
      const knownEffort = !value.reasoningEffort || efforts.some(([id]) => id === value.reasoningEffort);

      const save = async () => {
        const maxTokens = Math.floor(Number(value.maxTokens));
        const timeoutMs = Math.round(Number(value.timeoutMs));
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) { setSaveState('invalid'); return; }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) { setSaveState('invalidTimeout'); return; }
        setSaveState('saving');
        const ok = await scope.mutate([
          { op: 'set', path: ['enabled'], value: value.enabled },
          { op: 'set', path: ['predictionProvider'], value: value.predictionProvider },
          { op: 'set', path: ['predictionModel'], value: value.predictionModel },
          { op: 'set', path: ['reasoningEffort'], value: value.reasoningEffort },
          { op: 'set', path: ['maxTokens'], value: maxTokens },
          { op: 'set', path: ['timeoutMs'], value: timeoutMs },
        ], snap.revision);
        if (ok) { setDraft(null); setSaveState('saved'); } else setSaveState('failed');
      };

      const statusText = {
        saving: '正在保存…', saved: '已保存，下一次回复结束后生效。',
        failed: '保存失败，请检查后重试。', invalid: '最大输出 Token 必须是正整数。',
        invalidTimeout: '超时时间至少为 1 秒。',
      }[saveState] || (snap.writable ? '' : '当前部署的配置为只读。');

      return h('div', { className: 'dship-config' },
        h('label', { className: 'dship-check' },
          h('input', { type: 'checkbox', checked: value.enabled, disabled, onChange: (e) => edit({ enabled: e.target.checked }) }),
          '回复结束后显示输入预测'),
        h('label', null, '预测模型',
          h('select', {
            value: selected, disabled,
            onChange: (e) => edit({ ...parseRoute(e.target.value), reasoningEffort: '' }),
          },
          h('option', { value: '' }, '跟随当前会话模型'),
          !knownModel && h('option', { value: selected }, unknownLabel),
          ...groups.map((group) => h('optgroup', { key: group.id, label: group.name || group.id },
            ...(group.models || []).map((m) => h('option', { key: `${group.id}/${m.id}`, value: routeValue(group.id, m.id) }, m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id))))),
          h('small', null, catalogState === 'loading' ? '正在加载模型列表…'
            : catalogState === 'error' ? '模型列表加载失败，可稍后重新打开此页。'
              : '预测使用所选 Provider 和模型；该模型不可用时，回退到会话模型。')),
        h('label', null, '推理强度',
          h('select', { value: value.reasoningEffort, disabled, onChange: (e) => edit({ reasoningEffort: e.target.value }) },
            h('option', { value: '' }, '默认（同模型时沿用会话强度）'),
            !knownEffort && h('option', { value: value.reasoningEffort }, value.reasoningEffort),
            ...efforts.map(([id, name]) => h('option', { key: id, value: id }, name)))),
        h('label', null, '最大输出 Token',
          h('input', { type: 'number', min: 1, step: 1, value: value.maxTokens, disabled, onChange: (e) => edit({ maxTokens: e.target.value }) })),
        h('label', null, '超时（秒）',
          h('input', { type: 'number', min: 1, step: 1, value: Number(value.timeoutMs) / 1000, disabled, onChange: (e) => edit({ timeoutMs: Number(e.target.value) * 1000 }) })),
        h('div', { className: 'dship-actions' },
          h('button', { type: 'button', disabled: disabled || !dirty, onClick: save }, '保存'),
          dirty && h('button', { type: 'button', disabled, onClick: () => { setDraft(null); setSaveState(''); } }, '放弃'),
          statusText && h('span', { className: 'dship-status' }, statusText)));
    }

    function ConfigSummary({ scope }) {
      const snap = useSyncExternalStore(scope.subscribe.bind(scope), () => scope.getSnapshot());
      const model = snap.value?.predictionModel;
      const provider = snap.value?.predictionProvider;
      return `回复结束后预测下一条消息 · 模型：${model ? `${provider ? `${provider}/` : ''}${model}` : '跟随当前会话'}`;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'dsh-input-prediction',
          order: 20,
          inject: (sessionId) => ({ sessionId }),
        }, PredictionOverlay));

        // Config page is optional: the overlay keeps working without these services.
        ctx.inject(['configForms', 'remote', 'remote.session'], (sub) => {
          const scope = sub.configForms.get(CONFIG_NS);
          const loadCatalog = () => sub.remote.session.modelCatalog();
          const subscribeCatalog = (listener) => sub.remote.$on('llm/adapters-updated', listener);
          sub.effect(() => sub.configForms.whileServed([CONFIG_NS], () => sub.slots.inject('plugins.row.config', () => sub.slots.register({
            name: 'plugins.row.config',
            key: ROW_KEY,
          }, ({ view }) => (view === 'summary'
            ? h(ConfigSummary, { scope })
            : h(ConfigPage, { scope, loadCatalog, subscribeCatalog }))))), 'dsh-input-prediction: config page');
        });
      },
    };
  },
});
