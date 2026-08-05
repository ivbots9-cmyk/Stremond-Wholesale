/*
 * Хранилище плана. Два режима, переключение автоматическое:
 *
 *   'api'   — есть Worker с базой: план общий, правка с телефона видна
 *             на планшете через несколько секунд;
 *   'local' — Worker не отвечает (открыли файл локально, не настроили
 *             деплой): всё живёт в localStorage этого устройства.
 *
 * Локальный режим нужен, чтобы страницу можно было открыть и работать
 * с ней сразу, не дожидаясь настройки Cloudflare. Общего плана в нём
 * нет — об этом честно написано в шапке страницы.
 */
(function (root) {
  'use strict';

  var LS_CONFIG = 'wh.config';
  var LS_DAY = 'wh.day.';
  var LS_SESSION = 'wh.session';

  var RANK = { tablet: 1, manager: 2, admin: 3 };

  /* Локальные коды — не защита, а замок от случайного касания: они лежат
     в тех же настройках, которые открывают. В режиме 'api' проверка идёт
     на сервере, и эти коды не используются вовсе. */
  var DEFAULT_LOCAL_PINS = { tablet: '1111', manager: '2222', admin: '3333' };

  var state = {
    mode: null,
    role: '',            // '' | 'tablet' | 'manager' | 'admin'
    admin: false,        // может править план: manager или admin
    roles: [],           // какие роли вообще настроены на сервере
    pinSet: false,
    configVersion: 0,
    dayVersion: 0,
    lastError: ''
  };

  /* Единственное место, где решается «хватает ли прав». */
  function can(needed) {
    return Boolean(state.role) && RANK[state.role] >= RANK[needed];
  }

  function setRole(role) {
    state.role = role || '';
    state.admin = can('manager');
  }

  function api(path, options) {
    return fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, options || {}));
  }

  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { state.lastError = 'Не удалось сохранить локально'; return false; }
  }

  /*
   * Загрузка дня. Первый вызов заодно определяет режим: если /api/state
   * ответил — работаем через сервер, иначе уходим в локальный режим и
   * больше в сеть не стучимся.
   */
  function load(date) {
    if (state.mode === 'local') return Promise.resolve(loadLocal(date));

    return api('/api/state?date=' + encodeURIComponent(date))
      .then(function (res) {
        if (!res.ok && res.status !== 503) throw new Error('http ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data.error && !data.config) {
          /* База не привязана — это ошибка настройки сервера, а не повод
             уезжать в локальный режим: иначе правки уйдут в песок и
             никто не заметит. */
          if (data.error === 'no database') {
            state.mode = 'api';
            state.lastError = data.hint || 'База не подключена';
            throw new Error(state.lastError);
          }
        }
        state.mode = 'api';
        setRole(data.role);
        state.roles = data.roles || [];
        state.pinSet = Boolean(data.pinSet);
        state.configVersion = data.configVersion || 0;
        state.dayVersion = data.dayVersion || 0;
        state.lastError = '';
        return { config: data.config, day: data.day };
      })
      .catch(function (e) {
        if (state.mode === 'api') throw e;
        state.mode = 'local';
        return loadLocal(date);
      });
  }

  function localPins(config) {
    var access = (config && config.access) || {};
    var p = access.pins || {};
    return {
      tablet:  String(p.tablet  || DEFAULT_LOCAL_PINS.tablet),
      manager: String(p.manager || DEFAULT_LOCAL_PINS.manager),
      admin:   String(p.admin   || DEFAULT_LOCAL_PINS.admin)
    };
  }

  function loadLocal(date) {
    var session = lsGet(LS_SESSION, null);
    setRole(session && Number(session.until) > Date.now() ? session.role : '');
    state.roles = ['tablet', 'manager', 'admin'];
    state.pinSet = true;
    return { config: lsGet(LS_CONFIG, null), day: lsGet(LS_DAY + date, null) };
  }

  /*
   * Чтение и запись произвольной даты — нужно для «записать задание на
   * завтра». Версии чужих дней держим отдельной таблицей: версия
   * текущего дня к ним отношения не имеет, а без версии запись
   * затирала бы то, что там уже лежит.
   */
  var otherVersions = {};

  function loadDay(date) {
    if (state.mode === 'local') return Promise.resolve(lsGet(LS_DAY + date, null));
    return api('/api/state?date=' + encodeURIComponent(date))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        otherVersions[date] = data.dayVersion || 0;
        return data.day || null;
      })
      .catch(function () { return null; });
  }

  function saveDayAt(day, reason) {
    if (state.mode === 'local') {
      if (!can('manager')) return Promise.resolve({ error: 'forbidden' });
      return Promise.resolve(lsSet(LS_DAY + day.date, day) ? { ok: true } : { error: 'local write failed' });
    }
    return api('/api/day?date=' + encodeURIComponent(day.date), {
      method: 'PUT',
      body: JSON.stringify({ day: day, version: otherVersions[day.date] || 0, reason: reason || '' })
    }).then(readResult).then(function (r) {
      if (r.version) otherVersions[day.date] = r.version;
      return r;
    });
  }

  function saveConfig(config) {
    if (state.mode === 'local') {
      if (!can('manager')) return Promise.resolve({ error: 'forbidden' });
      return Promise.resolve(lsSet(LS_CONFIG, config) ? { ok: true } : { error: 'local write failed' });
    }
    return api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ config: config, version: state.configVersion })
    }).then(readResult).then(function (r) {
      if (r.version) state.configVersion = r.version;
      return r;
    });
  }

  function saveDay(day, reason) {
    if (state.mode === 'local') {
      /*
       * Те же права, что на сервере: править существующий день может
       * менеджер, но создать сегодняшний из шаблона разрешено и планшету.
       * Иначе утром некуда писать отметки прихода и выполнения, а
       * локальный режим вёл бы себя не так, как рабочий.
       */
      var exists = lsGet(LS_DAY + day.date, null);
      if (!can(exists ? 'manager' : 'tablet')) return Promise.resolve({ error: 'forbidden' });
      return Promise.resolve(lsSet(LS_DAY + day.date, day) ? { ok: true } : { error: 'local write failed' });
    }
    return api('/api/day?date=' + encodeURIComponent(day.date), {
      method: 'PUT',
      body: JSON.stringify({ day: day, version: state.dayVersion, reason: reason || '' })
    }).then(readResult).then(function (r) {
      if (r.version) state.dayVersion = r.version;
      return r;
    });
  }

  /* Отметка «начал / готово» — самой слабой роли достаточно. */
  function progress(date, blockId, status, doneQty) {
    if (state.mode === 'local') {
      if (!can('tablet')) return Promise.resolve({ error: 'forbidden' });
      var day = lsGet(LS_DAY + date, null);
      if (!day || !day.blocks) return Promise.resolve({ error: 'no day' });
      var b = day.blocks.filter(function (x) { return x.id === blockId; })[0];
      if (!b) return Promise.resolve({ error: 'no block' });
      b.status = status;
      if (doneQty != null) b.doneQty = doneQty;
      lsSet(LS_DAY + date, day);
      return Promise.resolve({ ok: true });
    }
    return api('/api/progress?date=' + encodeURIComponent(date), {
      method: 'POST',
      body: JSON.stringify({ blockId: blockId, status: status, doneQty: doneQty })
    }).then(readResult).then(function (r) {
      if (r.version) state.dayVersion = r.version;
      return r;
    });
  }

  /*
   * Отметка прихода и ухода. На сервере время ставит сервер — здесь оно
   * не передаётся вовсе, чтобы не было соблазна доверять часам планшета.
   */
  function attendance(date, staffId, action) {
    if (state.mode === 'local') {
      if (!can('tablet')) return Promise.resolve({ error: 'forbidden' });
      var day = lsGet(LS_DAY + date, null);
      if (!day) return Promise.resolve({ error: 'no day' });
      var now = new Date().toISOString();
      if (action === 'in') WHPlan.clockIn(day, staffId, now);
      else WHPlan.clockOut(day, staffId, now);
      lsSet(LS_DAY + date, day);
      return Promise.resolve({ ok: true, attendance: (day.attendance || {})[staffId] });
    }
    return api('/api/attendance?date=' + encodeURIComponent(date), {
      method: 'POST',
      body: JSON.stringify({ staffId: staffId, action: action })
    }).then(readResult).then(function (r) {
      if (r.version) state.dayVersion = r.version;
      return r;
    });
  }

  function login(pin) {
    if (state.mode === 'local') {
      var expected = localPins(lsGet(LS_CONFIG, null));
      var role = '';
      /* Тот же порядок, что на сервере: при совпадении кодов побеждает
         меньшее право. */
      ['tablet', 'manager', 'admin'].forEach(function (r) {
        if (!role && String(pin) === expected[r]) role = r;
      });
      if (!role) return Promise.resolve({ error: 'wrong pin' });

      var hours = role === 'tablet' ? 24 * 30 : 12;
      lsSet(LS_SESSION, { role: role, until: Date.now() + hours * 3600e3 });
      setRole(role);
      return Promise.resolve({ ok: true, role: role });
    }
    return api('/api/login', { method: 'POST', body: JSON.stringify({ pin: pin }) })
      .then(readResult)
      .then(function (r) {
        if (r.ok) setRole(r.role);
        return r;
      });
  }

  function logout() {
    setRole('');
    if (state.mode === 'local') {
      lsSet(LS_SESSION, null);
      return Promise.resolve({ ok: true });
    }
    return api('/api/logout', { method: 'POST' }).then(readResult);
  }

  function history(limit) {
    if (state.mode === 'local') return Promise.resolve({ ok: true, items: [] });
    return api('/api/log?limit=' + (limit || 50)).then(readResult);
  }

  function readResult(res) {
    return res.json()
      .then(function (data) {
        if (res.status === 409) return { conflict: true, data: data };
        if (!res.ok) return { error: data.error || ('http ' + res.status), hint: data.hint };
        return data;
      })
      .catch(function () { return { error: 'http ' + res.status }; });
  }

  root.WHStore = {
    state: state,
    can: can,
    load: load,
    saveConfig: saveConfig,
    saveDay: saveDay,
    loadDay: loadDay,
    saveDayAt: saveDayAt,
    progress: progress,
    attendance: attendance,
    login: login,
    logout: logout,
    history: history,
    localPins: localPins,
    DEFAULT_LOCAL_PINS: DEFAULT_LOCAL_PINS
  };
})(window);
