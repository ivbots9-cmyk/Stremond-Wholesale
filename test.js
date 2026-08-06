#!/usr/bin/env node
/*
 * Тесты движка плана: node warehouse/test.js
 *
 * Проверяют то, из-за чего плану перестают верить: что объём правда
 * превращается во время, что при делении между людьми не теряются
 * пакеты, что отсутствие человека не роняет его работу в никуда и что
 * распределение задания не сажает одного человека на переборку весь
 * день.
 */
'use strict';

var assert = require('assert');
var P = require('./plan.js');

var failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.error('  FAIL ' + name + '\n       ' + e.message);
  }
}

/* Фиксированные даты 2026 года, чтобы тест не зависел от дня запуска. */
var MONDAY = '2026-08-03';
var TUESDAY = '2026-08-04';
var SUNDAY = '2026-08-09';

function freshDay(date, config) {
  var day = P.emptyDay(date || MONDAY);
  P.materialize(config || P.defaultConfig(), day);
  return day;
}

function staff(cfg, id) {
  return cfg.staff.filter(function (s) { return s.id === id; })[0];
}

function lane(view, id) {
  return view.lanes.filter(function (l) { return l.staff.id === id; })[0];
}

/* Заполняет все объёмы дня одним числом — чтобы в сценарных тестах не
   выписывать составные ключи руками. */
function fillVolumes(cfg, day, qty) {
  day.volumes = day.volumes || {};
  (day.blocks || []).forEach(function (b) {
    if (b.mode === 'volume') day.volumes[P.volumeKey(b)] = qty;
  });
  P.applyVolumes(cfg, day);
  return day;
}

console.log('\nдвижок плана склада\n');

/* ---------- время ---------- */

check('hhmm/fmt — время ходит туда и обратно', function () {
  assert.strictEqual(P.hhmm('09:30'), 570);
  assert.strictEqual(P.fmt(570), '09:30');
  assert.strictEqual(P.fmt(P.hhmm('16:50')), '16:50');
});

check('human — часы и минуты, по умолчанию по-английски', function () {
  assert.strictEqual(P.human(45), '45 min');
  assert.strictEqual(P.human(120), '2 h');
  assert.strictEqual(P.human(150), '2 h 30 min');
});

check('склонение единиц', function () {
  assert.strictEqual(P.plural(1, 'коробка'), 'коробка');
  assert.strictEqual(P.plural(3, 'коробка'), 'коробки');
  assert.strictEqual(P.plural(10, 'коробка'), 'коробок');
  assert.strictEqual(P.plural(11, 'коробка'), 'коробок');
  assert.strictEqual(P.plural(21, 'коробка'), 'коробка');
  assert.strictEqual(P.plural(2.5, 'коробка'), 'коробки');
  assert.strictEqual(P.plural(5, 'бушель'), 'бушель', 'незнакомую единицу коверкать нельзя');

  /* Английские единицы идут по той же таблице: одна форма для 1,
     другая для всего остального. */
  assert.strictEqual(P.plural(1, 'box'), 'box');
  assert.strictEqual(P.plural(3, 'box'), 'boxes');
  assert.strictEqual(P.plural(10, 'box'), 'boxes');
  assert.strictEqual(P.plural(2.5, 'bag'), 'bags');
});

check('weekdayOf и переход через границу месяца', function () {
  assert.strictEqual(P.weekdayOf(MONDAY).key, 'mon');
  assert.strictEqual(P.weekdayOf(SUNDAY).key, 'sun');
  assert.strictEqual(P.shiftISO('2026-08-31', 1), '2026-09-01');
  assert.strictEqual(P.shiftISO('2026-01-01', -1), '2025-12-31');
});

/* ---------- смены и перерывы ---------- */

check('смены сходятся с выгрузкой Clockify', function () {
  var cfg = P.defaultConfig();
  /* Крис 09:30–16:50 минус мини-брейк 10 и перерыв 20 = 6 ч 50 мин */
  assert.strictEqual(P.capacityOf(cfg, staff(cfg, 'kris')), 410);
  /* Ева 10:00–16:50 минус те же 30 минут = 6 ч 20 мин */
  assert.strictEqual(P.capacityOf(cfg, staff(cfg, 'eva')), 380);
});

check('перерыв достаётся только своим', function () {
  var cfg = P.defaultConfig();
  var kris = P.breaksOf(cfg, staff(cfg, 'kris')).map(function (b) { return P.fmt(b.start); });
  var eva = P.breaksOf(cfg, staff(cfg, 'eva')).map(function (b) { return P.fmt(b.start); });

  assert.deepStrictEqual(kris, ['11:50', '13:30'], 'у Криса мини-брейк и перерыв в 13:30');
  assert.deepStrictEqual(eva, ['11:50', '14:00'], 'у Евы мини-брейк и перерыв в 14:00');
});

check('у каждого своё начало смены', function () {
  var cfg = P.defaultConfig();
  assert.strictEqual(P.fmt(P.shiftOf(cfg, staff(cfg, 'kris')).start), '09:30');
  assert.strictEqual(P.fmt(P.shiftOf(cfg, staff(cfg, 'eva')).start), '10:00');
});

/* ---------- два способа расчёта ---------- */

check('mode time — длительность берётся как есть, количество не влияет', function () {
  var cfg = P.defaultConfig();
  assert.strictEqual(P.durationOf(cfg, { taskId: 'sort', mode: 'time', duration: 150, qty: 9999 }), 150);
});

check('mode volume — количество × норма', function () {
  var cfg = P.defaultConfig();
  cfg.tasks.filter(function (t) { return t.id === 'pack'; })[0].byProduct['frooties:2lb'] = 1;
  var block = { taskId: 'pack', productId: 'frooties', packSize: '2lb', mode: 'volume', qty: 180 };
  assert.strictEqual(P.durationOf(cfg, block), 180);
});

check('mode volume — округление вверх до 5 минут, ноль остаётся нулём', function () {
  var cfg = P.defaultConfig();
  cfg.tasks.filter(function (t) { return t.id === 'pack'; })[0].byProduct['starburst:1lb'] = 0.75;
  var b = { taskId: 'pack', productId: 'starburst', packSize: '1lb', mode: 'volume', qty: 101 };
  assert.strictEqual(P.durationOf(cfg, b), 80, '101 × 0,75 = 75,75 → 80');
  assert.strictEqual(P.durationOf(cfg, { taskId: 'pack', productId: 'starburst', packSize: '1lb', mode: 'volume', qty: 0 }), 0);
});

/* ---------- нормы по товару ---------- */

check('норма ищется от частного к общему', function () {
  var cfg = P.defaultConfig();
  var pack = cfg.tasks.filter(function (t) { return t.id === 'pack'; })[0];
  pack.minPerUnit = 9;
  pack.byProduct = { jolly: 4, 'jolly:5lb': 7 };

  assert.strictEqual(P.normFor(cfg, { taskId: 'pack', productId: 'jolly', packSize: '5lb' }), 7, 'товар + фасовка');
  assert.strictEqual(P.normFor(cfg, { taskId: 'pack', productId: 'jolly', packSize: '2lb' }), 4, 'товар');
  assert.strictEqual(P.normFor(cfg, { taskId: 'pack', productId: 'frooties', packSize: '2lb' }), 9, 'базовая');
  assert.strictEqual(P.normFor(cfg, { taskId: 'pack' }), 9, 'товар не указан');
});

check('у нормы своя единица: Starburst в коробках, Jolly в пакетах', function () {
  var cfg = P.defaultConfig();
  var sb = P.normOf(cfg, { taskId: 'sort', productId: 'starburst' });
  var jr = P.normOf(cfg, { taskId: 'sort', productId: 'jolly' });

  assert.strictEqual(sb.unit, 'box');
  assert.strictEqual(sb.min, 15, '4 коробки в час');
  assert.strictEqual(jr.unit, 'bag');
  /* 10–11 пакетов в час → около 5,7 минуты на пакет */
  assert.ok(jr.min > 5 && jr.min < 6.5, 'норма Jolly должна быть около 5,7 мин на пакет');
});

check('выработка за отведённое время', function () {
  var cfg = P.defaultConfig();
  var sb = P.expectedOutput(cfg, { taskId: 'sort', productId: 'starburst', mode: 'time', duration: 150 });
  assert.strictEqual(sb.qty, 10, '2,5 часа Starburst = 10 коробок');
  assert.strictEqual(sb.unit, 'boxes');

  var jr = P.expectedOutput(cfg, { taskId: 'sort', productId: 'jolly', mode: 'time', duration: 150 });
  assert.ok(jr.qty > 25 && jr.qty < 27, '2,5 часа Jolly ≈ 26 пакетов, получено ' + jr.qty);
  /* 26,3 — дробное, значит родительный падеж единственного числа */
  assert.strictEqual(jr.unit, 'bags');
});

check('у задачи по количеству выработки нет', function () {
  var cfg = P.defaultConfig();
  assert.strictEqual(P.expectedOutput(cfg, { taskId: 'pack', mode: 'volume', qty: 10 }), null);
});

/* ---------- товары и коробки ---------- */

check('таблица склада: пакетов в коробке', function () {
  var cfg = P.defaultConfig();
  /* Frooties 2 lb — 18 пакетов в коробке, они уходят на TikTok */
  assert.strictEqual(P.packOf(cfg, { productId: 'frooties', packSize: '2lb' }).bagsPerBox, 18);
  assert.strictEqual(P.packOf(cfg, { productId: 'jolly', packSize: '2lb' }).bagsPerBox, 21);
  assert.strictEqual(P.packOf(cfg, { productId: 'starburst', packSize: '1lb' }).bagsPerBox, 36);
});

check('пакеты пересчитываются в коробки', function () {
  var cfg = P.defaultConfig();
  var b = { productId: 'frooties', packSize: '2lb' };
  assert.strictEqual(P.boxesFromBags(cfg, b, 180), 10, '180 пакетов по 18 = 10 коробок');
  assert.strictEqual(P.boxesFromBags(cfg, b, 181), 11, 'неполная коробка всё равно коробка');
  /* Незаполненная строка таблицы не должна выдавать выдуманное число */
  assert.strictEqual(P.boxesFromBags(cfg, { productId: 'jolly', packSize: '5lb' }, 100), null);
});

check('входящая коробка и коробка на отгрузку — разные вещи', function () {
  var cfg = P.defaultConfig();
  var sb = cfg.products.filter(function (p) { return p.id === 'starburst'; })[0];
  assert.strictEqual(sb.inbound.perBox, 6, 'от производителя 6 × 50 oz');
  assert.strictEqual(sb.packs[0].bagsPerBox, 36, 'на отгрузку 36 пакетов по 1 lb');
});

check('паллета — 28 коробок', function () {
  assert.strictEqual(P.palletSize(P.defaultConfig()), 28);
});

check('подпись работы включает товар, фасовку и цвет', function () {
  var cfg = P.defaultConfig();
  assert.strictEqual(P.blockTitle(cfg, { taskId: 'sort', productId: 'starburst' }), 'Colour sorting · Starburst');
  assert.strictEqual(
    P.blockTitle(cfg, { taskId: 'pack', productId: 'jolly', packSize: '2lb', variant: 'Watermelon' }),
    'Weighing / bagging · Jolly Rancher 2 lb · Watermelon'
  );
  assert.strictEqual(P.blockTitle(cfg, { taskId: 'clean' }), 'Warehouse tidy-up');
});

/* ---------- деление объёма ---------- */

check('объём делится между исполнителями без потери единиц', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(MONDAY);
  day.blocks = [
    { id: 'a', staffId: 'kris', taskId: 'pack', productId: 'frooties', packSize: '2lb', mode: 'volume', share: 1, qty: 0 },
    { id: 'b', staffId: 'eva', taskId: 'pack', productId: 'frooties', packSize: '2lb', mode: 'volume', share: 1, qty: 0 },
    { id: 'c', staffId: 'toni', taskId: 'pack', productId: 'frooties', packSize: '2lb', mode: 'volume', share: 1, qty: 0 }
  ];
  day.volumes = {};
  day.volumes[P.volumeKey(day.blocks[0])] = 400;
  P.applyVolumes(cfg, day);
  assert.strictEqual(day.blocks.reduce(function (s, b) { return s + b.qty; }, 0), 400);
});

check('share задаёт неравные доли', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(MONDAY);
  day.blocks = [
    { id: 'a', staffId: 'kris', taskId: 'pack', productId: 'frooties', packSize: '2lb', mode: 'volume', share: 3, qty: 0 },
    { id: 'b', staffId: 'eva', taskId: 'pack', productId: 'frooties', packSize: '2lb', mode: 'volume', share: 1, qty: 0 }
  ];
  day.volumes = {};
  day.volumes[P.volumeKey(day.blocks[0])] = 400;
  P.applyVolumes(cfg, day);
  assert.strictEqual(day.blocks[0].qty, 300);
  assert.strictEqual(day.blocks[1].qty, 100);
});

check('объём разных товаров и цветов не смешивается', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(MONDAY);
  day.blocks = [
    { id: 'a', staffId: 'kris', taskId: 'pack', productId: 'frooties', packSize: '2lb', mode: 'volume', share: 1, qty: 0 },
    { id: 'b', staffId: 'eva', taskId: 'pack', productId: 'starburst', packSize: '1lb', mode: 'volume', share: 1, qty: 0 },
    { id: 'c', staffId: 'toni', taskId: 'pack', productId: 'jolly', packSize: '2lb', variant: 'Grape', mode: 'volume', share: 1, qty: 0 }
  ];
  day.volumes = {};
  day.volumes[P.volumeKey(day.blocks[0])] = 100;
  day.volumes[P.volumeKey(day.blocks[1])] = 300;
  day.volumes[P.volumeKey(day.blocks[2])] = 50;
  P.applyVolumes(cfg, day);

  assert.strictEqual(day.blocks[0].qty, 100);
  assert.strictEqual(day.blocks[1].qty, 300);
  assert.strictEqual(day.blocks[2].qty, 50);
});

/* ---------- шаблон недели ---------- */

check('materialize разворачивает шаблон нужного дня недели', function () {
  var cfg = P.defaultConfig();
  var day = freshDay(TUESDAY, cfg);
  assert.ok(day.blocks.length > 0, 'вторник должен быть заполнен');
  assert.ok(day.blocks.some(function (b) { return b.taskId === 'sort'; }), 'вторник начинается с переборки');
});

check('выходной по шаблону даёт пустой день, а не ошибку', function () {
  var cfg = P.defaultConfig();
  var day = freshDay(SUNDAY, cfg);
  assert.deepStrictEqual(day.blocks, []);
  assert.strictEqual(P.schedule(cfg, day).totals.plannedMin, 0);
});

check('у блоков дня свои id — правка дня не трогает шаблон', function () {
  var cfg = P.defaultConfig();
  var day = freshDay(TUESDAY, cfg);
  var tplIds = cfg.templates.tue.map(function (t) { return t.id; });
  day.blocks.forEach(function (b) {
    assert.ok(tplIds.indexOf(b.id) < 0, 'id блока дня совпал с id шаблона');
  });
});

/* ---------- отсутствие и перераспределение ---------- */

check('человек не вышел — его работа уходит другим, ничего не теряется', function () {
  var cfg = P.defaultConfig();
  var day = freshDay(TUESDAY, cfg);
  fillVolumes(cfg, day, 60);

  var before = day.blocks.length;
  assert.ok(day.blocks.filter(function (b) { return b.staffId === 'eva'; }).length > 0);

  day.absent = ['eva'];
  P.applyAbsence(cfg, day);

  assert.strictEqual(day.blocks.length, before, 'блоки не должны исчезать');
  assert.strictEqual(day.blocks.filter(function (b) { return b.staffId === 'eva'; }).length, 0);
  assert.ok(day.blocks.every(function (b) { return b.staffId; }), 'все задачи должны иметь исполнителя');
  assert.ok(day.blocks.some(function (b) { return b.fromStaffId === 'eva'; }), 'должно быть видно, чьи это были задачи');
});

check('перераспределение выравнивает нагрузку', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  day.blocks = [1, 2, 3, 4].map(function (n) {
    return { id: String(n), staffId: 'eva', taskId: 'sort', productId: 'starburst', mode: 'time', duration: 60, status: 'planned' };
  });
  day.absent = ['eva'];
  P.applyAbsence(cfg, day);

  var load = {};
  day.blocks.forEach(function (b) { load[b.staffId] = (load[b.staffId] || 0) + b.duration; });
  /* Айсулу в отпуске — остаются Крис и Тони, по два часа каждому. */
  assert.deepStrictEqual(Object.keys(load).sort(), ['kris', 'toni']);
  assert.strictEqual(load.kris, 120);
  assert.strictEqual(load.toni, 120);
});

check('важность направления решает, что раздаётся первым', function () {
  var cfg = P.defaultConfig();
  /* Amazon и заказы — первый приоритет, Walmart — последний */
  assert.strictEqual(P.priorityOf(cfg, { taskId: 'pack', dest: 'amazon' }), 1);
  assert.strictEqual(P.priorityOf(cfg, { taskId: 'pack', dest: 'orders' }), 1);
  assert.strictEqual(P.priorityOf(cfg, { taskId: 'pack', dest: 'tiktok' }), 2);
  assert.strictEqual(P.priorityOf(cfg, { taskId: 'pack', dest: 'walmart' }), 3);
});

check('навыки соблюдаются, а нарушение видно', function () {
  var cfg = P.defaultConfig();
  staff(cfg, 'kris').skills = ['pack'];
  staff(cfg, 'toni').skills = ['pack'];

  var day = P.emptyDay(TUESDAY);
  day.blocks = [{ id: '1', staffId: 'eva', taskId: 'ship', mode: 'time', duration: 60 }];
  day.absent = ['eva'];
  P.applyAbsence(cfg, day);

  assert.ok(day.blocks[0].staffId, 'работа не должна повиснуть без исполнителя');
  assert.ok(day.blocks[0].warn, 'должно быть предупреждение: задача вне навыков');
});

check('человек вернулся — задачи возвращаются ему', function () {
  var cfg = P.defaultConfig();
  var day = freshDay(TUESDAY, cfg);
  var evaIds = day.blocks.filter(function (b) { return b.staffId === 'eva'; }).map(function (b) { return b.id; });

  day.absent = ['eva'];
  P.applyAbsence(cfg, day);
  day.absent = [];
  P.applyAbsence(cfg, day);

  evaIds.forEach(function (id) {
    var b = day.blocks.filter(function (x) { return x.id === id; })[0];
    assert.strictEqual(b.staffId, 'eva', 'задача не вернулась исходному исполнителю');
    assert.strictEqual(b.fromStaffId, null, 'след перераспределения должен сняться');
  });
});

check('сотрудник в отпуске в раздачу не попадает', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  day.blocks = [{ id: '1', staffId: 'eva', taskId: 'pack', mode: 'time', duration: 60 }];
  day.absent = ['eva'];
  P.applyAbsence(cfg, day);
  assert.notStrictEqual(day.blocks[0].staffId, 'aisulu', 'Айсулу в отпуске, работу получать не должна');
});

check('никого нет — работа видна как непереданная, а не исчезает', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  day.blocks = [{ id: '1', staffId: 'eva', taskId: 'pack', mode: 'time', duration: 60 }];
  day.absent = ['kris', 'eva', 'toni'];
  P.applyAbsence(cfg, day);

  assert.strictEqual(day.blocks[0].staffId, null);
  var s = P.schedule(cfg, day);
  assert.strictEqual(s.unassigned.length, 1);
  assert.ok(s.warnings.some(function (w) { return w.level === 'error'; }));
});

/* ---------- раскладка по времени ---------- */

check('блоки идут подряд от начала смены каждого', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  day.blocks = [
    { id: '1', staffId: 'kris', taskId: 'sort', mode: 'time', duration: 60 },
    { id: '2', staffId: 'kris', taskId: 'sort', mode: 'time', duration: 30 },
    { id: '3', staffId: 'eva', taskId: 'sort', mode: 'time', duration: 60 }
  ];
  var view = P.schedule(cfg, day);
  var k = lane(view, 'kris');
  assert.strictEqual(P.fmt(k.items[0].start), '09:30');
  assert.strictEqual(P.fmt(k.items[0].end), '10:30');
  assert.strictEqual(P.fmt(k.items[1].start), '10:30');
  /* Ева выходит в 10:00, а не в 9:30 */
  assert.strictEqual(P.fmt(lane(view, 'eva').items[0].start), '10:00');
});

check('перерыв сдвигает конец задачи, а не отменяет её', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  /* 09:30 + 2,5 часа = 12:00, но мини-брейк 11:50–12:00 внутри → 12:10 */
  day.blocks = [{ id: '1', staffId: 'kris', taskId: 'sort', mode: 'time', duration: 150 }];
  var item = lane(P.schedule(cfg, day), 'kris').items[0];
  assert.strictEqual(P.fmt(item.end), '12:10');
  assert.strictEqual(item.crossedBreak, 'Short break');
});

check('чужой перерыв на человека не влияет', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  /* Ева с 10:00 на 3 часа: её перерыв в 14:00, значит задевает только
     общий мини-брейк 11:50 → конец 13:10, а не 13:30 */
  day.blocks = [{ id: '1', staffId: 'eva', taskId: 'sort', mode: 'time', duration: 180 }];
  assert.strictEqual(P.fmt(lane(P.schedule(cfg, day), 'eva').items[0].end), '13:10');
});

check('задача, назначенная на время перерыва, ждёт его конца', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  /* 13:35 приходится на перерыв Криса 13:30–13:50 */
  day.blocks = [{ id: '1', staffId: 'kris', taskId: 'ship', mode: 'time', duration: 30, pinnedStart: '13:35' }];
  assert.strictEqual(P.fmt(lane(P.schedule(cfg, day), 'kris').items[0].start), '13:50');
});

check('задача, накрывающая оба перерыва, удлиняется на оба', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  /* 09:30 + 4 часа = 13:30, плюс мини-брейк 10 мин и перерыв 20 мин */
  day.blocks = [{ id: '1', staffId: 'kris', taskId: 'sort', mode: 'time', duration: 240 }];
  assert.strictEqual(P.fmt(lane(P.schedule(cfg, day), 'kris').items[0].end), '14:00');
});

check('pinnedStart прибивает задачу ко времени', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  day.blocks = [{ id: '1', staffId: 'kris', taskId: 'ship', mode: 'time', duration: 60, pinnedStart: '15:00' }];
  assert.strictEqual(P.fmt(lane(P.schedule(cfg, day), 'kris').items[0].start), '15:00');
});

check('переполненная смена помечается, а не обрезается', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  day.blocks = [{ id: '1', staffId: 'kris', taskId: 'ship', mode: 'time', duration: 600 }];
  var s = P.schedule(cfg, day);
  assert.ok(lane(s, 'kris').overMin > 0, 'перегруз должен считаться');
  assert.ok(lane(s, 'kris').items[0].overtime);
  assert.ok(s.warnings.some(function (w) { return w.code === 'overloaded'; }));
});

check('долгая сидячая работа подряд помечается', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay(TUESDAY);
  day.blocks = [
    { id: '1', staffId: 'kris', taskId: 'sort', productId: 'starburst', mode: 'time', duration: 120 },
    { id: '2', staffId: 'kris', taskId: 'sort', productId: 'starburst', mode: 'time', duration: 120 }
  ];
  var s = P.schedule(cfg, day);
  assert.strictEqual(lane(s, 'kris').sittingStreak, 240);
  assert.ok(s.warnings.some(function (w) { return w.code === 'sittingStreak'; }));
});

check('отпускник не попадает в сводку доступных', function () {
  var cfg = P.defaultConfig();
  var s = P.schedule(cfg, freshDay(TUESDAY, cfg));
  assert.strictEqual(s.totals.people, 3, 'на месте должны быть трое из четырёх');
  assert.strictEqual(lane(s, 'aisulu').vacation, true);
  assert.strictEqual(lane(s, 'aisulu').available, false);
});

/* ---------- распределение задания ---------- */

function normedConfig() {
  var cfg = P.defaultConfig();
  var pack = cfg.tasks.filter(function (t) { return t.id === 'pack'; })[0];
  pack.byProduct['frooties:2lb'] = 1;
  pack.byProduct['jolly:2lb'] = 1;
  return cfg;
}

check('задание раскидывается по людям', function () {
  var cfg = normedConfig();
  var day = P.emptyDay(TUESDAY);
  day.jobs = [P.newJob({ taskId: 'pack', productId: 'frooties', packSize: '2lb', qty: 180, dest: 'tiktok' })];
  P.autoAssign(cfg, day);

  var mine = day.blocks.filter(function (b) { return b.taskId === 'pack'; });
  assert.ok(mine.length > 0, 'задание должно превратиться в блоки');
  assert.strictEqual(mine.reduce(function (s, b) { return s + b.qty; }, 0), 180, 'количество не должно потеряться');
  assert.ok(mine.every(function (b) { return b.staffId; }), 'у каждого блока должен быть исполнитель');
});

check('большая работа делится между людьми, а не вешается на одного', function () {
  var cfg = normedConfig();
  var day = P.emptyDay(TUESDAY);
  /* 900 пакетов по минуте — заведомо больше одной смены */
  day.jobs = [P.newJob({ taskId: 'pack', productId: 'frooties', packSize: '2lb', qty: 900, dest: 'amazon' })];
  P.autoAssign(cfg, day);

  var owners = {};
  day.blocks.filter(function (b) { return b.taskId === 'pack'; })
    .forEach(function (b) { owners[b.staffId] = true; });
  assert.ok(Object.keys(owners).length >= 2, 'работа должна разойтись минимум на двоих');
});

check('на сидячей работе не держат дольше лимита подряд', function () {
  var cfg = P.defaultConfig();
  cfg.rules.fillTask = '';       // чтобы добивка не мешала считать
  var day = P.emptyDay(TUESDAY);
  /* Переборка на весь день одному человеку невозможна: лимит 3 часа */
  day.jobs = [P.newJob({ taskId: 'sort', productId: 'starburst', mode: 'time', duration: 600, dest: 'bulk' })];
  P.autoAssign(cfg, day);

  var perStaff = {};
  day.blocks.forEach(function (b) {
    perStaff[b.staffId] = (perStaff[b.staffId] || 0) + b.duration;
  });
  Object.keys(perStaff).forEach(function (id) {
    assert.ok(perStaff[id] <= cfg.rules.maxSittingStreak,
      id + ' получил ' + perStaff[id] + ' мин сидячей работы подряд при лимите ' + cfg.rules.maxSittingStreak);
  });
});

check('важное раздаётся раньше неважного', function () {
  var cfg = normedConfig();
  cfg.rules.fillTask = '';
  var day = P.emptyDay(TUESDAY);
  day.jobs = [
    P.newJob({ taskId: 'pack', productId: 'jolly', packSize: '2lb', qty: 600, dest: 'walmart' }),
    P.newJob({ taskId: 'pack', productId: 'frooties', packSize: '2lb', qty: 600, dest: 'amazon' })
  ];
  P.autoAssign(cfg, day);

  var amazon = day.blocks.filter(function (b) { return b.dest === 'amazon'; })
    .reduce(function (s, b) { return s + b.qty; }, 0);
  var walmart = day.blocks.filter(function (b) { return b.dest === 'walmart'; })
    .reduce(function (s, b) { return s + b.qty; }, 0);

  assert.strictEqual(amazon, 600, 'Amazon должен уйти в план целиком');
  assert.ok(walmart < 600, 'Walmart должен резаться первым');
  assert.ok(day.overflow.length > 0, 'непоместившееся должно остаться списком, а не пропасть');
  assert.strictEqual(day.overflow[0].dest, 'walmart');
});

check('что не влезло — видно в предупреждениях', function () {
  var cfg = normedConfig();
  var day = P.emptyDay(TUESDAY);
  day.jobs = [P.newJob({ taskId: 'pack', productId: 'frooties', packSize: '2lb', qty: 5000, dest: 'amazon' })];
  P.autoAssign(cfg, day);
  var s = P.schedule(cfg, day);
  assert.ok(s.warnings.some(function (w) { return w.code === 'overflow'; }));
});

check('свободное время добивается переборкой', function () {
  var cfg = normedConfig();
  var day = P.emptyDay(TUESDAY);
  day.jobs = [P.newJob({ taskId: 'pack', productId: 'frooties', packSize: '2lb', qty: 30, dest: 'tiktok' })];
  P.autoAssign(cfg, day);

  var fill = day.blocks.filter(function (b) { return b.origin === 'fill'; });
  assert.ok(fill.length > 0, 'остаток смены должен уходить на подготовку балка');
  assert.ok(fill.every(function (b) { return b.taskId === 'sort'; }));
  assert.ok(fill.every(function (b) { return b.dest === 'bulk'; }));
});

check('никого нет — задание целиком остаётся невыполненным, но не теряется', function () {
  var cfg = normedConfig();
  var day = P.emptyDay(TUESDAY);
  day.absent = ['kris', 'eva', 'toni'];
  day.jobs = [P.newJob({ taskId: 'pack', productId: 'frooties', packSize: '2lb', qty: 100 })];
  P.autoAssign(cfg, day);

  assert.strictEqual(day.blocks.length, 0);
  assert.strictEqual(day.overflow.length, 1);
});

check('распределение учитывает, кого сегодня нет', function () {
  var cfg = normedConfig();
  var day = P.emptyDay(TUESDAY);
  day.absent = ['eva'];
  day.jobs = [P.newJob({ taskId: 'pack', productId: 'frooties', packSize: '2lb', qty: 200, dest: 'amazon' })];
  P.autoAssign(cfg, day);

  assert.ok(day.blocks.length > 0);
  assert.ok(day.blocks.every(function (b) { return b.staffId !== 'eva' && b.staffId !== 'aisulu'; }),
    'работа не должна попадать на отсутствующих');
});

/* ---------- сквозной сценарий ---------- */

check('сквозной день: задание → план → кто-то не вышел → пересчёт', function () {
  var cfg = normedConfig();
  var day = P.emptyDay(TUESDAY);
  day.jobs = [
    P.newJob({ taskId: 'pack', productId: 'frooties', packSize: '2lb', qty: 180, dest: 'tiktok' }),
    P.newJob({ taskId: 'sort', productId: 'starburst', mode: 'time', duration: 150, dest: 'bulk' })
  ];
  P.autoAssign(cfg, day);
  var before = P.schedule(cfg, day);

  assert.ok(before.totals.plannedMin > 0);
  assert.strictEqual(before.totals.people, 3);
  assert.strictEqual(before.unassigned.length, 0);

  var work = day.blocks.reduce(function (s, b) { return s + P.durationOf(cfg, b); }, 0);

  day.absent = ['toni'];
  P.applyAbsence(cfg, day);
  var after = P.schedule(cfg, day);

  assert.strictEqual(after.totals.people, 2, 'на месте остаются двое');
  assert.strictEqual(after.unassigned.length, 0, 'вся работа распределена');
  assert.strictEqual(
    day.blocks.reduce(function (s, b) { return s + P.durationOf(cfg, b); }, 0), work,
    'объём работы от чужого отсутствия не меняется'
  );
});

/* ---------- отметка прихода ---------- */

check('до начала смены человека ждём, а не считаем прогульщиком', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  var kris = cfg.staff[0];                       // смена с 09:30
  /* 09:00 — ещё никто не дошёл до планшета, и это нормально. */
  assert.strictEqual(P.attendanceOf(cfg, day, kris, 9 * 60), 'expected');
  assert.ok(P.isAvailable(kris, day, 9 * 60, cfg), 'работу на него планируем');
});

check('пауза ожидания даёт дойти до планшета', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  var kris = cfg.staff[0];
  var start = P.hhmm(kris.shift.start);
  /* Начало смены и почти вся пауза — всё ещё ждём. */
  assert.strictEqual(P.attendanceOf(cfg, day, kris, start), 'expected');
  assert.strictEqual(P.attendanceOf(cfg, day, kris, start + P.CLOCK_IN_GRACE_MIN - 1), 'expected');
  /* Пауза вышла — не вышел на работу. */
  assert.strictEqual(P.attendanceOf(cfg, day, kris, start + P.CLOCK_IN_GRACE_MIN), 'noshow');
});

check('не отметился после паузы — работа на него не планируется', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  var kris = cfg.staff[0];
  var late = P.hhmm(kris.shift.start) + P.CLOCK_IN_GRACE_MIN + 5;
  assert.ok(!P.isAvailable(kris, day, late, cfg));
});

check('отметился — на смене, и время нажатия сохранено как есть', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  var kris = cfg.staff[0];
  var at = '2026-08-05T09:34:12.000Z';

  P.clockIn(day, kris.id, at);
  assert.strictEqual(P.firstIn(day.attendance[kris.id]), at, 'момент нажатия округлять нельзя — он идёт в табель');
  var late = P.hhmm(kris.shift.start) + P.CLOCK_IN_GRACE_MIN + 5;
  assert.strictEqual(P.attendanceOf(cfg, day, kris, late), 'in');
  assert.ok(P.isAvailable(kris, day, late, cfg));
});

check('второе нажатие «пришёл» не переписывает время прихода', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, 'kris', '2026-08-05T09:30:00.000Z');
  P.clockIn(day, 'kris', '2026-08-05T11:00:00.000Z');
  assert.strictEqual(P.sessionsOf(day.attendance.kris).length, 1, 'вторая смена начаться не должна');
  assert.strictEqual(P.firstIn(day.attendance.kris), '2026-08-05T09:30:00.000Z');
});

check('закрыл смену — из плана выпадает, отработанное считается', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  var kris = cfg.staff[0];

  P.clockIn(day, kris.id, '2026-08-05T09:30:00.000Z');
  P.clockOut(day, kris.id, '2026-08-05T16:50:00.000Z');

  assert.strictEqual(P.attendanceOf(cfg, day, kris, 12 * 60), 'out');
  assert.ok(!P.isAvailable(kris, day, 12 * 60, cfg), 'ушедшему работу не планируем');
  assert.strictEqual(P.workedMinutes(day, kris.id), 440, '7 ч 20 мин между отметками');
});

check('незакрытая смена не даёт выдуманных часов', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, 'kris', '2026-08-05T09:30:00.000Z');
  assert.strictEqual(P.workedMinutes(day, 'kris'), null, 'пока не ушёл — часов нет, а не ноль');
});

check('уход нельзя отметить, не отметив приход', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockOut(day, 'kris', '2026-08-05T16:50:00.000Z');
  assert.ok(!day.attendance.kris, 'записи быть не должно');
});

check('приход снимает отметку менеджера об отсутствии', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  var kris = cfg.staff[0];
  day.absent = [kris.id];
  assert.strictEqual(P.attendanceOf(cfg, day, kris, 10 * 60), 'absent');

  /* Человек всё-таки пришёл — факт с планшета важнее вчерашнего плана. */
  P.clockIn(day, kris.id, '2026-08-05T10:00:00.000Z');
  assert.strictEqual(P.attendanceOf(cfg, day, kris, 10 * 60), 'in');
  assert.ok(P.isAvailable(kris, day, 10 * 60, cfg));
});

check('отпуск и увольнение отметкой не перебиваются', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  var vac = cfg.staff.filter(function (s) { return s.status === 'vacation'; })[0];
  assert.strictEqual(P.attendanceOf(cfg, day, vac, 10 * 60), 'vacation');
  assert.ok(!P.isAvailable(vac, day, 10 * 60, cfg));
});

check('работа неявившегося уходит остальным', function () {
  var cfg = P.defaultConfig();
  var day = P.materialize(cfg, P.emptyDay('2026-08-05'));
  var kris = cfg.staff[0];

  var mine = day.blocks.filter(function (b) { return b.staffId === kris.id; });
  assert.ok(mine.length, 'для проверки нужна хотя бы одна задача на нём');

  /* Не отметился — менеджер нажимает «нет на работе», план пересобирается. */
  day.absent = [kris.id];
  P.applyAbsence(cfg, day);

  var still = day.blocks.filter(function (b) { return b.staffId === kris.id; });
  assert.strictEqual(still.length, 0, 'на отсутствующем задач остаться не должно');
  assert.ok(day.blocks.every(function (b) { return b.staffId || b.warn; }),
    'задача либо у кого-то, либо помечена — потеряться она не может');
});

check('не отметился к концу паузы — его работа уходит остальным сама', function () {
  var cfg = P.defaultConfig();
  var day = P.materialize(cfg, P.emptyDay('2026-08-05'));
  var kris = cfg.staff[0];

  /* Остальные отметились, Крис — нет. */
  cfg.staff.forEach(function (s) {
    if (s.id !== kris.id && s.status === 'active') P.clockIn(day, s.id, '2026-08-05T10:00:00.000Z');
  });

  var before = day.blocks.filter(function (b) { return b.staffId === kris.id; }).length;
  assert.ok(before > 0, 'для проверки нужна работа на Крисе');

  var late = P.hhmm(kris.shift.start) + P.CLOCK_IN_GRACE_MIN + 5;
  P.applyAbsence(cfg, day, late);

  assert.strictEqual(
    day.blocks.filter(function (b) { return b.staffId === kris.id; }).length, 0,
    'на неявившемся задач остаться не должно');
  assert.ok(day.blocks.every(function (b) { return b.staffId || b.warn; }),
    'работа не должна пропасть');
});

check('пока пауза не вышла, план не трогают', function () {
  var cfg = P.defaultConfig();
  var day = P.materialize(cfg, P.emptyDay('2026-08-05'));
  var kris = cfg.staff[0];
  var before = day.blocks.filter(function (b) { return b.staffId === kris.id; }).length;

  /* 09:35 — пауза ещё идёт, человек может просто не дойти до планшета. */
  P.applyAbsence(cfg, day, P.hhmm(kris.shift.start) + 5);

  assert.strictEqual(day.blocks.filter(function (b) { return b.staffId === kris.id; }).length, before,
    'до конца паузы работу забирать нельзя');
});

/* ---------- перерывы и табель ---------- */

check('перерыв не снимает человека с работы', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  var kris = cfg.staff[0];

  P.clockIn(day, kris.id, '2026-08-05T09:30:00.000Z');
  P.breakStart(day, kris.id, '2026-08-05T11:50:00.000Z');

  assert.strictEqual(P.attendanceOf(cfg, day, kris, 12 * 60), 'break');
  assert.ok(P.isAvailable(kris, day, 12 * 60, cfg), 'он вернётся — работу снимать нельзя');
});

check('перерыв оплачивается: из отработанного не вычитается', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, 'kris', '2026-08-05T09:00:00.000Z');
  P.breakStart(day, 'kris', '2026-08-05T12:00:00.000Z');
  P.breakEnd(day, 'kris', '2026-08-05T12:30:00.000Z');
  P.clockOut(day, 'kris', '2026-08-05T17:00:00.000Z');

  assert.strictEqual(P.breakMinutes(day, 'kris'), 30, 'перерыв виден отдельно');
  assert.strictEqual(P.workedMinutes(day, 'kris'), 480, 'с 09:00 до 17:00 целиком');
});

check('неоплачиваемые перерывы вычитаются, если так настроено', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, 'kris', '2026-08-05T09:00:00.000Z');
  P.breakStart(day, 'kris', '2026-08-05T12:00:00.000Z');
  P.breakEnd(day, 'kris', '2026-08-05T12:30:00.000Z');
  P.clockOut(day, 'kris', '2026-08-05T17:00:00.000Z');

  assert.strictEqual(P.workedMinutes(day, 'kris', false), 450, '8 часов минус полчаса');
});

check('оплата перерывов — настройка, а не зашитое правило', function () {
  var cfg = P.defaultConfig();
  assert.strictEqual(P.paidBreaks(cfg), true, 'на этом складе перерывы оплачиваются');

  cfg.rules = cfg.rules || {};
  cfg.rules.paidBreaks = false;
  assert.strictEqual(P.paidBreaks(cfg), false);
});

check('несколько перерывов складываются', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, 'kris', '2026-08-05T09:00:00.000Z');
  P.breakStart(day, 'kris', '2026-08-05T11:00:00.000Z');
  P.breakEnd(day, 'kris', '2026-08-05T11:10:00.000Z');
  P.breakStart(day, 'kris', '2026-08-05T13:00:00.000Z');
  P.breakEnd(day, 'kris', '2026-08-05T13:20:00.000Z');
  P.clockOut(day, 'kris', '2026-08-05T17:00:00.000Z');

  assert.strictEqual(P.breakMinutes(day, 'kris'), 30);
  assert.strictEqual(P.workedMinutes(day, 'kris'), 480, 'перерывы оплачиваются');
  assert.strictEqual(P.workedMinutes(day, 'kris', false), 450);
});

check('второй перерыв подряд не начинается', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, 'kris', '2026-08-05T09:00:00.000Z');
  P.breakStart(day, 'kris', '2026-08-05T11:00:00.000Z');
  P.breakStart(day, 'kris', '2026-08-05T11:05:00.000Z');
  var ses = P.sessionsOf(day.attendance.kris)[0];
  assert.strictEqual(ses.breaks.length, 1);
  assert.strictEqual(ses.breaks[0].start, '2026-08-05T11:00:00.000Z');
});

check('ушёл, не закрыв перерыв — перерыв закрывается уходом', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, 'kris', '2026-08-05T09:00:00.000Z');
  P.breakStart(day, 'kris', '2026-08-05T16:00:00.000Z');
  P.clockOut(day, 'kris', '2026-08-05T17:00:00.000Z');

  assert.strictEqual(P.sessionsOf(day.attendance.kris)[0].breaks[0].end, '2026-08-05T17:00:00.000Z',
    'иначе перерыв тянулся бы вечно');
  assert.strictEqual(P.workedMinutes(day, 'kris'), 480, 'перерыв оплачивается — вычитать нечего');
  assert.strictEqual(P.workedMinutes(day, 'kris', false), 420,
    'а при неоплачиваемых незакрытый перерыв не съедает больше часа');
});

check('перерыв нельзя начать, не отметив приход', function () {
  var day = P.emptyDay('2026-08-05');
  P.breakStart(day, 'kris', '2026-08-05T11:00:00.000Z');
  assert.ok(!day.attendance || !day.attendance.kris);
});

check('открытый перерыв растёт до текущего момента', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, 'kris', '2026-08-05T09:00:00.000Z');
  P.breakStart(day, 'kris', '2026-08-05T11:00:00.000Z');
  assert.strictEqual(P.breakMinutes(day, 'kris', '2026-08-05T11:15:00.000Z'), 15);
});

check('табель считает часы и деньги по закрытым сменам', function () {
  var cfg = P.defaultConfig();
  cfg.staff[0].rate = 20;                      // 20 в час

  var d1 = P.emptyDay('2026-08-03');
  P.clockIn(d1, cfg.staff[0].id, '2026-08-03T09:00:00.000Z');
  P.clockOut(d1, cfg.staff[0].id, '2026-08-03T17:00:00.000Z');   // 8 ч

  var d2 = P.emptyDay('2026-08-04');
  P.clockIn(d2, cfg.staff[0].id, '2026-08-04T09:00:00.000Z');
  P.breakStart(d2, cfg.staff[0].id, '2026-08-04T12:00:00.000Z');
  P.breakEnd(d2, cfg.staff[0].id, '2026-08-04T12:30:00.000Z');
  P.clockOut(d2, cfg.staff[0].id, '2026-08-04T17:00:00.000Z');   // 7,5 ч

  var rows = P.timesheet(cfg, [d1, d2]);
  var kris = rows.filter(function (r) { return r.staff.id === cfg.staff[0].id; })[0];

  assert.strictEqual(kris.workedMin, 960, '8 ч + 8 ч: перерыв внутри второго дня оплачен');
  assert.strictEqual(kris.hours, 16);
  assert.strictEqual(kris.pay, 320, '16 часов × 20');
  assert.strictEqual(kris.breakMin, 30, 'перерыв всё равно виден отдельной колонкой');
  assert.strictEqual(kris.closedDays, 2);
  assert.strictEqual(kris.paidBreaks, true);
});

check('при неоплачиваемых перерывах табель платит меньше', function () {
  var cfg = P.defaultConfig();
  cfg.staff[0].rate = 20;
  cfg.rules = cfg.rules || {};
  cfg.rules.paidBreaks = false;

  var day = P.emptyDay('2026-08-04');
  P.clockIn(day, cfg.staff[0].id, '2026-08-04T09:00:00.000Z');
  P.breakStart(day, cfg.staff[0].id, '2026-08-04T12:00:00.000Z');
  P.breakEnd(day, cfg.staff[0].id, '2026-08-04T12:30:00.000Z');
  P.clockOut(day, cfg.staff[0].id, '2026-08-04T17:00:00.000Z');

  var kris = P.timesheet(cfg, [day]).filter(function (r) { return r.staff.id === cfg.staff[0].id; })[0];
  assert.strictEqual(kris.hours, 7.5);
  assert.strictEqual(kris.pay, 150);
  assert.strictEqual(kris.paidBreaks, false);
});

check('«уже набежало» считается по тем же правилам, что и итог дня', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, cfg.staff[0].id, '2026-08-05T09:00:00.000Z');
  P.breakStart(day, cfg.staff[0].id, '2026-08-05T10:00:00.000Z');
  P.breakEnd(day, cfg.staff[0].id, '2026-08-05T10:30:00.000Z');

  var kris = P.timesheet(cfg, [day], '2026-08-05T12:00:00.000Z')
    .filter(function (r) { return r.staff.id === cfg.staff[0].id; })[0];
  assert.strictEqual(kris.openMin, 180, 'три часа целиком: перерыв оплачен');
});

check('незакрытая смена в деньги не идёт', function () {
  var cfg = P.defaultConfig();
  cfg.staff[0].rate = 20;

  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, cfg.staff[0].id, '2026-08-05T09:00:00.000Z');

  var kris = P.timesheet(cfg, [day], '2026-08-05T12:00:00.000Z')
    .filter(function (r) { return r.staff.id === cfg.staff[0].id; })[0];

  assert.strictEqual(kris.workedMin, 0, 'платить за незакончившийся день нельзя');
  assert.strictEqual(kris.pay, 0);
  assert.strictEqual(kris.openMin, 180, 'но показать «набежало 3 часа» — можно');
});

check('без ставки табель считает часы, но не деньги', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, cfg.staff[0].id, '2026-08-05T09:00:00.000Z');
  P.clockOut(day, cfg.staff[0].id, '2026-08-05T17:00:00.000Z');

  var kris = P.timesheet(cfg, [day]).filter(function (r) { return r.staff.id === cfg.staff[0].id; })[0];
  assert.strictEqual(kris.hours, 8);
  assert.strictEqual(kris.pay, 0, 'ставки нет — суммы нет, а не выдуманная');
});

check('удалённый из справочника человек табель не роняет', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  day.attendance = { ghost: { in: '2026-08-05T09:00:00.000Z', out: '2026-08-05T17:00:00.000Z', breaks: [] } };
  assert.doesNotThrow(function () { P.timesheet(cfg, [day]); });
});

check('неделя начинается с понедельника', function () {
  assert.strictEqual(P.weekStart('2026-08-05'), '2026-08-03', 'среда → понедельник той же недели');
  assert.strictEqual(P.weekStart('2026-08-03'), '2026-08-03', 'сам понедельник не двигается');
  assert.strictEqual(P.weekStart('2026-08-09'), '2026-08-03', 'воскресенье относится к прошедшей неделе');
});

/* ---------- план против факта ---------- */

check('«Начал» и «Готово» засекают время без отдельной кнопки', function () {
  var b = { id: 'b1', status: 'planned' };

  P.markProgress(b, 'active', '2026-08-05T10:00:00.000Z');
  assert.strictEqual(b.status, 'active');
  assert.strictEqual(b.startedAt, '2026-08-05T10:00:00.000Z');
  assert.strictEqual(P.actualMinutes(b), null, 'пока не закончил — факта нет');

  P.markProgress(b, 'done', '2026-08-05T11:40:00.000Z');
  assert.strictEqual(P.actualMinutes(b), 100, '1 ч 40 мин');
});

check('идущая задача показывает, сколько уже длится', function () {
  var b = { id: 'b1', status: 'planned' };
  P.markProgress(b, 'active', '2026-08-05T10:00:00.000Z');
  assert.strictEqual(P.actualMinutes(b, '2026-08-05T10:30:00.000Z'), 30);
});

check('после снятия статуса отсчёт начинается заново, а не продолжает старый', function () {
  var b = { id: 'b1', status: 'planned' };
  P.markProgress(b, 'active', '2026-08-05T10:00:00.000Z');
  P.markProgress(b, 'planned', '2026-08-05T10:05:00.000Z');
  P.markProgress(b, 'active', '2026-08-05T10:10:00.000Z');
  assert.strictEqual(b.startedAt, '2026-08-05T10:10:00.000Z',
    'снятие статуса стирает замер, и новый отсчёт честно начинается заново');
});

check('снятие статуса стирает замер, а не оставляет половину', function () {
  var b = { id: 'b1', status: 'planned' };
  P.markProgress(b, 'active', '2026-08-05T10:00:00.000Z');
  P.markProgress(b, 'done', '2026-08-05T11:00:00.000Z');
  P.markProgress(b, 'planned', '2026-08-05T11:05:00.000Z');
  assert.strictEqual(b.startedAt, null);
  assert.strictEqual(b.doneAt, null);
  assert.strictEqual(P.actualMinutes(b), null, 'незаконченный замер хуже отсутствующего');
});

check('«Готово» без «Начал» факта не выдумывает', function () {
  var b = { id: 'b1', status: 'planned' };
  P.markProgress(b, 'done', '2026-08-05T11:00:00.000Z');
  assert.strictEqual(P.actualMinutes(b), null, 'засекать не по чему — и ноль тут был бы враньём');
});

check('расхождение плана и факта считается со знаком', function () {
  var cfg = P.defaultConfig();
  var day = P.materialize(cfg, P.emptyDay('2026-08-05'));
  var b = day.blocks.filter(function (x) { return x.mode === 'time' && x.duration; })[0];
  assert.ok(b, 'для проверки нужна задача с заданным временем');

  var planned = P.durationOf(cfg, b);
  P.markProgress(b, 'active', '2026-08-05T09:00:00.000Z');
  P.markProgress(b, 'done', new Date(Date.parse('2026-08-05T09:00:00.000Z') + (planned + 25) * 60000).toISOString());

  assert.strictEqual(P.drift(cfg, b), 25, 'на 25 минут дольше плана');
});

/* ---------- очередь музыки ---------- */

check('очередь музыки считается от первого прихода', function () {
  var cfg = P.defaultConfig();
  cfg.rules = cfg.rules || {};
  cfg.rules.musicTurnMin = 120;
  cfg.staff[0].musicUrl = 'https://example.com/a';
  cfg.staff[2].musicUrl = 'https://example.com/b';

  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, cfg.staff[0].id, '2026-08-05T09:00:00.000Z');
  P.clockIn(day, cfg.staff[2].id, '2026-08-05T09:30:00.000Z');

  var first = P.musicTurn(cfg, day, '2026-08-05T10:00:00.000Z');
  assert.strictEqual(first.current.id, cfg.staff[0].id, 'первый слот у первого в списке');
  assert.strictEqual(first.next.id, cfg.staff[2].id);
  assert.strictEqual(first.minutesLeft, 60, 'до смены очереди час');

  var second = P.musicTurn(cfg, day, '2026-08-05T11:30:00.000Z');
  assert.strictEqual(second.current.id, cfg.staff[2].id, 'через два часа очередь перешла');
});

check('очередь идёт по кругу', function () {
  var cfg = P.defaultConfig();
  cfg.rules = { musicTurnMin: 60 };
  cfg.staff[0].musicUrl = 'a';
  cfg.staff[2].musicUrl = 'b';

  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, cfg.staff[0].id, '2026-08-05T09:00:00.000Z');
  P.clockIn(day, cfg.staff[2].id, '2026-08-05T09:00:00.000Z');

  assert.strictEqual(P.musicTurn(cfg, day, '2026-08-05T11:30:00.000Z').current.id, cfg.staff[0].id,
    'третий час — снова первый');
});

check('ушедший из очереди выпадает', function () {
  var cfg = P.defaultConfig();
  cfg.rules = { musicTurnMin: 120 };
  cfg.staff[0].musicUrl = 'a';
  cfg.staff[2].musicUrl = 'b';

  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, cfg.staff[0].id, '2026-08-05T09:00:00.000Z');
  P.clockIn(day, cfg.staff[2].id, '2026-08-05T09:00:00.000Z');
  P.clockOut(day, cfg.staff[0].id, '2026-08-05T13:00:00.000Z');

  var turn = P.musicTurn(cfg, day, '2026-08-05T14:00:00.000Z');
  assert.strictEqual(turn.queue.length, 1);
  assert.strictEqual(turn.current.id, cfg.staff[2].id);
});

check('без ссылок и без людей очереди нет, а не пустая карточка', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  assert.strictEqual(P.musicTurn(cfg, day, '2026-08-05T10:00:00.000Z'), null);

  P.clockIn(day, cfg.staff[0].id, '2026-08-05T09:00:00.000Z');
  assert.strictEqual(P.musicTurn(cfg, day, '2026-08-05T10:00:00.000Z'), null,
    'человек есть, ссылки нет — очередь не из чего строить');
});

check('после ухода можно вернуться в работу', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  var kris = cfg.staff[0];

  P.clockIn(day, kris.id, '2026-08-05T09:00:00.000Z');
  P.clockOut(day, kris.id, '2026-08-05T09:05:00.000Z');     // нажали случайно
  assert.strictEqual(P.attendanceOf(cfg, day, kris, 10 * 60), 'out');

  P.clockIn(day, kris.id, '2026-08-05T09:06:00.000Z');
  assert.strictEqual(P.attendanceOf(cfg, day, kris, 10 * 60), 'in', 'вернулся на смену');
  assert.ok(P.isAvailable(kris, day, 10 * 60, cfg), 'и работа снова на него планируется');
  assert.strictEqual(P.sessionsOf(day.attendance[kris.id]).length, 2);
});

check('часы за день складываются из всех отрезков', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, 'kris', '2026-08-05T09:00:00.000Z');
  P.clockOut(day, 'kris', '2026-08-05T12:00:00.000Z');      // 3 ч
  P.clockIn(day, 'kris', '2026-08-05T13:00:00.000Z');
  P.clockOut(day, 'kris', '2026-08-05T17:00:00.000Z');      // 4 ч

  assert.strictEqual(P.workedMinutes(day, 'kris'), 420, 'час между отрезками не оплачивается');
});

check('первый приход за день остаётся первым после возврата', function () {
  var day = P.emptyDay('2026-08-05');
  P.clockIn(day, 'kris', '2026-08-05T09:00:00.000Z');
  P.clockOut(day, 'kris', '2026-08-05T09:05:00.000Z');
  P.clockIn(day, 'kris', '2026-08-05T09:06:00.000Z');
  assert.strictEqual(P.firstIn(day.attendance.kris), '2026-08-05T09:00:00.000Z',
    'от него считается очередь музыки — он не должен прыгать');
});

check('записи старого вида читаются как один отрезок', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  /* Так выглядели данные до появления нескольких отрезков за день. */
  day.attendance = {
    kris: { in: '2026-08-05T09:00:00.000Z', out: '2026-08-05T17:00:00.000Z', breaks: [
      { start: '2026-08-05T12:00:00.000Z', end: '2026-08-05T12:30:00.000Z' }
    ] }
  };

  assert.strictEqual(P.workedMinutes(day, 'kris'), 480);
  assert.strictEqual(P.breakMinutes(day, 'kris'), 30);
  assert.strictEqual(P.attendanceOf(cfg, day, cfg.staff[0], 18 * 60), 'out');
});

check('возврат после ухода не ломает старую запись', function () {
  var day = P.emptyDay('2026-08-05');
  day.attendance = { kris: { in: '2026-08-05T09:00:00.000Z', out: '2026-08-05T12:00:00.000Z', breaks: [] } };

  P.clockIn(day, 'kris', '2026-08-05T13:00:00.000Z');
  P.clockOut(day, 'kris', '2026-08-05T17:00:00.000Z');

  assert.strictEqual(P.sessionsOf(day.attendance.kris).length, 2);
  assert.strictEqual(P.workedMinutes(day, 'kris'), 420, '3 ч + 4 ч');
});

/* ---------- перевозчики, фильтр товаров, коробки ---------- */

check('перевозчик берётся от площадки, но правится вручную', function () {
  var cfg = P.defaultConfig();
  assert.strictEqual(P.carrierOf(cfg, { dest: 'amazon' }), 'UPS');
  assert.strictEqual(P.carrierOf(cfg, { dest: 'walmart' }), 'FedEx');
  assert.strictEqual(P.carrierOf(cfg, { dest: 'tiktok' }), 'FedEx');
  assert.strictEqual(P.carrierOf(cfg, { dest: 'orders' }), 'USPS', 'свои заказы FBM уходят USPS');
  assert.strictEqual(P.carrierOf(cfg, { dest: 'bulk' }), '', 'в балк ничего не уезжает');

  /* Разовая отправка не тем, чем обычно, важнее умолчания. */
  assert.strictEqual(P.carrierOf(cfg, { dest: 'amazon', carrier: 'FedEx' }), 'FedEx');
});

check('на переборке предлагаются только перебираемые товары', function () {
  var cfg = P.defaultConfig();
  var forSort = P.productsForTask(cfg, 'sort');
  var all = cfg.products;

  assert.ok(forSort.length < all.length, 'список должен сузиться');
  assert.ok(forSort.every(function (p) { return p.sortable; }));
  assert.ok(forSort.some(function (p) { return p.id === 'jolly'; }));
  assert.ok(forSort.some(function (p) { return p.id === 'starburst'; }));
});

check('на остальных задачах список товаров полный', function () {
  var cfg = P.defaultConfig();
  assert.strictEqual(P.productsForTask(cfg, 'pack').length, cfg.products.length);
  assert.strictEqual(P.productsForTask(cfg, null).length, cfg.products.length,
    'без задачи — тоже полный: так его просит полный цикл');
});

check('количество можно задать в коробках, время считается верно', function () {
  var cfg = P.defaultConfig();
  /* Frooties 2 lb — 18 пакетов в коробке. */
  var inBags = { taskId: 'pack', productId: 'frooties', packSize: '2lb', mode: 'volume', qty: 180 };
  var inBoxes = { taskId: 'pack', productId: 'frooties', packSize: '2lb', mode: 'volume', qty: 10, qtyUnit: 'box' };

  assert.strictEqual(P.qtyInNormUnit(cfg, inBoxes), 180, '10 коробок × 18 = 180 пакетов');
  assert.strictEqual(P.durationOf(cfg, inBoxes), P.durationOf(cfg, inBags),
    'одна и та же работа, введённая двумя способами, должна занимать одно время');
});

check('без данных по коробке количество не выдумывается', function () {
  var cfg = P.defaultConfig();
  /* У 5 lb bagsPerBox не заполнен — множителя нет. */
  var b = { taskId: 'pack', productId: 'jolly', packSize: '5lb', mode: 'volume', qty: 7, qtyUnit: 'box' };
  assert.strictEqual(P.qtyInNormUnit(cfg, b), 7, 'лучше посчитать по введённому, чем угадать множитель');
});

/* ---------- допуск и предпочтения ---------- */

check('паллеты не уходят тем, кому нельзя', function () {
  var cfg = P.defaultConfig();
  var eva = cfg.staff.filter(function (s) { return s.id === 'eva'; })[0];
  var aisulu = cfg.staff.filter(function (s) { return s.id === 'aisulu'; })[0];
  var kris = cfg.staff.filter(function (s) { return s.id === 'kris'; })[0];
  var toni = cfg.staff.filter(function (s) { return s.id === 'toni'; })[0];

  assert.ok(!P.allowedFor(cfg, eva, 'pallet'), 'Еве паллеты не предлагаем');
  assert.ok(!P.allowedFor(cfg, aisulu, 'pallet'));
  assert.ok(P.allowedFor(cfg, kris, 'pallet'));
  assert.ok(P.allowedFor(cfg, toni, 'pallet'));
});

check('ордера остаются за Айсулу и Евой', function () {
  var cfg = P.defaultConfig();
  var byId = {};
  cfg.staff.forEach(function (s) { byId[s.id] = s; });

  assert.ok(P.allowedFor(cfg, byId.aisulu, 'orders'));
  assert.ok(P.allowedFor(cfg, byId.eva, 'orders'));
  assert.ok(!P.allowedFor(cfg, byId.kris, 'orders'), 'Крис на ордера не ставится');
  assert.ok(!P.allowedFor(cfg, byId.toni, 'orders'));
});

check('распределение не отдаёт паллеты женщинам, даже если больше некому', function () {
  var cfg = P.defaultConfig();
  /* На смене только Ева — паллеты собрать некому. */
  cfg.staff.forEach(function (s) { if (s.id !== 'eva') s.status = 'left'; });

  var day = P.emptyDay('2026-08-05');
  day.jobs = [P.newJob({ taskId: 'pallet', mode: 'volume', qty: 28, productId: 'jolly', packSize: '2lb' })];
  P.autoAssign(cfg, day);

  var pallets = (day.blocks || []).filter(function (b) { return b.taskId === 'pallet'; });
  assert.strictEqual(pallets.length, 0, 'ограничение важнее, чем закрыть задачу любой ценой');
  assert.ok((day.overflow || []).some(function (j) { return j.taskId === 'pallet'; }),
    'но работа не пропадает — она видна как невыполненная');
});

check('перераспределение тоже не нарушает жёсткий допуск', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  day.blocks = [{ id: 'p1', staffId: 'toni', taskId: 'pallet', mode: 'volume', qty: 28, status: 'planned' }];

  /* Тони и Криса нет — передать паллету некому. */
  day.absent = ['toni', 'kris'];
  P.applyAbsence(cfg, day);

  assert.strictEqual(day.blocks[0].staffId, null, 'работа висит непереданной');
  assert.strictEqual(day.blocks[0].warn, 'nobody');
});

check('предпочтение сдвигает выбор, но не забирает всю работу', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  /* Силинг предпочитает Тони. Работы на четыре часа — на одного это
     слишком много, и часть обязана уйти Крису. */
  cfg.staff.forEach(function (s) { if (s.id !== 'kris' && s.id !== 'toni') s.status = 'left'; });
  day.jobs = [P.newJob({ taskId: 'seal', mode: 'time', duration: 240 })];
  P.autoAssign(cfg, day);

  var byStaff = {};
  (day.blocks || []).forEach(function (b) {
    byStaff[b.staffId] = (byStaff[b.staffId] || 0) + P.durationOf(cfg, b);
  });

  assert.ok(byStaff.toni > 0, 'предпочитаемый получает работу');
  assert.ok(byStaff.kris > 0, 'но не всю — иначе это уже не предпочтение, а расписание');
  assert.ok(byStaff.toni >= byStaff.kris, 'при равных условиях перевес у того, кто обычно это делает');
});

check('предпочтение не мешает, когда предпочитаемого нет', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  cfg.staff.forEach(function (s) { if (s.id !== 'kris') s.status = 'left'; });
  day.jobs = [P.newJob({ taskId: 'seal', mode: 'time', duration: 60 })];
  P.autoAssign(cfg, day);

  assert.ok((day.blocks || []).some(function (b) { return b.staffId === 'kris'; }),
    'работа уходит молча, без предупреждений о нарушенном предпочтении');
});

/* ---------- объединённый процесс ---------- */

check('объединённая строка разворачивается в цепочку без имён', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  day.jobs = [P.newJob({
    combined: true, taskId: 'pack', mode: 'volume', qty: 180,
    productId: 'frooties', packSize: '2lb', dest: 'amazon'
  })];
  P.autoAssign(cfg, day);

  var steps = day.blocks.filter(function (b) { return b.shared; });
  assert.strictEqual(steps.length, P.COMBINED_STEPS.length, 'взвесить → засилить → уложить → паллета');
  assert.ok(steps.every(function (b) { return b.staffId === null; }),
    'имён быть не должно — кто встанет, они решают сами');
  assert.strictEqual(new Set(steps.map(function (b) { return b.batchId; })).size, 1,
    'это одна партия, а не четыре несвязанные задачи');
  assert.ok(steps.every(function (b) { return b.dest === 'amazon'; }), 'куда уезжает — общее на всю цепочку');
});

check('общая работа не считается «некому передать»', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  day.jobs = [P.newJob({ combined: true, mode: 'volume', qty: 100, productId: 'frooties', packSize: '2lb' })];
  P.autoAssign(cfg, day);

  var view = P.schedule(cfg, day);
  assert.ok(!view.warnings.some(function (w) { return w.code === 'nobodyToTake'; }),
    'работа без имени тут норма, а не проблема');
});

check('перераспределение общую работу не разбирает', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  day.jobs = [P.newJob({ combined: true, mode: 'volume', qty: 100, productId: 'frooties', packSize: '2lb' })];
  P.autoAssign(cfg, day);
  P.applyAbsence(cfg, day);

  assert.ok(day.blocks.every(function (b) { return !b.shared || b.staffId === null; }),
    'она должна лежать свободной, пока её не возьмут');
});

check('взял работу — она стала твоей', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  day.jobs = [P.newJob({ combined: true, mode: 'volume', qty: 100, productId: 'frooties', packSize: '2lb' })];
  P.autoAssign(cfg, day);

  var first = day.blocks[0];
  var r = P.claimBlock(day, first.id, 'toni');
  assert.ok(r.ok);
  assert.strictEqual(first.staffId, 'toni');
});

check('занятую работу не перехватить', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  day.jobs = [P.newJob({ combined: true, mode: 'volume', qty: 100, productId: 'frooties', packSize: '2lb' })];
  P.autoAssign(cfg, day);

  var first = day.blocks[0];
  P.claimBlock(day, first.id, 'toni');
  var r = P.claimBlock(day, first.id, 'eva');
  assert.strictEqual(r.error, 'taken');
  assert.strictEqual(r.by, 'toni');
  assert.strictEqual(first.staffId, 'toni', 'у первого её не отобрали');
});

check('взял по ошибке — можно вернуть, но только пока не начал', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  day.jobs = [P.newJob({ combined: true, mode: 'volume', qty: 100, productId: 'frooties', packSize: '2lb' })];
  P.autoAssign(cfg, day);

  var first = day.blocks[0];
  P.claimBlock(day, first.id, 'toni');
  assert.ok(P.releaseBlock(day, first.id, 'toni').ok);
  assert.strictEqual(first.staffId, null);

  P.claimBlock(day, first.id, 'toni');
  P.markProgress(first, 'active', '2026-08-05T10:00:00.000Z');
  assert.strictEqual(P.releaseBlock(day, first.id, 'toni').error, 'already started');
});

check('чужую работу вернуть в общий список нельзя', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  day.jobs = [P.newJob({ combined: true, mode: 'volume', qty: 100, productId: 'frooties', packSize: '2lb' })];
  P.autoAssign(cfg, day);

  var first = day.blocks[0];
  P.claimBlock(day, first.id, 'toni');
  assert.strictEqual(P.releaseBlock(day, first.id, 'eva').error, 'not yours');
});

check('обычные строки задания продолжают раздаваться по людям', function () {
  var cfg = P.defaultConfig();
  var day = P.emptyDay('2026-08-05');
  day.jobs = [
    P.newJob({ combined: true, mode: 'volume', qty: 60, productId: 'frooties', packSize: '2lb' }),
    P.newJob({ taskId: 'sort', mode: 'time', duration: 120, productId: 'jolly' })
  ];
  P.autoAssign(cfg, day);

  var named = day.blocks.filter(function (b) { return b.staffId; });
  assert.ok(named.length > 0, 'обычная работа как раздавалась, так и раздаётся');
  assert.ok(named.every(function (b) { return !b.shared; }));
});

console.log(failed ? '\n' + failed + ' проверок упало\n' : '\nвсе проверки прошли\n');
process.exit(failed ? 1 : 0);
