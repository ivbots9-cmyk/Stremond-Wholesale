#!/usr/bin/env node
/*
 * Тесты Worker'а плана склада: node worker.test.js
 *
 * Проверяют границу прав — то место, где ошибка стоит дороже всего.
 * Ролей три, и каждая пара «роль ↔ действие» проверяется с двух сторон:
 * что разрешённое проходит и что запрещённое отбивается. Базу подменяем
 * заглушкой в памяти, настоящий Cloudflare не нужен.
 */
'use strict';

var assert = require('assert');
var path = require('path');

var PIN = { tablet: '1234', manager: '5678', admin: '4821' };

/* Заглушка D1: хранит документы и журнал в обычных объектах и понимает
   те четыре запроса, которые делает worker.js. */
function fakeDB(state) {
  function run(sql, args) {
    if (/INSERT INTO wh_doc/.test(sql)) {
      state.docs[args[0]] = { body: args[1], version: args[2], updated_at: args[3], updated_by: args[4] };
      return { success: true };
    }
    if (/INSERT INTO wh_log/.test(sql)) {
      state.log.unshift({ at: args[0], actor: args[1], action: args[2], target: args[3], detail: args[4] });
      return { success: true };
    }
    return { success: true };
  }

  function first(sql, args) {
    if (/FROM wh_doc/.test(sql)) return state.docs[args[0]] || null;
    return null;
  }

  return {
    prepare: function (sql) {
      return {
        bind: function () {
          var args = Array.prototype.slice.call(arguments);
          return {
            first: async function () { return first(sql, args); },
            run: async function () { return run(sql, args); },
            all: async function () {
              if (/FROM wh_log/.test(sql)) return { results: state.log.slice(0, args[0]) };
              return { results: [] };
            }
          };
        }
      };
    }
  };
}

/*
 * opts.pins — какие роли настроены. По умолчанию все три.
 * opts.legacyPin — вместо WH_PIN_ADMIN выставить старый WH_PIN.
 */
function fakeEnv(state, opts) {
  opts = opts || {};
  var pins = opts.pins === undefined ? PIN : opts.pins;
  var env = {
    DB: fakeDB(state),
    ASSETS: { fetch: async function () { return new Response('<html>план</html>'); } }
  };
  if (pins.tablet) env.WH_PIN_TABLET = pins.tablet;
  if (pins.manager) env.WH_PIN_MANAGER = pins.manager;
  if (pins.admin) {
    if (opts.legacyPin) env.WH_PIN = pins.admin;
    else env.WH_PIN_ADMIN = pins.admin;
  }
  return env;
}

function freshState() {
  return { docs: {}, log: [] };
}

function req(url, options) {
  return new Request('https://warehouse-plan.workers.dev' + url, options);
}

function jsonReq(url, method, body, cookie) {
  var headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return req(url, { method: method, headers: headers, body: JSON.stringify(body || {}) });
}

function cookieOf(res) {
  var raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

var failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.error('  FAIL ' + name + '\n       ' + e.message);
  }
}

var DAY = '2026-08-04';
var sampleDay = { date: DAY, blocks: [{ id: 'b1', staffId: 'toni', taskId: 'pack', status: 'planned', doneQty: 0 }], absent: [], volumes: {} };

(async function () {
  var mod = await import(path.join(__dirname, 'worker.js'));
  var worker = mod.default;

  async function loginAs(env, role) {
    var res = await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN[role] }), env);
    assert.strictEqual(res.status, 200, 'вход под ролью ' + role + ' должен проходить');
    return cookieOf(res);
  }

  console.log('\nWorker плана склада\n');

  /* ---------- вход ---------- */

  await check('без кода править настройки нельзя', async function () {
    var env = fakeEnv(freshState());
    var res = await worker.fetch(jsonReq('/api/config', 'PUT', { config: { hacked: true } }), env);
    assert.strictEqual(res.status, 403);
  });

  await check('неверный код не пускает', async function () {
    var env = fakeEnv(freshState());
    var res = await worker.fetch(jsonReq('/api/login', 'POST', { pin: '0000' }), env);
    assert.strictEqual(res.status, 401);
    assert.ok(!res.headers.get('set-cookie'), 'куки при неверном коде быть не должно');
  });

  await check('код сам определяет роль — выбирать её при входе нельзя', async function () {
    var env = fakeEnv(freshState());

    var asTablet = await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN.tablet }), env);
    assert.strictEqual((await asTablet.json()).role, 'tablet');

    var asManager = await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN.manager }), env);
    assert.strictEqual((await asManager.json()).role, 'manager');

    var asAdmin = await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN.admin }), env);
    assert.strictEqual((await asAdmin.json()).role, 'admin');

    /* Просьба выдать роль повыше игнорируется: решает код, а не тело. */
    var cheeky = await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN.tablet, role: 'admin' }), env);
    assert.strictEqual((await cheeky.json()).role, 'tablet');
  });

  await check('старый WH_PIN продолжает пускать администратора', async function () {
    var env = fakeEnv(freshState(), { legacyPin: true });
    var res = await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN.admin }), env);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).role, 'admin');
  });

  await check('верный код выдаёт куку, и с ней правки проходят', async function () {
    var env = fakeEnv(freshState());
    var login = await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN.admin }), env);
    var cookie = cookieOf(login);
    assert.ok(/^wh_session=/.test(cookie), 'нет куки доступа');

    var res = await worker.fetch(jsonReq('/api/config', 'PUT', { config: { version: 1 }, version: 0 }, cookie), env);
    assert.strictEqual(res.status, 200);
  });

  await check('подделанная кука не проходит', async function () {
    var env = fakeEnv(freshState());
    var future = String(Date.now() + 3600e3);
    var forged = 'wh_session=admin.' + future + '.' + 'f'.repeat(64);
    var res = await worker.fetch(jsonReq('/api/config', 'PUT', { config: {} }, forged), env);
    assert.strictEqual(res.status, 403);
  });

  await check('куку планшета нельзя переписать в администратора', async function () {
    var env = fakeEnv(freshState());
    var tablet = await loginAs(env, 'tablet');

    /* Подпись считается от роли вместе со сроком, поэтому подставить
       чужую роль, не трогая подпись, не выйдет. */
    var promoted = tablet.replace('=tablet.', '=admin.');
    var res = await worker.fetch(jsonReq('/api/config', 'PUT', { config: { hacked: true } }, promoted), env);
    assert.strictEqual(res.status, 403);
  });

  await check('просроченная кука не проходит', async function () {
    var env = fakeEnv(freshState());
    var cookie = await loginAs(env, 'admin');
    var expired = cookie.replace(/\.(\d+)\./, '.' + (Date.now() - 1000) + '.');
    var res = await worker.fetch(jsonReq('/api/config', 'PUT', { config: {} }, expired), env);
    assert.strictEqual(res.status, 403);
  });

  await check('смена кода закрывает выданные раньше сессии', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var cookie = await loginAs(env, 'admin');

    /* Код увели — администратор его сменил. Старая кука должна умереть
       вместе с прежним кодом. */
    var rotated = fakeEnv(state, { pins: { tablet: PIN.tablet, manager: PIN.manager, admin: '9999' } });
    var res = await worker.fetch(jsonReq('/api/config', 'PUT', { config: {} }, cookie), rotated);
    assert.strictEqual(res.status, 403);
  });

  await check('роль без заданного кода не существует', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var cookie = await loginAs(env, 'manager');

    /* Менеджера убрали из настроек — его кука перестаёт пускать сразу,
       не дожидаясь конца срока. */
    var without = fakeEnv(state, { pins: { tablet: PIN.tablet, admin: PIN.admin } });
    var res = await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, cookie), without);
    assert.strictEqual(res.status, 403);

    var login = await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN.manager }), without);
    assert.strictEqual(login.status, 401, 'войти под снятой ролью тоже нельзя');
  });

  await check('совпавшие коды дают меньшие права, а не большие', async function () {
    /* Ошибка настройки не должна оборачиваться лишним доступом. */
    var env = fakeEnv(freshState(), { pins: { tablet: '1111', manager: '2222', admin: '1111' } });
    var res = await worker.fetch(jsonReq('/api/login', 'POST', { pin: '1111' }), env);
    assert.strictEqual((await res.json()).role, 'tablet');
  });

  await check('без заданных кодов вход отвечает подсказкой, а не пускает', async function () {
    var env = fakeEnv(freshState(), { pins: {} });
    var res = await worker.fetch(jsonReq('/api/login', 'POST', { pin: '1234' }), env);
    assert.strictEqual(res.status, 503);
    var body = await res.json();
    assert.ok(/wrangler secret/.test(body.hint), 'должна быть подсказка, как задать код');

    var write = await worker.fetch(jsonReq('/api/config', 'PUT', { config: {} }), env);
    assert.strictEqual(write.status, 403, 'без кода правки должны быть закрыты');
  });

  /* ---------- права планшета ---------- */

  await check('планшет отмечает выполнение', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);

    var res = await worker.fetch(jsonReq('/api/progress?date=' + DAY, 'POST', { blockId: 'b1', status: 'done', doneQty: 200 }, tablet), env);
    assert.strictEqual(res.status, 200);

    var saved = JSON.parse(state.docs['day:' + DAY].body);
    assert.strictEqual(saved.blocks[0].status, 'done');
    assert.strictEqual(saved.blocks[0].doneQty, 200);
  });

  await check('планшет не может править план', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var manager = await loginAs(env, 'manager');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, manager), env);

    var tablet = await loginAs(env, 'tablet');
    var res = await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: { date: DAY, blocks: [] } }, tablet), env);
    assert.strictEqual(res.status, 403);
  });

  await check('планшет не может менять настройки и не видит журнал', async function () {
    var env = fakeEnv(freshState());
    var tablet = await loginAs(env, 'tablet');

    var cfg = await worker.fetch(jsonReq('/api/config', 'PUT', { config: { hacked: true } }, tablet), env);
    assert.strictEqual(cfg.status, 403);

    var log = await worker.fetch(req('/api/log', { headers: { Cookie: tablet } }), env);
    assert.strictEqual(log.status, 403);
  });

  await check('гость смотрит план, но не отмечает выполнение', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var manager = await loginAs(env, 'manager');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, manager), env);

    var read = await worker.fetch(req('/api/state?date=' + DAY), env);
    assert.strictEqual(read.status, 200, 'смотреть план можно без входа');
    assert.strictEqual((await read.json()).day.blocks.length, 1);

    var mark = await worker.fetch(jsonReq('/api/progress?date=' + DAY, 'POST', { blockId: 'b1', status: 'done' }), env);
    assert.strictEqual(mark.status, 403, 'без входа отмечать нельзя');
  });

  /* ---------- права менеджера и администратора ---------- */

  await check('менеджер правит план и настройки', async function () {
    var env = fakeEnv(freshState());
    var manager = await loginAs(env, 'manager');

    var day = await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, manager), env);
    assert.strictEqual(day.status, 200);

    var cfg = await worker.fetch(jsonReq('/api/config', 'PUT', { config: { products: [] }, version: 0 }, manager), env);
    assert.strictEqual(cfg.status, 200);
  });

  await check('менеджер не может править раздел «Доступ»', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var admin = await loginAs(env, 'admin');
    await worker.fetch(jsonReq('/api/config', 'PUT', {
      config: { products: [], access: { pins: { tablet: '1111' } } }, version: 0
    }, admin), env);

    var manager = await loginAs(env, 'manager');
    var res = await worker.fetch(jsonReq('/api/config', 'PUT', {
      config: { products: [], access: { pins: { tablet: '0000' } } }, version: 1
    }, manager), env);
    assert.strictEqual(res.status, 403);

    var saved = JSON.parse(state.docs.config.body);
    assert.strictEqual(saved.access.pins.tablet, '1111', 'раздел «Доступ» не должен был измениться');
  });

  await check('менеджер сохраняет настройки, не трогая раздел «Доступ»', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var admin = await loginAs(env, 'admin');
    await worker.fetch(jsonReq('/api/config', 'PUT', {
      config: { products: ['jolly'], access: { pins: { tablet: '1111' } } }, version: 0
    }, admin), env);

    var manager = await loginAs(env, 'manager');
    var res = await worker.fetch(jsonReq('/api/config', 'PUT', {
      config: { products: ['jolly', 'starburst'], access: { pins: { tablet: '1111' } } }, version: 1
    }, manager), env);
    assert.strictEqual(res.status, 200, 'обычные настройки менеджеру менять можно');
  });

  await check('администратор правит раздел «Доступ»', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var admin = await loginAs(env, 'admin');
    var res = await worker.fetch(jsonReq('/api/config', 'PUT', {
      config: { access: { pins: { tablet: '7777' } } }, version: 0
    }, admin), env);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(state.docs.config.body).access.pins.tablet, '7777');
  });

  /* ---------- день ---------- */

  await check('планшет создаёт день из шаблона, но переписать не может', async function () {
    var env = fakeEnv(freshState());
    var tablet = await loginAs(env, 'tablet');

    var create = await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);
    assert.strictEqual(create.status, 200, 'создание дня с планшета должно проходить');

    var again = await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: { date: DAY, blocks: [] } }, tablet), env);
    assert.strictEqual(again.status, 403, 'перезапись существующего дня планшету запрещена');
  });

  await check('гость день не создаёт', async function () {
    var env = fakeEnv(freshState());
    var res = await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }), env);
    assert.strictEqual(res.status, 403);
  });

  await check('версия защищает от затирания чужой правки', async function () {
    var env = fakeEnv(freshState());
    var cookie = await loginAs(env, 'manager');

    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, cookie), env);
    /* Второй планшет прислал правку, не зная о первой. */
    var stale = await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, cookie), env);
    assert.strictEqual(stale.status, 409);
    var body = await stale.json();
    assert.ok(body.day, 'в ответе должна приехать актуальная версия дня');
  });

  await check('плохая дата отбивается', async function () {
    var env = fakeEnv(freshState());
    var cookie = await loginAs(env, 'manager');
    var res = await worker.fetch(jsonReq('/api/day?date=вчера', 'PUT', { day: sampleDay }, cookie), env);
    assert.strictEqual(res.status, 400);
  });

  /* ---------- отметки выполнения ---------- */

  await check('через отметку выполнения нельзя подменить план', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);

    await worker.fetch(jsonReq('/api/progress?date=' + DAY, 'POST', {
      blockId: 'b1',
      status: 'done',
      day: { blocks: [] },                    // попытка протащить свой план
      blocks: [],
      staffId: 'кто-то другой'
    }, tablet), env);

    var saved = JSON.parse(state.docs['day:' + DAY].body);
    assert.strictEqual(saved.blocks.length, 1, 'блоки плана не должны меняться');
    assert.strictEqual(saved.blocks[0].staffId, 'toni', 'исполнитель не должен меняться');
    assert.strictEqual(saved.blocks[0].status, 'done', 'а вот статус — должен');
  });

  await check('несуществующий статус не принимается', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);
    var res = await worker.fetch(jsonReq('/api/progress?date=' + DAY, 'POST', { blockId: 'b1', status: 'удалить' }, tablet), env);
    assert.strictEqual(res.status, 400);
  });

  await check('отметка по несуществующему блоку — 404, а не тихий успех', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);
    var res = await worker.fetch(jsonReq('/api/progress?date=' + DAY, 'POST', { blockId: 'нет-такого', status: 'done' }, tablet), env);
    assert.strictEqual(res.status, 404);
  });

  /* ---------- отметка прихода ---------- */

  await check('планшет отмечает приход, время ставит сервер', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);

    var before = Date.now();
    var res = await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', {
      staffId: 'toni', action: 'in', in: '1999-01-01T00:00:00.000Z'   // подсунутое время
    }, tablet), env);
    assert.strictEqual(res.status, 200);

    var saved = JSON.parse(state.docs['day:' + DAY].body);
    var at = new Date(saved.attendance.toni.in).getTime();
    assert.ok(at >= before, 'время должно быть серверное, а не из тела запроса');
    assert.strictEqual(saved.attendance.toni.out, null);
  });

  await check('гость отметиться не может', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);

    var res = await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'in' }), env);
    assert.strictEqual(res.status, 403);
  });

  await check('через отметку прихода нельзя подменить план', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);

    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', {
      staffId: 'toni',
      action: 'in',
      blocks: [],                       // попытка протащить свой план
      day: { blocks: [] },
      volumes: { hack: 1 }
    }, tablet), env);

    var saved = JSON.parse(state.docs['day:' + DAY].body);
    assert.strictEqual(saved.blocks.length, 1, 'блоки плана меняться не должны');
    assert.ok(!saved.volumes.hack, 'объёмы тоже');
  });

  await check('повторный приход не переписывает время', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);

    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'in' }, tablet), env);
    var first = JSON.parse(state.docs['day:' + DAY].body).attendance.toni.in;

    await new Promise(function (r) { setTimeout(r, 5); });
    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'in' }, tablet), env);
    var second = JSON.parse(state.docs['day:' + DAY].body).attendance.toni.in;
    assert.strictEqual(second, first);
  });

  await check('уход без прихода отбивается', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);

    var res = await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'out' }, tablet), env);
    assert.strictEqual(res.status, 409);
  });

  await check('приход и уход пишутся в журнал', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var manager = await loginAs(env, 'manager');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, manager), env);

    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'in' }, tablet), env);
    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'out' }, tablet), env);

    var res = await worker.fetch(req('/api/log?limit=10', { headers: { Cookie: manager } }), env);
    var items = (await res.json()).items;
    assert.strictEqual(items[0].action, 'attendance');
    assert.ok(/toni → out/.test(items[0].detail), 'в журнале должно быть видно, кто и что отметил');
    assert.ok(/toni → in/.test(items[1].detail));
  });

  await check('неизвестное действие не принимается', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);
    var res = await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'уволить' }, tablet), env);
    assert.strictEqual(res.status, 400);
  });

  await check('перерыв начинается и заканчивается, время серверное', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);
    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'in' }, tablet), env);

    var res = await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'break-start' }, tablet), env);
    assert.strictEqual(res.status, 200);
    var saved = JSON.parse(state.docs['day:' + DAY].body);
    assert.strictEqual(saved.attendance.toni.breaks.length, 1);
    assert.ok(saved.attendance.toni.breaks[0].start, 'начало перерыва должно быть записано');
    assert.strictEqual(saved.attendance.toni.breaks[0].end, null);

    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'break-end' }, tablet), env);
    saved = JSON.parse(state.docs['day:' + DAY].body);
    assert.ok(saved.attendance.toni.breaks[0].end, 'конец перерыва должен быть записан');
  });

  await check('перерыв без прихода отбивается', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);
    var res = await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'break-start' }, tablet), env);
    assert.strictEqual(res.status, 409);
  });

  await check('конец перерыва без перерыва отбивается', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);
    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'in' }, tablet), env);
    var res = await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'break-end' }, tablet), env);
    assert.strictEqual(res.status, 409);
  });

  await check('уход закрывает незакрытый перерыв', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }, tablet), env);
    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'in' }, tablet), env);
    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'break-start' }, tablet), env);
    await worker.fetch(jsonReq('/api/attendance?date=' + DAY, 'POST', { staffId: 'toni', action: 'out' }, tablet), env);

    var rec = JSON.parse(state.docs['day:' + DAY].body).attendance.toni;
    assert.ok(rec.out, 'смена закрыта');
    assert.ok(rec.breaks[0].end, 'перерыв не должен остаться открытым — иначе он съест часы');
  });

  /* ---------- чтение ---------- */

  await check('/api/state отдаёт настройки, день и роль', async function () {
    var env = fakeEnv(freshState());
    var cookie = await loginAs(env, 'admin');
    await worker.fetch(jsonReq('/api/config', 'PUT', { config: { title: 'Склад' }, version: 0 }, cookie), env);
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, cookie), env);

    var res = await worker.fetch(req('/api/state?date=' + DAY, { headers: { Cookie: cookie } }), env);
    var body = await res.json();
    assert.strictEqual(body.config.title, 'Склад');
    assert.strictEqual(body.day.blocks.length, 1);
    assert.strictEqual(body.role, 'admin');
    assert.strictEqual(body.admin, true);
    assert.strictEqual(body.pinSet, true);
    assert.deepStrictEqual(body.roles, ['tablet', 'manager', 'admin']);
  });

  await check('/api/state отличает планшет от того, кто правит план', async function () {
    var env = fakeEnv(freshState());
    var tablet = await loginAs(env, 'tablet');
    var res = await worker.fetch(req('/api/state?date=' + DAY, { headers: { Cookie: tablet } }), env);
    var body = await res.json();
    assert.strictEqual(body.role, 'tablet');
    assert.strictEqual(body.admin, false, 'планшету режим правок не включаем');
  });

  await check('/api/state без куки не выдаёт ни роли, ни признака правок', async function () {
    var env = fakeEnv(freshState());
    var res = await worker.fetch(req('/api/state?date=' + DAY), env);
    var body = await res.json();
    assert.strictEqual(body.role, '');
    assert.strictEqual(body.admin, false);
  });

  await check('журнал открыт менеджеру и пишет, кто именно правил', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var closed = await worker.fetch(req('/api/log'), env);
    assert.strictEqual(closed.status, 403);

    var cookie = await loginAs(env, 'manager');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, cookie), env);

    var res = await worker.fetch(req('/api/log?limit=10', { headers: { Cookie: cookie } }), env);
    var body = await res.json();
    assert.ok(body.items.length > 0, 'правка должна попасть в журнал');
    assert.strictEqual(body.items[0].actor, 'manager', 'в журнале должна стоять роль, а не общее «admin»');
  });

  await check('журнал различает отметку планшета и правку менеджера', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var manager = await loginAs(env, 'manager');
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, manager), env);

    var tablet = await loginAs(env, 'tablet');
    await worker.fetch(jsonReq('/api/progress?date=' + DAY, 'POST', { blockId: 'b1', status: 'done' }, tablet), env);

    var res = await worker.fetch(req('/api/log?limit=10', { headers: { Cookie: manager } }), env);
    var items = (await res.json()).items;
    assert.strictEqual(items[0].actor, 'tablet');
    assert.strictEqual(items[0].action, 'progress');
    assert.strictEqual(items[1].actor, 'manager');
    assert.strictEqual(items[1].action, 'day');
  });

  await check('выход закрывает доступ', async function () {
    var env = fakeEnv(freshState());
    var cookie = await loginAs(env, 'admin');
    var out = await worker.fetch(jsonReq('/api/logout', 'POST', {}, cookie), env);
    assert.ok(/Max-Age=0/.test(out.headers.get('set-cookie') || ''), 'кука должна гаситься');
  });

  await check('без базы честно сообщается о настройке, а не пустой план', async function () {
    var env = { WH_PIN_ADMIN: PIN.admin, ASSETS: { fetch: async function () { return new Response('ok'); } } };
    var res = await worker.fetch(req('/api/state?date=' + DAY), env);
    assert.strictEqual(res.status, 503);
    var body = await res.json();
    assert.ok(/D1/.test(body.hint));
  });

  await check('всё, кроме /api/, отдаётся статикой', async function () {
    var env = fakeEnv(freshState());
    var res = await worker.fetch(req('/'), env);
    assert.strictEqual(res.status, 200);
    assert.ok(/план/.test(await res.text()));
  });

  console.log(failed ? '\n' + failed + ' проверок упало\n' : '\nвсе проверки прошли\n');
  process.exit(failed ? 1 : 0);
})();
