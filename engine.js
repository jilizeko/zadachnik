// Движок artRandom: превращает карточку из конфига в слоты с roll().
// Общий для index.html и editor.html.
(function (global) {
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  const shuffle = a => {
    const c = a.slice();
    for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [c[i], c[j]] = [c[j], c[i]];
    }
    return c;
  };

  const VAR = /\{([^{}]+)\}/g;
  const fields = tpl => [...String(tpl ?? '').matchAll(VAR)].map(m => m[1]);
  const fill = (tpl, get) => String(tpl ?? '').replace(VAR, (_, k) => get(k));
  const complete = (tpl, get) => fields(tpl).every(k => get(k) !== '');
  const splitOptions = s => String(s ?? '').split(/\s*\/\s*/).map(x => x.trim()).filter(Boolean);
  const val = v => (v == null ? '' : String(v).trim());

  // Описание типов слотов: для редактора и для ошибок
  const SLOT_TYPES = {
    pick: { name: 'Значение из таблицы', fields: ['label', 'table', 'text', 'notes', 'cells', 'by'] },
    sample: { name: 'Несколько разных значений', fields: ['label', 'table', 'column', 'count', 'join'] },
    chunk: { name: 'Несколько подряд', fields: ['label', 'table', 'columns', 'size', 'join'] },
    rows: { name: 'Слот на каждую строку', fields: ['table', 'label', 'options', 'count'] },
    options: { name: 'Варианты через /', fields: ['label', 'options'] },
    number: { name: 'Число', fields: ['label', 'min', 'max'] },
  };

  function getTable(cfg, name) {
    const t = (cfg.tables || []).find(t => t.name === name);
    if (!t) throw new Error(name ? `нет таблицы «${name}»` : 'не выбрана таблица');
    return t;
  }

  function col(t, name) {
    const i = t.columns.indexOf(name);
    if (i < 0) throw new Error(`в таблице «${t.name}» нет столбца «${name}»`);
    return i;
  }

  const rowGetter = (t, row, extra = {}) => k => (k in extra ? val(extra[k]) : val(row[col(t, k)]));

  function checkTemplates(t, tpls) {
    tpls.forEach(tpl => fields(tpl).forEach(k => { if (!k.startsWith('$')) col(t, k); }));
  }

  const builders = {
    // Случайная строка (или ячейка из нескольких столбцов) по шаблону.
    // by: cell — все ячейки равновероятны, row — сначала строка, column — сначала столбец.
    pick(cfg, s) {
      const t = getTable(cfg, s.table);
      const cells = (s.cells || []).filter(Boolean);
      cells.forEach(c => col(t, c));
      const text = s.text || (cells.length ? '{$cell}' : `{${t.columns[0]}}`);
      const notes = (s.notes || []).filter(Boolean);
      checkTemplates(t, [text, ...notes]);

      const groups = new Map();
      t.rows.forEach((row, r) => {
        const base = { $row: r + 1 };
        const variants = cells.length
          ? cells.map((c, ci) => ({ ...base, $cell: val(row[col(t, c)]), $col: c, $colIndex: ci + 1 })).filter(x => x.$cell)
          : [base];
        for (const extra of variants) {
          const get = rowGetter(t, row, extra);
          if (!complete(text, get)) continue;
          const key = s.by === 'column' ? extra.$col : s.by === 'row' ? r : 0;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(get);
        }
      });
      if (!groups.size) throw new Error(`в таблице «${t.name}» нет подходящих значений`);
      const list = [...groups.values()];
      return {
        label: s.label || '',
        roll() {
          const get = rnd(rnd(list));
          return { t: fill(text, get), n: notes.filter(n => complete(n, get)).map(n => fill(n, get)) };
        },
      };
    },

    // Несколько разных значений из одного столбца
    sample(cfg, s) {
      const t = getTable(cfg, s.table);
      const i = col(t, s.column || t.columns[0]);
      const vals = t.rows.map(r => val(r[i])).filter(Boolean);
      if (!vals.length) throw new Error(`столбец «${t.columns[i]}» пуст`);
      const n = Math.max(1, Math.min(Number(s.count) || 3, vals.length));
      return { label: s.label || '', roll: () => shuffle(vals).slice(0, n).join(s.join ?? ', ') };
    },

    // Блок из size значений подряд из одного из столбцов
    chunk(cfg, s) {
      const t = getTable(cfg, s.table);
      const size = Math.max(1, Number(s.size) || 4);
      const cols = s.columns && s.columns.length ? s.columns : t.columns;
      const chunks = [];
      for (const c of cols) {
        const i = col(t, c);
        const vals = t.rows.map(r => val(r[i])).filter(Boolean);
        for (let k = 0; k + size <= vals.length; k += size) chunks.push(vals.slice(k, k + size));
      }
      if (!chunks.length) throw new Error(`в таблице «${t.name}» нет ${size} значений подряд`);
      return { label: s.label || '', roll: () => rnd(chunks).join(s.join ?? ' · ') };
    },

    // Слот на каждую строку (или на count случайных строк), значение — один из вариантов через /
    rows(cfg, s) {
      const t = getTable(cfg, s.table);
      const labelTpl = s.label || `{${t.columns[0]}}`;
      const optTpl = s.options || labelTpl;
      checkTemplates(t, [labelTpl, optTpl]);
      const list = t.rows.map(row => {
        const get = rowGetter(t, row);
        let label = fill(labelTpl, get);
        let opts = splitOptions(fill(optTpl, get));
        if (opts.length === 1) {
          if (labelTpl === optTpl) label = opts[0];
          opts = ['да', 'нет'];
        }
        return { label, opts };
      }).filter(x => x.label && x.opts.length);
      if (!list.length) throw new Error(`в таблице «${t.name}» нет строк с вариантами`);
      const n = Number(s.count) > 0 ? Math.min(Number(s.count), list.length) : list.length;
      const chosen = n < list.length ? shuffle(list).slice(0, n) : list;
      return chosen.map(x => ({ label: x.label, roll: () => rnd(x.opts) }));
    },

    options(cfg, s) {
      const opts = splitOptions(s.options);
      if (!opts.length) throw new Error('нет вариантов');
      return { label: s.label || '', roll: () => rnd(opts) };
    },

    number(cfg, s) {
      const a = Math.round(Number(s.min) || 0), b = Math.round(Number(s.max) || 0);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      return { label: s.label || '', roll: () => String(lo + Math.floor(Math.random() * (hi - lo + 1))) };
    },
  };

  function buildCard(cfg, card) {
    return (card.slots || []).flatMap(s => {
      try {
        const build = builders[s.type];
        if (!build) throw new Error(`неизвестный тип слота «${s.type}»`);
        return build(cfg, s);
      } catch (e) {
        const msg = e.message;
        return [{ label: s.label || SLOT_TYPES[s.type]?.name || 'слот', error: msg, roll: () => ({ t: msg, error: true }) }];
      }
    });
  }

  function rollSlot(slot) {
    const r = slot.roll();
    const o = typeof r === 'string' ? { t: r } : r;
    return { t: o.t, n: [].concat(o.n || []).filter(Boolean), error: !!o.error };
  }

  // Конфиг в config.js: строки таблиц по одной на строку файла, чтобы его было удобно читать и диффать
  function pretty(v, ind) {
    const next = ind + '  ';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      if (v.every(x => x === null || typeof x !== 'object')) return JSON.stringify(v).replace(/","/g, '", "');
      return '[\n' + v.map(x => next + pretty(x, next)).join(',\n') + '\n' + ind + ']';
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v).filter(k => v[k] !== undefined);
      if (!keys.length) return '{}';
      const flat = keys.every(k => v[k] === null || typeof v[k] !== 'object' || (Array.isArray(v[k]) && v[k].every(x => typeof x !== 'object')));
      const inline = '{ ' + keys.map(k => JSON.stringify(k) + ': ' + pretty(v[k], next)).join(', ') + ' }';
      if (flat && inline.length + ind.length <= 110) return inline;
      return '{\n' + keys.map(k => next + JSON.stringify(k) + ': ' + pretty(v[k], next)).join(',\n') + '\n' + ind + '}';
    }
    return JSON.stringify(v);
  }

  function serialize(cfg) {
    return '// artRandom: таблицы, карточки и наборы. Удобнее править через editor.html\n'
      + 'window.ARTRANDOM_CONFIG = ' + pretty(cfg, '') + ';\n';
  }

  global.ArtEngine = { buildCard, rollSlot, serialize, fields, splitOptions, SLOT_TYPES };
})(typeof window !== 'undefined' ? window : globalThis);
