// Чтение исходной Google-таблицы «как есть»: xlsx-выгрузка → листы → таблицы конфига.
// Таблица должна быть открыта по ссылке на просмотр. Карточки и наборы остаются в config.js,
// таблицы config.js служат запасной копией, если таблица или лист недоступны.
(function (global) {
  // ---------- xlsx: zip + XML, без библиотек ----------
  async function unzip(buf) {
    const dv = new DataView(buf);
    let eocd = buf.byteLength - 22;
    while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('это не xlsx');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const files = {};
    const utf8 = new TextDecoder();
    for (let i = 0; i < count; i++) {
      const nameLen = dv.getUint16(off + 28, true);
      const name = utf8.decode(new Uint8Array(buf, off + 46, nameLen));
      files[name] = { method: dv.getUint16(off + 10, true), size: dv.getUint32(off + 20, true), local: dv.getUint32(off + 42, true) };
      off += 46 + nameLen + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
    }
    return async name => {
      const f = files[name];
      if (!f) return null;
      const start = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
      const data = new Uint8Array(buf, start, f.size);
      if (f.method === 0) return utf8.decode(data);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return utf8.decode(await new Response(stream).arrayBuffer());
    };
  }

  const xml = text => new DOMParser().parseFromString(text, 'application/xml');
  const tags = (node, name) => [...node.getElementsByTagName(name)];

  function colIndex(ref) {
    let n = 0;
    for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
  }

  const fmtNumber = s => {
    const x = Number(s);
    if (!Number.isFinite(x)) return s;
    return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100);
  };

  // Переносы строк внутри ячеек: «первооткры-\nватели» склеиваем, настоящий дефис оставляем
  const KEEP_HYPHEN = ['вредители', 'self'];
  function clean(s) {
    return String(s)
      .replace(/([\p{L}\p{N}]+)-\s*\n\s*/gu, (_, w) => w + (KEEP_HYPHEN.includes(w) ? '-' : ''))
      .replace(/\/\s*\n\s*/g, '/')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function readWorkbook(buf) {
    const read = await unzip(buf);
    const wb = xml(await read('xl/workbook.xml'));
    const target = {};
    for (const r of tags(xml(await read('xl/_rels/workbook.xml.rels')), 'Relationship')) target[r.getAttribute('Id')] = r.getAttribute('Target');
    const ss = await read('xl/sharedStrings.xml');
    const shared = ss ? tags(xml(ss), 'si').map(si => tags(si, 't').map(t => t.textContent).join('')) : [];

    const sheets = {};
    for (const s of tags(wb, 'sheet')) {
      const t = target[s.getAttribute('r:id')] || '';
      const doc = xml(await read(t.startsWith('/') ? t.slice(1) : 'xl/' + t) || '<x/>');
      const rows = [];
      for (const row of tags(doc, 'row')) {
        const arr = [];
        let next = 0;
        for (const c of tags(row, 'c')) {
          const ref = c.getAttribute('r');
          const ci = ref ? colIndex(ref) : next;
          next = ci + 1;
          const type = c.getAttribute('t');
          const v = tags(c, 'v')[0]?.textContent ?? '';
          let val;
          if (type === 's') val = shared[+v] ?? '';
          else if (type === 'inlineStr') val = tags(c, 't').map(x => x.textContent).join('');
          else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'str' || type === 'e') val = v;
          else val = v === '' ? '' : fmtNumber(v);
          arr[ci] = clean(val);
        }
        const dense = Array.from(arr, x => x ?? '');
        while (dense.length && !dense[dense.length - 1]) dense.pop();
        rows[Number(row.getAttribute('r') || rows.length + 1) - 1] = dense;
      }
      sheets[s.getAttribute('name')] = Array.from(rows, x => x ?? []);
    }
    return sheets;
  }

  // ---------- листы → таблицы ----------
  const col = (rows, i, from = 0) => rows.slice(from).map(r => r[i] || '');
  const nonEmpty = a => a.filter(Boolean);
  const unique = a => [...new Set(a)];
  const isNum = s => s !== '' && !isNaN(Number(s));
  const numbered = n => Array.from({ length: n }, (_, i) => String(i + 1));
  const maxLen = rows => Math.max(0, ...rows.map(r => r.length));
  const ragged = (...lists) => Array.from({ length: Math.max(...lists.map(l => l.length)) }, (_, i) => lists.map(l => l[i] || ''));
  const table = (name, columns, rows) => ({
    name, columns,
    rows: rows.map(r => columns.map((_, i) => r[i] || '')).filter(r => r.some(Boolean)),
  });
  // Заголовок — первая строка; строки из одних чисел (счётчики под заголовком) пропускаем
  function headed(name, rows, fixed) {
    const head = rows[0] || [];
    const n = fixed ? fixed.length : head.reduce((m, h, i) => (h ? i + 1 : m), 0);
    const columns = fixed || Array.from({ length: n }, (_, i) => head[i] || `столбец ${i + 1}`);
    return table(name, columns, rows.slice(1).filter(r => !r.slice(0, n).every(x => x === '' || isNum(x))));
  }
  // Подтемы идут подряд справа от темы: столбцы 1..N
  function topics(name, rows, topicCol, firstSub, topicName) {
    const data = rows.slice(1).filter(r => r[topicCol]);
    const n = Math.max(0, ...data.map(r => r.length - firstSub));
    return table(name, [topicName, ...numbered(n)], data.map(r => [r[topicCol], ...r.slice(firstSub)]));
  }

  const ADAPTERS = {
    'ключи': rows => topics('ключи', rows, 0, 2, 'тема'),
    'keys': rows => topics('keys', rows, 1, 2, 'topic'),
    'персонаж': rows => headed('персонаж', rows),
    'глаголы': rows => headed('глаголы', rows),
    'verbs': rows => table('verbs', ['alone', 'pair', 'group', 'interactions'], rows.slice(1)),
    'Plutchik': rows => table('Plutchik', ['группа', 'внутри', 'во взаимодействии', 'inside', 'interaction'], rows.slice(1).filter(r => r[0])),
    'синестезия': rows => table('синестезия', ['ощущение', 'лучшее', 'как показать (лучшее)', 'худшее', 'как показать (худшее)'], rows.slice(1).filter(r => r[0])),
    'циклы': rows => table('циклы', ['название', 'размер', 'элементы'], rows.slice(1).filter(r => r[0])),
    '12': rows => table('12', ['слово'], unique(nonEmpty(col(rows, 0))).map(w => [w])),
    'спонтанное письмо': rows => table('спонтанное письмо', ['зачин'], nonEmpty(col(rows, 0)).map(x => [x])),
    'смешно': rows => table('смешно', ['формула'], nonEmpty(col(rows, 0)).map(x => [x])),
    'cognitive biases': rows => table('cognitive biases', ['bias', 'meaning'], rows.filter(r => r[0])),
    'голос': rows => table('голос', ['кто', 'жанр'], ragged(nonEmpty(col(rows, 0)), nonEmpty(col(rows, 2)))),
    'тропы': rows => [
      table('тропы', ['троп'], nonEmpty(col(rows, 0)).map(x => [x])),
      table('tropes', ['trope'], nonEmpty(col(rows, 1)).map(x => [x])),
    ],
    'буриме': rows => table('буриме', ['A', 'B'], rows.map(r => r.slice(0, 2).map(x => (/^https?:/.test(x) ? '' : x)))),

    // в начале / в конце; после пустой строки — вопросы, они идут в подсказку карточки
    'свойства': rows => {
      const end = rows.findIndex((r, i) => i > 0 && !r.some(Boolean));
      const data = rows.slice(1, end < 0 ? undefined : end);
      const questions = end < 0 ? [] : rows.slice(end).flatMap(nonEmpty);
      return { tables: [table('свойства', ['в начале', 'в конце'], data)], hints: questions.length ? { arc: questions.join('\n') } : {} };
    },

    // объекты — первая строка, состояния — первый столбец; строку «своё, см. …» пропускаем
    'чайник': rows => table('чайник', ['объект', 'состояние'],
      ragged(nonEmpty((rows[0] || []).slice(1)), nonEmpty(col(rows, 0, 1)).filter(s => !/^сво[её][,\s]/i.test(s)))),

    // «язык 1, язык 2, гибрид» → варианты через /
    'чеклист': rows => table('чеклист', ['ось'], nonEmpty(col(rows, 0)).map(s => [s.includes('/') ? s : s.replace(/\s*,\s*/g, ' / ')])),

    // на листе — параметр и одно значение-пример; варианты берём из запасной копии,
    // а если автор впишет варианты через «/», используются они
    'пространство': (rows, fallback) => {
      const known = Object.fromEntries((fallback('пространство')?.rows || []).map(r => [r[0], r[1]]));
      return table('пространство', ['параметр', 'варианты', 'пример из таблицы'], rows.filter(r => r[0]).map(([p, v = '']) => {
        if (p === 'константа') return [p, '', v];
        const opts = v.includes('/') ? v.split(/\s*\/\s*/) : unique([...(known[p] || '').split(/\s*\/\s*/), v]);
        return [p, nonEmpty(opts).join(' / '), v];
      }));
    },

    // строки — параметры, столбцы — каноны; разворачиваем: строка = канон
    'пропорции': rows => {
      const params = rows.filter(r => r[0]);
      const names = params.map(r => r[0]);
      const n = Math.max(0, ...params.map(r => r.length - 1));
      const height = names.indexOf('рост');
      return table('пропорции', ['канон', ...names], Array.from({ length: n }, (_, i) => [
        height >= 0 && params[height][i + 1] ? `рост ${params[height][i + 1]}` : `вариант ${i + 1}`,
        ...params.map(r => r[i + 1] || ''),
      ]));
    },

    // группа записана только в первой строке своего блока
    'когнитивные искажения': rows => {
      let group = '';
      return table('когнитивные искажения', ['группа', 'название', 'описание'], rows.slice(1).map(r => {
        if (r[0]) group = r[0];
        return r[1] ? [group, r[1], r[2] || ''] : [];
      }));
    },
  };

  function parseTitle(disposition) {
    const m = /filename\*=UTF-8''([^;]+)/i.exec(disposition || '') || /filename="([^"]+)"/i.exec(disposition || '');
    const name = m ? decodeURIComponent(m[1]).replace(/\.xlsx$/i, '').trim() : '';
    return name || null;
  }

  // Возвращает { cfg, title, notices }; при сбое загрузки бросает ошибку — вызывающий берёт config.js как есть
  async function load(baseCfg, { timeout = 20000 } = {}) {
    const id = baseCfg.source?.spreadsheet;
    if (!id) throw new Error('в config.js не указана таблица (source.spreadsheet)');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, { cache: 'no-store', signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error(`Google ответил ${res.status}`);
    const title = parseTitle(res.headers.get('Content-Disposition'));
    const sheets = await readWorkbook(await res.arrayBuffer());

    const fallback = name => baseCfg.tables.find(t => t.name === name);
    const fresh = {}, hints = {}, notices = [];
    for (const [sheet, adapt] of Object.entries(ADAPTERS)) {
      if (!sheets[sheet]) { notices.push(`нет листа «${sheet}»`); continue; }
      try {
        const out = adapt(sheets[sheet], fallback);
        const list = Array.isArray(out) ? out : out.tables || [out];
        for (const t of list) fresh[t.name] = t;
        Object.assign(hints, out.hints || {});
      } catch (e) {
        notices.push(`лист «${sheet}» не разобрался: ${e.message}`);
      }
    }
    const cfg = {
      ...baseCfg,
      tables: baseCfg.tables.map(t => fresh[t.name] || t),
      cards: baseCfg.cards.map(c => (hints[c.id] ? { ...c, hint: hints[c.id] } : c)),
    };
    return { cfg, title, notices, sheets };
  }

  global.ArtSheet = { load, readWorkbook, ADAPTERS };
})(typeof window !== 'undefined' ? window : globalThis);
