// Демо-режим: включается адресом ?demo=1.
// Вместо микрофона подставляется имитация распознавания, поэтому весь сценарий кликается
// в любом браузере, в том числе там, где Web Speech API не работает (Яндекс Браузер, Firefox).
// Над приложением появляется панель: можно выбрать, как поведёт себя следующая запись
// (тишина, короткий ответ, обрыв, ошибка службы…), и вызвать остальные состояния из спецификации.
// Без ?demo=1 файл ничего не делает.
// Подключается после config.js и до texts.js, чтобы изменённые пороги попали в тексты.
(() => {
  'use strict';
  if (!/[?&]demo=1(&|$)/.test(location.search)) return;

  const C = window.APP_CONFIG;
  const LIMIT_KEY = 'vacancy-voice.demo.shortLimit';
  let shortLimit = false;
  try { shortLimit = sessionStorage.getItem(LIMIT_KEY) === '1'; } catch (e) { /* без хранилища */ }

  // Сокращённые таймауты, чтобы ошибки можно было показать быстро.
  C.SILENCE_MS = 3000;
  C.STARTUP_GRACE_MS = 2000;
  if (shortLimit) { C.LIMIT_MS = 15000; C.WARN_BEFORE_LIMIT_MS = 5000; }

  const demo = { mode: 'normal', denyMic: false, micGranted: false };
  window.__demo = demo;
  window.__sim = window.__sim || {};

  const SCRIPTS = [
    'Ведёт карточки товаров, отвечает на обращения клиентов и готовит еженедельный отчёт.',
    'Проект автоматизации найма для крупных заказчиков: нужно описать процесс и собрать первые экраны.',
    'Продолжит работу над этим же проектом, а затем перейдёт на запуск мобильной версии.',
    'Figma, Miro, умение писать спецификации и общаться с разработчиками.'
  ];
  const CONTINUATION = 'Дополнительно нужно согласовать сроки с командой.';

  // ---------- Микрофон и разрешения ----------
  const define = (obj, key, value) => { try { Object.defineProperty(obj, key, { value, configurable: true }); } catch (e) { /* не переопределяется */ } };
  define(navigator, 'mediaDevices', {
    getUserMedia: async () => {
      if (demo.denyMic) throw new Error('NotAllowedError');
      demo.micGranted = true;
      return { getTracks: () => [] };
    }
  });
  define(navigator, 'permissions', {
    query: async () => ({ state: demo.denyMic ? 'denied' : demo.micGranted ? 'granted' : 'prompt' })
  });

  // ---------- Имитация распознавания ----------
  // Ведёт себя как браузерная служба: события start и audiostart, затем накопительные результаты.
  class FakeRecognition {
    constructor() { this.timers = []; }
    _later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
    _clear() { this.timers.forEach(clearTimeout); this.timers = []; }
    _begin() {
      if (this.onstart) this.onstart();
      if (this.onaudiostart) this.onaudiostart();
    }
    _say(text) { if (this.onresult) this.onresult({ results: [[{ transcript: text }]] }); }
    _fail(code) {
      if (this.onerror) this.onerror({ error: code });
      if (this.onend) this.onend();
    }
    start() {
      const mode = demo.mode;
      if (mode !== 'normal') setMode('normal'); // сценарий срабатывает один раз

      const st = window.__app && window.__app.state;
      const appending = !!(st && st.pending && st.pending.text);
      const text = appending ? CONTINUATION : SCRIPTS[(st && st.q) || 0] || SCRIPTS[0];
      const words = text.split(' ');

      if (mode === 'noaudio') return;                                          // браузер молчит: ни событий, ни звука
      if (mode === 'denied') { this._later(300, () => this._fail('not-allowed')); return; }
      if (mode === 'network') { this._later(400, () => this._fail('network')); return; }

      this._later(300, () => this._begin());
      if (mode === 'silence') return;                                          // микрофон включён, речи нет
      if (mode === 'short') { this._later(900, () => this._say('да нет')); return; }

      const n = mode === 'partial' ? 5 : words.length;
      words.slice(0, n).forEach((_, i) => {
        this._later(700 + i * 280, () => this._say(words.slice(0, i + 1).join(' ')));
      });
      if (mode === 'partial') this._later(700 + n * 280 + 600, () => this._fail('network'));
    }
    stop() { this._clear(); setTimeout(() => { if (this.onend) this.onend(); }, 300); }
    abort() { this._clear(); if (this.onend) this.onend(); }
  }
  window.SpeechRecognition = FakeRecognition;

  // ---------- Панель ----------
  const MODES = [
    ['normal', 'Обычная'],
    ['silence', 'Тишина'],
    ['short', 'Слишком короткий ответ'],
    ['partial', 'Обрыв посреди ответа'],
    ['network', 'Служба недоступна'],
    ['noaudio', 'Браузер не пишет звук'],
    ['denied', 'Браузер блокирует доступ']
  ];

  let panel;
  const modeButtons = {};
  const toggles = {};

  function el(tag, props, children) {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    (children || []).forEach(c => n.append(c));
    return n;
  }

  function setMode(mode) {
    demo.mode = mode;
    Object.keys(modeButtons).forEach(k => modeButtons[k].setAttribute('aria-pressed', String(k === mode)));
  }

  function toggle(key, label, get, set) {
    const b = el('button', { type: 'button', textContent: label });
    b.dataset.demoToggle = key;
    b.setAttribute('aria-pressed', String(!!get()));
    b.addEventListener('click', () => { set(!get()); b.setAttribute('aria-pressed', String(!!get())); });
    toggles[key] = { b, get };
    return b;
  }

  function build() {
    document.body.classList.add('has-demo');

    const modeRow = el('div', { className: 'demo__row' });
    MODES.forEach(([key, label]) => {
      const b = el('button', { type: 'button', textContent: label });
      b.dataset.demoMode = key;
      b.addEventListener('click', () => setMode(key));
      modeButtons[key] = b;
      modeRow.append(b);
    });

    const otherRow = el('div', { className: 'demo__row' }, [
      toggle('denyMic', 'Микрофон запрещён', () => demo.denyMic, v => { demo.denyMic = v; }),
      toggle('genError', 'Ошибка создания вакансии', () => !!window.__sim.generationError, v => { window.__sim.generationError = v; }),
      toggle('shortLimit', 'Лимит записи 15 с', () => shortLimit, v => {
        try { sessionStorage.setItem(LIMIT_KEY, v ? '1' : '0'); } catch (e) { /* без хранилища */ }
        location.reload();
      })
    ]);

    const reset = el('button', { type: 'button', textContent: 'Сбросить ответы и начать заново' });
    reset.dataset.demoReset = '1';
    reset.addEventListener('click', () => {
      try { localStorage.removeItem(C.DRAFT_KEY); } catch (e) { /* без хранилища */ }
      location.reload();
    });

    const body = el('div', { className: 'demo__body' }, [
      el('p', { className: 'demo__label', textContent: 'Следующая запись (срабатывает один раз)' }), modeRow,
      el('p', { className: 'demo__label', textContent: 'Состояния' }), otherRow,
      el('div', { className: 'demo__row' }, [reset]),
      el('p', { className: 'demo__note', textContent: 'Микрофон имитируется, голос не записывается. В демо тишина фиксируется через 3 с, запас на запуск 2 с.' })
    ]);

    panel = el('details', { className: 'demo-panel' }, [el('summary', { textContent: 'Демо-режим · микрофон имитируется' }), body]);
    document.body.insertBefore(panel, document.getElementById('app'));
    setMode('normal');

    // Ошибка создания вакансии срабатывает один раз, поэтому состояние кнопки обновляем сами.
    setInterval(() => {
      const t = toggles.genError;
      if (t) t.b.setAttribute('aria-pressed', String(!!t.get()));
    }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
