/*
 * Язык интерфейса. Английский по умолчанию — на складе читают на нём;
 * русский нужен тому, кто ведёт настройки.
 *
 * Переводится ТОЛЬКО интерфейс. Названия задач, товаров и имена людей —
 * это данные: их вводит менеджер на том языке, на котором ему удобно, и
 * переключатель их не трогает. Иначе переименование товара ломало бы
 * перевод, а перевод — переименование.
 *
 * Ключи плоские и говорящие: искать по ним в app.js проще, чем по
 * вложенным объектам, а строк тут несколько сотен.
 */
(function (root) {
  'use strict';

  var LS_LANG = 'wh.lang';

  var DICT = {
    en: {
      /* ─── шапка ─── */
      'app.title': 'Warehouse plan',
      'nav.prevDay': 'Previous day',
      'nav.nextDay': 'Next day',
      'nav.today': 'Today',
      'nav.settings': 'Settings',
      'nav.signIn': 'Sign in',
      'nav.signOut': 'Sign out',
      'nav.signInHint': 'Sign in with a code',

      'stat.onShift': 'on shift',
      'stat.planned': 'work planned',
      'stat.load': 'load',
      'stat.free': 'free',
      'stat.done': 'done',
      'stat.ofTotal': 'of',

      /* ─── панель дня ─── */
      'bar.presence': 'Who is in',
      'bar.volumes': 'Volume for the day',
      'bar.plan': 'Plan',
      'bar.jobs': 'Job list',
      'bar.addTask': '+ Task',
      'bar.rebuild': 'Rebuild',
      'bar.vacation': 'vacation',

      /* ─── карточка задачи ─── */
      'task.start': 'Start',
      'task.started': 'Started',
      'task.done': 'Done',
      'task.isDone': 'Completed',
      'task.edit': 'Edit task',
      'task.noVolume': 'volume not set',
      'task.toBulk': 'To bulk',
      'task.withBreak': 'break included: {name}',
      'task.overtime': 'runs past shift end',
      'task.approx': '≈ {value} {unit}',
      'task.handedFrom': 'handed over from {name}',

      /* ─── окно задачи ─── */
      'block.titleNew': 'New task',
      'block.titleEdit': 'Task',
      'block.who': 'Who does it',
      'block.what': 'What they do',
      'block.product': 'Product',
      'block.variant': 'Colour / flavour',
      'block.timeMode': 'How time is counted',
      'block.byTime': 'By time',
      'block.byVolume': 'By quantity',
      'block.duration': 'How long',
      'block.qty': 'Quantity',
      'block.dest': 'Where it goes',
      'block.notBefore': 'Not before',
      'block.optional': '(optional)',
      'block.note': 'Note',
      'block.notePlaceholder': 'e.g. strawberry first',
      'block.delete': 'Delete',
      'block.cancel': 'Cancel',
      'block.save': 'Save',
      'block.hintTime': 'Fixed time. The plan shows the expected output.',
      'block.hintVolume': 'Quantity × minutes per unit from the norms table.',
      'block.unassigned': '— nobody —',

      /* ─── задание на день ─── */
      'jobs.title': 'Job list for the day',
      'jobs.intro': 'What needs doing — with no people attached yet. «Assign to people» spreads it across the shift: important first, splits work between people, and never sits anyone on sorting for more than three hours straight.',
      'jobs.addRow': '+ Row',
      'jobs.fromTomorrow': 'Take from tomorrow',
      'jobs.close': 'Close',
      'jobs.copyTomorrow': 'Save for tomorrow',
      'jobs.apply': 'Assign to people',
      'jobs.summary': '{count} rows · {time}',
      'jobs.empty': 'Nothing here yet. Add a row.',
      'jobs.remove': 'Remove row',

      /* ─── вход ─── */
      'pin.title': 'Access code',
      'pin.hint': 'Enter your code. Your rights are set by the code itself.',
      'pin.hintLocal': 'Local codes by default: warehouse {tablet}, manager {manager}, admin {admin}',
      'pin.wrong': 'Wrong code',
      'pin.cancel': 'Cancel',
      'pin.submit': 'Sign in',
      'pin.signedInAs': 'signed in: {role}',

      /* ─── роли ─── */
      'role.tablet': 'Warehouse',
      'role.manager': 'Manager',
      'role.admin': 'Admin',
      'role.guest': 'Guest',

      /* ─── настройки ─── */
      'setup.templates': 'Week templates',
      'setup.norms': 'Time norms',
      'setup.tasks': 'Tasks',
      'setup.staff': 'People',
      'setup.shift': 'Shift',
      'setup.log': 'History',
      'setup.close': 'Close',
      'setup.save': 'Save settings',
      'setup.saved': 'settings saved',
      'setup.notSaved': 'settings not saved: {error}',
      'setup.access': 'Access',
      'setup.accessServer': 'Codes live in Cloudflare secrets, not in settings and not in the repository. To change one: npx wrangler secret put WH_PIN_TABLET (or _MANAGER, or _ADMIN).',
      'setup.accessLocal': 'In local mode the codes sit on this device and only guard against an accidental tap. Real checking starts once the server is connected — see README.',
      'setup.accessSet': 'code set',
      'setup.accessUnset': 'no code, sign-in closed',
      'setup.accessTablet': 'Warehouse (tablet)',
      'setup.logIntro': 'Who changed the plan and when.',
      'setup.logEmpty': 'Nothing yet.',
      'setup.logLocal': 'History is not kept in local mode.',

      /* ─── состояние ─── */
      'sync.loading': 'loading…',
      'sync.unsaved': 'not saved',
      'sync.saving': 'saving…',
      'sync.saved': 'saved',
      'sync.markFailed': 'mark not saved: {error}',
      'sync.needTablet': 'sign in with the warehouse code to mark progress',
      'sync.modeLocal': 'Local mode: the plan is kept on this device only',
      'sync.modeServer': 'shared plan',
      'sync.updatedAt': 'updated {time}',
      'sync.conflict': 'someone else changed the plan — reloading',

      /* ─── предупреждения движка ─── */
      'warn.absentHasTasks': '{name}: tasks are assigned to someone who is not in today',
      'warn.overloaded': '{name}: shift is over by {time}',
      'warn.noTasks': '{name}: nothing planned for today',
      'warn.sittingStreak': '{name}: {time} of sitting work in a row — worth breaking up',
      'warn.nobodyToTake': '{title}: nobody to hand this to',
      'warn.blockWarn': '{name}: {title} — {detail}',
      'warn.overflow': 'Does not fit in the shift: {title}',

      /* ─── время и даты ─── */
      'time.min': '{n} min',
      'time.hour': '{n} h',
      'time.hourMin': '{h} h {m} min',
      'unit.min': 'min',
      'unit.pcs': 'pcs',

      'weekday.mon': 'Monday',      'weekday.mon.short': 'Mon',
      'weekday.tue': 'Tuesday',     'weekday.tue.short': 'Tue',
      'weekday.wed': 'Wednesday',   'weekday.wed.short': 'Wed',
      'weekday.thu': 'Thursday',    'weekday.thu.short': 'Thu',
      'weekday.fri': 'Friday',      'weekday.fri.short': 'Fri',
      'weekday.sat': 'Saturday',    'weekday.sat.short': 'Sat',
      'weekday.sun': 'Sunday',      'weekday.sun.short': 'Sun',
      'date.today': 'today',
      'date.format': '{month} {day}',
      'month.1': 'January',   'month.2': 'February', 'month.3': 'March',
      'month.4': 'April',     'month.5': 'May',      'month.6': 'June',
      'month.7': 'July',      'month.8': 'August',   'month.9': 'September',
      'month.10': 'October',  'month.11': 'November', 'month.12': 'December',

      'lane.vacation': 'on vacation',
      'lane.absentToday': 'not in today',
      'lane.over': 'over by {time}',
      'lane.free': '{time} free',
      'lane.noTasks': 'No tasks',
      'lane.now': 'now',
      'lane.perHour': '{value} {unit} / hour',
      'lane.nobodyTitle': 'Nobody to take this',
      'lane.nobodyHint': 'none of the available people can pick this up',
      'lane.byTime': 'by time',
      'staff.notAtWork': ' (not at work)',
      'jobs.count': 'Job list · {n}',
      'jobs.noVolumeTasks': 'No quantity-based tasks today',
      'jobs.placeholder': 'Empty. Add a row — e.g. «Bagging · Frooties 2 lb — 180 bags → TikTok».',
      'jobs.colWhat': 'What', 'jobs.colProduct': 'Product', 'jobs.colColour': 'Colour',
      'jobs.colHowMuch': 'How much', 'jobs.colWhere': 'Where',
      'jobs.work': 'Work: {work} · today\u2019s shift {capacity}',
      'jobs.wontFit': ' — will not fit',
      'jobs.emptyAlert': 'The job list is empty — nothing to assign.',
      'jobs.confirmApply': 'Build the day plan from the job list? The current arrangement will be replaced.',
      'jobs.emptyAlert2': 'The job list is empty.',
      'jobs.writeFailed': 'Could not save: {error}',
      'jobs.savedFor': 'Job list saved for {date}. In the morning open that day and press «Assign to people».',
      'jobs.nothingTomorrow': 'Nothing was written ahead for this day.',
      'block.noProduct': 'No product', 'block.noPack': 'No pack size', 'block.allColours': 'All colours',
      'block.outApprox': ' Roughly {qty} {unit} in that time.',
      'block.calcAuto': 'Time is calculated: quantity × norm ({norm} min per {unit}).',
      'block.calcLine': '{qty} × {norm} min = {total}',
      'block.qtyFromVolume': 'Quantity comes from the day volume if left at 0.',
      'setup.tplIntro': 'A template is «what usually happens on this weekday». The plan for a date is built from it, but editing a day does not change the template.',
      'setup.tplTasks': '{title} · {n} tasks',
      'setup.colWho': 'Who', 'setup.colWhat': 'What', 'setup.colCalc': 'Calc',
      'setup.colTimeShare': 'Time / share', 'setup.colWhere': 'Where',
      'setup.minutes': 'minutes', 'setup.shareOfVolume': 'share of the day volume',
      'setup.addTo': '+ Add to {day}',
      'setup.normsIntro': 'How many minutes one unit takes. The norm is looked up from specific to general: «product + pack», then «product», then the task norm.',
      'setup.normsIntro2': 'A norm is how many minutes one unit takes. Quantity-based tasks are timed from it. Put in your own numbers: calculating from someone else\u2019s norms is meaningless.',
      'setup.noUnit': 'no unit',
      'setup.colCounted': 'What is counted', 'setup.colMinPer': 'Min / unit', 'setup.colPerHour': 'Same per hour',
      'setup.baseNorm': 'Base norm', 'setup.baseNormHint': 'when no product is given',
      'setup.perBoxN': '{n} per box', 'setup.noBoxData': 'no box data',
      'setup.fromSupplier': 'from supplier {n} × {size}',
      'setup.colTask': 'Task', 'setup.colUnit': 'Unit', 'setup.colImportance': 'Importance',
      'setup.taskUsed': 'Task «{title}» is in today\u2019s plan. Remove it from the catalogue anyway?',
      'setup.newTask': '+ New task', 'setup.newTaskName': 'New task',
      'setup.skillsIntro': 'Skills: if nothing is ticked, the person takes any work. Tick only when you need to limit what can be handed to them.',
      'setup.statusActive': 'Working', 'setup.statusVacation': 'On vacation', 'setup.statusLeft': 'No longer with us',
      'setup.removePerson': 'Remove {name} from the list?',
      'setup.addPerson': '+ Person', 'setup.newPerson': 'New person',
      'setup.shiftStart': 'Shift start', 'setup.shiftEnd': 'Shift end',
      'setup.breaks': 'Breaks',
      'setup.breaksIntro': 'A break does not cancel a task, it pushes its end: if lunch lands mid-packing, packing finishes later.',
      'setup.addBreak': '+ Break', 'setup.breakName': 'Break',
      'setup.confirmRebuild': 'Rebuild the day from the template? Manual edits to this day will be lost.',
      'setup.changedElsewhere': 'settings changed on another device, reloaded',
      'sync.planChanged': 'the plan changed on another device, reloaded',
      'sync.noRights': 'no rights to edit',
      'sync.notSavedErr': 'not saved: {error}',
      'sync.savedAt': 'saved {time}',
      'sync.online': 'online', 'sync.local': 'local',
      'sync.shared': 'Shared plan · edits show on every device',

      'clock.title': 'Who is at work',
      'clock.tapToStart': 'Tap your name when you start, and again when you leave',
      'clock.signInFirst': 'Sign in with the warehouse code to clock in',
      'clock.in': 'at work since {time}',
      'clock.out': 'worked {worked} · {from}–{to}',
      'clock.expected': 'expected at {time}',
      'clock.noshow': 'not clocked in',
      'clock.absent': 'marked absent',
      'clock.vacation': 'on vacation',
      'clock.failed': 'could not save the clock-in: {error}',
      'clock.confirmOut': 'End the shift for {name}?',
      'clock.someoneMissing': '{n} not clocked in — their work has moved to the others',

      'who.checkIn': 'Check in',
      'who.goBreak': 'Go to break',
      'who.endBreak': 'Back from break',
      'who.clockOut': 'Clock out',
      'who.onBreakSince': 'on break since {time} · {mins} so far',
      'clock.break': 'on break since {time}',
      'setup.hours': 'Hours',
      'hours.intro': 'Hours come from the check-in / break / clock-out taps. Only closed shifts count towards pay. This is a draft for the bookkeeper — no taxes, no overtime rules.',
      'hours.week': 'Week of {date}',
      'hours.prev': 'Previous week', 'hours.next': 'Next week', 'hours.thisWeek': 'This week',
      'hours.person': 'Person', 'hours.days': 'Days', 'hours.breaks': 'Breaks',
      'hours.worked': 'Worked', 'hours.rate': 'Rate / h', 'hours.pay': 'Pay',
      'hours.running': '+{time} running',
      'hours.total': 'Total',
      'hours.noRate': 'set a rate',
      'hours.empty': 'No clock-ins in this week yet.',
      'hours.copy': 'Copy for the bookkeeper',
      'hours.copied': 'copied to clipboard',

      'setup.paidBreaks': 'Breaks are paid',
      'setup.paidBreaksHint': 'Paid: time is counted from check-in to clock-out, breaks included. Unpaid: breaks are deducted. Affects the Hours tab and the pay figure.',
      'hours.paid': 'breaks are paid and included in the hours',
      'hours.unpaid': 'breaks are unpaid and deducted from the hours',
      'clock.outPaid': 'worked {worked} · {from}–{to} · {brk} on break',

      'fact.actual': 'took {time}',
      'fact.over': '{time} over plan',
      'fact.under': '{time} under plan',
      'fact.running': 'running {time}',
      'music.title': 'Music',
      'music.yourTurn': 'Your turn for music, {name}',
      'music.turnOf': '{name} picks the music · {left} left',
      'music.next': 'next: {name}',
      'music.open': 'Open {name}\u2019s music',
      'music.openMine': 'Open my music',
      'music.link': 'Music link',
      'music.linkHint': 'Radio, playlist, YouTube channel — whatever this person puts on. Opens in a new tab; the plan stays where it was.',
      'music.turnLength': 'Music turn, minutes',
      'music.turnLengthHint': 'How long one person\u2019s turn lasts before it passes on. Only people who are clocked in take part.',

      'warn.noSkill': 'outside their skills',
      'warn.nobodyShort': 'nobody available',

      'who.checkInAgain': 'Back to work',
      'who.yourTasks': 'Your tasks today',

      'music.now': 'Music: {name}',
      'music.leftShort': '{left} left',
      'music.nextShort': 'then {name}',
      'music.nobody': 'Music: nobody\u2019s turn yet',
      'music.services': 'Quick links',

      'hours.period': 'Timesheet {from} — {to}',

      'jobs.inBoxes': 'boxes',
      'block.carrier': 'Carrier',
      'block.carrierAuto': 'by destination: {carrier}',

      'lang.switch': 'Русский',
      'lang.switchHint': 'Switch language'
    },

    ru: {
      'app.title': 'План склада',
      'nav.prevDay': 'Предыдущий день',
      'nav.nextDay': 'Следующий день',
      'nav.today': 'Сегодня',
      'nav.settings': 'Настройки',
      'nav.signIn': 'Войти',
      'nav.signOut': 'Выйти',
      'nav.signInHint': 'Войти по коду',

      'stat.onShift': 'на смене',
      'stat.planned': 'работы в плане',
      'stat.load': 'загрузка',
      'stat.free': 'свободно',
      'stat.done': 'сделано',
      'stat.ofTotal': 'из',

      'bar.presence': 'Кто на месте',
      'bar.volumes': 'Объём на день',
      'bar.plan': 'План',
      'bar.jobs': 'Задание',
      'bar.addTask': '+ Задача',
      'bar.rebuild': 'Собрать заново',
      'bar.vacation': 'отпуск',

      'task.start': 'Начал',
      'task.started': 'Начал',
      'task.done': 'Готово',
      'task.isDone': 'Сделано',
      'task.edit': 'Изменить задачу',
      'task.noVolume': 'объём не задан',
      'task.toBulk': 'В балк',
      'task.withBreak': 'с перерывом на {name}',
      'task.overtime': 'выходит за смену',
      'task.approx': '≈ {value} {unit}',
      'task.handedFrom': 'передано от {name}',

      'block.titleNew': 'Новая задача',
      'block.titleEdit': 'Задача',
      'block.who': 'Кто делает',
      'block.what': 'Что делает',
      'block.product': 'Товар',
      'block.variant': 'Цвет / вкус',
      'block.timeMode': 'Как считаем время',
      'block.byTime': 'По времени',
      'block.byVolume': 'По количеству',
      'block.duration': 'Сколько времени',
      'block.qty': 'Количество',
      'block.dest': 'Куда уходит',
      'block.notBefore': 'Начать не раньше',
      'block.optional': '(необязательно)',
      'block.note': 'Заметка',
      'block.notePlaceholder': 'Например: сначала клубника',
      'block.delete': 'Удалить',
      'block.cancel': 'Отмена',
      'block.save': 'Сохранить',
      'block.hintTime': 'Время стоит как поставили. План покажет ожидаемую выработку.',
      'block.hintVolume': 'Количество × норма минут за единицу из таблицы норм.',
      'block.unassigned': '— никто —',

      'jobs.title': 'Задание на день',
      'jobs.intro': 'Что нужно сделать — без привязки к людям. Кнопка «Распределить» раскидает это по смене: важное вперёд, работу делит между людьми, дольше трёх часов подряд на переборке никого не сажает.',
      'jobs.addRow': '+ Строка',
      'jobs.fromTomorrow': 'Взять из завтрашнего',
      'jobs.close': 'Закрыть',
      'jobs.copyTomorrow': 'Записать на завтра',
      'jobs.apply': 'Распределить по людям',
      'jobs.summary': 'строк: {count} · {time}',
      'jobs.empty': 'Пока пусто. Добавьте строку.',
      'jobs.remove': 'Убрать строку',

      'pin.title': 'Код доступа',
      'pin.hint': 'Введите свой код. Права определятся сами.',
      'pin.hintLocal': 'Локальные коды по умолчанию: склад {tablet}, менеджер {manager}, администратор {admin}',
      'pin.wrong': 'Неверный код',
      'pin.cancel': 'Отмена',
      'pin.submit': 'Войти',
      'pin.signedInAs': 'вход: {role}',

      'role.tablet': 'Склад',
      'role.manager': 'Менеджер',
      'role.admin': 'Администратор',
      'role.guest': 'Гость',

      'setup.templates': 'Шаблоны недели',
      'setup.norms': 'Нормы времени',
      'setup.tasks': 'Задачи',
      'setup.staff': 'Сотрудники',
      'setup.shift': 'Смена',
      'setup.log': 'Журнал',
      'setup.close': 'Закрыть',
      'setup.save': 'Сохранить настройки',
      'setup.saved': 'настройки сохранены',
      'setup.notSaved': 'настройки не сохранены: {error}',
      'setup.access': 'Доступ',
      'setup.accessServer': 'Коды хранятся в секретах Cloudflare, не в настройках и не в репозитории. Сменить код: npx wrangler secret put WH_PIN_TABLET (или _MANAGER, или _ADMIN).',
      'setup.accessLocal': 'В локальном режиме коды лежат на этом же устройстве и защищают только от случайного касания. Настоящая проверка появляется после подключения сервера — см. README.',
      'setup.accessSet': 'код задан',
      'setup.accessUnset': 'код не задан, вход закрыт',
      'setup.accessTablet': 'Склад (планшет)',
      'setup.logIntro': 'Кто и когда менял план.',
      'setup.logEmpty': 'Пока пусто.',
      'setup.logLocal': 'В локальном режиме журнал не ведётся.',

      'sync.loading': 'загрузка…',
      'sync.unsaved': 'не сохранено',
      'sync.saving': 'сохраняю…',
      'sync.saved': 'сохранено',
      'sync.markFailed': 'отметка не сохранилась: {error}',
      'sync.needTablet': 'чтобы отмечать выполнение, войдите по коду склада',
      'sync.modeLocal': 'Локальный режим: план хранится только на этом устройстве',
      'sync.modeServer': 'общий план',
      'sync.updatedAt': 'обновлён {time}',
      'sync.conflict': 'план изменили с другого устройства — перечитываю',

      'warn.absentHasTasks': '{name}: задачи стоят на том, кого нет на работе',
      'warn.overloaded': '{name}: смена переполнена на {time}',
      'warn.noTasks': '{name}: на сегодня нет задач',
      'warn.sittingStreak': '{name}: {time} сидячей работы подряд — стоит разбавить',
      'warn.nobodyToTake': '{title}: некому передать',
      'warn.blockWarn': '{name}: {title} — {detail}',
      'warn.overflow': 'Не влезает в смену: {title}',

      'time.min': '{n} мин',
      'time.hour': '{n} ч',
      'time.hourMin': '{h} ч {m} мин',
      'unit.min': 'мин',
      'unit.pcs': 'шт',

      'weekday.mon': 'Понедельник', 'weekday.mon.short': 'Пн',
      'weekday.tue': 'Вторник',     'weekday.tue.short': 'Вт',
      'weekday.wed': 'Среда',       'weekday.wed.short': 'Ср',
      'weekday.thu': 'Четверг',     'weekday.thu.short': 'Чт',
      'weekday.fri': 'Пятница',     'weekday.fri.short': 'Пт',
      'weekday.sat': 'Суббота',     'weekday.sat.short': 'Сб',
      'weekday.sun': 'Воскресенье', 'weekday.sun.short': 'Вс',
      'date.today': 'сегодня',
      'date.format': '{day} {month}',
      'month.1': 'января',   'month.2': 'февраля',  'month.3': 'марта',
      'month.4': 'апреля',   'month.5': 'мая',      'month.6': 'июня',
      'month.7': 'июля',     'month.8': 'августа',  'month.9': 'сентября',
      'month.10': 'октября', 'month.11': 'ноября',  'month.12': 'декабря',

      'lane.vacation': 'в отпуске',
      'lane.absentToday': 'сегодня нет на работе',
      'lane.over': 'перегруз {time}',
      'lane.free': 'свободно {time}',
      'lane.noTasks': 'Задач нет',
      'lane.now': 'сейчас',
      'lane.perHour': '{value} {unit} / час',
      'lane.nobodyTitle': 'Некому передать',
      'lane.nobodyHint': 'никто из доступных не может это взять',
      'lane.byTime': 'по времени',
      'staff.notAtWork': ' (нет на работе)',
      'jobs.count': 'Задание · {n}',
      'jobs.noVolumeTasks': 'Сегодня нет задач, которые считаются по количеству',
      'jobs.placeholder': 'Пусто. Добавьте строку — например «Фасовка · Frooties 2 lb — 180 пакетов → TikTok».',
      'jobs.colWhat': 'Что', 'jobs.colProduct': 'Товар', 'jobs.colColour': 'Цвет',
      'jobs.colHowMuch': 'Сколько', 'jobs.colWhere': 'Куда',
      'jobs.work': 'Работы на {work} · смена на сегодня {capacity}',
      'jobs.wontFit': ' — не влезет',
      'jobs.emptyAlert': 'Задание пустое — распределять нечего.',
      'jobs.confirmApply': 'Собрать план дня из задания? Текущая расстановка задач будет заменена.',
      'jobs.emptyAlert2': 'Задание пустое.',
      'jobs.writeFailed': 'Не удалось записать: {error}',
      'jobs.savedFor': 'Задание записано на {date}. Утром откройте этот день и нажмите «Распределить».',
      'jobs.nothingTomorrow': 'На этот день заранее ничего не записано.',
      'block.noProduct': 'Без товара', 'block.noPack': 'Без фасовки', 'block.allColours': 'Все цвета',
      'block.outApprox': ' За это время выйдет примерно {qty} {unit}.',
      'block.calcAuto': 'Время считается само: количество × норма ({norm} мин за {unit}).',
      'block.calcLine': '{qty} × {norm} мин = {total}',
      'block.qtyFromVolume': 'Количество берётся из объёма на день, если оставить 0.',
      'setup.tplIntro': 'Шаблон — это «что обычно делают в такой день недели». План на конкретную дату собирается из него, но правки дня шаблон не меняют.',
      'setup.tplTasks': '{title} · {n} задач',
      'setup.colWho': 'Кто', 'setup.colWhat': 'Что', 'setup.colCalc': 'Расчёт',
      'setup.colTimeShare': 'Время / доля', 'setup.colWhere': 'Куда',
      'setup.minutes': 'минут', 'setup.shareOfVolume': 'доля от дневного объёма',
      'setup.addTo': '+ Добавить в {day}',
      'setup.normsIntro': 'Сколько минут уходит на одну единицу. Норма ищется от частного к общему: сначала «товар + фасовка», потом «товар», потом общая норма операции.',
      'setup.normsIntro2': 'Норма — сколько минут уходит на одну единицу. Из неё считается время для задач «по количеству». Поставьте свои значения: расчёт по чужим нормам смысла не имеет.',
      'setup.noUnit': 'без единицы',
      'setup.colCounted': 'Что считаем', 'setup.colMinPer': 'Мин / ед.', 'setup.colPerHour': 'Это же в час',
      'setup.baseNorm': 'Базовая норма', 'setup.baseNormHint': 'если товар не указан',
      'setup.perBoxN': '{n} в коробке', 'setup.noBoxData': 'нет данных по коробке',
      'setup.fromSupplier': 'от поставщика {n} × {size}',
      'setup.colTask': 'Задача', 'setup.colUnit': 'Единица', 'setup.colImportance': 'Важность',
      'setup.taskUsed': 'Задача «{title}» стоит в сегодняшнем плане. Всё равно удалить из справочника?',
      'setup.newTask': '+ Новая задача', 'setup.newTaskName': 'Новая задача',
      'setup.skillsIntro': 'Навыки: если ничего не отмечено — человек берётся за любую работу. Отмечайте, только когда нужно ограничить, что ему можно передавать.',
      'setup.statusActive': 'Работает', 'setup.statusVacation': 'В отпуске', 'setup.statusLeft': 'Не работает у нас',
      'setup.removePerson': 'Удалить {name} из списка?',
      'setup.addPerson': '+ Сотрудник', 'setup.newPerson': 'Новый сотрудник',
      'setup.shiftStart': 'Начало смены', 'setup.shiftEnd': 'Конец смены',
      'setup.breaks': 'Перерывы',
      'setup.breaksIntro': 'Перерыв не отменяет задачу, а сдвигает её конец: попал обед в середину упаковки — упаковка закончится позже.',
      'setup.addBreak': '+ Перерыв', 'setup.breakName': 'Перерыв',
      'setup.confirmRebuild': 'Собрать день заново из шаблона? Ручные правки этого дня пропадут.',
      'setup.changedElsewhere': 'настройки изменили с другого устройства, перечитано',
      'sync.planChanged': 'план изменили с другого устройства, перечитано',
      'sync.noRights': 'нет прав на правку',
      'sync.notSavedErr': 'не сохранено: {error}',
      'sync.savedAt': 'сохранено {time}',
      'sync.online': 'на связи', 'sync.local': 'локально',
      'sync.shared': 'Общий план · правки видны на всех устройствах',

      'clock.title': 'Кто на работе',
      'clock.tapToStart': 'Нажмите своё имя, когда начали, и ещё раз, когда уходите',
      'clock.signInFirst': 'Чтобы отмечаться, войдите по коду склада',
      'clock.in': 'на смене с {time}',
      'clock.out': 'отработано {worked} · {from}–{to}',
      'clock.expected': 'ждём к {time}',
      'clock.noshow': 'не отметился',
      'clock.absent': 'отмечен отсутствующим',
      'clock.vacation': 'в отпуске',
      'clock.failed': 'отметка не сохранилась: {error}',
      'clock.confirmOut': 'Закрыть смену для {name}?',
      'clock.someoneMissing': 'не отметились: {n} — их работа ушла остальным',

      'who.checkIn': 'Отметить приход',
      'who.goBreak': 'Уйти на перерыв',
      'who.endBreak': 'Вернуться с перерыва',
      'who.clockOut': 'Закрыть смену',
      'who.onBreakSince': 'на перерыве с {time} · уже {mins}',
      'clock.break': 'на перерыве с {time}',
      'setup.hours': 'Часы',
      'hours.intro': 'Часы берутся из нажатий «пришёл / перерыв / ушёл». В оплату идут только закрытые смены. Это черновик для бухгалтера — без налогов и правил переработки.',
      'hours.week': 'Неделя с {date}',
      'hours.prev': 'Прошлая неделя', 'hours.next': 'Следующая неделя', 'hours.thisWeek': 'Эта неделя',
      'hours.person': 'Сотрудник', 'hours.days': 'Дней', 'hours.breaks': 'Перерывы',
      'hours.worked': 'Отработано', 'hours.rate': 'Ставка / ч', 'hours.pay': 'К оплате',
      'hours.running': '+{time} идёт',
      'hours.total': 'Итого',
      'hours.noRate': 'задайте ставку',
      'hours.empty': 'На этой неделе отметок пока нет.',
      'hours.copy': 'Скопировать для бухгалтера',
      'hours.copied': 'скопировано в буфер',

      'setup.paidBreaks': 'Перерывы оплачиваются',
      'setup.paidBreaksHint': 'Оплачиваются: время считается от прихода до ухода, перерыв внутри. Не оплачиваются: перерывы вычитаются. Влияет на вкладку «Часы» и на сумму.',
      'hours.paid': 'перерывы оплачиваются и входят в часы',
      'hours.unpaid': 'перерывы не оплачиваются и вычтены из часов',
      'clock.outPaid': 'отработано {worked} · {from}–{to} · перерыв {brk}',

      'fact.actual': 'заняло {time}',
      'fact.over': 'дольше плана на {time}',
      'fact.under': 'быстрее плана на {time}',
      'fact.running': 'идёт {time}',
      'music.title': 'Музыка',
      'music.yourTurn': '{name}, твоя очередь ставить музыку',
      'music.turnOf': 'музыку ставит {name} · осталось {left}',
      'music.next': 'следующий: {name}',
      'music.open': 'Включить музыку — {name}',
      'music.openMine': 'Включить свою музыку',
      'music.link': 'Ссылка на музыку',
      'music.linkHint': 'Радио, плейлист, канал на YouTube — что человек слушает. Откроется в новой вкладке, план останется на месте.',
      'music.turnLength': 'Очередь музыки, минут',
      'music.turnLengthHint': 'Сколько длится очередь одного человека, прежде чем перейти дальше. Участвуют только те, кто отметился на смене.',

      'warn.noSkill': 'задача вне навыков',
      'warn.nobodyShort': 'некому передать',

      'who.checkInAgain': 'Вернуться в работу',
      'who.yourTasks': 'Твои задачи на сегодня',

      'music.now': 'Музыка: {name}',
      'music.leftShort': 'осталось {left}',
      'music.nextShort': 'дальше {name}',
      'music.nobody': 'Музыка: очередь ещё не началась',
      'music.services': 'Быстрые ссылки',

      'hours.period': 'Табель {from} — {to}',

      'jobs.inBoxes': 'коробки',
      'block.carrier': 'Перевозчик',
      'block.carrierAuto': 'по площадке: {carrier}',

      'lang.switch': 'English',
      'lang.switchHint': 'Сменить язык'
    }
  };

  var lang = 'en';

  function read() {
    try {
      var saved = localStorage.getItem(LS_LANG);
      if (saved && DICT[saved]) return saved;
    } catch (e) { /* приватный режим — просто остаёмся на языке по умолчанию */ }
    return 'en';
  }

  function write(next) {
    try { localStorage.setItem(LS_LANG, next); } catch (e) { /* см. выше */ }
  }

  /*
   * Подстановка {name} в строку. Пропущенный ключ возвращается как есть —
   * на экране это заметно сразу, в отличие от пустоты.
   */
  function t(key, params) {
    var s = DICT[lang][key];
    if (s === undefined) s = DICT.en[key];
    if (s === undefined) return key;
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, function (whole, name) {
      return params[name] === undefined ? whole : String(params[name]);
    });
  }

  function setLang(next, onChange) {
    if (!DICT[next] || next === lang) return false;
    lang = next;
    write(next);
    document.documentElement.lang = next;
    applyStatic();
    if (typeof onChange === 'function') onChange(next);
    return true;
  }

  /*
   * Разметка помечена data-i18n / data-i18n-aria / data-i18n-placeholder —
   * так статические подписи не приходится перечислять ещё и в app.js.
   */
  function applyStatic(rootNode) {
    var scope = rootNode || document;
    each(scope.querySelectorAll('[data-i18n]'), function (n) {
      n.textContent = t(n.getAttribute('data-i18n'));
    });
    each(scope.querySelectorAll('[data-i18n-aria]'), function (n) {
      n.setAttribute('aria-label', t(n.getAttribute('data-i18n-aria')));
    });
    each(scope.querySelectorAll('[data-i18n-placeholder]'), function (n) {
      n.placeholder = t(n.getAttribute('data-i18n-placeholder'));
    });
    var title = document.querySelector('title');
    if (title) title.textContent = t('app.title');
  }

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }

  lang = read();

  root.WHI18n = {
    t: t,
    setLang: setLang,
    applyStatic: applyStatic,
    get lang() { return lang; },
    other: function () { return lang === 'en' ? 'ru' : 'en'; }
  };
})(window);
