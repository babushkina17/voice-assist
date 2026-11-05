(() => {
  'use strict';

  const C = window.APP_CONFIG;
  const T = window.TEXTS;
  const root = document.getElementById('app');
  const live = document.getElementById('live');
  const N = T.questions.length;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ---------- Утилиты ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const words = s => (s || '').trim().split(/\s+/).filter(Boolean).length;
  const joinText = (a, b) => [a, b].map(s => (s || '').trim()).filter(Boolean).join(' ');
  const fmt = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const $ = sel => root.querySelector(sel);

  // ---------- Состояние ----------
  // screen:  welcome | access | question | summary
  // qState:  ready | recording | recognizing | review | text | error | accepted
  // errorKind (при qState = error): silence | recognition | interrupted
  // Ответ: { raw, text, source }  raw — что услышала система, text — что уйдёт в генерацию.
  const state = {
    screen: 'welcome',
    accessKind: 'prompt',     // prompt | denied | unsupported
    accessNote: '',
    voiceOk: !!(SR && navigator.mediaDevices),
    prefersText: false,
    q: 0,
    qState: 'ready',
    errorKind: null,
    pending: null,            // непринятый ответ текущего вопроса
    answers: loadDraft(),     // принятые ответы, хранятся в localStorage
    editing: false,
    limitHit: false,
    elapsed: 0,
    focusText: false,
    gen: { token: 0, status: 'idle', result: null, slow: false },
    copied: false
  };

  function loadDraft() {
    try {
      const a = JSON.parse(localStorage.getItem(C.DRAFT_KEY));
      if (Array.isArray(a) && a.length === N) {
        return a.map(x => x && typeof x.text === 'string'
          ? { raw: String(x.raw || ''), text: x.text, source: x.source === 'voice' ? 'voice' : 'text' }
          : null);
      }
    } catch (e) { /* пустой черновик */ }
    return Array(N).fill(null);
  }
  function saveDraft() {
    try { localStorage.setItem(C.DRAFT_KEY, JSON.stringify(state.answers)); } catch (e) { /* нет хранилища */ }
  }
  const answeredCount = () => state.answers.filter(Boolean).length;
  const firstUnanswered = () => state.answers.findIndex(a => !a);

  function canConfirm() {
    const p = state.pending;
    if (!p || !['review', 'text', 'error'].includes(state.qState)) return false;
    return words(p.text) >= C.MIN_WORDS;
  }

  // ---------- Распознавание (адаптер) ----------
  // Контракт: start(), stop(), abort(); колбэки onresult(текстСессии), onerror('no-speech'|'denied'|'other'), onend().
  // Подмена для демо и тестов: window.__fakeRecognizerFactory.
  function createRecognizer() {
    if (window.__fakeRecognizerFactory) return window.__fakeRecognizerFactory();
    const r = new SR();
    r.lang = C.LANG;
    r.continuous = true;
    r.interimResults = true;
    const api = {
      onresult: null, onerror: null, onend: null,
      start() { r.start(); },
      stop() { try { r.stop(); } catch (e) { /* уже остановлено */ } },
      abort() { try { r.abort(); } catch (e) { /* уже остановлено */ } }
    };
    r.onresult = e => {
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      if (api.onresult) api.onresult(t);
    };
    r.onerror = e => {
      const k = e.error === 'no-speech' ? 'no-speech'
        : (e.error === 'not-allowed' || e.error === 'service-not-allowed') ? 'denied'
        : e.error === 'aborted' ? null : 'other';
      if (k && api.onerror) api.onerror(k);
    };
    r.onend = () => { if (api.onend) api.onend(); };
    return api;
  }

  // ---------- Запись ----------
  let session = null;
  let acceptTimer = null;

  function clearTimers(s) {
    clearTimeout(s.timers.silence);
    clearInterval(s.timers.tick);
    clearTimeout(s.timers.fallback);
  }

  function liveText() { return session ? joinText(session.base, session.text) : ''; }

  function updateLive() {
    const el = document.getElementById('transcript');
    if (!el || state.qState !== 'recording') return;
    const t = liveText();
    el.innerHTML = t ? esc(t) : `<span class="ph">${esc(T.q.listening)}</span>`;
    el.scrollTop = el.scrollHeight;
  }

  function startRecording(append) {
    const base = append && state.pending ? state.pending.text : '';
    const s = session = {
      base, text: '', heard: false, reason: null, error: null, done: false,
      rec: createRecognizer(), start: Date.now(), timers: {}
    };
    s.rec.onresult = t => {
      if (session !== s) return;
      s.text = t;
      if (t.trim()) { s.heard = true; clearTimeout(s.timers.silence); }
      updateLive();
    };
    s.rec.onerror = k => { if (session === s) s.error = k; };
    s.rec.onend = () => { if (session === s) finish(s); };

    state.qState = 'recording';
    state.errorKind = null;
    state.limitHit = false;
    state.elapsed = 0;
    render();

    try { s.rec.start(); } catch (e) { s.error = 'other'; finish(s); return; }
    s.timers.silence = setTimeout(() => { if (session === s && !s.heard) stop(s, 'silence'); }, C.SILENCE_MS);
    s.timers.tick = setInterval(tick, 250);
  }

  function tick() {
    const s = session;
    if (!s || s.reason) return;
    const el = Date.now() - s.start;
    state.elapsed = el;
    const t = document.getElementById('timer');
    if (t) t.textContent = fmt(el);
    const w = document.getElementById('warn');
    if (w) w.hidden = el < C.LIMIT_MS - C.WARN_BEFORE_LIMIT_MS;
    if (el >= C.LIMIT_MS) stop(s, 'limit');
  }

  function stop(s, reason) {
    if (!s || s.reason) return;
    s.reason = reason;
    clearTimers(s);
    if (reason === 'silence') { s.rec.abort(); finish(s); return; }
    state.qState = 'recognizing';
    render();
    s.rec.stop();
    s.timers.fallback = setTimeout(() => finish(s), C.RECOGNITION_TIMEOUT_MS);
  }

  function fail(kind, text) {
    state.pending = text ? { raw: text, text, source: 'voice' } : null;
    state.qState = 'error';
    state.errorKind = kind;
    render();
  }

  function finish(s) {
    if (s.done) return;
    s.done = true;
    clearTimers(s);
    if (session === s) session = null;

    const text = joinText(s.base, s.text);
    const reason = s.reason || 'auto';

    if (s.error === 'denied') { state.voiceOk = false; setAccess('denied'); return; }
    if (reason === 'silence') return fail('silence', s.base);
    if (reason === 'interrupted') return fail('interrupted', text);
    if (s.error && s.error !== 'no-speech') return fail('recognition', text);
    if (!s.text.trim()) return fail('silence', s.base);

    state.pending = { raw: text, text, source: 'voice' };
    state.qState = 'review';
    state.errorKind = null;
    state.limitHit = reason === 'limit';
    render();
  }

  function abortSession() {
    clearTimeout(acceptTimer);
    if (session) {
      clearTimers(session);
      session.done = true;
      session.rec.abort();
      session = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && session && state.qState === 'recording') stop(session, 'interrupted');
  });

  // ---------- Доступ к микрофону ----------
  async function micStatus() {
    if (!SR || !navigator.mediaDevices) return 'unsupported';
    try {
      const p = await navigator.permissions.query({ name: 'microphone' });
      return p.state;
    } catch (e) { return 'prompt'; }
  }

  function setAccess(kind, note) {
    abortSession();
    state.screen = 'access';
    state.accessKind = kind;
    state.accessNote = note || '';
    state.voiceOk = kind === 'prompt';
    render();
  }

  async function beginFlow() {
    state.prefersText = false;
    const st = await micStatus();
    if (st === 'unsupported') return setAccess('unsupported');
    if (st === 'denied') return setAccess('denied');
    if (st === 'granted') { state.voiceOk = true; return proceed(); }
    setAccess('prompt');
  }

  async function allow() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      state.voiceOk = true;
      proceed();
    } catch (e) {
      setAccess('denied');
    }
  }

  async function recheck() {
    const st = await micStatus();
    if (st === 'granted') { state.voiceOk = true; return proceed(); }
    if (st === 'prompt') return setAccess('prompt');
    setAccess(st === 'unsupported' ? 'unsupported' : 'denied', T.denied.still);
  }

  function useText() {
    state.prefersText = true;
    proceed();
  }

  // ---------- Навигация ----------
  function proceed() {
    const i = firstUnanswered();
    if (i < 0) goSummary(); else goQuestion(i);
  }

  // editing: правка с экрана итога (после подтверждения возврат на итог).
  // revisit: возврат кнопкой «Назад» или проход вперёд по уже отвеченным вопросам (показываем ответ на проверку).
  function goQuestion(i, editing, revisit) {
    abortSession();
    state.screen = 'question';
    state.q = i;
    state.editing = !!editing;
    state.errorKind = null;
    state.limitHit = false;
    state.elapsed = 0;
    const ex = state.answers[i];
    if ((state.editing || revisit) && ex) {
      state.pending = { ...ex };
      state.qState = 'review';
    } else if (state.prefersText) {
      state.pending = { raw: '', text: '', source: 'text' };
      state.qState = 'text';
      state.focusText = true;
    } else {
      state.pending = null;
      state.qState = 'ready';
    }
    render();
  }

  function next() {
    if (state.editing) { state.editing = false; return goSummary(); }
    if (state.q < N - 1) return goQuestion(state.q + 1, false, true);
    goSummary();
  }

  function goSummary() {
    abortSession();
    state.screen = 'summary';
    state.editing = false;
    startGeneration();
  }

  // ---------- Генерация ----------
  let slowTimer = null;
  async function startGeneration() {
    const token = state.gen.token + 1;
    clearTimeout(slowTimer);
    state.gen = { token, status: 'loading', result: null, slow: false };
    state.copied = false;
    slowTimer = setTimeout(() => {
      if (state.gen.token === token && state.gen.status === 'loading') { state.gen.slow = true; render(); }
    }, C.GENERATION_SLOW_MS);
    render();
    try {
      const result = await window.generateVacancy(state.answers.map(a => a.text));
      if (state.gen.token !== token) return;
      state.gen.status = 'ready';
      state.gen.result = result;
    } catch (e) {
      if (state.gen.token !== token) return;
      state.gen.status = 'error';
    }
    clearTimeout(slowTimer);
    render();
  }

  function toPlain(r) {
    return T.summary.title + '\n\n' + r.sections
      .map(s => `${s.heading}\n${s.items ? s.items.map(i => '— ' + i).join('\n') : s.text}`)
      .join('\n\n');
  }

  let copyTimer = null;
  async function copy() {
    if (state.gen.status !== 'ready') return;
    const text = toPlain(state.gen.result);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = fallbackCopy(text); }
    if (!ok) return;
    state.copied = true;
    render();
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { state.copied = false; if (state.screen === 'summary') render(); }, C.COPIED_MS);
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  // ---------- Действия ----------
  function confirmAnswer() {
    if (!canConfirm()) return;
    const p = state.pending;
    state.answers[state.q] = { raw: p.raw, text: p.text.trim(), source: p.source };
    saveDraft();
    state.qState = 'accepted';
    render();
    clearTimeout(acceptTimer);
    acceptTimer = setTimeout(next, C.ACCEPT_DELAY_MS);
  }

  const A = {
    start: () => beginFlow(),
    resume: () => beginFlow(),
    restart: () => { state.answers = Array(N).fill(null); saveDraft(); beginFlow(); },
    allow, recheck, useText,
    close: () => {
      abortSession();
      state.screen = 'welcome';
      state.editing = false;
      state.pending = null;
      render();
    },
    back: () => {
      if (state.editing) {
        // Правка отменена, ответ не менялся: возвращаемся на итог без пересборки описания.
        abortSession();
        state.editing = false;
        state.pending = null;
        state.screen = 'summary';
        render();
        return;
      }
      if (state.q > 0) goQuestion(state.q - 1, false, true);
    },
    record: () => startRecording(false),
    retry: () => startRecording(!!state.pending),
    stop: () => stop(session, 'user'),
    confirm: confirmAnswer,
    rerecord: () => {
      state.pending = null; state.errorKind = null; state.limitHit = false;
      state.prefersText = false; state.qState = 'ready'; render();
    },
    toText: () => {
      state.pending = state.pending || { raw: '', text: '', source: 'text' };
      state.errorKind = null; state.limitHit = false;
      state.qState = 'text'; state.focusText = true; render();
    },
    toVoice: () => {
      if (!state.voiceOk) return beginFlow();
      state.pending = null; state.prefersText = false; state.qState = 'ready'; render();
    },
    edit: d => goQuestion(Number(d.i), true),
    copy,
    regen: () => startGeneration()
  };

  root.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const f = A[el.dataset.action];
    if (f) f(el.dataset);
  });

  root.addEventListener('input', e => {
    if (e.target.id !== 'answer') return;
    state.pending = state.pending || { raw: '', text: '', source: 'text' };
    state.pending.text = e.target.value;
    state.pending.source = 'text';
    const b = document.getElementById('confirm');
    if (b) b.disabled = !canConfirm();
  });

  // ---------- Представления ----------
  const ICONS = {
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    wave: '<path d="M3 10v4M7.5 7v10M12 4v16M16.5 8v8M21 11v2"/>',
    dots: '<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>',
    lines: '<path d="M5 7h14M5 12h14M5 17h9"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.5"/>',
    pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M15 5l-7 7 7 7"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  function arc(cx, cy, r, a0, a1) {
    const p = a => { const t = a * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  // Состояние сегмента: empty | active | done.
  // Уже подтверждённый ответ, который пользователь просматривает, остаётся done,
  // пока он не начал записывать заново.
  function segStates() {
    return state.answers.map((a, i) => {
      if (state.screen === 'question' && i === state.q) {
        if (state.qState === 'accepted') return 'done';
        if (a && state.qState === 'review') return 'done';
        return 'active';
      }
      return a ? 'done' : 'empty';
    });
  }

  // Состояния сегментов в прошлой отрисовке: от них кольцо плавно переходит к новым.
  let lastSegs = null;
  let nextSegs = null;

  function ringBlock({ mode = '', iconName = '', size = '' } = {}) {
    const segs = segStates();
    const prev = lastSegs || Array(N).fill('empty');
    nextSegs = segs;
    const gap = 16;
    let paths = '';
    for (let i = 0; i < N; i++) {
      const a0 = -90 + i * 90 + gap / 2;
      const a1 = -90 + (i + 1) * 90 - gap / 2;
      const d = arc(120, 120, 104, a0, a1);
      // Рисуем с прошлым состоянием; после вставки в DOM переключаем на новое (см. render), CSS анимирует переход.
      paths += `<g class="seg-g" data-state="${prev[i]}" data-next="${segs[i]}">
        <path class="seg seg--track" d="${d}"/>
        <path class="seg seg--active" d="${d}"/>
        <path class="seg seg--fill" pathLength="100" d="${d}"/>
      </g>`;
    }
    const done = segs.filter(s => s === 'done').length;
    return `<div class="ring ${size ? 'ring--' + size : ''}" data-mode="${mode}" role="img" aria-label="${esc(T.ringLabel(done, N))}">
      <svg class="ring__svg" viewBox="0 0 240 240" aria-hidden="true">${paths}</svg>
      ${iconName ? `<div class="ring__icon">${icon(iconName)}</div>` : ''}
    </div>`;
  }

  // Крупная иконка без кольца: стартовый экран и экран доступа к микрофону.
  const hero = (name, isError) => `<div class="hero ${isError ? 'hero--error' : ''}" aria-hidden="true">${icon(name)}</div>`;

  const btn = (action, label, cls = 'btn--primary', extra = '') =>
    `<button class="btn ${cls}" data-action="${action}" ${extra}>${esc(label)}</button>`;
  const link = (action, label) => `<button class="link" data-action="${action}">${esc(label)}</button>`;
  const screenWrap = (bar, content, actions, left) =>
    `<div class="screen">${bar}<main class="content ${left ? 'content--left' : ''}">${content}</main><footer class="actions">${actions}</footer></div>`;
  const emptyBar = '<header class="bar"><span></span><span></span><span></span></header>';

  function viewWelcome() {
    const n = answeredCount();
    const draft = n > 0;
    const title = draft ? (n === N ? T.draft.titleDone : T.draft.title) : T.welcome.title;
    const meta = draft ? T.draft.meta(n, N) : T.welcome.meta;
    return screenWrap(
      emptyBar,
      `${hero('mic')}<h1 class="h1" id="title" tabindex="-1">${esc(title)}</h1><p class="meta">${esc(meta)}</p>`,
      draft ? btn('resume', T.draft.resume) + link('restart', T.draft.restart) : btn('start', T.welcome.start)
    );
  }

  function viewAccess() {
    const k = state.accessKind;
    const t = k === 'prompt' ? T.access : k === 'denied' ? T.denied : T.unsupported;
    const note = state.accessNote ? `<p class="msg msg--error">${esc(state.accessNote)}</p>` : '';
    const actions = k === 'prompt' ? btn('allow', T.access.allow)
      : k === 'denied' ? btn('useText', T.denied.text) + link('recheck', T.denied.retry)
      : btn('useText', T.unsupported.text);
    return screenWrap(
      emptyBar,
      `${hero(k === 'prompt' ? 'mic' : 'warn', k !== 'prompt')}
       <h1 class="h1" id="title" tabindex="-1">${esc(t.title)}</h1><p class="body-text">${esc(t.body)}</p>${note}`,
      actions
    );
  }

  function errorMessage() {
    const has = !!(state.pending && state.pending.text);
    switch (state.errorKind) {
      case 'silence': return T.errors.silence;
      case 'recognition': return has ? T.errors.recognition : T.errors.recognitionEmpty;
      case 'interrupted': return has ? T.errors.interrupted : T.errors.interruptedEmpty;
      default: return '';
    }
  }

  function questionActions() {
    const s = state.qState;
    const confirmBtn = btn('confirm', T.q.confirm, 'btn--primary', `id="confirm" ${canConfirm() ? '' : 'disabled'}`);
    if (s === 'ready') return btn('record', T.q.start) + link('toText', T.q.typeLink);
    if (s === 'recording') return btn('stop', T.q.stop, 'btn--rec');
    if (s === 'recognizing') return btn('record', T.q.start, 'btn--primary', 'disabled');
    if (s === 'accepted') return btn('confirm', T.q.confirm, 'btn--primary', 'disabled');
    if (s === 'text') return confirmBtn + (state.voiceOk ? link('toVoice', T.q.toVoice) : '');
    if (s === 'review') return confirmBtn + link('rerecord', T.q.rerecord) + link('toText', T.q.typeLink);
    if (s === 'error') {
      const has = !!(state.pending && state.pending.text);
      const label = state.errorKind !== 'silence' && has ? T.q.continue : T.q.retry;
      return btn('retry', label)
        + (canConfirm() ? btn('confirm', T.q.confirmAsIs, 'btn--secondary') : '')
        + (has ? link('rerecord', T.q.rerecord) : '')
        + link('toText', T.q.typeLink);
    }
    return '';
  }

  function viewQuestion() {
    const s = state.qState;
    const q = T.questions[state.q];
    const compact = s === 'text';
    const iconName = { ready: 'mic', recording: 'wave', recognizing: 'dots', accepted: 'check', error: 'warn', text: 'pencil', review: 'lines' }[s];
    const mode = s === 'error' ? 'error' : (s === 'recording' || s === 'recognizing') ? s : '';

    const canBack = state.editing || state.q > 0;
    const backBtn = canBack
      ? `<button class="icon-btn" data-action="back" aria-label="${esc(T.q.back)}" ${s === 'accepted' ? 'disabled' : ''}>${icon('back')}</button>`
      : '<span></span>';
    const bar = `<header class="bar">${backBtn}<span class="counter" id="counter">${esc(T.q.counter(state.q + 1, N))}</span>
      <button class="icon-btn" data-action="close" aria-label="${esc(T.q.close)}">${icon('close')}</button></header>`;

    let c = '';
    if (state.editing) c += `<p class="eyebrow">${esc(T.summary.editTitle)}</p>`;
    c += `<h1 class="question" id="title" tabindex="-1">${esc(q.q)}</h1><p class="hint">${esc(q.hint)}</p>`;
    c += ringBlock({ mode, iconName, size: compact ? 'compact' : '' });

    if (s === 'recording') {
      c += `<div class="timer" id="timer">${fmt(state.elapsed)}</div>`;
      c += `<p class="msg msg--warn" id="warn" ${state.elapsed >= C.LIMIT_MS - C.WARN_BEFORE_LIMIT_MS ? '' : 'hidden'}>${esc(T.q.warn)}</p>`;
    }

    if (s === 'recording' || s === 'recognizing') {
      const t = liveText();
      c += `<div class="transcript" id="transcript">${t ? esc(t) : (s === 'recording' ? `<span class="ph">${esc(T.q.listening)}</span>` : '')}</div>`;
      if (s === 'recognizing') c += `<p class="meta">${esc(T.q.recognizing)}</p>`;
    } else if (s === 'text') {
      const v = state.pending ? state.pending.text : '';
      c += `<label class="sr-only" for="answer">${esc(T.q.textLabel)}</label>
        <textarea class="textarea" id="answer" rows="5" placeholder="${esc(T.q.textPlaceholder)}">${esc(v)}</textarea>
        <p class="helper">${esc(T.q.minWords(C.MIN_WORDS))}</p>`;
    } else if (state.pending && state.pending.text && (s === 'review' || s === 'error' || s === 'accepted')) {
      const lbl = state.pending.source === 'text' ? T.q.reviewTyped : T.q.reviewHeard;
      c += `<p class="label">${esc(lbl)}</p><div class="transcript" id="transcript">${esc(state.pending.text)}</div>`;
    }

    if (s === 'error') c += `<p class="msg msg--error">${esc(errorMessage())}</p>`;
    if (s === 'review' && state.pending && words(state.pending.text) < C.MIN_WORDS) c += `<p class="msg msg--error">${esc(T.errors.short)}</p>`;
    if (s === 'review' && state.limitHit) c += `<p class="meta">${esc(T.q.limit)}</p>`;
    if (s === 'ready' && state.answers[state.q]) c += `<p class="note">${esc(T.q.rerecordNote)}</p>`;
    if (state.editing && s !== 'accepted') c += `<p class="note">${esc(T.summary.editNote)}</p>`;
    if (s === 'accepted') c += `<p class="meta">${esc(T.q.accepted)}</p>`;

    return screenWrap(bar, c, questionActions());
  }

  function sectionsHTML(r) {
    return r.sections.map(s => `<section><h3 class="h3">${esc(s.heading)}</h3>${
      s.items ? `<ul>${s.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : `<p>${esc(s.text)}</p>`
    }</section>`).join('');
  }

  function viewSummary() {
    const g = state.gen;
    let body;
    if (g.status === 'error') {
      body = `<div class="card"><p class="msg msg--error">${esc(T.summary.error)}</p></div>`;
    } else if (g.status === 'ready') {
      body = `<article class="card doc">${sectionsHTML(g.result)}</article>`;
    } else {
      body = `<div class="card" aria-busy="true"><p class="status">${esc(T.summary.generating)}</p>
        <div class="skel"></div><div class="skel w80"></div><div class="skel"></div><div class="skel w60"></div>
        ${g.slow ? `<p class="meta">${esc(T.summary.slow)}</p>` : ''}</div>`;
    }
    const cards = state.answers.map((a, i) => `<div class="card">
        <p class="label">${esc(T.questions[i].q)}</p>
        <p class="body-text">${esc(a.text)}</p>
        <button class="link link--inline" data-action="edit" data-i="${i}">${esc(T.summary.edit)}</button>
      </div>`).join('');
    const head = `<div style="display:flex;flex-direction:column;align-items:center;gap:8px">${ringBlock({ size: 'small', iconName: 'check' })}
      <h1 class="h1" id="title" tabindex="-1">${esc(T.summary.title)}</h1></div>`;
    const actions = g.status === 'error' ? btn('regen', T.summary.retry)
      : btn('copy', state.copied ? T.summary.copied : T.summary.copy, 'btn--primary', g.status === 'ready' ? '' : 'disabled');
    return screenWrap(emptyBar, `${head}${body}<h2 class="h2">${esc(T.summary.answers)}</h2>${cards}`, actions, true);
  }

  // ---------- Озвучивание статусов и фокус ----------
  function statusText() {
    if (state.screen === 'question') {
      switch (state.qState) {
        case 'ready': return T.questions[state.q].q;
        case 'recording': return T.q.srRecording;
        case 'recognizing': return T.q.recognizing;
        case 'review': return `${T.q.reviewHeard} ${state.pending ? state.pending.text : ''}`;
        case 'error': return errorMessage();
        case 'accepted': return T.q.accepted;
        default: return '';
      }
    }
    if (state.screen === 'summary') {
      return state.gen.status === 'loading' ? T.summary.generating
        : state.gen.status === 'ready' ? T.summary.ready : T.summary.error;
    }
    return '';
  }

  let lastFocusKey = '';
  let lastStatusKey = '';

  function render() {
    const views = { welcome: viewWelcome, access: viewAccess, question: viewQuestion, summary: viewSummary };
    nextSegs = null;
    root.innerHTML = views[state.screen]();

    // Плавный переход сегментов: после вставки в DOM переключаем data-state на новое значение.
    if (nextSegs) {
      const groups = root.querySelectorAll('.seg-g');
      void root.offsetWidth; // зафиксировать исходное состояние
      requestAnimationFrame(() => groups.forEach(g => { g.dataset.state = g.dataset.next; }));
      lastSegs = nextSegs;
    }

    const focusKey = `${state.screen}:${state.q}:${state.editing}:${state.accessKind}`;
    const title = document.getElementById('title');
    if (focusKey !== lastFocusKey) {
      lastFocusKey = focusKey;
      if (title) title.focus({ preventScroll: true });
    } else if (!root.contains(document.activeElement)) {
      const primary = root.querySelector('.btn--primary:not([disabled])');
      (primary || title) && (primary || title).focus({ preventScroll: true });
    }
    if (state.focusText) {
      state.focusText = false;
      const ta = document.getElementById('answer');
      if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }

    const key = `${state.screen}|${state.q}|${state.qState}|${state.errorKind}|${state.gen.status}`;
    if (key !== lastStatusKey) {
      lastStatusKey = key;
      const msg = statusText();
      live.textContent = '';
      if (msg) setTimeout(() => { live.textContent = msg; }, 50);
    }
  }

  // Для демо-панели и тестов
  window.__app = { state, render, config: C };

  render();
})();
