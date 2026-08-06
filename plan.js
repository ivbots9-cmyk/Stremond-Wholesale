/*
 * Движок плана смены. Чистые функции без DOM, сети и глобального
 * состояния — поэтому одинаково работают в браузере (планшет на складе)
 * и в node (warehouse/test.js).
 *
 * Три вещи, вокруг которых построено всё остальное.
 *
 * 1. Время блока считается ДВУМЯ способами, способ выбирается для
 *    каждого блока:
 *      'time'   — «переборка два с половиной часа». Длительность задана
 *                 руками, количество не важно: сколько успели, столько
 *                 успели. Обратная величина — выработка, её показываем.
 *      'volume' — «180 пакетов». Длительность = количество × норма.
 *
 * 2. Норма зависит не от операции, а от товара и фасовки: Starburst
 *    перебирается вчетверо быстрее Jolly, 5 lb фасуется дольше 2 lb.
 *    Поэтому норма ищется от частного к общему и может иметь свою
 *    единицу измерения — коробки для одного товара, пакеты для другого.
 *
 * 3. Задание на день («что нужно сделать») отделено от плана («кто это
 *    делает»). Задание пишется одной строкой, а autoAssign() раскидывает
 *    его по людям с учётом смен, навыков и того, что дольше трёх часов
 *    подряд на сидячей переборке никто не сидит.
 *
 * Всё время внутри — минуты от полуночи (целые числа). Строки '09:30'
 * появляются только на границе: hhmm() на входе, fmt() на выходе.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WHPlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================================================
     Справочники
     ============================================================ */

  /* Порядок как в календаре, а не как в Date.getDay() (там неделя
     начинается с воскресенья). index — то, что вернёт getDay(). */
  /*
   * title/short — запасной вариант на случай, если движок работает без
   * интерфейса (тесты, Node). Экран берёт названия по key из словаря
   * переводов, а не отсюда.
   */
  var WEEKDAYS = [
    { key: 'mon', index: 1, title: 'Monday', short: 'Mon' },
    { key: 'tue', index: 2, title: 'Tuesday', short: 'Tue' },
    { key: 'wed', index: 3, title: 'Wednesday', short: 'Wed' },
    { key: 'thu', index: 4, title: 'Thursday', short: 'Thu' },
    { key: 'fri', index: 5, title: 'Friday', short: 'Fri' },
    { key: 'sat', index: 6, title: 'Saturday', short: 'Sat' },
    { key: 'sun', index: 0, title: 'Sunday', short: 'Sun' }
  ];

  /*
   * Куда уходит партия. priority здесь — то, чем жертвуют первым, когда
   * людей не хватает: Amazon и розничные заказы режут последними,
   * Walmart — первым.
   */
  /*
   * carrier — то, чем партия реально уезжает. На складе оперируют
   * перевозчиком, а не площадкой: «это на UPS» понятнее, чем «это на
   * Amazon», потому что коробку клеят и ставят по перевозчику.
   * Площадку оставляем — по ней считается приоритет.
   */
  var DESTINATIONS = [
    { key: '', title: '—', priority: 2, carrier: '' },
    { key: 'amazon', title: 'Amazon', priority: 1, carrier: 'UPS' },
    { key: 'orders', title: 'Orders (FBM)', priority: 1, carrier: 'USPS' },
    { key: 'tiktok', title: 'TikTok', priority: 2, carrier: 'FedEx' },
    { key: 'walmart', title: 'Walmart', priority: 3, carrier: 'FedEx' },
    { key: 'bulk', title: 'To bulk', priority: 3, carrier: '' }
  ];

  /* Перевозчик партии. Задать можно и вручную — если разово уходит не
     тем, чем обычно, это важнее умолчания по площадке. */
  function carrierOf(config, block) {
    if (block && block.carrier) return block.carrier;
    var d = destOf(block && block.dest);
    return (d && d.carrier) || '';
  }

  var PRIORITIES = [
    { value: 1, title: 'Critical', hint: 'must ship today' },
    { value: 2, title: 'Important', hint: 'planned for today' },
    { value: 3, title: 'If time allows', hint: 'can be moved' }
  ];

  var STATUSES = ['planned', 'active', 'done'];

  /* ============================================================
     Время
     ============================================================ */

  function hhmm(s) {
    if (typeof s === 'number') return s;
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return 0;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function fmt(min) {
    var v = Math.max(0, Math.round(min));
    var h = Math.floor(v / 60) % 24;
    return pad(h) + ':' + pad(v % 60);
  }

  /*
   * Форматирование времени и дат зависит от языка, но движок не должен
   * знать про словарь: он считает и в Node, где интерфейса нет. Поэтому
   * язык подставляется снаружи через setFormat, а по умолчанию тут
   * английский.
   */
  var format = {
    min:     function (n) { return n + ' min'; },
    hour:    function (n) { return n + ' h'; },
    hourMin: function (h, m) { return h + ' h ' + m + ' min'; },
    date:    function (day, monthIndex) { return MONTHS_EN[monthIndex - 1] + ' ' + day; }
  };

  var MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function setFormat(next) {
    format = Object.assign({}, format, next || {});
  }

  /* «2 ч 30 мин» — на планшете читается быстрее, чем «150 мин». */
  function human(min) {
    var v = Math.max(0, Math.round(min));
    var h = Math.floor(v / 60);
    var m = v % 60;
    if (!h) return format.min(m);
    if (!m) return format.hour(h);
    return format.hourMin(h, m);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /*
   * Склонение единиц: «10 коробок», а не «10 коробка». Таблица только
   * на те единицы, что мы правда используем; для чего угодно, что
   * заведут в настройках руками, возвращаем как есть — лучше
   * несклонённое слово, чем угаданное неверно.
   */
  /*
   * Английские формы попадают в ту же таблицу: правило ниже даёт для них
   * верный результат само собой — 1 берёт первую форму, всё остальное
   * вторую или третью, а они у английского совпадают.
   */
  var PLURALS = {
    'коробка': ['коробка', 'коробки', 'коробок'],
    'пакет': ['пакет', 'пакета', 'пакетов'],
    'заказ': ['заказ', 'заказа', 'заказов'],
    'бин': ['бин', 'бина', 'бинов'],
    'паллета': ['паллета', 'паллеты', 'паллет'],
    'шт': ['шт', 'шт', 'шт'],

    'box': ['box', 'boxes', 'boxes'],
    'bag': ['bag', 'bags', 'bags'],
    'order': ['order', 'orders', 'orders'],
    'bin': ['bin', 'bins', 'bins'],
    'pallet': ['pallet', 'pallets', 'pallets'],
    'pcs': ['pcs', 'pcs', 'pcs']
  };

  function plural(n, unit) {
    var forms = PLURALS[unit];
    if (!forms) return unit;
    /* Дробное число требует родительного падежа единственного числа:
       «10,5 коробки». */
    if (Math.round(n) !== n) return forms[1];
    var abs = Math.abs(n) % 100;
    var last = abs % 10;
    if (abs > 10 && abs < 20) return forms[2];
    if (last > 1 && last < 5) return forms[1];
    if (last === 1) return forms[0];
    return forms[2];
  }

  function todayISO(d) {
    var t = d ? new Date(d) : new Date();
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  }

  function shiftISO(iso, days) {
    var p = String(iso).split('-');
    var t = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    t.setDate(t.getDate() + days);
    return todayISO(t);
  }

  function weekdayOf(iso) {
    var p = String(iso).split('-');
    var idx = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay();
    for (var i = 0; i < WEEKDAYS.length; i++) {
      if (WEEKDAYS[i].index === idx) return WEEKDAYS[i];
    }
    return WEEKDAYS[0];
  }

  function humanDate(iso) {
    var p = String(iso).split('-');
    return format.date(Number(p[2]), Number(p[1]));
  }

  /* ============================================================
     Идентификаторы
     ============================================================ */

  var seq = 0;
  function uid(prefix) {
    seq++;
    return (prefix || 'b') + '_' + Date.now().toString(36) + seq.toString(36) +
      Math.floor(Math.random() * 1296).toString(36);
  }

  /* ============================================================
     Настройки по умолчанию
     ============================================================ */

  /*
   * Смены восстановлены по выгрузке Clockify за июнь и сходятся с ней:
   * Крис 09:30–16:50 минус 30 минут перерывов = 6 ч 50 мин, ровно его
   * среднее по факту; Ева 10:00–16:50 = 6 ч 20 мин, тоже её среднее.
   *
   * ⚠ Подтверждённые нормы: переборка Starburst 4 коробки в час,
   * переборка Jolly 10,5 пакетов в час, паллета 28 коробок (7 × 4),
   * фасовки и размеры коробок — из таблицы склада. Нормы фасовки,
   * силинга, укладки и заказов помечены ниже как «уточнить»: их
   * нужно замерить. Правятся на вкладке «Нормы времени».
   */
  function defaultConfig() {
    return {
      version: 3,
      title: 'Warehouse plan',

      /* Общая смена — запасной вариант для тех, у кого не задана своя. */
      shift: {
        start: '09:30',
        end: '16:50',
        /*
         * Перерыв не отменяет задачу, а сдвигает её конец. staffIds
         * пустой = перерыв общий; иначе перерыв только у перечисленных.
         * Разное время обеда — не прихоть, а способ не оставлять склад
         * пустым: одни уходят в 13:30, другие в 14:00.
         */
        breaks: [
          { title: 'Short break', start: '11:50', duration: 10, staffIds: [] },
          { title: 'Lunch', start: '13:30', duration: 20, staffIds: ['kris', 'aisulu'] },
          { title: 'Lunch', start: '14:00', duration: 20, staffIds: ['eva', 'toni'] }
        ]
      },

      staff: [
        { id: 'kris', name: 'Chris', color: '#c2410c', status: 'active', skills: [], shift: { start: '09:30', end: '16:50' } },
        { id: 'aisulu', name: 'Aisulu', color: '#7c3aed', status: 'vacation', skills: [], shift: { start: '09:30', end: '16:50' } },
        { id: 'eva', name: 'Eva', color: '#0f9d76', status: 'active', skills: [], shift: { start: '10:00', end: '16:50' } },
        { id: 'toni', name: 'Toni', color: '#2f6fed', status: 'active', skills: [], shift: { start: '10:00', end: '16:50' } }
      ],

      /*
       * Товары. Две разные «коробки», которые легко перепутать:
       *   inbound — коробка от производителя, её перебирают
       *             (Starburst 6 × 50 oz, Jolly 8 × 5 lb);
       *   packs   — наша коробка на отгрузку, в ней bagsPerBox пакетов
       *             готового товара.
       * bagsPerBox: null означает «в таблице склада пусто» — такие
       * места видно в интерфейсе, их нужно дозаполнить.
       */
      products: [
        prod('starburst', 'Starburst', {
          inbound: { perBox: 6, unitSize: '50 oz' },
          sortable: true,
          colors: ['Red', 'Pink', 'Orange', 'Yellow'],
          packs: [pack('1lb', '1 lb', 36, '18×12×10')]
        }),
        prod('jolly', 'Jolly Rancher', {
          inbound: { perBox: 8, unitSize: '5 lb' },
          sortable: true,
          colors: ['Watermelon', 'Green Apple', 'Blue Raspberry', 'Grape', 'Cherry'],
          packs: [
            pack('1lb', '1 lb', 36, '18×12×12'),
            pack('2lb', '2 lb', 21, '18×12×12'),
            pack('5lb', '5 lb', null, '')
          ]
        }),
        prod('jolly_grape', 'Jolly Rancher Grape (clear bag)', {
          packs: [pack('2lb', '2 lb', 21, '18×12×10')]
        }),
        prod('frooties', 'Tootsie Frooties Mix', {
          packs: [
            pack('1lb', '1 lb', 33, '18×12×12'),
            pack('2lb', '2 lb', 18, '18×12×12'),
            pack('5lb', '5 lb', null, '')
          ]
        }),
        prod('tootsie_pops', 'Tootsie Pops', {
          packs: [pack('2lb', '2 lb', 17, '18×12×12')]
        }),
        prod('tootsie_chews', 'Tootsie Fruit Chews / Sour', {
          packs: [pack('2lb', '2 lb', null, '20×12×12')]   // в таблице цифра зачёркнута
        }),
        prod('tootsie_twists', 'Tootsie Roll Twists', {
          packs: [
            pack('1lb', '1 lb', 36, '18×12×12'),
            pack('2lb', '2 lb', 20, '18×12×12'),
            pack('3lb', '3 lb', null, '20×12×12')          // в таблице пусто
          ]
        }),
        prod('tootsie_long', 'Tootsie Long', {
          packs: [pack('3lb', '3 lb', null, ''), pack('5lb', '5 lb', null, '')]
        }),
        prod('dumdums', 'Dum Dums Pops', {
          packs: [
            pack('1lb', '1 lb', 24, '20×12×12'),
            pack('2lb', '2 lb', 24, '20×12×12')
          ]
        }),
        prod('hot_tamales', 'Hot Tamales', {
          packs: [
            pack('10oz3', '10 oz × 3', 20, '18×12×10'),
            pack('1lb', '1 lb', 36, '18×12×8'),
            pack('2lb', '2 lb', 22, '18×12×8')
          ]
        }),
        prod('mike_ike', 'Mike n Ike', {
          packs: [pack('2lb', '2 lb', 21, '18×12×8')]
        }),
        prod('smarties', 'Smarties Candy Rolls', {
          packs: [pack('2lb', '2 lb', 16, '18×12×12')]
        }),
        prod('top_pops', 'Top Pops Asst 48 ct', {
          packs: [pack('48ct', '48 ct', 24, '17×15×9')]
        }),
        prod('fd_skittles', 'Freeze Dried Skittles', {
          packs: [pack('8oz', '8 oz', 36, '18×12×12')]
        }),
        prod('fd_airheads', 'Freeze Dried Air Heads', {
          packs: [pack('6oz', '6 oz', 30, '18×12×12')]
        }),
        prod('good_plenty', 'Good & Plenty', {
          packs: [pack('1lb', '1 lb', 38, '18×12×8')]
        }),
        prod('bit_o_honey', 'Bit O Honey', {
          packs: [pack('3lb', '3 lb', null, ''), pack('5lb', '5 lb', null, '')]
        }),
        prod('albanese', 'Albanese Gummies', {
          packs: [pack('5lb', '5 lb', null, '')]
        }),
        prod('root_beer', 'Root Beers', {
          packs: [pack('1lb', '1 lb', null, ''), pack('2lb', '2 lb', null, '')]
        })
      ],

      /*
       * Операции в том порядке, в каком товар через них проходит.
       * sitting: работа сидя — по ней действует ограничение на то,
       * сколько можно просидеть подряд.
       */
      tasks: [
        {
          id: 'sort', title: 'Colour sorting', mode: 'time', unit: 'box', sortOnly: true,
          minPerUnit: 15, priority: 1, color: '#f59e0b', sitting: true,
          byProduct: {
            /* подтверждено: 4 коробки в час */
            starburst: { min: 15, unit: 'box' },
            /* подтверждено: 10–11 пакетов в час, берём 10,5 */
            jolly: { min: 5.7, unit: 'bag' }
          }
        },
        {
          id: 'pack', title: 'Weighing / bagging', mode: 'volume', unit: 'bag',
          minPerUnit: 1, priority: 1, color: '#16a34a',
          byProduct: {}   // уточнить: минут на пакет по фасовкам
        },
        {
          id: 'seal', title: 'Sealing', mode: 'volume', unit: 'bag',
          minPerUnit: 0.5, priority: 1, color: '#0ea5e9',
          byProduct: {}   // уточнить
        },
        {
          id: 'box', title: 'Boxing', mode: 'volume', unit: 'box',
          minPerUnit: 5, priority: 2, color: '#0d9488', byProduct: {}   // уточнить
        },
        {
          id: 'pallet', title: 'Pallet building', mode: 'volume', unit: 'box',
          minPerUnit: 2, priority: 2, color: '#0f766e', byProduct: {}   // уточнить
        },
        {
          id: 'orders', title: 'Order picking', mode: 'volume', unit: 'order',
          minPerUnit: 2, priority: 1, color: '#e11d48', byProduct: {}   // уточнить
        },
        {
          id: 'ship', title: 'Shipping', mode: 'time', unit: 'box',
          minPerUnit: 2, priority: 1, color: '#334155', byProduct: {}
        },
        {
          id: 'clean', title: 'Warehouse tidy-up', mode: 'time', unit: '',
          minPerUnit: 0, priority: 3, color: '#64748b', byProduct: {}
        }
      ],

      /* Паллета на Amazon: 7 коробок на уровень, 4 уровня. */
      pallet: { boxesPerLevel: 7, levels: 4 },

      rules: {
        /* Дольше этого никто не сидит подряд на переборке — после
           этого система ставит другую работу. Ограничение помечено
           флагом sitting и сейчас стоит только на переборке: именно
           она сидячая и выматывающая. */
        maxSittingStreak: 180,
        /* Свободное время в конце смены заполняем переборкой: если
           заданий больше нет, готовят балк на завтра. */
        fillTask: 'sort'
      },

      /*
       * Шаблон недели. Это только «скелет дня»; что именно фасовать,
       * приезжает из задания на день.
       */
      templates: {
        mon: [
          tpl('kris', 'orders', 'volume', { dest: 'orders' }),
          tpl('eva', 'orders', 'volume', { dest: 'orders' }),
          tpl('kris', 'sort', 'time', { productId: 'starburst', duration: 60, dest: 'bulk' })
        ],
        tue: [
          tpl('kris', 'sort', 'time', { productId: 'starburst', duration: 150, dest: 'bulk' }),
          tpl('eva', 'sort', 'time', { productId: 'jolly', duration: 150, dest: 'bulk' }),
          tpl('toni', 'pack', 'volume', { productId: 'frooties', packSize: '2lb', dest: 'tiktok' }),
          tpl('kris', 'seal', 'volume', { productId: 'frooties', packSize: '2lb', dest: 'tiktok' }),
          tpl('eva', 'box', 'volume', { productId: 'frooties', packSize: '2lb', dest: 'tiktok' })
        ],
        wed: [
          tpl('kris', 'sort', 'time', { productId: 'starburst', duration: 150, dest: 'bulk' }),
          tpl('eva', 'sort', 'time', { productId: 'jolly', duration: 150, dest: 'bulk' }),
          tpl('toni', 'pack', 'volume', { productId: 'jolly', packSize: '2lb', dest: 'amazon' }),
          tpl('kris', 'seal', 'volume', { productId: 'jolly', packSize: '2lb', dest: 'amazon' }),
          tpl('eva', 'box', 'volume', { productId: 'jolly', packSize: '2lb', dest: 'amazon' })
        ],
        thu: [
          tpl('kris', 'sort', 'time', { productId: 'starburst', duration: 150, dest: 'bulk' }),
          tpl('eva', 'sort', 'time', { productId: 'jolly', duration: 150, dest: 'bulk' }),
          tpl('toni', 'pack', 'volume', { productId: 'starburst', packSize: '1lb', dest: 'amazon' }),
          tpl('kris', 'seal', 'volume', { productId: 'starburst', packSize: '1lb', dest: 'amazon' }),
          tpl('eva', 'pallet', 'volume', { dest: 'amazon' })
        ],
        fri: [
          tpl('kris', 'orders', 'volume', { dest: 'orders' }),
          tpl('eva', 'pack', 'volume', { productId: 'frooties', packSize: '2lb', dest: 'tiktok' }),
          tpl('toni', 'seal', 'volume', { productId: 'frooties', packSize: '2lb', dest: 'tiktok' }),
          tpl('kris', 'pallet', 'volume', { dest: 'amazon' }),
          tpl('eva', 'ship', 'time', { duration: 60, dest: 'amazon' })
        ],
        sat: [],
        sun: []
      }
    };
  }

  function prod(id, title, extra) {
    var p = {
      id: id, title: title, colors: [], sortable: false,
      inbound: null, packs: []
    };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) p[k] = extra[k];
    return p;
  }

  function pack(id, title, bagsPerBox, box) {
    return { id: id, title: title, bagsPerBox: bagsPerBox, box: box || '' };
  }

  function tpl(staffId, taskId, mode, extra) {
    var b = {
      id: uid('t'),
      staffId: staffId,
      taskId: taskId,
      mode: mode,
      duration: 60,
      share: 1,
      productId: '',
      packSize: null,
      variant: '',
      dest: '',
      note: '',
      pinnedStart: null
    };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) b[k] = extra[k];
    return b;
  }

  /* ============================================================
     День
     ============================================================ */

  /*
   * Пустой день. blocks === null отличает «день не открывали» от
   * «день намеренно очистили» ([]).
   *
   * jobs — задание на день: что нужно сделать, без привязки к людям.
   * Его пишут накануне, а autoAssign() превращает в blocks.
   */
  function emptyDay(date) {
    return {
      date: date,
      blocks: null,
      jobs: [],
      absent: [],
      /*
       * Кто отметился на смене. Ключ — id сотрудника, значение —
       * { in, out } с моментами нажатия в ISO. Отдельно от absent:
       * absent — решение менеджера, attendance — факт с планшета, и
       * смешивать их нельзя, иначе непонятно, кто кого переопределил.
       */
      attendance: {},
      volumes: {},
      note: '',
      updatedAt: null
    };
  }

  function newJob(extra) {
    var j = {
      id: uid('j'),
      taskId: 'pack',
      productId: '',
      packSize: null,
      variant: '',
      mode: 'volume',
      qty: 0,
      duration: 60,
      dest: '',
      note: ''
    };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) j[k] = extra[k];
    return j;
  }

  /* Копия строки задания для другого дня: новый id, чтобы правка
     завтрашнего задания не тянулась за сегодняшним. */
  function cloneJob(job) {
    var copy = assign({}, job);
    copy.id = uid('j');
    return copy;
  }

  /* Разворачивает шаблон дня недели в блоки конкретной даты. */
  function materialize(config, day) {
    var wd = weekdayOf(day.date);
    var template = (config.templates && config.templates[wd.key]) || [];
    day.blocks = template.map(function (t) {
      return blockFrom(t, 'template');
    });
    applyVolumes(config, day);
    applyAbsence(config, day);
    return day;
  }

  function blockFrom(src, origin) {
    return {
      id: uid('b'),
      staffId: src.staffId || null,
      taskId: src.taskId,
      mode: src.mode,
      duration: src.duration || 0,
      share: src.share || 1,
      qty: src.qty || 0,
      productId: src.productId || '',
      packSize: src.packSize == null ? null : src.packSize,
      variant: src.variant || '',
      dest: src.dest || '',
      note: src.note || '',
      pinnedStart: src.pinnedStart || null,
      status: 'planned',
      doneQty: 0,
      fromStaffId: null,
      origin: origin || 'manual'
    };
  }

  /*
   * Раскидывает дневной объём по блокам.
   *
   * Если на фасовке двое, а введено 400 пакетов — каждому по 200. Доля
   * настраивается полем share. Остаток от деления отдаём последнему
   * блоку, чтобы сумма по людям сходилась ровно с введённым числом.
   */
  function applyVolumes(config, day) {
    var byKey = {};
    (day.blocks || []).forEach(function (b) {
      if (b.mode !== 'volume') return;
      (byKey[volumeKey(b)] = byKey[volumeKey(b)] || []).push(b);
    });

    Object.keys(byKey).forEach(function (key) {
      var list = byKey[key];
      var total = Number(day.volumes && day.volumes[key]);
      /* Объём на день не задан — оставляем то, что уже стоит в блоках
         (их могло проставить распределение задания). */
      if (!isFinite(total)) return;

      var weights = list.reduce(function (s, b) { return s + (Number(b.share) || 1); }, 0);
      var given = 0;
      list.forEach(function (b, i) {
        if (i === list.length - 1) {
          b.qty = Math.max(0, total - given);
          return;
        }
        b.qty = Math.round(total * (Number(b.share) || 1) / weights);
        given += b.qty;
      });
    });
    return day;
  }

  /* ============================================================
     Смены и перерывы
     ============================================================ */

  function shiftOf(config, staff) {
    var s = (staff && staff.shift) || config.shift;
    return { start: hhmm(s.start), end: hhmm(s.end) };
  }

  /* Перерывы конкретного человека: общие плюс адресованные лично ему. */
  function breaksOf(config, staff) {
    var all = (config.shift && config.shift.breaks) || [];
    return all.filter(function (b) {
      var ids = b.staffIds || [];
      return !ids.length || (staff && ids.indexOf(staff.id) >= 0);
    }).map(function (b) {
      var start = hhmm(b.start);
      return { title: b.title || 'Перерыв', start: start, end: start + (Number(b.duration) || 0) };
    }).sort(function (a, b) { return a.start - b.start; });
  }

  /* Сколько человек реально может работать: смена минус его перерывы. */
  function capacityOf(config, staff) {
    var sh = shiftOf(config, staff);
    var lost = breaksOf(config, staff).reduce(function (sum, br) {
      return sum + (br.start >= sh.start && br.end <= sh.end ? br.end - br.start : 0);
    }, 0);
    return Math.max(0, sh.end - sh.start - lost);
  }

  /* ============================================================
     Отсутствие и перераспределение
     ============================================================ */

  /*
   * Сколько ждём человека после начала его смены, прежде чем считать,
   * что он не вышел. Без этой паузы план разваливался бы каждое утро:
   * в 09:30 ещё никто не успел дойти до планшета.
   */
  var CLOCK_IN_GRACE_MIN = 20;

  /*
   * Состояние человека на сегодня. Пять значений, и каждое отвечает на
   * свой вопрос:
   *
   *   'left'     — не работает у нас, в плане не участвует вовсе;
   *   'vacation' — в отпуске, известно заранее;
   *   'absent'   — менеджер отметил, что человека сегодня нет;
   *   'in'       — отметился на планшете и ещё не закрыл смену;
   *   'out'      — отметился и закрыл смену;
   *   'expected' — смена ещё не началась (или идёт пауза ожидания),
   *                человека ждём и работу на него планируем;
   *   'noshow'   — смена началась, пауза прошла, а он не отметился.
   *
   * nowMin — минуты от полуночи. Передаётся снаружи, чтобы функция
   * оставалась чистой и её можно было проверить тестом на любой момент.
   */
  function attendanceOf(config, day, staff, nowMin) {
    if (!staff) return 'left';
    if (staff.status === 'left') return 'left';
    if (staff.status === 'vacation') return 'vacation';
    if ((day.absent || []).indexOf(staff.id) >= 0) return 'absent';

    var rec = (day.attendance || {})[staff.id];
    var list = sessionsOf(rec);
    if (openSession(rec)) return openBreak(rec) ? 'break' : 'in';
    if (list.length) return 'out';

    /* Без часов судить о неявке нельзя — считаем, что человека ждём. */
    if (nowMin == null) return 'expected';

    var shift = shiftOf(config, staff);
    return nowMin >= shift.start + CLOCK_IN_GRACE_MIN ? 'noshow' : 'expected';
  }

  /*
   * Работу планируем на того, кто на смене или кого ещё ждём. Тот, кто
   * не отметился после паузы, и тот, кто уже закрыл смену, из плана
   * выпадают — их задачи уходят остальным.
   */
  /*
   * Перерыв — это всё ещё рабочий день: человек вернётся, и работу с него
   * снимать нельзя. Поэтому 'break' здесь наравне с 'in'.
   */
  function isAvailable(staff, day, nowMin, config) {
    var st = attendanceOf(config, day, staff, nowMin);
    return st === 'in' || st === 'break' || st === 'expected';
  }

  /*
   * Отрезки работы за день. Их может быть несколько: человек закрыл
   * смену случайно и вернулся, или уходил и пришёл снова. Одной пары
   * in/out на день не хватает — второй приход затирал бы первый.
   *
   * Старая форма { in, out, breaks } читается как одна сессия: записи,
   * сделанные до этого изменения, не теряются.
   */
  function sessionsOf(rec) {
    if (!rec) return [];
    if (Array.isArray(rec.sessions)) return rec.sessions;
    if (rec.in) return [{ in: rec.in, out: rec.out || null, breaks: rec.breaks || [] }];
    return [];
  }

  /* Открытая сессия — та, где ещё не отметили уход. */
  function openSession(rec) {
    var list = sessionsOf(rec);
    var last = list[list.length - 1];
    return last && !last.out ? last : null;
  }

  /* Первый приход за день: с него начинается отсчёт очереди музыки. */
  function firstIn(rec) {
    var list = sessionsOf(rec);
    return list.length ? list[0].in : null;
  }

  /* Незакрытый перерыв внутри открытой сессии. */
  function openBreak(rec) {
    var ses = openSession(rec);
    var list = (ses && ses.breaks) || [];
    var last = list[list.length - 1];
    return last && !last.end ? last : null;
  }

  /* Приводим запись к форме с сессиями — один раз при первой правке. */
  function ensureSessions(day, staffId) {
    day.attendance = day.attendance || {};
    var rec = day.attendance[staffId];
    if (!rec) rec = day.attendance[staffId] = { sessions: [] };
    if (!Array.isArray(rec.sessions)) {
      rec.sessions = sessionsOf(rec);
      delete rec.in;
      delete rec.out;
      delete rec.breaks;
    }
    return rec;
  }

  function availableStaff(config, day, nowMin) {
    return (config.staff || []).filter(function (s) { return isAvailable(s, day, nowMin, config); });
  }

  /*
   * Отметка прихода и ухода. Момент нажатия сохраняется как есть —
   * именно он потом пойдёт в табель, поэтому округлять или подгонять
   * его под расписание нельзя.
   *
   * Повторное нажатие «пришёл» время прихода не переписывает: если
   * человек нажал дважды, верным остаётся первое нажатие.
   */
  /*
   * Приход. Если открытая сессия уже есть — ничего не делаем: повторное
   * нажатие не должно ни начинать вторую, ни переписывать первую.
   * Если все сессии закрыты — начинается новая. Это и есть возврат в
   * работу после случайного (или настоящего) ухода.
   */
  function clockIn(day, staffId, iso) {
    var rec = ensureSessions(day, staffId);
    if (openSession(rec)) return day;
    rec.sessions.push({ in: iso, out: null, breaks: [] });
    /* Пришёл — значит уже не «отмечен отсутствующим». */
    day.absent = (day.absent || []).filter(function (id) { return id !== staffId; });
    return day;
  }

  function breakStart(day, staffId, iso) {
    var rec = (day.attendance || {})[staffId];
    var ses = openSession(rec);
    if (!ses) return day;
    if (openBreak(rec)) return day;          // уже на перерыве
    ses.breaks = ses.breaks || [];
    ses.breaks.push({ start: iso, end: null });
    return day;
  }

  function breakEnd(day, staffId, iso) {
    var open = openBreak((day.attendance || {})[staffId]);
    if (!open) return day;
    open.end = iso;
    return day;
  }

  function clockOut(day, staffId, iso) {
    var rec = (day.attendance || {})[staffId];
    var ses = openSession(rec);
    if (!ses) return day;
    /* Ушёл, не закрыв перерыв: перерыв заканчивается тем же моментом —
       иначе он тянулся бы до бесконечности. */
    var open = openBreak(rec);
    if (open) open.end = iso;
    ses.out = iso;
    return day;
  }

  /*
   * Табель за период. days — массив документов дня (какие есть; за какой
   * день данных нет, тот просто не участвует).
   *
   * Деньги считаются от ставки сотрудника и только по закрытым сменам.
   * Незакрытая смена в сумму не идёт: платить за день, который ещё не
   * кончился, нельзя, а показать «столько уже набежало» — можно, для
   * этого есть openMinutes.
   *
   * Это черновик для бухгалтера, а не расчётный лист: налоги, переработки
   * и всё остальное — не наша забота, о чём сказано и на экране.
   */
  function timesheet(config, days, nowIso) {
    var paid = paidBreaks(config);
    var byStaff = {};
    (config.staff || []).forEach(function (s) {
      byStaff[s.id] = {
        staff: s,
        rate: Number(s.rate) || 0,
        days: [],
        workedMin: 0,
        breakMin: 0,
        openMin: 0,
        closedDays: 0
      };
    });

    (days || []).forEach(function (day) {
      if (!day || !day.attendance) return;
      Object.keys(day.attendance).forEach(function (staffId) {
        var row = byStaff[staffId];
        if (!row) return;                       // человека удалили из справочника
        var rec = day.attendance[staffId];
        var list = sessionsOf(rec);
        if (!list.length) return;

        var worked = workedMinutes(day, staffId, paid);
        var brk = Math.round(breakMinutes(day, staffId, nowIso));

        /* Открытая сессия считается отдельно: платить за день, который
           ещё не кончился, нельзя, но показать «уже набежало» — можно. */
        var open = openSession(rec);
        if (open && nowIso) {
          var openBrk = (open.breaks || []).reduce(function (b, br) {
            var end = br.end || nowIso;
            return b + minutesBetween(br.start, end);
          }, 0);
          row.openMin += Math.max(0, Math.round(minutesBetween(open.in, nowIso) - (paid ? 0 : openBrk)));
        }

        if (worked != null) {
          row.workedMin += worked;
          row.closedDays++;
        }
        row.breakMin += brk;
        row.days.push({
          date: day.date,
          in: list[0].in,
          out: open ? null : list[list.length - 1].out,
          sessions: list.length,
          breakMin: brk,
          workedMin: worked
        });
      });
    });

    return Object.keys(byStaff).map(function (id) {
      var r = byStaff[id];
      r.paidBreaks = paid;
      r.days.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      r.hours = Math.round(r.workedMin / 60 * 100) / 100;
      r.pay = Math.round(r.hours * r.rate * 100) / 100;
      return r;
    }).filter(function (r) {
      return r.staff.status !== 'left' || r.days.length;
    });
  }

  /*
   * Чья сейчас очередь ставить музыку.
   *
   * Считается, а не хранится: любое хранимое «сейчас очередь Криса»
   * пришлось бы двигать по таймеру и чинить после перезагрузки. Здесь
   * очередь — чистая функция от того, кто на смене и сколько прошло с
   * начала дня, поэтому на всех устройствах она одинаковая сама собой.
   *
   * В круг входят только те, кто отметился и не ушёл: смысла ставить
   * очередь тому, кого нет, никакого.
   */
  function musicTurn(config, day, nowIso) {
    var minutes = (config.rules && config.rules.musicTurnMin) || 120;

    var present = (config.staff || []).filter(function (s) {
      return s.musicUrl && openSession((day.attendance || {})[s.id]);
    });
    if (!present.length || !nowIso) return null;

    /* Отсчёт от первого прихода за день — это и есть начало дня по факту. */
    var starts = present.map(function (s) { return firstIn(day.attendance[s.id]); }).sort();
    var anchor = starts[0];

    var passed = minutesBetween(anchor, nowIso);
    var slot = Math.floor(passed / minutes);
    var idx = ((slot % present.length) + present.length) % present.length;

    var endsInMin = minutes - (passed - slot * minutes);
    return {
      current: present[idx],
      next: present[(idx + 1) % present.length],
      minutesLeft: Math.max(0, Math.round(endsInMin)),
      turnMinutes: minutes,
      queue: present
    };
  }

  /* Понедельник недели, в которую попадает дата. */
  function weekStart(iso) {
    var p = String(iso).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    var shift = (d.getDay() + 6) % 7;           // 0 = понедельник
    d.setDate(d.getDate() - shift);
    return todayISO(d);
  }

  /*
   * План против факта.
   *
   * Метки ставятся на тех же нажатиях «Начал» и «Готово», которые на
   * складе делают и так — отдельной кнопки-таймера нет и быть не должно.
   * Видимый счётчик превратил бы замер в гонку: люди начали бы жать
   * «Готово» заранее, и данные испортились бы именно там, где нужны
   * честные.
   *
   * Снятие статуса обратно в 'planned' стирает обе метки: незаконченный
   * замер хуже отсутствующего — он выглядит как настоящий.
   */
  function markProgress(block, status, iso) {
    if (status === 'active') {
      /* Повторное «Начал» время не переписывает: верным остаётся первое. */
      if (!block.startedAt) block.startedAt = iso;
      block.doneAt = null;
    } else if (status === 'done') {
      if (!block.startedAt) block.startedAt = null;   // жали «Готово», не жав «Начал»
      block.doneAt = iso;
    } else {
      block.startedAt = null;
      block.doneAt = null;
    }
    block.status = status;
    return block;
  }

  /*
   * Сколько задача заняла на самом деле. null, если засечь не по чему:
   * не нажали «Начал» или ещё не закончили. Ноль здесь был бы враньём.
   */
  function actualMinutes(block, nowIso) {
    if (!block || !block.startedAt) return null;
    var end = block.doneAt || (block.status === 'active' ? nowIso : null);
    if (!end) return null;
    return Math.round(minutesBetween(block.startedAt, end));
  }

  /*
   * Расхождение плана и факта в минутах: плюс — дольше плана.
   * null, пока факта нет.
   */
  function drift(config, block, nowIso) {
    var actual = actualMinutes(block, nowIso);
    if (actual == null) return null;
    return actual - durationOf(config, block);
  }

  function minutesBetween(a, b) {
    var ms = new Date(b).getTime() - new Date(a).getTime();
    return ms > 0 ? ms / 60000 : 0;
  }

  /* Сколько минут человек провёл на перерывах. Открытый перерыв считается
     до указанного момента — иначе на экране он бы не рос. */
  function breakMinutes(day, staffId, untilIso) {
    return sessionsOf((day.attendance || {})[staffId]).reduce(function (total, ses) {
      return total + (ses.breaks || []).reduce(function (sum, br) {
        var end = br.end || untilIso;
        return end ? sum + minutesBetween(br.start, end) : sum;
      }, 0);
    }, 0);
  }

  /*
   * Оплачиваются ли перерывы. На этом складе — да, поэтому такое значение
   * по умолчанию. Настройкой это сделано не «на всякий случай»: если
   * когда-нибудь появится получасовой обед, который по закону не
   * оплачивают, менять придётся галочку, а не расчёт зарплаты в коде.
   */
  function paidBreaks(config) {
    var rules = (config && config.rules) || {};
    return rules.paidBreaks !== false;
  }

  /*
   * Отработанное время, которое идёт в оплату.
   *
   * paidBreaks = true (по умолчанию) — считаем от прихода до ухода:
   * перерыв оплачивается, вычитать его нельзя.
   * paidBreaks = false — перерывы вычитаются.
   *
   * null означает «смена не закрыта», а не ноль: разница важна, чтобы в
   * табеле не появлялись выдуманные нули за незакончившийся день.
   */
  function workedMinutes(day, staffId, paid) {
    var list = sessionsOf((day.attendance || {})[staffId]);
    var closed = list.filter(function (ses) { return ses.in && ses.out; });
    if (!closed.length) return null;

    var gross = closed.reduce(function (sum, ses) {
      return sum + minutesBetween(ses.in, ses.out);
    }, 0);
    var deduct = paid === false
      ? closed.reduce(function (sum, ses) {
        return sum + (ses.breaks || []).reduce(function (b, br) {
          return br.end ? b + minutesBetween(br.start, br.end) : b;
        }, 0);
      }, 0)
      : 0;
    return Math.max(0, Math.round(gross - deduct));
  }

  /* Умеет ли человек эту задачу. Пустой список навыков = универсал:
     на складе из четырёх человек проще отмечать исключения, чем
     заполнять матрицу «кто что умеет» целиком. */
  function canDo(staff, taskId) {
    if (!staff.skills || !staff.skills.length) return true;
    return staff.skills.indexOf(taskId) >= 0;
  }

  /* Важность блока: направление важнее операции — «на Amazon» режут
     последним, что бы это ни была за работа. */
  function priorityOf(config, block) {
    var dest = destOf(block.dest);
    if (dest && dest.key) return dest.priority;
    return taskOf(config, block).priority || 2;
  }

  function destOf(key) {
    for (var i = 0; i < DESTINATIONS.length; i++) {
      if (DESTINATIONS[i].key === (key || '')) return DESTINATIONS[i];
    }
    return null;
  }

  /*
   * Кто-то не вышел — его блоки уходят другим.
   *
   * Порядок разбора: сначала критичные, внутри важности — длинные
   * вперёд. Длинный блок сложнее пристроить, и если раздать сперва
   * мелочь, он упрётся в того, кто уже загружен.
   */
  /*
   * nowMin необязателен. Передали — из плана выпадают и те, кто не
   * отметился после паузы ожидания; не передали — считаются только
   * отпуск, увольнение и отметка менеджера. Так старые вызовы (и тесты
   * на них) продолжают значить ровно то же, что значили.
   */
  function applyAbsence(config, day, nowMin) {
    var blocks = day.blocks || [];
    var people = availableStaff(config, day, nowMin);
    var byId = indexBy(config.staff || []);

    /* Вернуть блоки тому, кто снова на месте: снятая галочка
       «нет на работе» должна откатывать вчерашнее перераспределение. */
    blocks.forEach(function (b) {
      if (!b.fromStaffId) return;
      var owner = byId[b.fromStaffId];
      if (owner && isAvailable(owner, day, nowMin, config)) {
        b.staffId = b.fromStaffId;
        b.fromStaffId = null;
        b.warn = '';
      }
    });

    if (!people.length) {
      blocks.forEach(function (b) {
        if (b.staffId && !isAvailable(byId[b.staffId], day, nowMin, config)) {
          b.fromStaffId = b.fromStaffId || b.staffId;
          b.staffId = null;
          /* Код, а не текст: строку соберёт экран на своём языке. */
          b.warn = 'nobody';
        }
      });
      return day;
    }

    var load = {};
    people.forEach(function (s) { load[s.id] = 0; });
    blocks.forEach(function (b) {
      if (b.staffId && load[b.staffId] != null) load[b.staffId] += durationOf(config, b);
    });

    var orphans = blocks.filter(function (b) {
      return !b.staffId || load[b.staffId] == null;
    });

    orphans.sort(function (a, b) {
      var pa = priorityOf(config, a);
      var pb = priorityOf(config, b);
      if (pa !== pb) return pa - pb;
      return durationOf(config, b) - durationOf(config, a);
    });

    orphans.forEach(function (b) {
      var skilled = people.filter(function (s) { return canDo(s, b.taskId); });
      var pool = skilled.length ? skilled : people;
      var pick = pool.reduce(function (best, s) {
        return load[s.id] < load[best.id] ? s : best;
      }, pool[0]);

      b.fromStaffId = b.fromStaffId || b.staffId || null;
      b.staffId = pick.id;
      b.warn = skilled.length ? '' : 'noSkill';
      load[pick.id] += durationOf(config, b);
    });

    return day;
  }

  /* ============================================================
     Нормы и расчёт длительности
     ============================================================ */

  function taskOf(config, block) {
    var list = config.tasks || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === block.taskId) return list[i];
    return { id: block.taskId, title: block.taskId, mode: 'time', unit: '', minPerUnit: 0, priority: 2, color: '#94a3b8', byProduct: {} };
  }

  function productOf(config, block) {
    if (!block || !block.productId) return null;
    var list = config.products || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === block.productId) return list[i];
    return null;
  }

  function packOf(config, block) {
    var product = productOf(config, block);
    if (!product || !block.packSize) return null;
    var list = product.packs || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === block.packSize) return list[i];
    return null;
  }

  /*
   * Норма: минут на единицу плюс сама единица. Единица нужна потому,
   * что один и тот же «сортинг» на Starburst считают коробками, а на
   * Jolly — пакетами; сводить их к общей единице значит выбросить то,
   * как люди на складе на самом деле мерят работу.
   *
   * Поиск от частного к общему: «товар + фасовка» → «товар» → операция.
   */
  function normOf(config, block) {
    var task = taskOf(config, block);
    var by = task.byProduct || {};
    var pid = block.productId || '';
    var found = null;

    if (pid && block.packSize && by[pid + ':' + block.packSize] != null) found = by[pid + ':' + block.packSize];
    else if (pid && by[pid] != null) found = by[pid];

    if (found == null) return { min: Number(task.minPerUnit) || 0, unit: task.unit || 'шт' };
    if (typeof found === 'number') return { min: found, unit: task.unit || 'шт' };
    return { min: Number(found.min) || 0, unit: found.unit || task.unit || 'шт' };
  }

  function normFor(config, block) { return normOf(config, block).min; }

  function unitFor(config, block) { return normOf(config, block).unit; }

  /*
   * Товары, которые имеет смысл предлагать для этой задачи. У переборки
   * это только то, что вообще перебирают — Jolly и Starburst; выбирать
   * из сотни позиций там не из чего, а ошибиться легко.
   *
   * Признак берём из самой задачи: sortOnly ставится на переборке, и
   * список сузится сам, если операций такого рода станет больше.
   */
  function productsForTask(config, taskId) {
    var all = config.products || [];
    var task = (config.tasks || []).filter(function (t) { return t.id === taskId; })[0];
    if (!task || !task.sortOnly) return all;
    var sortable = all.filter(function (p) { return p.sortable; });
    return sortable.length ? sortable : all;
  }

  /*
   * Пересчёт введённого количества в единицу нормы. На упаковке удобнее
   * сказать «14 коробок», а норма считается за пакет — переводим по
   * таблице склада. Нет данных по коробке — оставляем как есть, лучше
   * посчитать по введённому, чем молча выдумать множитель.
   */
  function qtyInNormUnit(config, block) {
    var qty = Number(block.qty) || 0;
    if (block.qtyUnit !== 'box') return qty;
    var pk = packOf(config, block);
    if (!pk || !pk.bagsPerBox) return qty;
    return qty * pk.bagsPerBox;
  }

  /* Ключ объёма на день. Товар, фасовка и цвет входят в ключ: «100
     пакетов Frooties 2 lb» и «300 пакетов Starburst 1 lb» — разные
     строки, складывать их в одно число нельзя. */
  function volumeKey(block) {
    return [
      block.taskId,
      block.productId || '',
      block.packSize == null ? '' : block.packSize,
      block.variant || ''
    ].join('|');
  }

  /* Подпись работы: «Переборка по цветам · Starburst · Watermelon»,
     «Фасовка (взвешивание) · Jolly Rancher 2 lb». */
  function blockTitle(config, block) {
    var task = taskOf(config, block);
    var product = productOf(config, block);
    if (!product) return task.title;
    var pk = packOf(config, block);
    return task.title + ' · ' + product.title
      + (pk ? ' ' + pk.title : '')
      + (block.variant ? ' · ' + block.variant : '');
  }

  /*
   * Те самые «оба варианта»:
   *   time   — сколько поставили, столько и стоит в плане;
   *   volume — количество × норма, округляя вверх до 5 минут (планировать
   *            смену с точностью до секунды бессмысленно, а «2 ч 03 мин»
   *            на планшете выглядит как ошибка).
   */
  function durationOf(config, block) {
    if (block.mode === 'volume') {
      /* Количество могли ввести в коробках — норма считается за пакет. */
      var raw = qtyInNormUnit(config, block) * normFor(config, block);
      return raw > 0 ? Math.max(5, Math.ceil(raw / 5) * 5) : 0;
    }
    return Math.max(0, Number(block.duration) || 0);
  }

  /*
   * Сколько успеют за отведённое время. Обратная сторона расчёта: для
   * переборки время задано, а знать нужно выработку — «2,5 часа на
   * Starburst это примерно 10 коробок».
   */
  function expectedOutput(config, block) {
    if (block.mode !== 'time') return null;
    var norm = normOf(config, block);
    if (!norm.min) return null;
    var qty = (Number(block.duration) || 0) / norm.min;
    if (qty < 1) return null;
    var rounded = Math.round(qty * 10) / 10;
    return { qty: rounded, unit: plural(rounded, norm.unit) };
  }

  /* Сколько коробок выйдет из пакетов — по таблице склада. */
  function boxesFromBags(config, block, bags) {
    var pk = packOf(config, block);
    if (!pk || !pk.bagsPerBox) return null;
    return Math.ceil((Number(bags) || 0) / pk.bagsPerBox);
  }

  function palletSize(config) {
    var p = config.pallet || {};
    return (Number(p.boxesPerLevel) || 0) * (Number(p.levels) || 0);
  }

  /* ============================================================
     Распределение задания по людям
     ============================================================ */

  /*
   * Превращает задание на день в план: кто, что и сколько делает.
   *
   * Правила, которые здесь зашиты, — те же, по которым это делают
   * руками:
   *   — сначала критичное (Amazon и заказы), потом остальное;
   *   — работу можно делить между людьми, если одному не успеть;
   *   — на сидячей работе не держим дольше maxSittingStreak подряд;
   *   — что не влезло в смену, не выбрасываем, а возвращаем списком.
   *
   * Существующие блоки заменяются целиком: это «собрать день заново»,
   * а не «дополнить».
   */
  function autoAssign(config, day) {
    var people = availableStaff(config, day);
    day.blocks = [];
    day.overflow = [];

    if (!people.length) {
      day.overflow = (day.jobs || []).slice();
      return day;
    }

    var cap = {};
    var load = {};
    var lastTask = {};
    var streak = {};
    people.forEach(function (s) {
      cap[s.id] = capacityOf(config, s);
      load[s.id] = 0;
      lastTask[s.id] = '';
      streak[s.id] = 0;
    });

    var maxStreak = (config.rules && config.rules.maxSittingStreak) || 180;

    var jobs = (day.jobs || []).slice().sort(function (a, b) {
      var pa = priorityOf(config, a);
      var pb = priorityOf(config, b);
      if (pa !== pb) return pa - pb;
      return jobMinutes(config, b) - jobMinutes(config, a);
    });

    jobs.forEach(function (job) {
      var norm = normFor(config, job);
      var sitting = taskOf(config, job).sitting;
      var left = job.mode === 'volume' ? (Number(job.qty) || 0) : (Number(job.duration) || 0);
      if (left <= 0) return;

      /*
       * Сколько минут этой работы человек ещё может взять. Ноль значит
       * «этот не может» — но это не повод бросать задачу: её берёт
       * следующий. Из-за этого выбор кандидата и считается отдельно от
       * цикла раздачи.
       */
      function roomFor(s) {
        var free = cap[s.id] - load[s.id];
        if (free <= 0) return 0;
        if (!sitting) return free;
        /* Ограничение на сидячую работу подряд считается только по
           текущему непрерывному отрезку: пересел на другое — обнулилось. */
        var used = lastTask[s.id] === job.taskId ? streak[s.id] : 0;
        return Math.min(free, Math.max(0, maxStreak - used));
      }

      var guard = 0;
      while (left > 0 && guard++ < 200) {
        var pool = people.filter(function (s) {
          if (!canDo(s, job.taskId)) return false;
          var room = roomFor(s);
          if (room <= 0) return false;
          /* На дробную единицу работу не режем: если у человека не
             влезает даже один пакет, он не кандидат. */
          return job.mode !== 'volume' || norm <= 0 || Math.floor(room / norm) >= 1;
        });
        if (!pool.length) break;

        /* Самый свободный; при равенстве — тот, кто не делал эту же
           работу последним, чтобы не сажать человека на одно и то же
           весь день. */
        var pick = pool.reduce(function (best, s) {
          var free = cap[s.id] - load[s.id];
          var bestFree = cap[best.id] - load[best.id];
          if (free !== bestFree) return free > bestFree ? s : best;
          var sRepeats = lastTask[s.id] === job.taskId;
          var bestRepeats = lastTask[best.id] === job.taskId;
          if (sRepeats !== bestRepeats) return sRepeats ? best : s;
          return best;
        }, pool[0]);

        var chunkMin = roomFor(pick);
        var block;
        if (job.mode === 'volume') {
          var qty = norm > 0 ? Math.floor(chunkMin / norm) : left;
          if (qty > left) qty = left;
          block = blockFrom({
            staffId: pick.id, taskId: job.taskId, mode: 'volume',
            qty: qty, productId: job.productId, packSize: job.packSize,
            variant: job.variant, dest: job.dest, note: job.note
          }, 'auto');
          left -= qty;
        } else {
          var mins = Math.min(left, chunkMin);
          block = blockFrom({
            staffId: pick.id, taskId: job.taskId, mode: 'time',
            duration: mins, productId: job.productId, packSize: job.packSize,
            variant: job.variant, dest: job.dest, note: job.note
          }, 'auto');
          left -= mins;
        }

        var spent = durationOf(config, block);
        day.blocks.push(block);
        load[pick.id] += spent;
        streak[pick.id] = lastTask[pick.id] === job.taskId ? streak[pick.id] + spent : spent;
        lastTask[pick.id] = job.taskId;
      }

      if (left > 0) {
        day.overflow.push(assign({}, job, job.mode === 'volume' ? { qty: left } : { duration: left }));
      }
    });

    fillFreeTime(config, day, people, cap, load, lastTask);
    return day;
  }

  /*
   * Свободное время в конце смены заполняем переборкой: именно так это
   * и происходит на складе — если заданий больше нет, готовят балк на
   * завтра, а не расходятся.
   */
  function fillFreeTime(config, day, people, cap, load, lastTask) {
    var fillId = config.rules && config.rules.fillTask;
    if (!fillId) return;
    var maxStreak = (config.rules && config.rules.maxSittingStreak) || 180;

    people.forEach(function (s) {
      var free = cap[s.id] - load[s.id];
      /* Меньше получаса добивать нечем — это не работа, а обрывок. */
      if (free < 30 || !canDo(s, fillId)) return;

      var product = defaultSortProduct(config);
      day.blocks.push(blockFrom({
        staffId: s.id, taskId: fillId, mode: 'time',
        duration: Math.min(free, maxStreak),
        productId: product ? product.id : '',
        dest: 'bulk', note: 'добить смену'
      }, 'fill'));
      load[s.id] += Math.min(free, maxStreak);
    });
  }

  function defaultSortProduct(config) {
    var list = (config.products || []).filter(function (p) { return p.sortable; });
    return list[0] || null;
  }

  function jobMinutes(config, job) {
    return job.mode === 'volume'
      ? (Number(job.qty) || 0) * normFor(config, job)
      : (Number(job.duration) || 0);
  }

  /* ============================================================
     Раскладка по времени
     ============================================================ */

  /*
   * Ставит блоки одного человека на ось времени подряд от начала смены.
   * Перерыв не отменяет задачу, а сдвигает её конец: попал обед в
   * середину фасовки — фасовка закончится позже.
   */
  function layout(config, staff, blocks) {
    var sh = shiftOf(config, staff);
    var breaks = breaksOf(config, staff);
    var cursor = sh.start;
    var items = [];

    blocks.forEach(function (b) {
      var dur = durationOf(config, b);
      if (b.pinnedStart != null && b.pinnedStart !== '') cursor = Math.max(cursor, hhmm(b.pinnedStart));

      /* Начало не должно попадать внутрь перерыва. */
      breaks.forEach(function (br) {
        if (cursor >= br.start && cursor < br.end) cursor = br.end;
      });

      var start = cursor;
      var end = start + dur;
      var crossed = null;
      breaks.forEach(function (br) {
        if (start < br.start && end > br.start) {
          end += (br.end - br.start);
          crossed = br;
        }
      });

      items.push({
        block: b,
        start: start,
        end: end,
        duration: dur,
        crossedBreak: crossed ? crossed.title : '',
        overtime: end > sh.end
      });
      cursor = end;
    });

    return { shift: sh, items: items, endsAt: cursor };
  }

  /*
   * Полная раскладка дня: дорожки по людям, сводка и предупреждения.
   * Ничего не меняет во входных данных — вызывается на каждую отрисовку.
   */
  function schedule(config, day, nowMin) {
    var byId = indexBy(config.staff || []);
    var blocks = day.blocks || [];
    var lanes = [];
    var warnings = [];
    var maxStreak = (config.rules && config.rules.maxSittingStreak) || 180;

    (config.staff || []).forEach(function (s) {
      if (s.status === 'left') return;
      var mine = blocks.filter(function (b) { return b.staffId === s.id; });
      var lay = layout(config, s, mine);
      var planned = lay.items.reduce(function (sum, i) { return sum + i.duration; }, 0);
      var capacity = capacityOf(config, s);

      lanes.push({
        staff: s,
        available: isAvailable(s, day, nowMin, config),
        absent: (day.absent || []).indexOf(s.id) >= 0,
        vacation: s.status === 'vacation',
        items: lay.items,
        shift: lay.shift,
        breaks: breaksOf(config, s),
        endsAt: lay.endsAt,
        plannedMin: planned,
        capacityMin: capacity,
        freeMin: Math.max(0, capacity - planned),
        overMin: Math.max(0, planned - capacity),
        loadPct: capacity ? Math.round(planned / capacity * 100) : 0,
        sittingStreak: longestSittingStreak(config, lay.items)
      });
    });

    /*
     * Предупреждения отдаются кодом и параметрами, а не готовой строкой:
     * движок считает и в Node, где языка интерфейса нет, а экран сам
     * решает, на каком языке это показать. minutes отдаём числом —
     * форматирование тоже дело экрана.
     */
    lanes.forEach(function (l) {
      if (!l.available && l.items.length) {
        warnings.push({ level: 'error', code: 'absentHasTasks', name: l.staff.name });
      }
      if (l.available && l.overMin > 0) {
        warnings.push({ level: 'warn', code: 'overloaded', name: l.staff.name, minutes: l.overMin });
      }
      if (l.available && l.plannedMin === 0) {
        warnings.push({ level: 'info', code: 'noTasks', name: l.staff.name });
      }
      if (l.available && l.sittingStreak > maxStreak) {
        warnings.push({ level: 'warn', code: 'sittingStreak', name: l.staff.name, minutes: l.sittingStreak });
      }
    });

    blocks.forEach(function (b) {
      if (!b.staffId) {
        warnings.push({ level: 'error', code: 'nobodyToTake', title: blockTitle(config, b) });
      } else if (b.warn) {
        warnings.push({
          level: 'warn',
          code: 'blockWarn',
          name: (byId[b.staffId] || {}).name,
          title: blockTitle(config, b),
          detail: b.warn
        });
      }
    });

    (day.overflow || []).forEach(function (job) {
      warnings.push({ level: 'error', code: 'overflow', title: blockTitle(config, job) });
    });

    var totalPlanned = lanes.reduce(function (s, l) { return s + (l.available ? l.plannedMin : 0); }, 0);
    var totalCapacity = lanes.reduce(function (s, l) { return s + (l.available ? l.capacityMin : 0); }, 0);
    var done = blocks.filter(function (b) { return b.status === 'done'; }).length;

    return {
      date: day.date,
      weekday: weekdayOf(day.date),
      lanes: lanes,
      unassigned: blocks.filter(function (b) { return !b.staffId; }),
      overflow: day.overflow || [],
      warnings: warnings,
      totals: {
        plannedMin: totalPlanned,
        capacityMin: totalCapacity,
        freeMin: Math.max(0, totalCapacity - totalPlanned),
        loadPct: totalCapacity ? Math.round(totalPlanned / totalCapacity * 100) : 0,
        blocks: blocks.length,
        done: done,
        people: lanes.filter(function (l) { return l.available; }).length
      }
    };
  }

  /* Самый长 отрезок сидячей работы подряд — по нему видно, что человек
     полдня не вставал. Перерыв отрезок не разрывает: он короткий. */
  function longestSittingStreak(config, items) {
    var best = 0;
    var run = 0;
    var prev = '';
    items.forEach(function (i) {
      var task = taskOf(config, i.block);
      if (!task.sitting) { run = 0; prev = ''; return; }
      run = (task.id === prev || prev === '') ? run + i.duration : i.duration;
      prev = task.id;
      if (run > best) best = run;
    });
    return best;
  }

  /* ============================================================
     Служебное
     ============================================================ */

  function indexBy(list, key) {
    var out = {};
    (list || []).forEach(function (x) { out[x[key || 'id']] = x; });
    return out;
  }

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i] || {};
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /* Какие объёмы спрашивать на день — по одной строке на связку
     «операция + товар + фасовка + цвет». */
  function volumeTasks(config, day) {
    var seen = {};
    var out = [];
    (day.blocks || []).forEach(function (b) {
      var key = volumeKey(b);
      if (b.mode !== 'volume' || seen[key]) return;
      seen[key] = true;
      out.push({
        key: key,
        id: key,
        title: blockTitle(config, b),
        unit: unitFor(config, b)
      });
    });
    return out;
  }

  return {
    WEEKDAYS: WEEKDAYS,
    DESTINATIONS: DESTINATIONS,
    PRIORITIES: PRIORITIES,
    STATUSES: STATUSES,
    plural: plural,
    hhmm: hhmm,
    fmt: fmt,
    human: human,
    setFormat: setFormat,
    todayISO: todayISO,
    shiftISO: shiftISO,
    weekdayOf: weekdayOf,
    humanDate: humanDate,
    uid: uid,
    defaultConfig: defaultConfig,
    emptyDay: emptyDay,
    newJob: newJob,
    cloneJob: cloneJob,
    materialize: materialize,
    blockFrom: blockFrom,
    applyVolumes: applyVolumes,
    applyAbsence: applyAbsence,
    autoAssign: autoAssign,
    availableStaff: availableStaff,
    isAvailable: isAvailable,
    attendanceOf: attendanceOf,
    clockIn: clockIn,
    breakStart: breakStart,
    breakEnd: breakEnd,
    breakMinutes: breakMinutes,
    paidBreaks: paidBreaks,
    timesheet: timesheet,
    weekStart: weekStart,
    musicTurn: musicTurn,
    openBreak: openBreak,
    sessionsOf: sessionsOf,
    openSession: openSession,
    firstIn: firstIn,
    clockOut: clockOut,
    workedMinutes: workedMinutes,
    markProgress: markProgress,
    actualMinutes: actualMinutes,
    drift: drift,
    CLOCK_IN_GRACE_MIN: CLOCK_IN_GRACE_MIN,
    canDo: canDo,
    priorityOf: priorityOf,
    destOf: destOf,
    shiftOf: shiftOf,
    breaksOf: breaksOf,
    capacityOf: capacityOf,
    taskOf: taskOf,
    productOf: productOf,
    packOf: packOf,
    normOf: normOf,
    normFor: normFor,
    unitFor: unitFor,
    volumeKey: volumeKey,
    blockTitle: blockTitle,
    expectedOutput: expectedOutput,
    boxesFromBags: boxesFromBags,
    carrierOf: carrierOf,
    productsForTask: productsForTask,
    qtyInNormUnit: qtyInNormUnit,
    palletSize: palletSize,
    durationOf: durationOf,
    schedule: schedule,
    volumeTasks: volumeTasks,
    indexBy: indexBy,
    clone: clone
  };
});
