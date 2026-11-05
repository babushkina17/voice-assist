// Точка замены генерации описания.
// Контракт: generateVacancy(answers: string[4]) -> Promise<{ sections: Section[] }>
//   Section = { heading: string, items?: string[], text?: string }
// Сейчас это шаблон на правилах: без сети, детерминированный.
// Чтобы подключить модель, заменить тело функции на вызов серверной прослойки,
// сохранив форму результата. Ошибка = reject, интерфейс покажет S2-error.
window.generateVacancy = async function generateVacancy(answers) {
  const C = window.APP_CONFIG;
  const H = window.TEXTS.vacancy.headings;

  await new Promise(r => setTimeout(r, C.GENERATION_DELAY_MS));

  if (window.__sim && window.__sim.generationError) {
    window.__sim.generationError = false;
    throw new Error('simulated generation error');
  }

  const clean = s => s.trim().replace(/\s+/g, ' ');
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const stripEnd = s => s.replace(/[.\s]+$/, '');
  const sentence = s => {
    const t = cap(clean(s));
    return /[.!?…]$/.test(t) ? t : t + '.';
  };
  const wordCount = s => s.split(/\s+/).filter(Boolean).length;

  // Список только если ответ явно перечисляет: 2+ коротких пункта через запятую, точку с запятой или перенос.
  const asList = s => {
    const parts = s.split(/[;,\n]+/).map(p => cap(stripEnd(clean(p)))).filter(Boolean);
    return parts.length >= 2 && parts.every(p => wordCount(p) <= 10) ? parts : null;
  };

  const listable = new Set([0, 3]);
  const sections = answers.map((a, i) => {
    const items = listable.has(i) ? asList(a) : null;
    return items
      ? { heading: H[i], items }
      : { heading: H[i], text: sentence(a) };
  });

  return { sections };
};
