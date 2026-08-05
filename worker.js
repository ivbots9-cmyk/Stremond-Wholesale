/*
 * Cloudflare Worker плана склада: отдаёт статику и хранит два документа —
 * настройки и день.
 *
 * Три роли, по возрастанию прав:
 *
 *   tablet   — планшет на складе, общий на всю смену. Смотреть план и
 *              отмечать «начал» / «готово». Больше ничего: подменить план
 *              с планшета нельзя, что бы ни прислали в теле запроса.
 *   manager  — тот, кто ведёт склад: план, задание, отсутствия, товары,
 *              нормы, смены, журнал.
 *   admin    — всё то же плюс раздел «Доступ»: только он меняет настройки
 *              самого доступа.
 *
 * Каждой роли свой секрет, в коде их нет:
 *   npx wrangler secret put WH_PIN_TABLET
 *   npx wrangler secret put WH_PIN_MANAGER
 *   npx wrangler secret put WH_PIN_ADMIN
 *
 * Старый одиночный WH_PIN продолжает работать как код администратора:
 * уже развёрнутый склад не должен терять доступ из-за обновления.
 *
 * Без входа страница доступна только на чтение. Отметка выполнения
 * требует роли tablet — планшет логинится один раз и остаётся в сессии
 * месяц, так что сотрудник у стола код не вводит.
 */

const COOKIE = 'wh_session';

/* Ранг роли: всё сравнение прав сводится к «не ниже, чем». */
const RANK = { tablet: 1, manager: 2, admin: 3 };

/*
 * Планшет — выделенное устройство на складе, ему переучиваться каждое
 * утро незачем. Правки живут смену: закрыли ноутбук — доступ закрылся.
 */
const SESSION_HOURS = { tablet: 24 * 30, manager: 12, admin: 12 };

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
        case '/api/attendance': return await postAttendance(request, env, url);
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
 * Какие роли реально настроены. Незаданная роль просто не существует:
 * войти под ней нельзя, и в подсказке на странице её не будет.
 */
function pins(env) {
  return {
    tablet:  String(env.WH_PIN_TABLET || ''),
    manager: String(env.WH_PIN_MANAGER || ''),
    /* WH_PIN — код администратора из первой версии, до появления ролей. */
    admin:   String(env.WH_PIN_ADMIN || env.WH_PIN || '')
  };
}

function configuredRoles(env) {
  const p = pins(env);
  return Object.keys(RANK).filter((r) => p[r]);
}

/*
 * Ключ подписи куки собирается из самих кодов: отдельный секрет заводить
 * не нужно, а подделать куку, не зная кодов, нельзя. Побочный эффект
 * полезный — смена любого кода разлогинивает всех, включая того, у кого
 * код увели.
 *
 * Роль входит в подписанные данные, иначе куку планшета можно было бы
 * переписать в admin, не трогая подпись.
 */
async function sign(env, payload) {
  const p = pins(env);
  /* Разделитель, который не может встретиться в коде: иначе пары
     кодов 12+34 и 1+234 дали бы один и тот же ключ подписи. */
  const secret = [p.tablet, p.manager, p.admin].join('\u0000');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
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

/*
 * Роль предъявителя куки или '' — гость. Гость может только смотреть.
 */
async function roleOf(request, env) {
  if (!configuredRoles(env).length) return '';
  const raw = readCookie(request, COOKIE);
  if (!raw) return '';

  const parts = raw.split('.');
  if (parts.length !== 3) return '';
  const [role, exp, mac] = parts;

  if (!RANK[role]) return '';
  /* Роль, у которой отобрали код, перестаёт пускать сразу — не дожидаясь
     конца срока куки. */
  if (!pins(env)[role]) return '';
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return '';
  if (!sameSecret(mac, await sign(env, role + '.' + exp))) return '';
  return role;
}

/* Право — это «роль не ниже требуемой». */
async function allow(request, env, needed) {
  const role = await roleOf(request, env);
  return Boolean(role) && RANK[role] >= RANK[needed];
}

async function login(request, env) {
  const available = configuredRoles(env);
  if (!available.length) {
    return json({
      error: 'pin not set',
      hint: 'Коды доступа не заданы. Выполните: npx wrangler secret put WH_PIN_ADMIN'
    }, 503);
  }

  const body = await readBody(request);
  const pin = String(body.pin || '').trim();
  const p = pins(env);

  /*
   * Роль определяется самим кодом — отдельного поля «войти как» нет:
   * сотрудник у планшета не должен выбирать, кем он входит.
   *
   * Порядок перебора — от меньших прав к большим. Если два кода случайно
   * совпали, вход даёт меньшие права: ошибка настройки не должна
   * оборачиваться лишним доступом.
   */
  let role = '';
  for (const r of ['tablet', 'manager', 'admin']) {
    if (p[r] && sameSecret(pin, p[r])) { role = r; break; }
  }

  /* Пауза на неверный код: четырёхзначный перебирается за секунды,
     здесь на это уйдут часы. */
  if (!role) {
    await new Promise((r) => setTimeout(r, 700));
    return json({ error: 'wrong pin' }, 401);
  }

  const hours = SESSION_HOURS[role];
  const exp = String(Date.now() + hours * 3600e3);
  const value = role + '.' + exp + '.' + await sign(env, role + '.' + exp);
  return json({ ok: true, role: role, until: Number(exp) }, 200, {
    'Set-Cookie': `${COOKIE}=${value}; Path=/; Max-Age=${Math.round(hours * 3600)}; Secure; HttpOnly; SameSite=Lax`
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

  const [config, day, role] = await Promise.all([
    readDoc(env, 'config'),
    readDoc(env, 'day:' + date),
    roleOf(request, env)
  ]);

  return json({
    ok: true,
    role: role,
    /* admin — «может править план». Поле осталось от версии с одним
       кодом, страница по-прежнему включает по нему режим правок. */
    admin: Boolean(role) && RANK[role] >= RANK.manager,
    roles: configuredRoles(env),
    pinSet: configuredRoles(env).length > 0,
    serverTime: new Date().toISOString(),
    config: config ? config.body : null,
    configVersion: config ? config.version : 0,
    day: day ? day.body : null,
    dayVersion: day ? day.version : 0
  });
}

/* Раздел «Доступ» правит только администратор — на нём висят настройки
   самого входа, и менеджеру там делать нечего. */
function accessChanged(before, after) {
  const a = before && before.access;
  const b = after && after.access;
  return JSON.stringify(a === undefined ? null : a) !== JSON.stringify(b === undefined ? null : b);
}

async function putConfig(request, env) {
  const role = await roleOf(request, env);
  if (!role || RANK[role] < RANK.manager) return json({ error: 'forbidden' }, 403);

  const body = await readBody(request);
  if (!body.config) return json({ error: 'no config' }, 400);

  if (role !== 'admin') {
    const current = await readDoc(env, 'config');
    if (accessChanged(current && current.body, body.config)) {
      return json({
        error: 'forbidden',
        hint: 'Раздел «Доступ» меняет только администратор.'
      }, 403);
    }
  }

  const res = await writeDoc(env, 'config', body.config, body.version, role);
  if (res.conflict) {
    return json({ error: 'conflict', config: res.current && res.current.body, version: res.current && res.current.version }, 409);
  }
  await log(env, role, 'config', '', 'настройки обновлены');
  return json({ ok: true, version: res.version });
}

async function putDay(request, env, url) {
  const date = String(url.searchParams.get('date') || '');
  if (!DATE_RE.test(date)) return json({ error: 'bad date' }, 400);

  const body = await readBody(request);
  if (!body.day) return json({ error: 'no day' }, 400);

  const role = await roleOf(request, env);
  if (!role) return json({ error: 'forbidden' }, 403);

  /*
   * Менять план может менеджер и выше, но первое создание дня разрешено
   * и планшету. Иначе утром планшет показывал бы план из шаблона, а
   * кнопка «готово» падала бы с «нет такого дня»: отмечать выполнение
   * не в чем, пока день не записан. Создание ничего не затирает —
   * версия 0 означает, что документа ещё нет.
   */
  if (RANK[role] < RANK.manager) {
    const existing = await readDoc(env, 'day:' + date);
    if (existing) return json({ error: 'forbidden' }, 403);
    const res = await writeDoc(env, 'day:' + date, body.day, 0, role);
    if (res.conflict) return json({ error: 'forbidden' }, 403);
    await log(env, role, 'day', date, 'день создан из шаблона');
    return json({ ok: true, version: res.version });
  }

  const res = await writeDoc(env, 'day:' + date, body.day, body.version, role);
  if (res.conflict) {
    return json({ error: 'conflict', day: res.current && res.current.body, version: res.current && res.current.version }, 409);
  }
  await log(env, role, 'day', date, body.reason || 'план дня обновлён');
  return json({ ok: true, version: res.version });
}

/*
 * Отметка выполнения — самое частое действие на складе, и оно доступно
 * самой слабой роли. Меняет только status и doneQty конкретного блока:
 * подменить план этим запросом нельзя, что бы ни прислали в теле.
 */
async function postProgress(request, env, url) {
  const date = String(url.searchParams.get('date') || '');
  if (!DATE_RE.test(date)) return json({ error: 'bad date' }, 400);

  const role = await roleOf(request, env);
  if (!role) return json({ error: 'forbidden' }, 403);

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

  const now = new Date().toISOString();

  /*
   * Метки времени ставятся на тех же нажатиях «Начал» и «Готово», что и
   * раньше — отдельной кнопки-таймера нет. Время серверное, как и у
   * прихода: по этим цифрам мы потом уточняем нормы, и часы планшета
   * тут доверия не заслуживают.
   *
   * Снятие статуса стирает обе метки: половина замера выглядит как
   * настоящий и врёт убедительнее, чем его отсутствие.
   */
  if (status === 'active') {
    if (!block.startedAt) block.startedAt = now;
    block.doneAt = null;
  } else if (status === 'done') {
    block.doneAt = now;
  } else {
    block.startedAt = null;
    block.doneAt = null;
  }

  block.status = status;
  if (body.doneQty != null) block.doneQty = Math.max(0, Number(body.doneQty) || 0);
  block.statusAt = now;

  /* Версию не проверяем: отметка «готово» не должна проигрывать гонку
     параллельной правке плана — потерять её обиднее, чем перезаписать. */
  const res = await writeDoc(env, 'day:' + date, doc.body, null, role);
  await log(env, role, 'progress', date, block.taskId + ' → ' + status);
  return json({ ok: true, version: res.version });
}

/*
 * Отметка прихода и ухода с планшета. Как и отметка выполнения, доступна
 * самой слабой роли и трогает ровно одно поле: attendance конкретного
 * человека. План, задание и объёмы этим запросом не поменять.
 *
 * Время ставит сервер, а не планшет. Часы на планшете может сбить кто
 * угодно, а по этим отметкам потом считают зарплату.
 */
async function postAttendance(request, env, url) {
  const date = String(url.searchParams.get('date') || '');
  if (!DATE_RE.test(date)) return json({ error: 'bad date' }, 400);

  const role = await roleOf(request, env);
  if (!role) return json({ error: 'forbidden' }, 403);

  const body = await readBody(request);
  const staffId = String(body.staffId || '');
  const action = String(body.action || '');
  if (!staffId || ['in', 'break-start', 'break-end', 'out'].indexOf(action) < 0) {
    return json({ error: 'bad request' }, 400);
  }

  const doc = await readDoc(env, 'day:' + date);
  if (!doc || !doc.body) return json({ error: 'no day' }, 404);

  const day = doc.body;
  day.attendance = day.attendance || {};
  const now = new Date().toISOString();
  const rec = day.attendance[staffId];

  /*
   * Отрезков работы за день может быть несколько: человек закрыл смену
   * случайно и вернулся, или уходил и пришёл снова. Старая форма
   * { in, out, breaks } читается как один отрезок — записи, сделанные до
   * этого изменения, не теряются.
   */
  const sessionsOf = (r) => {
    if (!r) return [];
    if (Array.isArray(r.sessions)) return r.sessions;
    if (r.in) return [{ in: r.in, out: r.out || null, breaks: r.breaks || [] }];
    return [];
  };
  const openSession = (r) => {
    const list = sessionsOf(r);
    const last = list[list.length - 1];
    return last && !last.out ? last : null;
  };
  const openBreak = (r) => {
    const ses = openSession(r);
    const list = (ses && ses.breaks) || [];
    const last = list[list.length - 1];
    return last && !last.end ? last : null;
  };
  const ensure = () => {
    let r = day.attendance[staffId];
    if (!r) r = day.attendance[staffId] = { sessions: [] };
    if (!Array.isArray(r.sessions)) {
      r.sessions = sessionsOf(r);
      delete r.in; delete r.out; delete r.breaks;
    }
    return r;
  };

  if (action === 'in') {
    const r = ensure();
    /* Открытый отрезок уже есть — повторное нажатие не начинает второй
       и не переписывает время первого. */
    if (!openSession(r)) {
      r.sessions.push({ in: now, out: null, breaks: [] });
      /* Пришёл — значит уже не «отмечен отсутствующим». */
      day.absent = (day.absent || []).filter((id) => id !== staffId);
    }
  } else if (action === 'break-start') {
    const ses = openSession(rec);
    if (!ses) return json({ error: 'not clocked in' }, 409);
    if (!openBreak(rec)) {
      ses.breaks = ses.breaks || [];
      ses.breaks.push({ start: now, end: null });
    }
  } else if (action === 'break-end') {
    const open = openBreak(rec);
    if (!open) return json({ error: 'not on break' }, 409);
    open.end = now;
  } else {
    const ses = openSession(rec);
    if (!ses) return json({ error: 'not clocked in' }, 409);
    /* Ушёл, не закрыв перерыв: закрываем тем же моментом, иначе перерыв
       тянулся бы вечно. */
    const open = openBreak(rec);
    if (open) open.end = now;
    ses.out = now;
  }

  /* Версию не проверяем — по той же причине, что и у отметки выполнения:
     потерять отметку прихода хуже, чем разойтись с параллельной правкой. */
  const res = await writeDoc(env, 'day:' + date, day, null, role);
  await log(env, role, 'attendance', date, staffId + ' → ' + action + ' at ' + now);
  return json({ ok: true, attendance: day.attendance[staffId], version: res.version });
}

async function getLog(request, env, url) {
  /* Журнал — рабочий инструмент менеджера: кто передвинул план, кто
     отметил отсутствие. Планшету он не нужен. */
  if (!await allow(request, env, 'manager')) return json({ error: 'forbidden' }, 403);
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
