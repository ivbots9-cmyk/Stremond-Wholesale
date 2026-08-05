#!/usr/bin/env node
/*
 * Тесты Worker'а плана склада: node warehouse/worker.test.js
 *
 * Проверяют границу прав — то место, где ошибка стоит дороже всего:
 * планшет в общем доступе не должен уметь править план, но обязан
 * уметь отмечать выполнение. Базу подменяем заглушкой в памяти,
 * настоящий Cloudflare не нужен.
 */
'use strict';

var assert = require('assert');
var path = require('path');

var PIN = '4821';

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

function fakeEnv(state, opts) {
  return {
    DB: fakeDB(state),
    WH_PIN: (opts && opts.noPin) ? undefined : PIN,
    ASSETS: { fetch: async function () { return new Response('<html>план</html>'); } }
  };
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

  console.log('\nWorker плана склада\n');

  /* ---------- доступ ---------- */

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

  await check('верный код выдаёт куку, и с ней правки проходят', async function () {
    var env = fakeEnv(freshState());
    var login = await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN }), env);
    assert.strictEqual(login.status, 200);
    var cookie = cookieOf(login);
    assert.ok(/^wh_admin=/.test(cookie), 'нет куки доступа');

    var res = await worker.fetch(jsonReq('/api/config', 'PUT', { config: { version: 1 }, version: 0 }, cookie), env);
    assert.strictEqual(res.status, 200);
  });

  await check('подделанная кука не проходит', async function () {
    var env = fakeEnv(freshState());
    var future = String(Date.now() + 3600e3);
    var forged = 'wh_admin=' + future + '.' + 'f'.repeat(64);
    var res = await worker.fetch(jsonReq('/api/config', 'PUT', { config: {} }, forged), env);
    assert.strictEqual(res.status, 403);
  });

  await check('просроченная кука не проходит', async function () {
    var env = fakeEnv(freshState());
    var login = await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN }), env);
    var cookie = cookieOf(login);
    var expired = cookie.replace(/=(\d+)\./, '=' + (Date.now() - 1000) + '.');
    var res = await worker.fetch(jsonReq('/api/config', 'PUT', { config: {} }, expired), env);
    assert.strictEqual(res.status, 403);
  });

  await check('без заданного WH_PIN вход отвечает подсказкой, а не пускает', async function () {
    var env = fakeEnv(freshState(), { noPin: true });
    var res = await worker.fetch(jsonReq('/api/login', 'POST', { pin: '1234' }), env);
    assert.strictEqual(res.status, 503);
    var body = await res.json();
    assert.ok(/wrangler secret/.test(body.hint), 'должна быть подсказка, как задать код');

    var write = await worker.fetch(jsonReq('/api/config', 'PUT', { config: {} }), env);
    assert.strictEqual(write.status, 403, 'без кода правки должны быть закрыты');
  });

  /* ---------- день ---------- */

  await check('первый заход создаёт день без кода, повторная правка — уже нет', async function () {
    var env = fakeEnv(freshState());
    var create = await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }), env);
    assert.strictEqual(create.status, 200, 'создание дня с планшета должно проходить');

    var again = await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: { date: DAY, blocks: [] } }), env);
    assert.strictEqual(again.status, 403, 'перезапись существующего дня без кода запрещена');
  });

  await check('версия защищает от затирания чужой правки', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var cookie = cookieOf(await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN }), env));

    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, cookie), env);
    /* Второй планшет прислал правку, не зная о первой. */
    var stale = await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, cookie), env);
    assert.strictEqual(stale.status, 409);
    var body = await stale.json();
    assert.ok(body.day, 'в ответе должна приехать актуальная версия дня');
  });

  await check('плохая дата отбивается', async function () {
    var env = fakeEnv(freshState());
    var res = await worker.fetch(jsonReq('/api/day?date=вчера', 'PUT', { day: sampleDay }), env);
    assert.strictEqual(res.status, 400);
  });

  /* ---------- отметки выполнения ---------- */

  await check('планшет отмечает выполнение без кода', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }), env);

    var res = await worker.fetch(jsonReq('/api/progress?date=' + DAY, 'POST', { blockId: 'b1', status: 'done', doneQty: 200 }), env);
    assert.strictEqual(res.status, 200);

    var saved = JSON.parse(state.docs['day:' + DAY].body);
    assert.strictEqual(saved.blocks[0].status, 'done');
    assert.strictEqual(saved.blocks[0].doneQty, 200);
  });

  await check('через отметку выполнения нельзя подменить план', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }), env);

    await worker.fetch(jsonReq('/api/progress?date=' + DAY, 'POST', {
      blockId: 'b1',
      status: 'done',
      day: { blocks: [] },                    // попытка протащить свой план
      blocks: [],
      staffId: 'кто-то другой'
    }), env);

    var saved = JSON.parse(state.docs['day:' + DAY].body);
    assert.strictEqual(saved.blocks.length, 1, 'блоки плана не должны меняться');
    assert.strictEqual(saved.blocks[0].staffId, 'toni', 'исполнитель не должен меняться');
    assert.strictEqual(saved.blocks[0].status, 'done', 'а вот статус — должен');
  });

  await check('несуществующий статус не принимается', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }), env);
    var res = await worker.fetch(jsonReq('/api/progress?date=' + DAY, 'POST', { blockId: 'b1', status: 'удалить' }), env);
    assert.strictEqual(res.status, 400);
  });

  await check('отметка по несуществующему блоку — 404, а не тихий успех', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay }), env);
    var res = await worker.fetch(jsonReq('/api/progress?date=' + DAY, 'POST', { blockId: 'нет-такого', status: 'done' }), env);
    assert.strictEqual(res.status, 404);
  });

  /* ---------- чтение ---------- */

  await check('/api/state отдаёт настройки и день', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var cookie = cookieOf(await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN }), env));
    await worker.fetch(jsonReq('/api/config', 'PUT', { config: { title: 'Склад' }, version: 0 }, cookie), env);
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, cookie), env);

    var res = await worker.fetch(req('/api/state?date=' + DAY, { headers: { Cookie: cookie } }), env);
    var body = await res.json();
    assert.strictEqual(body.config.title, 'Склад');
    assert.strictEqual(body.day.blocks.length, 1);
    assert.strictEqual(body.admin, true);
    assert.strictEqual(body.pinSet, true);
  });

  await check('/api/state без куки не выдаёт признак администратора', async function () {
    var env = fakeEnv(freshState());
    var res = await worker.fetch(req('/api/state?date=' + DAY), env);
    var body = await res.json();
    assert.strictEqual(body.admin, false);
  });

  await check('журнал закрыт без кода и пишется при правках', async function () {
    var state = freshState();
    var env = fakeEnv(state);
    var closed = await worker.fetch(req('/api/log'), env);
    assert.strictEqual(closed.status, 403);

    var cookie = cookieOf(await worker.fetch(jsonReq('/api/login', 'POST', { pin: PIN }), env));
    await worker.fetch(jsonReq('/api/day?date=' + DAY, 'PUT', { day: sampleDay, version: 0 }, cookie), env);

    var res = await worker.fetch(req('/api/log?limit=10', { headers: { Cookie: cookie } }), env);
    var body = await res.json();
    assert.ok(body.items.length > 0, 'правка должна попасть в журнал');
    assert.strictEqual(body.items[0].actor, 'admin');
  });

  await check('без базы честно сообщается о настройке, а не пустой план', async function () {
    var env = { WH_PIN: PIN, ASSETS: { fetch: async function () { return new Response('ok'); } } };
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
