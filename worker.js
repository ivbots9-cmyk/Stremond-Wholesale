/*
 * Cloudflare Worker плана склада: отдаёт статику из warehouse/ и хранит
 * два документа — настройки и день.
 *
 * Разделение прав держится на одном различии:
 *   — планшет на складе может отметить «начал» / «готово» (POST /api/progress);
 *   — всё остальное (план, шаблоны, нормы, отсутствие) требует PIN.
 * Так план не сломается от случайного касания, но отмечать выполнение
 * можно без ввода кода — иначе им никто не будет пользоваться.
 *
 * PIN хранится в секрете WH_PIN, в коде его нет:
 *   npx wrangler secret put WH_PIN
 */

const COOKIE = 'wh_admin';
const SESSION_HOURS = 12;   // смена кончилась — доступ на планшете сам закрылся

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Credentials': 'true'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      switch (url.pathname) {
        case '/api/state':    return await getState(request, env, url);
        case '/api/config':   return await putConfig(request, env);
        case '/api/day':      return await putDay(request, env, url);
        case '/api/progress': return await postProgress(request, env, url);
        case '/api/login':    return await login(request, env);
        case '/api/logout':   return logout();
        case '/api/log':      return await getLog(request, env, url);
        default:              return json({ error: 'not found' }, 404);
      }
    } catch (e) {
      return json({ error: 'server error', detail: String(e && e.message || e) }, 500);
    }
  }
};

/* ============================================================
   Доступ
   ============================================================ */

/*
 * Кука подписана HMAC-ом от самого PIN-а: отдельный секрет заводить не
 * нужно, а подделать её, не зная PIN, нельзя. В куке лежит только срок
 * годности — ничего личного там нет.
 */
async function sign(env, payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(env.WH_PIN || '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* Сравнение за постоянное время: обычное === выдаёт по времени, сколько
   символов подписи угадано. */
function sameSecret(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isAdmin(request, env) {
  if (!env.WH_PIN) return false;
  const raw = readCookie(request, COOKIE);
  if (!raw) return false;
  const [exp, mac] = raw.split('.');
  if (!exp || !mac) return false;
  if (Number(exp) < Date.now()) return false;
  return sameSecret(mac, await sign(env, exp));
}

async function login(request, env) {
  if (!env.WH_PIN) {
    return json({
      error: 'pin not set',
      hint: 'PIN не задан. Выполните: npx wrangler secret put WH_PIN'
    }, 503);
  }
  const body = await readBody(request);
  const pin = String(body.pin || '').trim();

  /* Пауза на неверный PIN: четырёхзначный код перебирается за секунды,
     здесь на это уйдут часы. */
  if (!sameSecret(pin, String(env.WH_PIN))) {
    await new Promise((r) => setTimeout(r, 700));
    return json({ error: 'wrong pin' }, 401);
  }

  const exp = String(Date.now() + SESSION_HOURS * 3600e3);
  const value = exp + '.' + await sign(env, exp);
  return json({ ok: true, until: Number(exp) }, 200, {
    'Set-Cookie': `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_HOURS * 3600}; Secure; HttpOnly; SameSite=Lax`
  });
}

function logout() {
  return json({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`
  });
}

/* ============================================================
   Документы
   ============================================================ */

async function readDoc(env, key) {
  const row = await env.DB.prepare('SELECT body, version, updated_at FROM wh_doc WHERE key = ?')
    .bind(key).first();
  if (!row) return null;
  try {
    return { body: JSON.parse(row.body), version: row.version, updatedAt: row.updated_at };
  } catch (e) {
    return null;
  }
}

/*
 * Запись с проверкой версии. Двое правят план с телефона и с планшета —
 * тот, кто пришёл со старой версией, получает 409 и перечитывает день,
 * вместо того чтобы молча затереть чужую правку.
 */
async function writeDoc(env, key, body, expectedVersion, actor) {
  const current = await readDoc(env, key);
  const version = current ? current.version : 0;
  if (expectedVersion != null && Number(expectedVersion) !== version) {
    return { conflict: true, current: current };
  }
  const next = version + 1;
  await env.DB.prepare(
    `INSERT INTO wh_doc (key, body, version, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, version = excluded.version,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(key, JSON.stringify(body), next, new Date().toISOString(), actor || 'admin').run();
  return { version: next };
}

async function log(env, actor, action, target, detail) {
  try {
    await env.DB.prepare('INSERT INTO wh_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(new Date().toISOString(), actor, action, target || '', detail || '').run();
  } catch (e) { /* журнал не должен мешать сохранению плана */ }
}

/* ============================================================
   Обработчики
   ============================================================ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function getState(request, env, url) {
  const date = String(url.searchParams.get('date') || '');
  if (!DATE_RE.test(date)) return json({ error: 'bad date' }, 400);
  if (!env.DB) return json({ error: 'no database', hint: 'Не привязана D1: Worker → Settings → Bindings → DB.' }, 503);

  const [config, day, admin] = await Promise.all([
    readDoc(env, 'config'),
    readDoc(env, 'day:' + date),
    isAdmin(request, env)
  ]);

  return json({
    ok: true,
    admin: admin,
    pinSet: Boolean(env.WH_PIN),
    serverTime: new Date().toISOString(),
    config: config ? config.body : null,
    configVersion: config ? config.version : 0,
    day: day ? day.body : null,
    dayVersion: day ? day.version : 0
  });
}

async function putConfig(request, env) {
  if (!await isAdmin(request, env)) return json({ error: 'forbidden' }, 403);
  const body = await readBody(request);
  if (!body.config) return json({ error: 'no config' }, 400);

  const res = await writeDoc(env, 'config', body.config, body.version, 'admin');
  if (res.conflict) {
    return json({ error: 'conflict', config: res.current && res.current.body, version: res.current && res.current.version }, 409);
  }
  await log(env, 'admin', 'config', '', 'настройки обновлены');
  return json({ ok: true, version: res.version });
}

async function putDay(request, env, url) {
  const date = String(url.searchParams.get('date') || '');
  if (!DATE_RE.test(date)) return json({ error: 'bad date' }, 400);

  const body = await readBody(request);
  if (!body.day) return json({ error: 'no day' }, 400);

  /*
   * Правка дня требует PIN, но первое создание — нет. Иначе утром
   * планшет показывал бы план из шаблона, а кнопка «готово» падала бы
   * с «нет такого дня»: отмечать выполнение не в чем, пока день не
   * записан. Создание пустого дня ничего не затирает — версия 0
   * означает, что документа ещё нет.
   */
  const admin = await isAdmin(request, env);
  if (!admin) {
    const existing = await readDoc(env, 'day:' + date);
    if (existing) return json({ error: 'forbidden' }, 403);
    const res = await writeDoc(env, 'day:' + date, body.day, 0, 'tablet');
    if (res.conflict) return json({ error: 'forbidden' }, 403);
    await log(env, 'tablet', 'day', date, 'день создан из шаблона');
    return json({ ok: true, version: res.version });
  }

  const res = await writeDoc(env, 'day:' + date, body.day, body.version, 'admin');
  if (res.conflict) {
    return json({ error: 'conflict', day: res.current && res.current.body, version: res.current && res.current.version }, 409);
  }
  await log(env, 'admin', 'day', date, body.reason || 'план дня обновлён');
  return json({ ok: true, version: res.version });
}

/*
 * Отметка выполнения с планшета — единственная запись без PIN.
 * Меняет только status и doneQty конкретного блока: подменить план
 * этим запросом нельзя, что бы ни прислали в теле.
 */
async function postProgress(request, env, url) {
  const date = String(url.searchParams.get('date') || '');
  if (!DATE_RE.test(date)) return json({ error: 'bad date' }, 400);

  const body = await readBody(request);
  const blockId = String(body.blockId || '');
  const status = String(body.status || '');
  if (!blockId || ['planned', 'active', 'done'].indexOf(status) < 0) {
    return json({ error: 'bad request' }, 400);
  }

  const doc = await readDoc(env, 'day:' + date);
  if (!doc || !doc.body || !Array.isArray(doc.body.blocks)) return json({ error: 'no day' }, 404);

  const block = doc.body.blocks.find((b) => b.id === blockId);
  if (!block) return json({ error: 'no block' }, 404);

  block.status = status;
  if (body.doneQty != null) block.doneQty = Math.max(0, Number(body.doneQty) || 0);
  block.statusAt = new Date().toISOString();

  /* Версию не проверяем: отметка «готово» не должна проигрывать гонку
     параллельной правке плана — потерять её обиднее, чем перезаписать. */
  const res = await writeDoc(env, 'day:' + date, doc.body, null, 'tablet');
  await log(env, 'tablet', 'progress', date, block.taskId + ' → ' + status);
  return json({ ok: true, version: res.version });
}

async function getLog(request, env, url) {
  if (!await isAdmin(request, env)) return json({ error: 'forbidden' }, 403);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const rows = await env.DB.prepare(
    'SELECT at, actor, action, target, detail FROM wh_log ORDER BY id DESC LIMIT ?'
  ).bind(limit).all();
  return json({ ok: true, items: (rows && rows.results) || [] });
}

/* ============================================================
   Мелочи
   ============================================================ */

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

async function readBody(request) {
  try {
    const ct = request.headers.get('content-type') || '';
    return ct.includes('application/json')
      ? await request.json()
      : Object.fromEntries((await request.formData()).entries());
  } catch (e) {
    return {};
  }
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS, headers || {})
  });
}
