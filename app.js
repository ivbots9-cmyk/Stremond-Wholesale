/*
 * Интерфейс плана склада.
 *
 * Схема работы: состояние (config + day) живёт в одном объекте, любое
 * изменение проходит через mutate() — он пересчитывает план, перерисовывает
 * экран и откладывает сохранение. Прямых правок DOM из обработчиков нет,
 * поэтому экран не может разойтись с данными.
 */
(function () {
  'use strict';

  var P = window.WHPlan;
  var S = window.WHStore;

  var SAVE_DELAY = 700;      // склейка быстрых правок в одно сохранение
  var REFRESH_MS = 20000;    // как часто планшет подтягивает чужие правки

  var app = {
    date: P.todayISO(),
    config: null,
    day: null,
    view: null,
    admin: false,
    dirty: false,
    saving: false,
    editingBlockId: null,
    draftConfig: null   // копия настроек, пока открыто окно настроек
  };

  var saveTimer = null;
  var refreshTimer = null;

  /* ============================================================
     Служебное
     ============================================================ */

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function initials(name) {
    return String(name || '?').trim().charAt(0).toUpperCase();
  }

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }
  function anyModalOpen() {
    return ['pin-modal', 'block-modal', 'setup-modal', 'jobs-modal'].some(function (id) { return !$(id).hidden; });
  }

  /* ============================================================
     Загрузка и сохранение
     ============================================================ */

  function boot() {
    bindStaticHandlers();
    load().then(function () {
      refreshTimer = setInterval(maybeRefresh, REFRESH_MS);
      setInterval(tickClock, 30000);
    });
  }

  function load() {
    setSync('загрузка…');
    return S.load(app.date).then(function (data) {
      app.config = data.config || P.defaultConfig();
      app.admin = S.state.admin;

      if (data.day) {
        app.day = data.day;
      } else {
        /* Дня ещё нет — разворачиваем шаблон нужного дня недели и
           сразу сохраняем, чтобы отметки «готово» было куда писать. */
        app.day = P.materialize(app.config, P.emptyDay(app.date));
        scheduleSave('день создан из шаблона', true);
      }

      recompute();
      render();
      setSync('');
    }).catch(function (e) {
      setSync(String(e.message || e), true);
      if (!app.config) {
        app.config = P.defaultConfig();
        app.day = P.materialize(app.config, P.emptyDay(app.date));
        recompute();
        render();
      }
    });
  }

  /* Тихое обновление: подтягивает чужие правки, не мешая тому, кто
     сейчас что-то заполняет. */
  function maybeRefresh() {
    if (S.state.mode !== 'api' || app.dirty || app.saving || anyModalOpen()) return;
    S.load(app.date).then(function (data) {
      if (app.dirty || anyModalOpen()) return;
      if (data.config) app.config = data.config;
      if (data.day) app.day = data.day;
      app.admin = S.state.admin;
      recompute();
      render();
    }).catch(function () { /* пропавшая сеть не должна ломать экран */ });
  }

  function scheduleSave(reason, immediate) {
    app.dirty = true;
    setSync('не сохранено');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, immediate ? 0 : SAVE_DELAY);

    function doSave() {
      app.saving = true;
      setSync('сохранение…');
      app.day.updatedAt = new Date().toISOString();
      S.saveDay(app.day, reason).then(function (r) {
        app.saving = false;
        if (r && r.conflict) {
          /* Кто-то сохранил день раньше. Забираем свежую версию —
             молча затирать чужую правку хуже, чем потерять свою. */
          app.dirty = false;
          setSync('план изменили с другого устройства, перечитано', true);
          return load();
        }
        if (r && r.error) {
          setSync(r.error === 'forbidden' ? 'нет прав на правку' : ('не сохранено: ' + r.error), true);
          return;
        }
        app.dirty = false;
        setSync('сохранено ' + P.fmt(minutesNow()));
      }).catch(function (e) {
        app.saving = false;
        setSync('не сохранено: ' + (e.message || e), true);
      });
    }
  }

  /* Любое изменение плана идёт сюда. */
  function mutate(fn, reason) {
    fn();
    recompute();
    render();
    scheduleSave(reason);
  }

  function recompute() {
    P.applyVolumes(app.config, app.day);
    P.applyAbsence(app.config, app.day);
    app.view = P.schedule(app.config, app.day);
  }

  function minutesNow() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function isToday() { return app.date === P.todayISO(); }

  function tickClock() { if (isToday()) renderBoard(); }

  /* ============================================================
     Отрисовка
     ============================================================ */

  function render() {
    renderHeader();
    renderBar();
    renderAlerts();
    renderBoard();
    renderFoot();
  }

  function renderHeader() {
    var wd = P.weekdayOf(app.date);
    $('date-title').textContent = P.humanDate(app.date);
    $('date-sub').textContent = wd.title + (isToday() ? ' · сегодня' : '');

    var t = app.view.totals;
    var stats = $('stats');
    stats.innerHTML = '';
    stats.appendChild(stat(t.people + ' из ' + app.config.staff.length, 'на смене'));
    stats.appendChild(stat(P.human(t.plannedMin), 'работы в плане'));
    stats.appendChild(stat(t.loadPct + '%', 'загрузка', t.loadPct > 100));
    stats.appendChild(stat(P.human(t.freeMin), 'свободно'));
    stats.appendChild(stat(t.done + ' / ' + t.blocks, 'сделано'));

    $('admin-toggle').textContent = app.admin ? 'Готово' : 'Правки';
    $('setup-open').hidden = !app.admin;
  }

  function stat(value, label, warn) {
    var n = el('div', 'stat' + (warn ? ' stat--warn' : ''));
    n.appendChild(el('b', null, value));
    n.appendChild(el('span', null, label));
    return n;
  }

  function renderBar() {
    var bar = $('bar');
    bar.hidden = !app.admin;
    if (!app.admin) return;

    var presence = $('presence');
    presence.innerHTML = '';
    app.config.staff.forEach(function (s) {
      if (s.status === 'left') return;
      var off = (app.day.absent || []).indexOf(s.id) >= 0;
      var vac = s.status === 'vacation';
      var chip = el('button', 'chip' + (off ? ' is-off' : '') + (vac ? ' is-vacation' : ''));
      chip.type = 'button';
      var dot = el('span', 'chip__dot');
      dot.style.background = s.color;
      chip.appendChild(dot);
      chip.appendChild(el('span', null, s.name + (vac ? ' · отпуск' : '')));
      if (!vac) {
        chip.addEventListener('click', function () { toggleAbsent(s.id); });
      }
      presence.appendChild(chip);
    });

    var jobCount = (app.day.jobs || []).length;
    $('jobs-open').textContent = jobCount ? 'Задание · ' + jobCount : 'Задание';

    var volumes = $('volumes');
    volumes.innerHTML = '';
    var tasks = P.volumeTasks(app.config, app.day);
    if (!tasks.length) {
      volumes.appendChild(el('span', 'muted', 'Сегодня нет задач, которые считаются по количеству'));
    }
    tasks.forEach(function (slot) {
      var box = el('div', 'volume');
      box.appendChild(el('label', null, slot.title));
      var input = el('input');
      input.type = 'number';
      input.min = '0';
      input.inputMode = 'numeric';
      input.value = (app.day.volumes && app.day.volumes[slot.key]) || 0;
      input.addEventListener('change', function () {
        var v = Math.max(0, Number(input.value) || 0);
        mutate(function () {
          app.day.volumes = app.day.volumes || {};
          app.day.volumes[slot.key] = v;
        }, 'объём: ' + slot.title + ' = ' + v);
      });
      box.appendChild(input);
      box.appendChild(el('span', 'unit', slot.unit));
      volumes.appendChild(box);
    });
  }

  function renderAlerts() {
    var box = $('alerts');
    box.innerHTML = '';
    (app.view.warnings || []).forEach(function (w) {
      box.appendChild(el('div', 'alert alert--' + w.level, w.text));
    });
  }

  function renderBoard() {
    var board = $('board');
    board.innerHTML = '';

    app.view.lanes.forEach(function (lane) {
      if (lane.vacation && !app.admin) return;
      board.appendChild(renderLane(lane));
    });

    if (app.view.unassigned.length) {
      board.appendChild(renderOrphans());
    }
  }

  function renderLane(lane) {
    var node = el('section', 'lane' + (lane.available ? '' : ' lane--off'));

    var head = el('div', 'lane__head');
    var av = el('div', 'avatar', initials(lane.staff.name));
    av.style.background = lane.staff.color;
    head.appendChild(av);

    var name = el('div', 'lane__name');
    name.appendChild(el('b', null, lane.staff.name));
    name.appendChild(el('span', null,
      lane.vacation ? 'в отпуске'
        : lane.absent ? 'сегодня нет на работе'
          : P.fmt(lane.shift.start) + '–' + P.fmt(lane.shift.end)));
    head.appendChild(name);

    if (lane.available) {
      var load = el('div', 'load' + (lane.overMin ? ' load--over' : ''));
      load.appendChild(el('b', null, lane.loadPct + '%'));
      load.appendChild(el('span', null, lane.overMin
        ? 'перегруз ' + P.human(lane.overMin)
        : 'свободно ' + P.human(lane.freeMin)));
      head.appendChild(load);
    }
    node.appendChild(head);

    var body = el('div', 'lane__body');
    if (!lane.items.length) {
      body.appendChild(el('div', 'empty', lane.available ? 'Задач нет' : '—'));
    }
    lane.items.forEach(function (item) { body.appendChild(renderTask(item)); });
    node.appendChild(body);
    return node;
  }

  function renderTask(item, opts) {
    var b = item.block;
    var task = P.taskOf(app.config, b);
    var now = minutesNow();
    var noTime = opts && opts.noTime;
    var isNow = !noTime && isToday() && now >= item.start && now < item.end && b.status !== 'done';
    /* Задача «по количеству», для которой объём ещё не ввели: времени у
       неё нет, и показывать «0 мин» нельзя — это выглядит как готовая
       работа на ноль минут, а не как незаполненное поле. */
    var idle = item.duration === 0 && b.mode === 'volume';

    var node = el('article', 'task'
      + (b.status === 'done' ? ' task--done' : '')
      + (b.status === 'active' || isNow ? ' task--active' : '')
      + (idle ? ' task--idle' : '')
      + (item.overtime ? ' task--overtime' : ''));
    node.style.borderLeftColor = task.color || '#94a3b8';

    var time = el('div', 'task__time');
    if (idle || noTime) {
      time.appendChild(el('b', null, '—'));
      time.appendChild(el('span', null, idle ? 'объём не задан' : P.human(item.duration)));
    } else {
      time.appendChild(el('b', null, P.fmt(item.start) + '–' + P.fmt(item.end)));
      time.appendChild(el('span', null, P.human(item.duration)));
    }
    if (isNow) time.appendChild(el('span', 'tag tag--qty', 'сейчас'));
    node.appendChild(time);

    node.appendChild(el('div', 'task__title', P.blockTitle(app.config, b)));

    var meta = el('div', 'task__meta');
    if (b.mode === 'volume' && b.qty) {
      meta.appendChild(el('span', 'tag tag--qty', b.qty + ' ' + P.plural(b.qty, task.unit || 'шт')));
    }
    if (b.mode === 'time') {
      /* Для работы «до упора» полезнее выработка, а не слово «по
         времени»: 2,5 часа переборки — это примерно 10 коробок. */
      var out = P.expectedOutput(app.config, b);
      meta.appendChild(out
        ? el('span', 'tag', '≈ ' + out.qty + ' ' + out.unit)
        : el('span', 'tag', 'по времени'));
    }
    var dest = P.DESTINATIONS.filter(function (d) { return d.key === b.dest; })[0];
    if (dest && dest.key) meta.appendChild(el('span', 'tag tag--dest', dest.title));
    if (b.fromStaffId) {
      var from = P.indexBy(app.config.staff)[b.fromStaffId];
      meta.appendChild(el('span', 'tag tag--moved', 'передано от ' + (from ? from.name : '—')));
    }
    if (b.warn) meta.appendChild(el('span', 'tag tag--warn', b.warn));
    if (item.crossedBreak) meta.appendChild(el('span', 'tag', 'с перерывом на ' + item.crossedBreak.toLowerCase()));
    if (item.overtime) meta.appendChild(el('span', 'tag tag--warn', 'выходит за смену'));
    if (b.note) meta.appendChild(el('span', 'tag tag--note', b.note));
    if (meta.childNodes.length) node.appendChild(meta);

    var act = el('div', 'task__act');

    var start = el('button', b.status === 'active' ? 'is-active' : '', 'Начал');
    start.type = 'button';
    start.addEventListener('click', function () {
      setStatus(b, b.status === 'active' ? 'planned' : 'active');
    });
    act.appendChild(start);

    var done = el('button', b.status === 'done' ? 'is-on' : '', b.status === 'done' ? 'Сделано' : 'Готово');
    done.type = 'button';
    done.addEventListener('click', function () {
      setStatus(b, b.status === 'done' ? 'planned' : 'done');
    });
    act.appendChild(done);

    if (app.admin) {
      var edit = el('button', 'edit', '✎');
      edit.type = 'button';
      edit.setAttribute('aria-label', 'Изменить задачу');
      edit.addEventListener('click', function () { openBlockEditor(b.id); });
      act.appendChild(edit);
    }

    node.appendChild(act);
    return node;
  }

  /* Работа, которую некому передать: показываем отдельной колонкой,
     чтобы её нельзя было не заметить. */
  function renderOrphans() {
    var node = el('section', 'lane');
    var head = el('div', 'lane__head');
    var av = el('div', 'avatar', '!');
    av.style.background = '#dc2626';
    head.appendChild(av);
    var name = el('div', 'lane__name');
    name.appendChild(el('b', null, 'Некому передать'));
    name.appendChild(el('span', null, 'никто из доступных не может это взять'));
    head.appendChild(name);
    node.appendChild(head);

    var body = el('div', 'lane__body');
    app.view.unassigned.forEach(function (b) {
      body.appendChild(renderTask(
        { block: b, start: 0, end: 0, duration: P.durationOf(app.config, b), overtime: false, crossedBreak: '' },
        { noTime: true }
      ));
    });
    node.appendChild(body);
    return node;
  }

  function renderFoot() {
    $('foot-mode').textContent = S.state.mode === 'local'
      ? 'Локальный режим: план хранится только на этом устройстве'
      : 'Общий план · правки видны на всех устройствах';
  }

  function setSync(text, isError) {
    var n = $('sync');
    n.textContent = text || (S.state.mode === 'local' ? 'локально' : 'на связи');
    n.className = 'sync' + (isError ? ' sync--err' : '');
    $('foot-saved').textContent = app.day && app.day.updatedAt
      ? 'обновлён ' + new Date(app.day.updatedAt).toLocaleString('ru-RU')
      : '';
  }

  /* ============================================================
     Действия
     ============================================================ */

  function setStatus(block, status) {
    /* Оптимистично: кнопка должна отзываться мгновенно, иначе на
       планшете её нажмут второй раз. */
    block.status = status;
    recompute();
    renderHeader();
    renderBoard();
    S.progress(app.date, block.id, status, block.doneQty).then(function (r) {
      if (r && r.error) setSync('отметка не сохранилась: ' + r.error, true);
      else setSync('');
    }).catch(function (e) { setSync('отметка не сохранилась: ' + e.message, true); });
  }

  function toggleAbsent(staffId) {
    mutate(function () {
      app.day.absent = app.day.absent || [];
      var i = app.day.absent.indexOf(staffId);
      if (i >= 0) app.day.absent.splice(i, 1);
      else app.day.absent.push(staffId);
    }, 'отсутствие: ' + staffId);
  }

  function goDate(iso) {
    app.date = iso;
    load();
  }

  /* ============================================================
     Редактор задачи
     ============================================================ */

  function openBlockEditor(blockId) {
    app.editingBlockId = blockId || null;
    var b = blockId
      ? app.day.blocks.filter(function (x) { return x.id === blockId; })[0]
      : {
          id: null, staffId: (P.availableStaff(app.config, app.day)[0] || app.config.staff[0]).id,
          taskId: app.config.tasks[0].id, mode: 'time', duration: 60, share: 1, qty: 0,
          productId: '', packSize: null,
          dest: '', note: '', pinnedStart: null, status: 'planned', doneQty: 0, fromStaffId: null
        };

    $('block-title').textContent = blockId ? 'Задача' : 'Новая задача';
    $('block-delete').hidden = !blockId;

    fillSelect($('block-staff'), app.config.staff
      .filter(function (s) { return s.status !== 'left'; })
      .map(function (s) {
        return { value: s.id, title: s.name + (P.isAvailable(s, app.day) ? '' : ' (нет на работе)') };
      }), b.staffId);

    fillSelect($('block-task'), app.config.tasks.map(function (t) {
      return { value: t.id, title: t.title };
    }), b.taskId);

    fillSelect($('block-product'), [{ value: '', title: 'Без товара' }].concat(
      (app.config.products || []).map(function (p) { return { value: p.id, title: p.title }; })
    ), b.productId || '');

    fillSelect($('block-dest'), P.DESTINATIONS.map(function (d) {
      return { value: d.key, title: d.title };
    }), b.dest || '');

    $('block-duration').value = b.duration || 0;
    $('block-qty').value = b.qty || 0;
    $('block-note').value = b.note || '';
    $('block-pinned').value = b.pinnedStart || '';

    fillPackSizes(b.packSize);
    fillVariants(b.variant);
    setMode(b.mode);
    $('block-task').onchange = function () { setMode(currentMode()); };
    $('block-product').onchange = function () {
      fillPackSizes(null);
      fillVariants('');
      setMode(currentMode());
    };
    $('block-pack').onchange = function () { setMode(currentMode()); };
    $('block-qty').oninput = function () { setMode('volume'); };

    openModal('block-modal');
  }

  /* Фасовки зависят от товара: у Frooties своя, у Jolly свои. Список
     перестраивается при смене товара, чтобы нельзя было выбрать
     несуществующую пару. */
  /* Цвета есть только у того, что перебирают по цветам. Для остального
     список прячем — пустой выпадающий список только путает. */
  function fillVariants(current) {
    var product = P.productOf(app.config, { productId: $('block-product').value });
    var colors = (product && product.colors) || [];
    fillSelect($('block-variant'), [{ value: '', title: 'Все цвета' }].concat(
      colors.map(function (c) { return { value: c, title: c }; })
    ), current || '');
    $('field-variant').hidden = !colors.length;
  }

  function fillPackSizes(current) {
    var product = P.productOf(app.config, { productId: $('block-product').value });
    var packs = (product && product.packs) || [];
    fillSelect($('block-pack'), [{ value: '', title: 'Без фасовки' }].concat(
      packs.map(function (pk) { return { value: pk.id, title: pk.title }; })
    ), current == null ? '' : String(current));
    $('block-pack').disabled = !packs.length;
  }

  function currentMode() {
    var on = $('block-mode').querySelector('.is-on');
    return on ? on.getAttribute('data-mode') : 'time';
  }

  function setMode(mode) {
    Array.prototype.forEach.call($('block-mode').children, function (btn) {
      btn.classList.toggle('is-on', btn.getAttribute('data-mode') === mode);
    });
    $('field-duration').hidden = mode !== 'time';
    $('field-qty').hidden = mode !== 'volume';

    var draft = {
      taskId: $('block-task').value,
      productId: $('block-product').value,
      packSize: $('block-pack').value || null
    };
    var task = P.taskOf(app.config, draft);
    var norm = P.normFor(app.config, draft);

    $('qty-unit').textContent = P.unitFor(app.config, draft);

    if (mode === 'time') {
      var dur = Math.max(0, Number($('block-duration').value) || 0);
      var out = P.expectedOutput(app.config, { taskId: draft.taskId, productId: draft.productId, packSize: draft.packSize, mode: 'time', duration: dur });
      $('mode-hint').textContent = 'Длительность задаётся руками — так работает переборка: сколько успели за отведённое время, столько успели.'
        + (out ? ' За это время выйдет примерно ' + out.qty + ' ' + out.unit + '.' : '');
    } else {
      $('mode-hint').textContent = 'Время считается само: количество × норма (' + norm + ' мин за ' + P.unitFor(app.config, draft) + ').';
      var qty = Number($('block-qty').value) || 0;
      $('qty-calc').textContent = qty
        ? qty + ' × ' + norm + ' мин = ' + P.human(P.durationOf(app.config, {
            taskId: draft.taskId, productId: draft.productId, packSize: draft.packSize, mode: 'volume', qty: qty
          }))
        : 'Количество берётся из объёма на день, если оставить 0.';
    }
  }

  function saveBlock() {
    var mode = currentMode();
    var data = {
      staffId: $('block-staff').value,
      taskId: $('block-task').value,
      productId: $('block-product').value,
      packSize: $('block-pack').value || null,
      variant: $('block-variant').value || '',
      mode: mode,
      duration: Math.max(0, Number($('block-duration').value) || 0),
      qty: Math.max(0, Number($('block-qty').value) || 0),
      dest: $('block-dest').value,
      note: $('block-note').value.trim(),
      pinnedStart: $('block-pinned').value || null
    };

    mutate(function () {
      var b = app.editingBlockId
        ? app.day.blocks.filter(function (x) { return x.id === app.editingBlockId; })[0]
        : null;

      if (!b) {
        b = { id: P.uid('b'), share: 1, status: 'planned', doneQty: 0, fromStaffId: null, origin: 'manual' };
        app.day.blocks.push(b);
      }
      Object.keys(data).forEach(function (k) { b[k] = data[k]; });

      /*
       * Количество, введённое руками, нужно поднять в объём на день —
       * иначе следующий пересчёт разделит дневной объём заново и
       * затрёт введённое число нулём.
       */
      if (mode === 'volume' && data.qty > 0) {
        var key = P.volumeKey(b);
        var others = app.day.blocks.reduce(function (sum, x) {
          return x !== b && x.mode === 'volume' && P.volumeKey(x) === key ? sum + (Number(x.qty) || 0) : sum;
        }, 0);
        app.day.volumes = app.day.volumes || {};
        app.day.volumes[key] = others + data.qty;
      }
    }, app.editingBlockId ? 'правка задачи' : 'добавлена задача');

    closeModal('block-modal');
  }

  function deleteBlock() {
    if (!app.editingBlockId) return;
    mutate(function () {
      app.day.blocks = app.day.blocks.filter(function (x) { return x.id !== app.editingBlockId; });
    }, 'задача удалена');
    closeModal('block-modal');
  }

  function fillSelect(node, options, value) {
    node.innerHTML = '';
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.title;
      node.appendChild(opt);
    });
    node.value = value == null ? '' : value;
  }


  /* ============================================================
     Задание на день
     ============================================================ */

  /*
   * Задание — это «что нужно сделать», отдельно от «кто это делает».
   * Так его можно записать накануне одной строкой, не думая про людей,
   * а утром нажать «Распределить»: кто сегодня вышел, тот и получит
   * работу. Это ровно тот способ, которым план и составляют в голове.
   */
  function openJobs() {
    app.day.jobs = app.day.jobs || [];
    renderJobs();
    openModal('jobs-modal');
  }

  function renderJobs() {
    var box = $('jobs-list');
    box.innerHTML = '';
    var jobs = app.day.jobs || [];

    if (!jobs.length) {
      box.appendChild(el('p', 'muted', 'Пусто. Добавьте строку — например «Фасовка · Frooties 2 lb — 180 пакетов → TikTok».'));
    }

    var grid = el('div', 'grid grid--jobs');
    if (jobs.length) {
      ['Что', 'Товар', 'Цвет', 'Сколько', 'Куда', ''].forEach(function (h) {
        grid.appendChild(el('span', 'grid__head', h));
      });
    }

    jobs.forEach(function (job, i) {
      var task = document.createElement('select');
      fillSelect(task, app.config.tasks.map(function (t) { return { value: t.id, title: t.title }; }), job.taskId);
      task.onchange = function () {
        job.taskId = task.value;
        job.mode = P.taskOf(app.config, job).mode;
        renderJobs();
      };
      grid.appendChild(task);

      var product = document.createElement('select');
      fillSelect(product, productOptions(), job.productId ? job.productId + (job.packSize ? ':' + job.packSize : '') : '');
      product.onchange = function () {
        var parts = product.value.split(':');
        job.productId = parts[0] || '';
        job.packSize = parts[1] || null;
        job.variant = '';
        renderJobs();
      };
      grid.appendChild(product);

      var colors = (P.productOf(app.config, job) || {}).colors || [];
      var variant = document.createElement('select');
      fillSelect(variant, [{ value: '', title: colors.length ? 'Все цвета' : '—' }].concat(
        colors.map(function (c) { return { value: c, title: c }; })
      ), job.variant || '');
      variant.disabled = !colors.length;
      variant.onchange = function () { job.variant = variant.value; renderJobs(); };
      grid.appendChild(variant);

      /* Единица подписана прямо у поля: «180 пакетов» и «150 мин» —
         разные вещи, и перепутать их на планшете легко. */
      var amount = el('div', 'row');
      var input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.inputMode = 'numeric';
      if (job.mode === 'volume') {
        input.value = job.qty || 0;
        input.onchange = function () { job.qty = Math.max(0, Number(input.value) || 0); renderJobs(); };
      } else {
        input.step = '5';
        input.value = job.duration || 0;
        input.onchange = function () { job.duration = Math.max(0, Number(input.value) || 0); renderJobs(); };
      }
      amount.appendChild(input);
      amount.appendChild(el('span', 'unit', job.mode === 'volume' ? P.unitFor(app.config, job) : 'мин'));
      grid.appendChild(amount);

      var dest = document.createElement('select');
      fillSelect(dest, P.DESTINATIONS.map(function (d) { return { value: d.key, title: d.title }; }), job.dest || '');
      dest.onchange = function () { job.dest = dest.value; renderJobs(); };
      grid.appendChild(dest);

      var del = el('button', 'row-del', '✕');
      del.type = 'button';
      del.onclick = function () { jobs.splice(i, 1); renderJobs(); };
      grid.appendChild(del);
    });

    box.appendChild(grid);
    renderJobsSummary();
  }

  /* Сводка внизу окна: сколько это часов и влезает ли в смену. Без
     неё «180 пакетов» — абстракция, а с ней сразу видно, что это
     полдня работы и что людей не хватит. */
  function renderJobsSummary() {
    var jobs = app.day.jobs || [];
    var minutes = jobs.reduce(function (sum, j) {
      return sum + (j.mode === 'volume'
        ? (Number(j.qty) || 0) * P.normFor(app.config, j)
        : (Number(j.duration) || 0));
    }, 0);
    var capacity = P.availableStaff(app.config, app.day)
      .reduce(function (sum, s) { return sum + P.capacityOf(app.config, s); }, 0);

    if (!jobs.length) { $('jobs-summary').textContent = ''; return; }
    $('jobs-summary').textContent = 'Работы на ' + P.human(minutes)
      + ' · смена на сегодня ' + P.human(capacity)
      + (minutes > capacity ? ' — не влезет' : '');
  }

  function productOptions() {
    var out = [{ value: '', title: 'Без товара' }];
    (app.config.products || []).forEach(function (p) {
      out.push({ value: p.id, title: p.title });
      (p.packs || []).forEach(function (pk) {
        out.push({ value: p.id + ':' + pk.id, title: p.title + ' ' + pk.title });
      });
    });
    return out;
  }

  function addJob() {
    app.day.jobs = app.day.jobs || [];
    var task = app.config.tasks[0];
    app.day.jobs.push(P.newJob({ taskId: task.id, mode: task.mode }));
    renderJobs();
  }

  function applyJobs() {
    var jobs = (app.day.jobs || []).filter(function (j) {
      return j.mode === 'volume' ? Number(j.qty) > 0 : Number(j.duration) > 0;
    });
    if (!jobs.length) {
      alert('Задание пустое — распределять нечего.');
      return;
    }
    if (!confirm('Собрать план дня из задания? Текущая расстановка задач будет заменена.')) return;

    mutate(function () {
      app.day.jobs = jobs;
      P.autoAssign(app.config, app.day);
    }, 'план собран из задания');
    closeModal('jobs-modal');
  }

  /* Записать задание на завтра — то, ради чего это и затевалось:
     вечером записал, утром нажал «Распределить». */
  function copyJobsToTomorrow() {
    var jobs = (app.day.jobs || []).map(function (j) {
      return P.cloneJob(j);
    });
    if (!jobs.length) { alert('Задание пустое.'); return; }

    var date = P.shiftISO(app.date, 1);
    S.loadDay(date).then(function (day) {
      var target = day || P.emptyDay(date);
      target.jobs = jobs;
      return S.saveDayAt(target, 'задание записано на ' + date).then(function (r) {
        if (r && r.error) { alert('Не удалось записать: ' + r.error); return; }
        alert('Задание записано на ' + P.humanDate(date) + '. Утром откройте этот день и нажмите «Распределить».');
      });
    });
  }

  /* Забрать задание, записанное вчера на сегодня, если его писали
     заранее и день уже успел развернуться из шаблона. */
  function pullTomorrowJobs() {
    S.loadDay(app.date).then(function (day) {
      if (!day || !day.jobs || !day.jobs.length) {
        alert('На этот день заранее ничего не записано.');
        return;
      }
      app.day.jobs = day.jobs;
      renderJobs();
    });
  }

  /* ============================================================
     Настройки
     ============================================================ */

  function openSetup() {
    app.draftConfig = P.clone(app.config);
    showTab('templates');
    openModal('setup-modal');
  }

  function showTab(name) {
    Array.prototype.forEach.call($('setup-tabs').children, function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-tab') === name);
    });
    ['templates', 'norms', 'tasks', 'staff', 'shift', 'log'].forEach(function (t) {
      $('tab-' + t).hidden = t !== name;
    });
    if (name === 'templates') renderTemplatesTab();
    if (name === 'norms') renderNormsTab();
    if (name === 'tasks') renderTasksTab();
    if (name === 'staff') renderStaffTab();
    if (name === 'shift') renderShiftTab();
    if (name === 'log') renderLogTab();
  }

  function renderTemplatesTab() {
    var box = $('tab-templates');
    box.innerHTML = '';
    box.appendChild(el('p', 'muted',
      'Шаблон — это «что обычно делают в такой день недели». План на конкретную дату собирается из него, но правки дня шаблон не меняют.'));

    P.WEEKDAYS.forEach(function (wd) {
      var list = app.draftConfig.templates[wd.key] = app.draftConfig.templates[wd.key] || [];
      var det = el('details', 'tpl-day');
      var sum = el('summary', null, wd.title + ' · ' + list.length + ' задач');
      det.appendChild(sum);

      var grid = el('div', 'grid grid--tpl');
      ['Кто', 'Что', 'Товар', 'Расчёт', 'Время / доля', 'Куда', ''].forEach(function (h) {
        grid.appendChild(el('span', 'grid__head', h));
      });

      list.forEach(function (t, i) {
        var staff = document.createElement('select');
        fillSelect(staff, app.draftConfig.staff.map(function (s) { return { value: s.id, title: s.name }; }), t.staffId);
        staff.onchange = function () { t.staffId = staff.value; };
        grid.appendChild(staff);

        var task = document.createElement('select');
        fillSelect(task, app.draftConfig.tasks.map(function (x) { return { value: x.id, title: x.title }; }), t.taskId);
        task.onchange = function () { t.taskId = task.value; };
        grid.appendChild(task);

        /* Товар и фасовка одним полем: «Jolly Rancher 5 lb» — так это
           и называется на складе, разносить их по двум спискам в
           плотной таблице неудобно. */
        var product = document.createElement('select');
        var options = [{ value: '', title: 'Без товара' }];
        (app.draftConfig.products || []).forEach(function (p) {
          options.push({ value: p.id, title: p.title });
          (p.packs || []).forEach(function (pk) {
            options.push({ value: p.id + ':' + pk.id, title: p.title + ' ' + pk.title });
          });
        });
        fillSelect(product, options, t.productId ? t.productId + (t.packSize ? ':' + t.packSize : '') : '');
        product.onchange = function () {
          var parts = product.value.split(':');
          t.productId = parts[0] || '';
          t.packSize = parts[1] || null;
        };
        grid.appendChild(product);

        var mode = document.createElement('select');
        fillSelect(mode, [
          { value: 'time', title: 'По времени' },
          { value: 'volume', title: 'По количеству' }
        ], t.mode);
        mode.onchange = function () { t.mode = mode.value; renderTemplatesTab(); };
        grid.appendChild(mode);

        var val = document.createElement('input');
        val.type = 'number';
        val.min = '0';
        if (t.mode === 'time') {
          val.step = '5';
          val.value = t.duration || 0;
          val.title = 'минут';
          val.onchange = function () { t.duration = Math.max(0, Number(val.value) || 0); };
        } else {
          val.step = '1';
          val.value = t.share || 1;
          val.title = 'доля от дневного объёма';
          val.onchange = function () { t.share = Math.max(1, Number(val.value) || 1); };
        }
        grid.appendChild(val);

        var dest = document.createElement('select');
        fillSelect(dest, P.DESTINATIONS.map(function (d) { return { value: d.key, title: d.title }; }), t.dest || '');
        dest.onchange = function () { t.dest = dest.value; };
        grid.appendChild(dest);

        var del = el('button', 'row-del', '✕');
        del.type = 'button';
        del.onclick = function () { list.splice(i, 1); renderTemplatesTab(); };
        grid.appendChild(del);
      });

      det.appendChild(grid);

      var add = el('button', 'btn btn--sm btn--ghost', '+ Добавить в ' + wd.title.toLowerCase());
      add.type = 'button';
      add.style.marginTop = '10px';
      add.onclick = function () {
        list.push({
          id: P.uid('t'),
          staffId: app.draftConfig.staff[0].id,
          taskId: app.draftConfig.tasks[0].id,
          mode: 'time', duration: 60, share: 1,
          productId: '', packSize: null, dest: '', note: '', pinnedStart: null
        });
        renderTemplatesTab();
        det.open = true;
      };
      det.appendChild(add);

      box.appendChild(det);
    });
  }

  /*
   * Нормы времени — главный экран настройки. Пока он не заполнен
   * своими цифрами, план считает правдоподобно, но неправду, поэтому
   * рядом с каждой нормой показываем её же в привычном виде
   * («4 коробки в час»), чтобы цифру было легко проверить на глаз.
   */
  function renderNormsTab() {
    var box = $('tab-norms');
    box.innerHTML = '';
    box.appendChild(el('p', 'muted',
      'Сколько минут уходит на одну единицу. Норма ищется от частного к общему: сначала «товар + фасовка», потом «товар», потом общая норма операции.'));

    app.draftConfig.tasks.forEach(function (task) {
      var det = el('details', 'tpl-day');
      det.appendChild(el('summary', null, task.title + ' · ' + (task.unit || 'без единицы')));

      var grid = el('div', 'grid grid--norms');
      ['Что считаем', 'Мин / ед.', 'Это же в час', ''].forEach(function (h) {
        grid.appendChild(el('span', 'grid__head', h));
      });

      normRows(task).forEach(function (row) {
        grid.appendChild(el('span', null, row.title));

        var perHour = el('span', 'muted');
        var input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '0.05';
        input.value = row.get();
        input.onchange = function () {
          row.set(Math.max(0, Number(input.value) || 0));
          perHour.textContent = hourly(Number(input.value) || 0, row.unit());
        };
        grid.appendChild(input);

        perHour.textContent = hourly(row.get(), row.unit());
        grid.appendChild(perHour);

        grid.appendChild(el('span', 'muted', row.hint || ''));
      });

      det.appendChild(grid);
      box.appendChild(det);
    });
  }

  /* Строки норм для одной операции: базовая плюс по каждому товару,
     а для фасовочных работ — по каждой фасовке отдельно. */
  function normRows(task) {
    var rows = [{
      title: 'Базовая норма',
      hint: 'если товар не указан',
      get: function () { return Number(task.minPerUnit) || 0; },
      set: function (v) { task.minPerUnit = v; }
    }];

    task.byProduct = task.byProduct || {};

    (app.draftConfig.products || []).forEach(function (p) {
      var packs = task.mode === 'volume' ? (p.packs || []) : [];
      if (!packs.length) {
        rows.push(normRow(task, p.id, p.title, boxHint(p, task)));
        return;
      }
      packs.forEach(function (pk) {
        rows.push(normRow(task, p.id + ':' + pk.id, p.title + ' ' + pk.title,
          pk.bagsPerBox ? pk.bagsPerBox + ' в коробке' : 'нет данных по коробке'));
      });
    });

    return rows;
  }

  /* Норма может быть числом или объектом со своей единицей — у
     переборки Starburst считают коробками, а Jolly пакетами. Правку
     числа делаем, не теряя единицу. */
  function normRow(task, key, title, hint) {
    return {
      title: title,
      hint: hint,
      unit: function () {
        var v = task.byProduct[key];
        return v && typeof v === 'object' ? (v.unit || task.unit) : task.unit;
      },
      get: function () {
        var v = task.byProduct[key];
        if (v == null) return '';
        return typeof v === 'object' ? Number(v.min) : Number(v);
      },
      set: function (v) {
        var prev = task.byProduct[key];
        if (!v) { delete task.byProduct[key]; return; }
        if (prev && typeof prev === 'object') prev.min = v;
        else task.byProduct[key] = v;
      }
    };
  }

  function boxHint(product, task) {
    var inb = product.inbound;
    if (task.unit !== 'коробка' || !inb || !inb.perBox) return '';
    return 'от поставщика ' + inb.perBox + ' × ' + inb.unitSize;
  }

  function hourly(minPerUnit, unit) {
    var n = Number(minPerUnit);
    if (!n) return '—';
    var per = 60 / n;
    var qty = per >= 10 ? Math.round(per) : Math.round(per * 10) / 10;
    return qty + ' ' + P.plural(qty, unit || 'шт') + ' / час';
  }

  function renderTasksTab() {
    var box = $('tab-tasks');
    box.innerHTML = '';
    box.appendChild(el('p', 'muted',
      'Норма — сколько минут уходит на одну единицу. Из неё считается время для задач «по количеству». Поставьте свои значения: расчёт по чужим нормам смысла не имеет.'));

    var grid = el('div', 'grid grid--tasks');
    ['Задача', 'Единица', 'Мин/ед.', 'Расчёт', 'Важность', ''].forEach(function (h) {
      grid.appendChild(el('span', 'grid__head', h));
    });

    app.draftConfig.tasks.forEach(function (t, i) {
      var title = document.createElement('input');
      title.value = t.title;
      title.onchange = function () { t.title = title.value.trim() || t.title; };
      grid.appendChild(title);

      var unit = document.createElement('input');
      unit.value = t.unit || '';
      unit.placeholder = 'пакет';
      unit.onchange = function () { t.unit = unit.value.trim(); };
      grid.appendChild(unit);

      var norm = document.createElement('input');
      norm.type = 'number';
      norm.min = '0';
      norm.step = '0.05';
      norm.value = t.minPerUnit || 0;
      norm.onchange = function () { t.minPerUnit = Math.max(0, Number(norm.value) || 0); };
      grid.appendChild(norm);

      var mode = document.createElement('select');
      fillSelect(mode, [
        { value: 'time', title: 'По времени' },
        { value: 'volume', title: 'По количеству' }
      ], t.mode || 'time');
      mode.onchange = function () { t.mode = mode.value; };
      grid.appendChild(mode);

      var prio = document.createElement('select');
      fillSelect(prio, P.PRIORITIES.map(function (p) { return { value: String(p.value), title: p.title }; }), String(t.priority || 2));
      prio.onchange = function () { t.priority = Number(prio.value); };
      grid.appendChild(prio);

      var del = el('button', 'row-del', '✕');
      del.type = 'button';
      del.onclick = function () {
        var used = app.day.blocks.some(function (b) { return b.taskId === t.id; });
        if (used && !confirm('Задача «' + t.title + '» стоит в сегодняшнем плане. Всё равно удалить из справочника?')) return;
        app.draftConfig.tasks.splice(i, 1);
        renderTasksTab();
      };
      grid.appendChild(del);
    });

    box.appendChild(grid);

    var add = el('button', 'btn btn--sm btn--ghost', '+ Новая задача');
    add.type = 'button';
    add.style.marginTop = '12px';
    add.onclick = function () {
      app.draftConfig.tasks.push({
        id: P.uid('task'), title: 'Новая задача', mode: 'time', unit: 'шт',
        minPerUnit: 1, priority: 2, color: '#64748b'
      });
      renderTasksTab();
    };
    box.appendChild(add);
  }

  function renderStaffTab() {
    var box = $('tab-staff');
    box.innerHTML = '';
    box.appendChild(el('p', 'muted',
      'Навыки: если ничего не отмечено — человек берётся за любую работу. Отмечайте, только когда нужно ограничить, что ему можно передавать.'));

    app.draftConfig.staff.forEach(function (s, i) {
      var card = el('div', 'tpl-day');

      var row = el('div', 'grid grid--staff');
      var name = document.createElement('input');
      name.value = s.name;
      name.onchange = function () { s.name = name.value.trim() || s.name; };
      row.appendChild(name);

      var status = document.createElement('select');
      fillSelect(status, [
        { value: 'active', title: 'Работает' },
        { value: 'vacation', title: 'В отпуске' },
        { value: 'left', title: 'Не работает у нас' }
      ], s.status);
      status.onchange = function () { s.status = status.value; };
      row.appendChild(status);

      var color = document.createElement('input');
      color.type = 'color';
      color.value = s.color || '#64748b';
      color.onchange = function () { s.color = color.value; };
      row.appendChild(color);

      var del = el('button', 'row-del', '✕');
      del.type = 'button';
      del.onclick = function () {
        if (!confirm('Удалить ' + s.name + ' из списка?')) return;
        app.draftConfig.staff.splice(i, 1);
        renderStaffTab();
      };
      row.appendChild(del);
      card.appendChild(row);

      var chips = el('div', 'chips');
      chips.style.marginTop = '10px';
      app.draftConfig.tasks.forEach(function (t) {
        var on = (s.skills || []).indexOf(t.id) >= 0;
        var chip = el('button', 'chip' + (on ? '' : ' is-vacation'), t.title);
        chip.type = 'button';
        chip.style.cursor = 'pointer';
        chip.onclick = function () {
          s.skills = s.skills || [];
          var idx = s.skills.indexOf(t.id);
          if (idx >= 0) s.skills.splice(idx, 1);
          else s.skills.push(t.id);
          renderStaffTab();
        };
        chips.appendChild(chip);
      });
      card.appendChild(chips);
      box.appendChild(card);
    });

    var add = el('button', 'btn btn--sm btn--ghost', '+ Сотрудник');
    add.type = 'button';
    add.onclick = function () {
      app.draftConfig.staff.push({
        id: P.uid('s'), name: 'Новый сотрудник', color: '#64748b',
        status: 'active', skills: [], shift: null
      });
      renderStaffTab();
    };
    box.appendChild(add);
  }

  function renderShiftTab() {
    var box = $('tab-shift');
    box.innerHTML = '';
    var sh = app.draftConfig.shift;

    box.appendChild(timeField('Начало смены', sh.start, function (v) { sh.start = v; }));
    box.appendChild(timeField('Конец смены', sh.end, function (v) { sh.end = v; }));

    box.appendChild(el('h2', null, 'Перерывы'));
    box.appendChild(el('p', 'muted', 'Перерыв не отменяет задачу, а сдвигает её конец: попал обед в середину упаковки — упаковка закончится позже.'));

    (sh.breaks || []).forEach(function (br, i) {
      var grid = el('div', 'grid grid--staff');
      var title = document.createElement('input');
      title.value = br.title;
      title.onchange = function () { br.title = title.value.trim() || 'Перерыв'; };
      grid.appendChild(title);

      var start = document.createElement('input');
      start.type = 'time';
      start.step = '300';
      start.value = br.start;
      start.onchange = function () { br.start = start.value; };
      grid.appendChild(start);

      var dur = document.createElement('input');
      dur.type = 'number';
      dur.min = '0';
      dur.step = '5';
      dur.value = br.duration;
      dur.title = 'минут';
      dur.onchange = function () { br.duration = Math.max(0, Number(dur.value) || 0); };
      grid.appendChild(dur);

      var del = el('button', 'row-del', '✕');
      del.type = 'button';
      del.onclick = function () { sh.breaks.splice(i, 1); renderShiftTab(); };
      grid.appendChild(del);

      box.appendChild(grid);
    });

    var add = el('button', 'btn btn--sm btn--ghost', '+ Перерыв');
    add.type = 'button';
    add.style.marginTop = '10px';
    add.onclick = function () {
      sh.breaks = sh.breaks || [];
      sh.breaks.push({ title: 'Перерыв', start: '15:00', duration: 15 });
      renderShiftTab();
    };
    box.appendChild(add);

    if (S.state.mode === 'local') {
      box.appendChild(el('h2', null, 'Код доступа'));
      box.appendChild(el('p', 'muted',
        'В локальном режиме код хранится на этом же устройстве и защищает только от случайного касания. Общий план с настоящей проверкой кода появляется после подключения сервера — см. README.'));
      var pin = document.createElement('input');
      pin.value = app.draftConfig.localPin || S.DEFAULT_LOCAL_PIN;
      pin.onchange = function () { app.draftConfig.localPin = pin.value.trim(); };
      var wrap = el('label', 'field');
      wrap.appendChild(el('span', null, 'Локальный код'));
      wrap.appendChild(pin);
      box.appendChild(wrap);
    }
  }

  function timeField(label, value, onChange) {
    var wrap = el('label', 'field');
    wrap.appendChild(el('span', null, label));
    var input = document.createElement('input');
    input.type = 'time';
    input.step = '300';
    input.value = value;
    input.onchange = function () { onChange(input.value); };
    wrap.appendChild(input);
    return wrap;
  }

  function renderLogTab() {
    var box = $('tab-log');
    box.innerHTML = '';
    box.appendChild(el('p', 'muted', 'Кто и когда менял план.'));
    S.history(80).then(function (r) {
      if (!r || !r.items || !r.items.length) {
        box.appendChild(el('p', 'muted', S.state.mode === 'local'
          ? 'В локальном режиме журнал не ведётся.'
          : 'Пока пусто.'));
        return;
      }
      r.items.forEach(function (it) {
        var row = el('div', 'log-item');
        var t = el('time', null, new Date(it.at).toLocaleString('ru-RU'));
        row.appendChild(t);
        row.appendChild(el('span', null,
          (it.actor === 'admin' ? 'правки' : 'планшет') + ' · ' + (it.detail || it.action) +
          (it.target ? ' (' + it.target + ')' : '')));
        box.appendChild(row);
      });
    });
  }

  function saveSetup() {
    app.config = app.draftConfig;
    recompute();
    render();
    S.saveConfig(app.config).then(function (r) {
      if (r && r.conflict) {
        setSync('настройки изменили с другого устройства, перечитано', true);
        return load();
      }
      if (r && r.error) {
        setSync('настройки не сохранены: ' + r.error, true);
        return;
      }
      setSync('настройки сохранены');
      closeModal('setup-modal');
    });
  }

  /* ============================================================
     Вход
     ============================================================ */

  function askPin() {
    $('pin-input').value = '';
    $('pin-err').textContent = '';
    $('pin-hint').textContent = S.state.mode === 'local'
      ? 'Локальный код по умолчанию: ' + S.DEFAULT_LOCAL_PIN
      : 'Введите код, чтобы менять план.';
    openModal('pin-modal');
    setTimeout(function () { $('pin-input').focus(); }, 50);
  }

  function submitPin() {
    var pin = $('pin-input').value.trim();
    if (!pin) return;
    $('pin-err').textContent = '';
    S.login(pin).then(function (r) {
      if (r && r.ok) {
        app.admin = true;
        closeModal('pin-modal');
        render();
        return;
      }
      $('pin-err').textContent = r && r.hint ? r.hint : 'Неверный код';
      $('pin-input').value = '';
    });
  }

  /* ============================================================
     Обработчики
     ============================================================ */

  function bindStaticHandlers() {
    $('prev-day').onclick = function () { goDate(P.shiftISO(app.date, -1)); };
    $('next-day').onclick = function () { goDate(P.shiftISO(app.date, 1)); };
    $('today').onclick = function () { goDate(P.todayISO()); };

    $('admin-toggle').onclick = function () {
      if (app.admin) {
        S.logout().then(function () { app.admin = false; render(); });
      } else {
        askPin();
      }
    };

    $('setup-open').onclick = openSetup;
    $('add-block').onclick = function () { openBlockEditor(null); };
    $('jobs-open').onclick = openJobs;
    $('job-add').onclick = addJob;
    $('jobs-apply').onclick = applyJobs;
    $('jobs-copy').onclick = copyJobsToTomorrow;
    $('jobs-tomorrow').onclick = pullTomorrowJobs;

    $('rebuild').onclick = function () {
      if (!confirm('Собрать день заново из шаблона? Ручные правки этого дня пропадут.')) return;
      mutate(function () {
        var volumes = app.day.volumes;
        var absent = app.day.absent;
        app.day = P.materialize(app.config, P.emptyDay(app.date));
        app.day.volumes = volumes;
        app.day.absent = absent;
      }, 'день собран заново из шаблона');
    };

    $('block-save').onclick = saveBlock;
    $('block-delete').onclick = deleteBlock;
    Array.prototype.forEach.call($('block-mode').children, function (btn) {
      btn.onclick = function () { setMode(btn.getAttribute('data-mode')); };
    });

    $('pin-submit').onclick = submitPin;
    $('pin-input').onkeydown = function (e) { if (e.key === 'Enter') submitPin(); };

    /* Цифровая клавиатура: на планшете системная клавиатура закрывает
       половину экрана и на киоск-режиме может не появиться вовсе. */
    var keypad = $('keypad');
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].forEach(function (k) {
      var b = el('button', null, k);
      b.type = 'button';
      b.onclick = function () {
        var input = $('pin-input');
        if (k === '⌫') input.value = input.value.slice(0, -1);
        else if (k === '✓') submitPin();
        else input.value += k;
      };
      keypad.appendChild(b);
    });

    $('setup-save').onclick = saveSetup;
    $('logout').onclick = function () {
      S.logout().then(function () {
        app.admin = false;
        closeModal('setup-modal');
        render();
      });
    };
    Array.prototype.forEach.call($('setup-tabs').children, function (b) {
      b.onclick = function () { showTab(b.getAttribute('data-tab')); };
    });

    document.addEventListener('click', function (e) {
      var id = e.target.getAttribute && e.target.getAttribute('data-close');
      if (id) closeModal(id);
      /* Клик по затемнению закрывает окно; клик внутри — нет. */
      if (e.target.classList && e.target.classList.contains('modal')) e.target.hidden = true;
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      ['pin-modal', 'block-modal', 'setup-modal', 'jobs-modal'].forEach(closeModal);
    });

    /* Планшет висит сутками: в полночь дата должна перещёлкнуться сама. */
    setInterval(function () {
      if (!app.dirty && !anyModalOpen() && app.date !== P.todayISO() && wasToday) {
        wasToday = false;
        goDate(P.todayISO());
      }
      if (app.date === P.todayISO()) wasToday = true;
    }, 60000);
  }

  var wasToday = true;

  boot();
})();
