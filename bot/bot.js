const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const https = require('https');

// ============ CONFIG ============
const BOT_TOKEN = process.env.BOT_TOKEN || '8301245345:AAHx6nEzBFyB_-3BYG8BssEDNGoG7CvDwfA';
const PHOTO_BASE = process.env.PHOTO_BASE || 'https://46.173.25.198.nip.io/photos';
// Build photo URL with proper encoding for Cyrillic and spaces
function buildPhotoUrl(path) {
  return PHOTO_BASE + '/' + path.split('/').map(s => encodeURIComponent(s)).join('/');
}
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || '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';
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID || '796215905';
const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID || '-1003748230152';
const AI_MODEL = 'anthropic/claude-3.5-haiku';

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'karaoke_bot',
  user: process.env.DB_USER || 'karaoke',
  password: process.env.DB_PASS || 'KaraokeBot2026!',
});

const bot = new Telegraf(BOT_TOKEN);

// ============ PERSISTENT REPLY KEYBOARD ============
const mainKeyboard = Markup.keyboard([
  ['🍹 Напитки', '🍽 Меню'],
  ['🛋️ Бронирование', '🔥 Кальян'],
  ['🤖 ИИ Агент', '📞 Контакты'],
  ['👤 Профиль', '🛒 Корзина'],
]).resize();

// ============ IN-MEMORY STATE ============
const carts = {};
const sessions = {};
// Support chat relay: staff message_id → guest user_id
const supportMsgToGuest = {};
// Staff reply mode: staffUserId → ticketId
const staffReplyMode = {};

// ============ FEATURE 2: ROTATING BANNERS ============
// Upload banner1.jpg, banner2.jpg, banner3.jpg to /opt/photos/ on VPS
// Banner changes automatically every 3 days in rotation
const BANNERS = ['banner1.jpg', 'banner2.jpg', 'banner3.jpg'];
function getCurrentBanner() {
  const daysSinceEpoch = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  return BANNERS[Math.floor(daysSinceEpoch / 3) % BANNERS.length];
}


// ============ DRINKS CATEGORY CONFIG ============
// Unified drinks table — category field stores 2-letter code
const DRINK_CATS = {
  ck: { label: '🍸 КОКТЕЙЛИ',  folder: 'cocktails', banner: 'banner_cocktails.png' },
  av: { label: '✨ АВТОРСКИЕ', folder: 'authorial',  banner: 'banner_cocktails.png' },
  cw: { label: '🍷 ВИНА',     folder: 'wines',       banner: 'banner_wine.png' },
  cs: { label: '🥃 КРЕПКОЕ',  folder: 'spirits',     banner: 'banner_spirits.png' },
  cp: { label: '🍺 ПИВО',     folder: 'beer',        banner: 'banner_beer.png' },
  cl: { label: '🍋 ЛИМОНАДЫ', folder: 'lemonades',   banner: 'banner_lemonades.png' },
  ch: { label: '☕ ГОРЯЧЕЕ',  folder: 'hot',         banner: 'banner_hot.png' },
  cb: { label: '🥤 БЕЗ АЛК', folder: 'nonalcohol',  banner: 'banner_nonalcohol.png' },
};

// Subcategories for wine (cw) and spirits (cs)
const SUBCATS = {
  cw: [
    { code: 'sparkling', label: '🥂 Игристое' },
    { code: 'red',       label: '🔴 Красное' },
    { code: 'white',     label: '⚪ Белое' },
    { code: 'rose',      label: '🌸 Розовое' },
  ],
  cs: [
    { code: 'vodka',     label: '🍶 Водка' },
    { code: 'rum',       label: '🌿 Ром' },
    { code: 'tequila',   label: '🌵 Текила' },
    { code: 'whisky',    label: '🥃 Виски' },
    { code: 'gin',       label: '🌿 Джин' },
    { code: 'cognac',    label: '🍂 Коньяк' },
    { code: 'sherry',    label: '🍇 Херес' },
    { code: 'porto',     label: '🍷 Порто' },
    { code: 'grappa',    label: '🍾 Граппа' },
    { code: 'vermouth',  label: '🌿 Вермуты' },
    { code: 'nalivka',   label: '🍒 Настойки' },
    { code: 'liqueur',   label: '🍬 Ликёр' },
    { code: 'mezcal',    label: '🌵 Мескаль' },
    { code: 'armagnac',  label: '🥃 Арманьяк' },
    { code: 'calvados',  label: '🍎 Кальвадос' },
    { code: 'brandy',    label: '🥃 Бренди' },
  ],
};

// Map from button callback key → 2-letter code in drinks table
const CAT_TO_CODE = {
  'Классические коктейли': 'ck',
  'Авторские коктейли':    'av',
  'wines':                 'cw',
  'spirits':               'cs',
  'Пиво':                  'cp',
  'Лимонады':              'cl',
  'hot':                   'ch',
  'Безалкогольные':        'cb',
};

// ============ CART HELPERS ============
function getCart(userId) {
  if (!carts[userId]) carts[userId] = [];
  return carts[userId];
}

function addToCart(userId, item) {
  const cart = getCart(userId);
  const existing = cart.find(c => c.name === item.name);
  if (existing) existing.qty += 1;
  else cart.push({ name: item.name, price: item.price, qty: 1 });
}

function removeFromCart(userId, itemName) {
  const cart = getCart(userId);
  const idx = cart.findIndex(c => c.name === itemName);
  if (idx !== -1) {
    cart[idx].qty -= 1;
    if (cart[idx].qty <= 0) cart.splice(idx, 1);
  }
}

function cartTotal(userId) {
  return getCart(userId).reduce((sum, i) => sum + i.price * i.qty, 0);
}

function clearCart(userId) {
  carts[userId] = [];
}

function cartText(userId) {
  const cart = getCart(userId);
  if (cart.length === 0) return '🛒 Корзина пуста';
  let text = '🛒 Ваша корзина:\n\n';
  cart.forEach(i => { text += `• ${i.name} x${i.qty} — ${i.price * i.qty}₽\n`; });
  text += `\n💰 Итого: ${cartTotal(userId)}₽`;
  return text;
}

// ============ OPENROUTER AI ============
function getBookingSystemPrompt(bookingDate, bookingTime, hasCart = false) {
  const hasDateTime = !!(bookingDate && bookingTime);
  let dateTimeStr = '';
  if (hasDateTime) {
    const [y, m, d] = bookingDate.split('-');
    dateTimeStr = `${d}.${m} в ${bookingTime}`;
  }

  const knownBlock = hasDateTime
    ? `\nУЖЕ ИЗВЕСТНО (не спрашивай):\n- Дата и время: ${dateTimeStr}\n`
    : '';

  const taskList = hasDateTime
    ? `1. Количество гостей\n2. Имя для бронирования\n3. Номер телефона\n4. Предзаказ (спроси В КОНЦЕ)`
    : `1. Дата и время (формат ДД.ММ ЧЧ:ММ)\n2. Количество гостей\n3. Имя для бронирования\n4. Номер телефона\n5. Предзаказ (спроси В КОНЦЕ)`;

  const dateRule = hasDateTime
    ? `- НЕ спрашивай дату и время — зафиксированы: ${dateTimeStr}`
    : `- ПЕРВЫМ ДЕЛОМ спроси дату и время визита`;

  const cartRule = hasCart
    ? `- Гость упомянул товары в корзине — при вопросе о предзаказе ОБЯЗАТЕЛЬНО скажи: "У вас уже есть позиции в корзине. Для предзаказа потребуется внести предоплату — подтвердите, и мы оформим вместе с бронью."`
    : `- ПОСЛЕДНИЙ вопрос после сбора всех данных: "Хотите добавить предзаказ напитков или кальяна? Я покажу меню прямо сейчас."`;

  return `Ты — ИИ-ассистент караоке-клуба 7Sky (Санкт-Петербург, Ковенский пер., 5, 7 этаж).
Твоя задача — помочь гостю забронировать комнату или стол.

ИНФОРМАЦИЯ О ЗАВЕДЕНИИ:
- Работаем ежедневно 18:00–06:00
- Телефон: 8 (812) 401-47-45
- 40 000+ песен в базе

КОМНАТЫ:
- Комната 1 (до 8 чел): 2700₽/час (45₽/мин)
- Комната 2 (до 10 чел): 3000₽/час (50₽/мин)
- Комната 3 (до 8 чел): 2700₽/час (45₽/мин)
- Комната 4 (до 10 чел): 3000₽/час (50₽/мин)
- Комната до 18 человек: 3900₽/час (65₽/мин), поминутная тарификация
- Общий зал: 500₽ за песню, до 40 человек, 6 столов

ДЕПОЗИТ:
- Бронь бесплатна, но рекомендуем внести депозит 50% от стоимости первого часа
- Депозит можно внести переводом или на месте

АКЦИИ:
- Пн-Чт скидка 20% на кабинки
- День рождения: именинник поёт бесплатно + скидка 15% для компании
- Happy Hour 18:00-20:00: коктейли -30%
- Студентам: -10% по студенческому
${knownBlock}
ТВОЯ ЗАДАЧА — собрать данные для бронирования:
${taskList}

ПРАВИЛА:
- Будь дружелюбным и кратким (2-3 предложения максимум)
- Спрашивай по одному пункту за раз, не засыпай вопросами
${dateRule}
- Если гость упоминает акцию — подтверди и расскажи условия
- Если данные неполные — мягко уточни
- НЕ выдумывай информацию, которой нет выше
- Отвечай ТОЛЬКО на русском языке
${cartRule}

Когда ВСЕ данные собраны и гость ХОЧЕТ предзаказ (или подтверждает товары из корзины), ответь РОВНО в таком формате:
PREORDER_OFFER
тип: [комната/стол]
место: [название]
дата: [дата и время]
гости: [количество]
имя: [имя]
телефон: [номер]
депозит: [да/нет/на месте]

Когда ВСЕ данные собраны и гость НЕ хочет предзаказ (говорит "нет", "не нужно", "без предзаказа"), ответь РОВНО в таком формате:
BOOKING_COMPLETE
тип: [комната/стол]
место: [название]
дата: [дата и время]
гости: [количество]
имя: [имя]
телефон: [номер]
депозит: [да/нет/на месте]`;
}

function getHelpSystemPrompt(lastBooking) {
  let bookingInfo = 'У пользователя нет предыдущих бронирований.';
  if (lastBooking) {
    bookingInfo = `Последняя бронь пользователя: ${lastBooking.room_name || lastBooking.room_type || 'не указано'}, дата: ${lastBooking.booking_date || 'не указана'}, гостей: ${lastBooking.guests_count || '?'}.`;
  }

  return `Ты — помощник караоке-клуба 7Sky (Санкт-Петербург, Ковенский пер., 5, 7 этаж).
Пользователь обратился за помощью.
${bookingInfo}

Твоя задача — выяснить, что нужно пользователю:
- Забыл вещи
- Вопрос по оплате/счёту
- Жалоба или проблема
- Вопрос по услугам
- Другое

ПРАВИЛА:
- Будь дружелюбным и кратким
- Узнай суть проблемы за 1-2 сообщения
- Отвечай ТОЛЬКО на русском языке

Когда поймёшь проблему, ответь РОВНО в таком формате:
HELP_COMPLETE
проблема: [краткое описание проблемы]`;
}

const AGENT_SYSTEM_PROMPT = `Ты — дружелюбный ИИ-ассистент караоке-клуба 7Sky (Санкт-Петербург, Ковенский пер., 5, 7 этаж).
Ты можешь ответить на любые вопросы гостей о заведении и не только.

ИНФОРМАЦИЯ О ЗАВЕДЕНИИ:
- Работаем ежедневно 18:00–06:00
- Адрес: Ковенский пер., 5, 7 этаж (метро Площадь Восстания / Чернышевская)
- Телефон: 8 (812) 401-47-45
- Сайт: spb7sky.ru
- 40 000+ песен в базе

КОМНАТЫ И ЦЕНЫ:
- Комната 1, 3 (до 8 чел): 2700₽/час (45₽/мин)
- Комната 2, 4 (до 10 чел): 3000₽/час (50₽/мин)
- Комната до 18 человек: 3900₽/час (65₽/мин)
- Общий зал: 500₽ за песню, до 40 человек, 6 столов

АКЦИИ:
- Пн-Чт скидка 20% на кабинки
- День рождения: именинник поёт бесплатно + скидка 15%
- Happy Hour 18:00-20:00: коктейли -30%
- Студентам: -10% по студенческому

КАЛЬЯН: от 1500₽ (классический) до 2500₽ (авторский)

ПРАВИЛА:
- Будь дружелюбным, весёлым и кратким
- Отвечай на ЛЮБЫЕ вопросы — не только о заведении
- Если спрашивают что-то не связанное с клубом — отвечай как обычный помощник
- Если не знаешь точный ответ про клуб — честно скажи и предложи позвонить
- Отвечай ТОЛЬКО на русском языке
- Используй эмодзи для живости`;

const SUPPORT_SYSTEM_PROMPT = `Ты — фильтр запросов от гостей в служебный чат клуба 7Sky.

ЗАДАЧА: оцени сообщение гостя и сформируй запрос для персонала.

ПРАВИЛА:
- Если сообщение — спам, бессмыслица, оскорбления или явно не относится к заведению — ответь только: SPAM
- Если нормальный запрос — ответь РОВНО в таком формате (без лишнего текста):
SUPPORT_REQUEST
текст: [суть запроса в 1-2 предложениях, нейтрально и чётко]

Примеры нормальных запросов: принести воду, уточнить счёт, сломан микрофон, шумные соседи, забыли вещи, проблема с заказом.`;

const STAFF_POLISH_PROMPT = `Ты — ИИ-помощник клуба 7Sky. Задача — по черновику сотрудника составить вежливое сообщение для гостя.

Входные данные:
CONTEXT: краткое описание заявки гостя.
STAFF_RAW: черновой ответ сотрудника.

Правила:
- Не придумывай ничего от себя: передавай только то, что есть в STAFF_RAW.
- Пиши по-русски, на «вы», максимум 1–3 коротких предложения.
- Не используй слова «тикет», «персонал», «сотрудник» — говори от лица заведения: «Мы», «Администратор».
- Если в ответе есть конкретные действия — сформулируй чётко и без двусмысленностей.
- Только простой текст, без markdown и форматирования.
- Верни только финальный текст для гостя, без пояснений.`;

async function polishStaffResponse(ticketContext, staffRaw) {
  try {
    return await callOpenRouter([
      { role: 'system', content: STAFF_POLISH_PROMPT },
      { role: 'user', content: `CONTEXT: ${ticketContext}\nSTAFF_RAW: ${staffRaw}` },
    ]);
  } catch (e) {
    console.error('polish error:', e.message);
    return staffRaw; // fallback — отправляем как есть
  }
}

function callOpenRouter(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: AI_MODEL,
      messages,
      max_tokens: 300,
      temperature: 0.7,
    });

    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://t.me/karaoke7skybot',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]) {
            resolve(json.choices[0].message.content);
          } else {
            console.error('AI response error:', data);
            reject(new Error('No AI response'));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============ SESSION MANAGEMENT ============
function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      active: false,
      type: null,
      room: null,
      bookingId: null,
      ticketId: null,
      date: null,
      time: null,
      messages: [],
      pendingBookingData: null,
    };
  }
  return sessions[userId];
}

function startBookingSession(userId, roomName, date, time) {
  const session = getSession(userId);
  session.active = true;
  session.type = 'booking';
  session.room = roomName;
  session.bookingId = null;
  session.date = date || null;
  session.time = time || null;

  // Передаём корзину как контекст для AI
  const cart = getCart(userId);
  const hasCart = cart.length > 0;
  const cartSummary = hasCart
    ? cart.map(i => `${i.name} x${i.qty} (${i.price * i.qty}₽)`).join(', ') + ` — итого ${cartTotal(userId)}₽`
    : null;

  let userMsg = `Хочу забронировать: ${roomName}`;
  if (date && time) {
    const [y, m, d] = date.split('-');
    userMsg += `\nДата и время уже выбраны: ${d}.${m} в ${time}`;
  }
  if (hasCart) {
    userMsg += `\nУ меня уже есть товары в корзине: ${cartSummary}`;
  }

  session.messages = [
    { role: 'system', content: getBookingSystemPrompt(date, time, hasCart) },
    { role: 'user', content: userMsg },
  ];
  return session;
}

async function startHelpSession(userId) {
  const session = getSession(userId);
  const lastBooking = await getLastBooking(userId);
  session.active = true;
  session.type = 'help';
  session.room = null;
  session.bookingId = null;
  session.lastBooking = lastBooking;
  session.messages = [
    { role: 'system', content: getHelpSystemPrompt(lastBooking) },
  ];
  return session;
}

function startSupportSession(userId) {
  const session = getSession(userId);
  session.active = true;
  session.type = 'support';
  session.messages = [
    { role: 'system', content: SUPPORT_SYSTEM_PROMPT },
  ];
  return session;
}

function endSession(userId) {
  if (sessions[userId]) {
    sessions[userId].active = false;
    sessions[userId].type = null;
    sessions[userId].messages = [];
    sessions[userId].bookingId = null;
    sessions[userId].ticketId = null;
    sessions[userId].date = null;
    sessions[userId].time = null;
    sessions[userId].pendingBookingData = null;
  }
}

// ============ CALENDAR / TIME-PICKER HELPERS ============
const MONTH_NAMES = ['Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MONTH_NAMES_GENITIVE = ['января','февраля','марта','апреля','мая','июня',
  'июля','августа','сентября','октября','ноября','декабря'];

function buildCalendarKeyboard(year, month) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  // Prev/next nav
  const prevDate = new Date(year, month - 2, 1);
  const nextDate = new Date(year, month, 1);
  const prevY = prevDate.getFullYear(), prevM = prevDate.getMonth() + 1;
  const nextY = nextDate.getFullYear(), nextM = nextDate.getMonth() + 1;
  const canGoPrev = prevY > curYear || (prevY === curYear && prevM >= curMonth);
  const prevKey = canGoPrev ? `cal_nav_${prevY}-${String(prevM).padStart(2,'0')}` : 'cal_noop';
  const nextKey = `cal_nav_${nextY}-${String(nextM).padStart(2,'0')}`;

  const rows = [];
  // Header row
  rows.push([
    Markup.button.callback(canGoPrev ? '◀️' : ' ', prevKey),
    Markup.button.callback(`${MONTH_NAMES[month-1]} ${year}`, 'cal_noop'),
    Markup.button.callback('▶️', nextKey),
  ]);
  // Day-of-week header
  rows.push(['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => Markup.button.callback(d, 'cal_noop')));

  // Day grid
  const today = new Date(); today.setHours(0,0,0,0);
  const firstDow = (new Date(year, month - 1, 1).getDay() + 6) % 7; // 0=Mon
  const daysInMonth = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(Markup.button.callback(' ', 'cal_noop'));
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(year, month - 1, d);
    const ds = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    cells.push(dateObj < today
      ? Markup.button.callback('·', 'cal_noop')
      : Markup.button.callback(String(d), `cal_day_${ds}`)
    );
  }
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  rows.push([Markup.button.callback('❌ Отмена', 'cancel_booking')]);
  return Markup.inlineKeyboard(rows);
}

function buildTimePickerKeyboard() {
  const slots = [];
  for (let h = 17; h <= 23; h++) {
    slots.push(`${String(h).padStart(2,'0')}:00`);
    slots.push(`${String(h).padStart(2,'0')}:30`);
  }
  for (let h = 0; h <= 2; h++) {
    slots.push(`${String(h).padStart(2,'0')}:00`);
    if (h < 2) slots.push(`${String(h).padStart(2,'0')}:30`);
  }
  const rows = [];
  for (let i = 0; i < slots.length; i += 4) {
    rows.push(slots.slice(i, i+4).map(t => Markup.button.callback(t, `time_${t}`)));
  }
  rows.push([Markup.button.callback('◀️ Назад к датам', 'back_to_calendar')]);
  rows.push([Markup.button.callback('❌ Отмена', 'cancel_booking')]);
  return Markup.inlineKeyboard(rows);
}

// ============ AI MESSAGE HANDLER ============
async function handleAIMessage(ctx, text) {
  const session = getSession(ctx.from.id);
  if (!session.active) return false;

  if (text === '/start' ||
      text === '🍹 Напитки' || text === '🍽 Меню' ||
      text === '🛋️ Бронирование' || text === '🔥 Кальян' ||
      text === '🤖 ИИ Агент' || text === '📞 Контакты' ||
      text === '👤 Профиль' || text === '🛒 Корзина') {
    endSession(ctx.from.id);
    if (session.type === 'support_chat') {
      try {
        await bot.telegram.sendMessage(SUPPORT_CHAT_ID,
          `ℹ️ Гость ${ctx.from.first_name || ''} (@${ctx.from.username || 'нет'}) вышел из чата`);
      } catch (e) {}
    }
    return false;
  }

  // Support chat — пересылаем напрямую без AI
  if (session.type === 'support_chat') {
    const guestName = ctx.from.first_name || 'Гость';
    const username = ctx.from.username ? `@${ctx.from.username}` : 'нет';
    const tId = session.ticketId;
    const tRef = tId ? ` [#${tId}]` : '';
    try {
      const sent = await bot.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `💬 ${guestName} (${username})${tRef}:\n${text}`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback(`✏️ Ответить${tRef}`, `reply_ticket_${tId || 0}`)],
            [Markup.button.callback(`✅ Закрыть${tRef}`, `close_ticket_${tId || 0}`)],
          ]).reply_markup,
        }
      );
      supportMsgToGuest[sent.message_id] = ctx.from.id;
    } catch (e) { console.error('support_chat forward:', e.message); }
    await ctx.reply('📨 Отправлено персоналу', Markup.inlineKeyboard([
      [Markup.button.callback('❌ Завершить чат', 'support_end_guest')],
    ]));
    return true;
  }

  session.messages.push({ role: 'user', content: text });

  try {
    await ctx.sendChatAction('typing');
    const aiReply = await callOpenRouter(session.messages);
    session.messages.push({ role: 'assistant', content: aiReply });

    if (session.type === 'booking') {
      return await handleBookingReply(ctx, aiReply, session);
    } else if (session.type === 'help') {
      return await handleHelpReply(ctx, aiReply, session);
    } else if (session.type === 'support') {
      return await handleSupportReply(ctx, aiReply, session);
    } else if (session.type === 'agent') {
      await ctx.reply('🤖 ' + aiReply, Markup.inlineKeyboard([
        [Markup.button.callback('❌ Закрыть чат', 'cancel_agent')],
      ]));
      return true;
    }
  } catch (e) {
    console.error('AI error:', e.message);
    await ctx.reply(
      'Извините, произошла ошибка. Попробуйте ещё раз или позвоните:\n📞 8 (812) 401-47-45',
      mainKeyboard
    );
    endSession(ctx.from.id);
    return true;
  }
}

async function handleBookingReply(ctx, aiReply, session) {
  // Нормализуем дату из сессии если AI не вернул её
  function fillDateFromSession(data) {
    if (!data['дата'] && session.date) {
      const [y, m, d] = session.date.split('-');
      data['дата'] = `${d}.${m}${session.time ? ' ' + session.time : ''}`;
    }
  }

  // Общий обработчик финала (BOOKING_COMPLETE или PREORDER_OFFER)
  if (aiReply.includes('PREORDER_OFFER') || aiReply.includes('BOOKING_COMPLETE')) {
    const isPreorder = aiReply.includes('PREORDER_OFFER');
    const marker = isPreorder ? 'PREORDER_OFFER' : 'BOOKING_COMPLETE';
    const bookingData = parseBookingData(aiReply.replace(marker, ''));
    fillDateFromSession(bookingData);
    const bookingId = await saveBooking(ctx.from, bookingData);
    await notifyManager(ctx.from, bookingData);
    session.bookingId = bookingId;
    session.active = false;

    const cart = getCart(ctx.from.id);
    const bookingSummary =
      `🏠 ${bookingData['место'] || session.room}\n` +
      `📆 ${bookingData['дата'] || '?'}\n` +
      `👥 ${bookingData['гости'] || '?'} чел.\n` +
      `👤 ${bookingData['имя'] || ''}`;

    // Если в корзине уже есть товары — спрашиваем через кнопки
    if (cart.length > 0) {
      const total = cartTotal(ctx.from.id);
      const cartList = cart.map(i => `• ${i.name} x${i.qty} — ${i.price * i.qty}₽`).join('\n');
      session.pendingBookingData = bookingData;

      await ctx.reply(
        `✅ Данные бронирования приняты!\n\n${bookingSummary}\n\n` +
        `🛒 В вашей корзине:\n${cartList}\n💰 Итого: ${total}₽\n\n` +
        `⚠️ Для предзаказа потребуется предоплата.\nДобавить позиции к бронированию?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Да, добавить предзаказ', `cart_confirm_${bookingId}`)],
          [Markup.button.callback('❌ Нет, без предзаказа', `cart_skip_${bookingId}`)],
        ])
      );
      return true;
    }

    // Корзина пуста
    if (isPreorder) {
      // Гость хочет выбрать предзаказ из меню
      await ctx.reply(
        `✅ Данные приняты!\n\n${bookingSummary}\n\n` +
        `🛒 Выберите напитки и кальян для предзаказа, затем нажмите «✅ Отправить заявку»`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🍸 КОКТЕЙЛИ', 'precat_ck'), Markup.button.callback('✨ АВТОРСКИЕ', 'precat_av')],
          [Markup.button.callback('🍷 ВИНА', 'precat_cw'), Markup.button.callback('🥃 КРЕПКОЕ', 'precat_cs')],
          [Markup.button.callback('🍺 ПИВО', 'precat_cp'), Markup.button.callback('🔥 КАЛЬЯН', 'precat_hookah')],
          [Markup.button.callback(`✅ Отправить заявку`, `preorder_submit_${bookingId}`)],
          [Markup.button.callback('❌ Без предзаказа', 'booking_done')],
        ])
      );
    } else {
      // Гость не хочет предзаказ — сразу отправляем тикет
      const ticketId = await createBookingTicket(ctx.from, bookingId, bookingData, session.room, null);
      if (ticketId) session.ticketId = ticketId;

      await ctx.reply(
        `✅ Заявка отправлена!\n\n${bookingSummary}\n\n` +
        `🟡 Статус: не подтверждена\nМенеджер свяжется для подтверждения.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Добавить предзаказ', `preorder_${bookingId}`)],
          [Markup.button.callback('✅ ГОТОВО', 'booking_done')],
        ])
      );
    }
    return true;
  }

  // Обычный ответ AI (ещё собирает данные) — без кнопок, гость просто отвечает текстом
  const cleanReply = aiReply.replace('BOOKING_COMPLETE', '').replace('PREORDER_OFFER', '').trim();
  await ctx.reply('🤖 ' + cleanReply);
  return true;
}

async function handleHelpReply(ctx, aiReply, session) {
  if (aiReply.includes('HELP_COMPLETE')) {
    const helpData = parseBookingData(aiReply);
    const problem = helpData['проблема'] || 'не указана';

    const lastBooking = session.lastBooking;
    const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const managerText =
      '🆘 ЗАПРОС ПОМОЩИ\n\n' +
      `👤 ${ctx.from.first_name || ''} (@${ctx.from.username || 'нет'})\n` +
      `📅 Последняя бронь: ${lastBooking ? `${lastBooking.room_name || '?'}, ${lastBooking.booking_date || '?'}` : 'нет'}\n` +
      `❓ Проблема: ${problem}\n` +
      `⏰ Время: ${now}\n` +
      `🆔 Telegram: ${ctx.from.id}`;

    try {
      await bot.telegram.sendMessage(MANAGER_CHAT_ID, managerText);
    } catch (e) {
      console.error('notifyManager help error:', e.message);
    }

    endSession(ctx.from.id);

    await ctx.reply(
      '✅ Спасибо! Я передал информацию менеджеру.\n\n' +
      (lastBooking
        ? `📅 Ваша последняя бронь: ${lastBooking.room_name || '?'}, ${lastBooking.booking_date || '?'}\n\n`
        : '') +
      'Менеджер свяжется с вами в ближайшее время.\n' +
      '📞 Также можете позвонить: 8 (812) 401-47-45',
      mainKeyboard
    );
    return true;
  }

  const cleanReply = aiReply.replace('HELP_COMPLETE', '').trim();
  await ctx.reply('🤖 ' + cleanReply, Markup.inlineKeyboard([
    [Markup.button.callback('❌ Отмена', 'cancel_help')],
  ]));
  return true;
}

async function handleSupportReply(ctx, aiReply, session) {
  if (aiReply.trim() === 'SPAM') {
    endSession(ctx.from.id);
    await ctx.reply(
      '🤔 Не совсем понял запрос. Попробуйте описать чётче или позвоните:\n📞 8 (812) 401-47-45',
      mainKeyboard
    );
    return true;
  }

  if (aiReply.includes('SUPPORT_REQUEST')) {
    let firstName = ctx.from.first_name || 'Гость';
    let roomName = 'не указана';

    try {
      const ur = await pool.query('SELECT first_name FROM users WHERE user_id = $1', [ctx.from.id]);
      if (ur.rows[0]?.first_name) firstName = ur.rows[0].first_name;
    } catch (e) { console.error('support user query:', e.message); }

    try {
      const br = await pool.query(
        `SELECT room_name FROM bookings WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
        [ctx.from.id]
      );
      if (br.rows[0]?.room_name) roomName = br.rows[0].room_name;
    } catch (e) { console.error('support booking query:', e.message); }

    const textMatch = aiReply.match(/текст:\s*(.+)/s);
    const requestText = textMatch ? textMatch[1].trim() : '(без описания)';
    const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

    // Создаём тикет в БД, получаем ticketId
    let ticketId = null;
    try {
      const tr = await pool.query(
        `INSERT INTO support_tickets (user_id, username, cabin_name, request_text, status)
         VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
        [ctx.from.id, ctx.from.username || '', roomName, requestText]
      );
      ticketId = tr.rows[0].id;
    } catch (e) { console.error('support ticket save:', e.message); }

    session.ticketId = ticketId;

    const ticketRef = ticketId ? ` #${ticketId}` : '';
    const managerText =
      `🆘 НОВЫЙ ЗАПРОС${ticketRef}\n\n` +
      `👤 ${firstName} (@${ctx.from.username || 'нет'})\n` +
      `🏠 Кабинка/стол: ${roomName}\n` +
      `💬 ${requestText}\n` +
      `⏰ ${now}\n` +
      `🆔 ID: ${ctx.from.id}`;

    try {
      const sent = await bot.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        managerText,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback(`✏️ Ответить на${ticketRef}`, `reply_ticket_${ticketId || 0}`)],
            [Markup.button.callback(`✅ Закрыть${ticketRef}`, `close_ticket_${ticketId || 0}`)],
          ]).reply_markup,
        }
      );
      supportMsgToGuest[sent.message_id] = ctx.from.id;
      // Сохраняем message_id карточки для обновления статуса
      if (ticketId) {
        try {
          await pool.query(
            `UPDATE support_tickets SET staff_card_msg_id = $1 WHERE id = $2`,
            [sent.message_id, ticketId]
          );
        } catch (e) {}
      }
    } catch (e) { console.error('support notify staff:', e.message); }

    // Переключаем в режим чата — сессия остаётся активной
    session.type = 'support_chat';
    session.messages = [];
    await ctx.reply(
      `✅ Запрос${ticketRef} принят\n🟡 Ожидает ответа персонала\n\nПишите сообщения — они уходят сотруднику напрямую.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('❌ Завершить чат', 'support_end_guest')],
        ...(ticketId ? [[Markup.button.callback(`🚫 Отменить запрос${ticketRef}`, `cancel_ticket_${ticketId}`)]] : []),
      ])
    );
    return true;
  }

  // AI не вернул ожидаемый формат — открываем чат напрямую
  const lastMsg = session.messages[session.messages.length - 2]?.content || '(без описания)';
  const now2 = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

  let fallbackTicketId = null;
  try {
    const tr = await pool.query(
      `INSERT INTO support_tickets (user_id, username, cabin_name, request_text, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [ctx.from.id, ctx.from.username || '', 'не указана', lastMsg]
    );
    fallbackTicketId = tr.rows[0].id;
  } catch (e) {}

  session.ticketId = fallbackTicketId;
  const fallbackRef = fallbackTicketId ? ` #${fallbackTicketId}` : '';

  try {
    const sent = await bot.telegram.sendMessage(
      SUPPORT_CHAT_ID,
      `🆘 НОВЫЙ ЗАПРОС${fallbackRef}\n\n👤 ${ctx.from.first_name || 'Гость'} (@${ctx.from.username || 'нет'})\n💬 ${lastMsg}\n⏰ ${now2}\n🆔 ID: ${ctx.from.id}`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback(`✏️ Ответить на${fallbackRef}`, `reply_ticket_${fallbackTicketId || 0}`)],
          [Markup.button.callback(`✅ Закрыть${fallbackRef}`, `close_ticket_${fallbackTicketId || 0}`)],
        ]).reply_markup,
      }
    );
    supportMsgToGuest[sent.message_id] = ctx.from.id;
    if (fallbackTicketId) {
      try {
        await pool.query(
          `UPDATE support_tickets SET staff_card_msg_id = $1 WHERE id = $2`,
          [sent.message_id, fallbackTicketId]
        );
      } catch (e) {}
    }
  } catch (e) { console.error('support fallback notify:', e.message); }

  session.type = 'support_chat';
  session.messages = [];
  await ctx.reply(
    `✅ Запрос${fallbackRef} принят\n🟡 Ожидает ответа персонала\n\nПишите сообщения — они уходят сотруднику напрямую.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('❌ Завершить чат', 'support_end_guest')],
      ...(fallbackTicketId ? [[Markup.button.callback(`🚫 Отменить запрос${fallbackRef}`, `cancel_ticket_${fallbackTicketId}`)]] : []),
    ])
  );
  return true;
}

// ============ DATA HELPERS ============
function parseBookingData(text) {
  const data = {};
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^([\w\u0400-\u04FF]+):\s*(.+)$/);
    if (match) data[match[1]] = match[2].trim();
  }
  return data;
}

// Feature 1: Log key user actions to visit_log
async function logVisit(userId, action = 'start') {
  try {
    await pool.query(
      'INSERT INTO visit_log (user_id, action) VALUES ($1, $2)',
      [userId, action]
    );
  } catch (e) {
    console.error('logVisit error:', e.message);
  }
}

async function saveBooking(from, data) {
  try {
    const result = await pool.query(
      `INSERT INTO bookings (user_id, username, guest_name, phone, room_type, room_name, booking_date, guests_count, deposit, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'new')
       RETURNING id`,
      [
        from.id,
        from.username || '',
        data['имя'] || '',
        data['телефон'] || '',
        data['тип'] || '',
        data['место'] || '',
        data['дата'] || '',
        data['гости'] || '',
        data['депозит'] || '',
      ]
    );
    await logVisit(from.id, 'booking');
    return result.rows[0].id;
  } catch (e) {
    console.error('saveBooking error:', e.message);
    return null;
  }
}

async function notifyManager(from, data) {
  const text =
    '🔔 НОВАЯ БРОНЬ!\n\n' +
    `👤 ${data['имя'] || from.first_name} (@${from.username || 'нет'})\n` +
    `📞 ${data['телефон'] || 'не указан'}\n` +
    `🏠 ${data['место'] || '?'} (${data['тип'] || '?'})\n` +
    `📅 ${data['дата'] || 'не указана'}\n` +
    `👥 ${data['гости'] || '?'} чел.\n` +
    `💰 Депозит: ${data['депозит'] || '?'}\n\n` +
    `🆔 Telegram: ${from.id}`;

  try {
    await bot.telegram.sendMessage(MANAGER_CHAT_ID, text);
  } catch (e) {
    console.error('notifyManager error:', e.message);
  }
}

// Создать тикет + отправить карточку в рабочий чат
async function createBookingTicket(from, bookingId, bookingData, roomFallback, cart) {
  const venueName = bookingData['место'] || roomFallback || '';
  const venueType = bookingData['тип'] || (venueName.toLowerCase().includes('стол') ? 'Стол' : 'Комната');
  const venueObj = ROOMS.find(r => r.name === venueName) || TABLES.find(t => t.name === venueName || venueName.includes(t.name));
  const capacity = venueObj ? `до ${venueObj.capacity} чел.` : '?';

  let ticketId = null;
  try {
    const tr = await pool.query(
      `INSERT INTO support_tickets (user_id, username, cabin_name, request_text, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [from.id, from.username || '', venueName,
       `${venueType}, ${capacity}, ${bookingData['дата'] || '?'}, ${bookingData['гости'] || '?'} гостей`]
    );
    ticketId = tr.rows[0].id;
  } catch (e) { console.error('createBookingTicket insert:', e.message); }

  if (!ticketId) return null;

  let staffText =
    `📅 НОВАЯ БРОНЬ #${ticketId} — 🟡 ожидает подтверждения\n\n` +
    `🏠 ${venueName}\n` +
    `👥 Вместимость: ${capacity}\n` +
    `📆 ${bookingData['дата'] || '?'}\n` +
    `👤 ${bookingData['имя'] || from.first_name} (@${from.username || 'нет'})\n` +
    `📞 ${bookingData['телефон'] || 'не указан'}\n` +
    `🟣 Гостей: ${bookingData['гости'] || '?'}\n` +
    `💰 Депозит: ${bookingData['депозит'] || '?'}`;

  if (cart && cart.length > 0) {
    const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
    staffText += '\n\n🛒 ПРЕДЗАКАЗ:\n';
    cart.forEach(i => { staffText += `• ${i.name} x${i.qty} — ${i.price * i.qty}₽\n`; });
    staffText += `💰 Итого предзаказа: ${total}₽`;
  }

  try {
    const sent = await bot.telegram.sendMessage(SUPPORT_CHAT_ID, staffText, {
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback(`✅ Подтвердить`, `confirm_booking_${ticketId}`),
          Markup.button.callback(`❌ Отклонить`, `reject_booking_${ticketId}`),
        ],
        [Markup.button.callback(`✏️ Написать гостю #${ticketId}`, `reply_ticket_${ticketId}`)],
      ]).reply_markup,
    });
    supportMsgToGuest[sent.message_id] = from.id;
    await pool.query(
      `UPDATE support_tickets SET staff_card_msg_id = $1 WHERE id = $2`,
      [sent.message_id, ticketId]
    ).catch(() => {});
  } catch (e) { console.error('createBookingTicket send:', e.message); }

  return ticketId;
}

async function getLastBooking(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT room_name, room_type, booking_date, guests_count, guest_name, phone, status
       FROM bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('getLastBooking error:', e.message);
    return null;
  }
}

async function getUserProfile(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT first_name, username, visits, first_seen, last_seen, phone FROM users WHERE user_id = $1`,
      [userId]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('getUserProfile error:', e.message);
    return null;
  }
}

// ============ UPSERT USER + LOG VISIT ============
async function upsertUser(from) {
  try {
    await pool.query(
      `INSERT INTO users (user_id, username, first_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
       SET visits = users.visits + 1, last_seen = NOW(), username = EXCLUDED.username`,
      [from.id, from.username || '', from.first_name || '']
    );
    await logVisit(from.id, 'start');
  } catch (e) {
    console.error('upsertUser error:', e.message);
  }
}

// ============ /start + MAIN MENU ============
// Feature 2: rotating banner + HTML bold text
async function sendMainMenu(ctx) {
  endSession(ctx.from.id);
  await upsertUser(ctx.from);
  const banner = getCurrentBanner();
  try {
    await ctx.replyWithPhoto(
      { url: `${PHOTO_BASE}/${banner}` },
      {
        caption:
          '<b>🎵 Добро пожаловать в Каракоке-клуб 7Sky!</b>\n\n' +
          '📍 Ковенский пер., 5, 7 этаж\n' +
          '📞 8 (812) 401-47-45\n' +
          '⏰ Ежедневно 18:00–06:00\n\n' +
          '<b>Выберите раздел в меню ниже 👇</b>',
        parse_mode: 'HTML',
        ...mainKeyboard,
      }
    );
  } catch (e) {
    // Fallback: banner not uploaded yet — send text only
    await ctx.reply(
      '🎵 Добро пожаловать в Каракоке-клуб 7Sky!\n\n' +
      '📍 Ковенский пер., 5, 7 этаж\n' +
      '📞 8 (812) 401-47-45\n' +
      '⏰ Ежедневно 18:00–06:00\n\n' +
      'Выберите раздел в меню ниже 👇',
      mainKeyboard
    );
  }
}

bot.start(sendMainMenu);

// Служебная команда для получения ID чата (для настройки рабочего чата)
bot.hears('/chatid', async (ctx) => {
  await ctx.reply(`Chat ID: \`${ctx.chat.id}\`\nUser ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
});

// ============ НАПИТКИ ============
function buildDrinkCatsKeyboard() {
  const cats = [
    { text: '🍸 КОКТЕЙЛИ', data: 'cat_Классические коктейли' },
    { text: '✨ АВТОРСКИЕ', data: 'cat_Авторские коктейли' },
    { text: '🍷 ВИНА',     data: 'cat_wines' },
    { text: '🥃 КРЕПКОЕ',  data: 'cat_spirits' },
    { text: '🍺 ПИВО',     data: 'cat_Пиво' },
    { text: '🍋 ЛИМОНАДЫ', data: 'cat_Лимонады' },
    { text: '☕ ГОРЯЧЕЕ',  data: 'cat_hot' },
    { text: '🥤 БЕЗ АЛК', data: 'cat_Безалкогольные' },
  ];
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [Markup.button.callback(cats[i].text, cats[i].data)];
    if (cats[i + 1]) row.push(Markup.button.callback(cats[i + 1].text, cats[i + 1].data));
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

async function showSubSelection(ctx, cat) {
  const conf = DRINK_CATS[cat];
  const subs = SUBCATS[cat] || [];
  const rows = [];
  for (let i = 0; i < subs.length; i += 2) {
    const row = [Markup.button.callback(subs[i].label, `ds_pg_${cat}_${subs[i].code}_0`)];
    if (subs[i + 1]) row.push(Markup.button.callback(subs[i + 1].label, `ds_pg_${cat}_${subs[i + 1].code}_0`));
    rows.push(row);
  }
  rows.push([Markup.button.callback('◀️ Назад', 'dk_cats')]);
  const bannerUrl = `${PHOTO_BASE}/${conf.banner}`;
  try {
    await ctx.editMessageMedia(
      { type: 'photo', media: bannerUrl, caption: `${conf.label} — выберите тип:` },
      { reply_markup: Markup.inlineKeyboard(rows).reply_markup }
    );
  } catch (e) {
    try {
      await ctx.replyWithPhoto(
        { url: bannerUrl },
        { caption: `${conf.label} — выберите тип:`, ...Markup.inlineKeyboard(rows) }
      );
    } catch (e2) {
      console.error('showSubSelection error:', e2.message);
    }
  }
}

bot.hears('🍹 Напитки', async (ctx) => {
  endSession(ctx.from.id);
  await ctx.replyWithPhoto(
    { url: `${PHOTO_BASE}/drinks.jpg` },
    { caption: '🍹 НАПИТКИ — выберите категорию:', ...buildDrinkCatsKeyboard() }
  );
});

// ============ UNIFIED DRINKS CARD SYSTEM ============
// Table: drinks (id, category, name, price, description, pairing, strength, serving, photo, is_active, sort_order)
// category = 2-letter code: ck/av/cw/cs/cp/cl/ch/cb
const DRINKS_PER_PAGE = 9;

async function getDrinkPage(cat, page, sub = null) {
  const offset = page * DRINKS_PER_PAGE;
  const hasSub = sub && sub !== '';
  const cond = hasSub
    ? 'category = $1 AND sub_category = $2 AND is_active = true'
    : 'category = $1 AND is_active = true';
  const params = hasSub ? [cat, sub] : [cat];
  const [{ rows: drinks }, { rows: countRows }] = await Promise.all([
    pool.query(
      `SELECT id, name, price FROM drinks WHERE ${cond} ORDER BY sort_order, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, DRINKS_PER_PAGE, offset]
    ),
    pool.query(`SELECT COUNT(*)::int as total FROM drinks WHERE ${cond}`, params),
  ]);
  const totalPages = Math.max(1, Math.ceil(countRows[0].total / DRINKS_PER_PAGE));
  return { drinks, totalPages, page };
}

async function getDrinkById(id) {
  const { rows } = await pool.query('SELECT * FROM drinks WHERE id = $1 AND is_active = true', [id]);
  return rows[0] || null;
}

function buildDrinkGrid(drinks, page, totalPages, cat, sub = null) {
  const buttons = [];
  for (let i = 0; i < drinks.length; i += 3) {
    const row = [];
    for (let j = 0; j < 3; j++) {
      if (drinks[i + j]) {
        const d = drinks[i + j];
        const cb = sub
          ? `ds_cd_${d.id}_${cat}_${sub}_${page}`
          : `dk_cd_${d.id}_${cat}_${page}`;
        row.push(Markup.button.callback(d.name, cb));
      }
    }
    buttons.push(row);
  }
  if (totalPages > 1) {
    const nav = [];
    const pgBase = sub ? `ds_pg_${cat}_${sub}` : `dk_pg_${cat}`;
    if (page > 0) nav.push(Markup.button.callback('◀️', `${pgBase}_${page - 1}`));
    nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'dk_noop'));
    if (page < totalPages - 1) nav.push(Markup.button.callback('▶️', `${pgBase}_${page + 1}`));
    buttons.push(nav);
  }
  return Markup.inlineKeyboard(buttons);
}

async function showDrinkGrid(ctx, cat, page, sub = null) {
  const conf = DRINK_CATS[cat];
  let data;
  try {
    data = await getDrinkPage(cat, page, sub);
  } catch (e) {
    console.error('getDrinkPage error:', cat, e.message);
    await ctx.reply('Ошибка загрузки меню.');
    return;
  }
  if (!data || data.drinks.length === 0) {
    await ctx.reply('Пока пусто в этой категории');
    return;
  }
  const subLabel = sub && SUBCATS[cat]
    ? ((SUBCATS[cat].find(s => s.code === sub) || {}).label || '') : '';
  const caption = `${conf.label}${subLabel ? ' · ' + subLabel : ''} — стр. ${page + 1}/${data.totalPages}\n\nВыберите:`;
  const keyboard = buildDrinkGrid(data.drinks, page, data.totalPages, cat, sub);
  const bannerUrl = `${PHOTO_BASE}/${conf.banner}`;
  try {
    await ctx.editMessageMedia(
      { type: 'photo', media: bannerUrl, caption },
      { reply_markup: keyboard.reply_markup }
    );
  } catch (e) {
    console.error('showDrinkGrid editMedia error:', cat, e.message);
    try {
      await ctx.replyWithPhoto({ url: bannerUrl }, { caption, ...keyboard });
    } catch (e2) {
      await ctx.reply(caption, keyboard);
    }
  }
}

async function showDrinkCard(ctx, drinkId, cat, fromPage, sub = null) {
  const conf = DRINK_CATS[cat];
  let drink;
  try {
    drink = await getDrinkById(drinkId);
  } catch (e) {
    console.error('getDrinkById error:', e.message);
    return;
  }
  if (!drink) return;

  const qty = (getCart(ctx.from.id).find(c => c.name === drink.name) || {}).qty || 0;
  let caption = `<b>${drink.name}</b>\n💰 <b>${drink.price}₽</b>`;
  if (drink.description) caption += `\n\n📝 ${drink.description}`;
  if (drink.pairing)     caption += `\n\n🍴 С чем: ${drink.pairing}`;
  if (drink.strength)    caption += `\n💪 Крепость: ${drink.strength}`;
  if (drink.serving)     caption += `\n🥂 Подача: ${drink.serving}`;
  if (qty > 0)           caption += `\n\n🛒 В корзине: ${qty} шт.`;

  const addCb  = sub ? `ds_add_${drinkId}_${cat}_${sub}_${fromPage}` : `dk_add_${drinkId}_${cat}_${fromPage}`;
  const backCb = sub ? `ds_pg_${cat}_${sub}_${fromPage}` : `dk_pg_${cat}_${fromPage}`;

  const keyboard = {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('➕ ДОБАВИТЬ В КОРЗИНУ', addCb)],
      [Markup.button.callback('◀️ Назад', backCb)],
    ]).reply_markup,
  };

  const photoUrl = drink.photo
    ? `${PHOTO_BASE}/${drink.photo.split('/').map(encodeURIComponent).join('/')}`
    : `${PHOTO_BASE}/drinks.jpg`;

  try {
    await ctx.editMessageMedia(
      { type: 'photo', media: photoUrl, caption, parse_mode: 'HTML' },
      keyboard
    );
  } catch (e) {
    try {
      await ctx.editMessageMedia(
        { type: 'photo', media: `${PHOTO_BASE}/drinks.jpg`, caption, parse_mode: 'HTML' },
        keyboard
      );
    } catch (e2) {
      console.error('showDrinkCard error:', e2.message);
    }
  }
}

// ============ DRINKS CATEGORY HANDLER ============
bot.action(/^cat_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const cat = CAT_TO_CODE[ctx.match[1]];
  if (!cat) { await ctx.reply('Категория не найдена'); return; }
  if (SUBCATS[cat]) {
    await showSubSelection(ctx, cat);
  } else {
    await showDrinkGrid(ctx, cat, 0);
  }
});

// ============ DRINKS ACTION HANDLERS ============
bot.action('dk_noop', async (ctx) => { await ctx.answerCbQuery(); });

bot.action('dk_cats', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageMedia(
      { type: 'photo', media: `${PHOTO_BASE}/drinks.jpg`, caption: '🍹 НАПИТКИ — выберите категорию:' },
      { reply_markup: buildDrinkCatsKeyboard().reply_markup }
    );
  } catch (e) {
    console.error('dk_cats error:', e.message);
  }
});

bot.action(/^dk_pg_(\w+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showDrinkGrid(ctx, ctx.match[1], parseInt(ctx.match[2]));
});

bot.action(/^dk_cd_(\d+)_(\w+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showDrinkCard(ctx, parseInt(ctx.match[1]), ctx.match[2], parseInt(ctx.match[3]));
});

bot.action(/^dk_add_(\d+)_(\w+)_(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const cat = ctx.match[2];
  const fromPage = parseInt(ctx.match[3]);
  let drink;
  try {
    drink = await getDrinkById(id);
  } catch (e) {
    await ctx.answerCbQuery('Ошибка');
    return;
  }
  if (!drink) { await ctx.answerCbQuery(); return; }
  addToCart(ctx.from.id, { name: drink.name, price: drink.price });
  const qty = (getCart(ctx.from.id).find(c => c.name === drink.name) || {}).qty || 0;
  await ctx.answerCbQuery(`✅ ${drink.name}: ${qty} шт. — итого ${cartTotal(ctx.from.id)}₽`);
  await showDrinkCard(ctx, id, cat, fromPage);
});

// ============ SUBCATEGORY DRINKS HANDLERS (ds_) ============
// ds_pg_{cat}_{sub}_{page} — показать сетку подкатегории
bot.action(/^ds_pg_(\w+)_(\w+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showDrinkGrid(ctx, ctx.match[1], parseInt(ctx.match[3]), ctx.match[2]);
});

// ds_cd_{id}_{cat}_{sub}_{page} — карточка товара из подкатегории
bot.action(/^ds_cd_(\d+)_(\w+)_(\w+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showDrinkCard(ctx, parseInt(ctx.match[1]), ctx.match[2], parseInt(ctx.match[4]), ctx.match[3]);
});

// ds_add_{id}_{cat}_{sub}_{page} — добавить в корзину из подкатегории
bot.action(/^ds_add_(\d+)_(\w+)_(\w+)_(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const cat = ctx.match[2];
  const sub = ctx.match[3];
  const fromPage = parseInt(ctx.match[4]);
  let drink;
  try {
    drink = await getDrinkById(id);
  } catch (e) {
    await ctx.answerCbQuery('Ошибка');
    return;
  }
  if (!drink) { await ctx.answerCbQuery(); return; }
  addToCart(ctx.from.id, { name: drink.name, price: drink.price });
  const qty = (getCart(ctx.from.id).find(c => c.name === drink.name) || {}).qty || 0;
  await ctx.answerCbQuery(`✅ ${drink.name}: ${qty} шт. — итого ${cartTotal(ctx.from.id)}₽`);
  await showDrinkCard(ctx, id, cat, fromPage, sub);
});

// ============ CART ACTIONS (add/remove for non-counter sections) ============
bot.action(/^add_(.+)_(\d+)$/, async (ctx) => {
  const name = ctx.match[1];
  const price = parseInt(ctx.match[2]);
  addToCart(ctx.from.id, { name, price });
  await ctx.answerCbQuery(`✅ ${name} добавлен (итого ${cartTotal(ctx.from.id)}₽)`);
});

bot.action(/^rem_(.+)$/, async (ctx) => {
  const name = ctx.match[1];
  removeFromCart(ctx.from.id, name);
  await ctx.answerCbQuery(`🗑 ${name} убран`);
});

// ============ КОРЗИНА ============
bot.hears('🛒 Корзина', async (ctx) => {
  endSession(ctx.from.id);
  const text = cartText(ctx.from.id);
  const cart = getCart(ctx.from.id);

  if (cart.length === 0) {
    await ctx.reply(text, mainKeyboard);
    return;
  }

  await ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback('🗑 ОЧИСТИТЬ', 'cart_clear')],
  ]));
});

bot.action('cart_clear', async (ctx) => {
  carts[ctx.from.id] = [];
  await ctx.answerCbQuery('🗑 Корзина очищена');
  await ctx.editMessageText('🛒 Корзина пуста');
});

// ============ БРОНИРОВАНИЕ ============
function bookingMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🛏️ КОМНАТЫ', 'book_rooms'), Markup.button.callback('🍽️ ОБЩИЙ ЗАЛ', 'book_hall')],
    [Markup.button.callback('💬 Чат с персоналом', 'booking_support')],
  ]);
}

bot.hears('🛋️ Бронирование', async (ctx) => {
  endSession(ctx.from.id);
  const kb = bookingMenuKeyboard();
  try {
    await ctx.replyWithPhoto(
      { url: `${PHOTO_BASE}/banner_booking.png` },
      { caption: '📅 БРОНИРОВАНИЕ\n\nВыберите тип:', ...kb }
    );
  } catch (e) {
    await ctx.reply('📅 БРОНИРОВАНИЕ\n\nВыберите тип:', kb);
  }
});

bot.action('back_to_booking', async (ctx) => {
  await ctx.answerCbQuery();
  endSession(ctx.from.id);
  const text = '📅 БРОНИРОВАНИЕ\n\nВыберите тип:';
  const kb = bookingMenuKeyboard();
  try {
    await ctx.editMessageCaption(text, { reply_markup: kb.reply_markup });
  } catch (e) {
    try {
      await ctx.editMessageText(text, kb);
    } catch (e2) {
      await ctx.reply(text, kb);
    }
  }
});

bot.action('booking_support', async (ctx) => {
  await ctx.answerCbQuery();
  startSupportSession(ctx.from.id);
  await ctx.reply(
    '💬 Чат с персоналом\n\nОпишите вашу просьбу — передадим сотруднику:',
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'support_cancel')]])
  );
});

// --- ROOMS ---
const ROOMS = [
  {
    id: 'r1', name: 'Комната 1', capacity: 8, price_hour: 2700, price_min: 45,
    desc: 'Уютная комната для небольших компаний.',
    photos: [
      'rooms/комната 1 до 8 человек/2025-11-06 20.09.27.jpg',
      'rooms/комната 1 до 8 человек/2025-11-06 20.09.36.jpg',
      'rooms/комната 1 до 8 человек/2025-11-06 20.09.48.jpg',
      'rooms/комната 1 до 8 человек/2025-11-06 20.09.57.jpg',
      'rooms/комната 1 до 8 человек/2025-11-06 20.11.24.jpg',
      'rooms/комната 1 до 8 человек/2025-11-06 20.11.42.jpg',
      'rooms/комната 1 до 8 человек/2025-11-06 20.11.49.jpg',
    ],
  },
  {
    id: 'r2', name: 'Комната 2', capacity: 10, price_hour: 3000, price_min: 50,
    desc: 'Просторная комната для компании до 10 человек.',
    photos: [
      'rooms/комната 2 до 10 человек/2025-11-06 20.15.47.jpg',
      'rooms/комната 2 до 10 человек/2025-11-06 20.15.54.jpg',
      'rooms/комната 2 до 10 человек/2025-11-06 20.16.20.jpg',
      'rooms/комната 2 до 10 человек/2025-11-06 20.16.28.jpg',
    ],
  },
  {
    id: 'r3', name: 'Комната 3', capacity: 8, price_hour: 2700, price_min: 45,
    desc: 'Уютная комната для небольших компаний.',
    photos: [
      'rooms/комната 3 до 8 человек/2025-11-06 20.19.34.jpg',
      'rooms/комната 3 до 8 человек/2025-11-06 20.19.39.jpg',
    ],
  },
  {
    id: 'r4', name: 'Комната 4', capacity: 10, price_hour: 3000, price_min: 50,
    desc: 'Просторная комната для компании до 10 человек.',
    photos: [
      'rooms/комната 4 до 10 человек/2025-11-06 20.17.52.jpg',
      'rooms/комната 4 до 10 человек/2025-11-06 20.17.58.jpg',
      'rooms/комната 4 до 10 человек/2025-11-06 20.18.02.jpg',
      'rooms/комната 4 до 10 человек/2025-11-06 20.18.13.jpg',
      'rooms/комната 4 до 10 человек/2025-11-06 20.18.22.jpg',
    ],
  },
  {
    id: 'r5', name: 'Комната до 18 человек', capacity: 18, price_hour: 3900, price_min: 65,
    desc: 'Большая комната для шумных компаний. Премиум-оборудование.',
    photos: [
      'rooms/комната до 18 человек/1.jpg',
      'rooms/комната до 18 человек/2.jpg',
      'rooms/комната до 18 человек/3.jpg',
    ],
  },
];

bot.action('book_rooms', async (ctx) => {
  await ctx.answerCbQuery();
  const buttons = [];
  for (let i = 0; i < ROOMS.length; i += 2) {
    const row = [Markup.button.callback(
      `${ROOMS[i].name} · до ${ROOMS[i].capacity} чел.`, `roomcard_${ROOMS[i].id}_0`
    )];
    if (ROOMS[i + 1]) row.push(Markup.button.callback(
      `${ROOMS[i + 1].name} · до ${ROOMS[i + 1].capacity} чел.`, `roomcard_${ROOMS[i + 1].id}_0`
    ));
    buttons.push(row);
  }
  buttons.push([Markup.button.callback('◀️ Назад', 'back_to_booking')]);
  const msg = '🛏️ КОМНАТЫ\n\nВыберите комнату:';
  try {
    await ctx.editMessageCaption(msg, { reply_markup: Markup.inlineKeyboard(buttons).reply_markup });
  } catch (e) {
    try {
      await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons));
    } catch (e2) {
      await ctx.reply(msg, Markup.inlineKeyboard(buttons));
    }
  }
});

bot.action(/^roomcard_(r\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const roomId = ctx.match[1];
  const photoIdx = parseInt(ctx.match[2]);
  const room = ROOMS.find(r => r.id === roomId);
  if (!room) return;

  const total = room.photos.length;
  const idx = Math.max(0, Math.min(photoIdx, total - 1));
  const photoUrl = buildPhotoUrl(room.photos[idx]);

  const caption =
    `🎤 ${room.name}\n` +
    `👥 До ${room.capacity} человек\n` +
    `💰 ${room.price_hour}₽/час (${room.price_min}₽/мин)\n\n` +
    room.desc;

  const prevIdx = idx > 0 ? idx - 1 : total - 1;
  const nextIdx = idx < total - 1 ? idx + 1 : 0;
  const keyboard = Markup.inlineKeyboard([
    ...(total > 1 ? [[
      Markup.button.callback('◀️', `roomcard_${roomId}_${prevIdx}`),
      Markup.button.callback(`${idx + 1}/${total}`, 'cal_noop'),
      Markup.button.callback('▶️', `roomcard_${roomId}_${nextIdx}`),
    ]] : []),
    [Markup.button.callback('📅 ЗАБРОНИРОВАТЬ', `bookroom_${roomId}`)],
    [Markup.button.callback('◀️ Назад к комнатам', 'book_rooms')],
  ]);

  const isPhotoMsg = !!(ctx.callbackQuery?.message?.photo);
  if (isPhotoMsg) {
    try {
      await ctx.editMessageMedia(
        { type: 'photo', media: photoUrl, caption },
        { reply_markup: keyboard.reply_markup }
      );
    } catch (e) {
      await ctx.editMessageCaption(caption, { reply_markup: keyboard.reply_markup }).catch(() => {});
    }
  } else {
    try {
      await ctx.replyWithPhoto({ url: photoUrl }, { caption, ...keyboard });
    } catch (e) {
      await ctx.reply(caption, keyboard);
    }
  }
});

bot.action(/^bookroom_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const roomId = ctx.match[1];
  const room = ROOMS.find(r => r.id === roomId);
  const roomName = room ? room.name : roomId;
  const session = getSession(ctx.from.id);
  session.room = roomName;

  const now = new Date();
  await ctx.reply(
    `📅 Бронирование: ${roomName}\n\nШаг 1 из 2 — выберите дату:`,
    buildCalendarKeyboard(now.getFullYear(), now.getMonth() + 1)
  );
});

// --- GENERAL HALL ---
const HALL_PHOTOS = [
  'rooms/общий зал/1.jpg',
  'rooms/общий зал/2.jpg',
  'rooms/общий зал/3.jpg',
];
const TABLES = [
  { id: 't1', name: 'Стол 1', capacity: 10, desc: 'у сцены', photos: HALL_PHOTOS },
  { id: 't2', name: 'Стол 2', capacity: 10, desc: 'у сцены', photos: HALL_PHOTOS },
  { id: 't3', name: 'Стол 3', capacity: 5, desc: 'центр зала', photos: HALL_PHOTOS },
  { id: 't4', name: 'Стол 4', capacity: 5, desc: 'центр зала', photos: HALL_PHOTOS },
  { id: 't5', name: 'Стол 5', capacity: 5, desc: 'у окна', photos: HALL_PHOTOS },
  { id: 't6', name: 'Стол 6', capacity: 5, desc: 'у окна', photos: HALL_PHOTOS },
];

bot.action('book_hall', async (ctx) => {
  await ctx.answerCbQuery();
  const buttons = [];
  for (let i = 0; i < TABLES.length; i += 2) {
    const row = [Markup.button.callback(
      `🪑 ${TABLES[i].name} · до ${TABLES[i].capacity} чел.`, `tablecard_${TABLES[i].id}_0`
    )];
    if (TABLES[i + 1]) row.push(Markup.button.callback(
      `🪑 ${TABLES[i + 1].name} · до ${TABLES[i + 1].capacity} чел.`, `tablecard_${TABLES[i + 1].id}_0`
    ));
    buttons.push(row);
  }
  buttons.push([Markup.button.callback('◀️ Назад', 'back_to_booking')]);
  const msg = '🍽️ ОБЩИЙ ЗАЛ — 500₽ за песню\n👥 До 40 человек\n🎤 40 000+ композиций\n\nВыберите стол:';
  try {
    await ctx.editMessageCaption(msg, { reply_markup: Markup.inlineKeyboard(buttons).reply_markup });
  } catch (e) {
    try {
      await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons));
    } catch (e2) {
      await ctx.reply(msg, Markup.inlineKeyboard(buttons));
    }
  }
});

bot.action(/^tablecard_(t\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tableId = ctx.match[1];
  const photoIdx = parseInt(ctx.match[2]);
  const table = TABLES.find(t => t.id === tableId);
  if (!table) return;

  const total = table.photos.length;
  const idx = Math.max(0, Math.min(photoIdx, total - 1));
  const photoUrl = buildPhotoUrl(table.photos[idx]);

  const caption =
    `🪑 ${table.name}\n` +
    `👥 До ${table.capacity} человек\n` +
    `📍 ${table.desc}\n\n` +
    `500₽ за песню`;

  const prevIdx = idx > 0 ? idx - 1 : total - 1;
  const nextIdx = idx < total - 1 ? idx + 1 : 0;
  const keyboard = Markup.inlineKeyboard([
    ...(total > 1 ? [[
      Markup.button.callback('◀️', `tablecard_${tableId}_${prevIdx}`),
      Markup.button.callback(`${idx + 1}/${total}`, 'cal_noop'),
      Markup.button.callback('▶️', `tablecard_${tableId}_${nextIdx}`),
    ]] : []),
    [Markup.button.callback('📅 ЗАБРОНИРОВАТЬ', `booktable_${tableId}`)],
    [Markup.button.callback('◀️ Назад к залу', 'book_hall')],
  ]);

  const isPhotoMsg = !!(ctx.callbackQuery?.message?.photo);
  if (isPhotoMsg) {
    try {
      await ctx.editMessageMedia(
        { type: 'photo', media: photoUrl, caption },
        { reply_markup: keyboard.reply_markup }
      );
    } catch (e) {
      await ctx.editMessageCaption(caption, { reply_markup: keyboard.reply_markup }).catch(() => {});
    }
  } else {
    try {
      await ctx.replyWithPhoto({ url: photoUrl }, { caption, ...keyboard });
    } catch (e) {
      await ctx.reply(caption, keyboard);
    }
  }
});

bot.action(/^booktable_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tableId = ctx.match[1];
  const table = TABLES.find(t => t.id === tableId);
  const place = table ? `${table.name} (${table.desc}) в общем зале` : `Стол ${tableId} в общем зале`;
  const session = getSession(ctx.from.id);
  session.room = place;

  const now = new Date();
  await ctx.reply(
    `📅 Бронирование: ${place}\n\nШаг 1 из 2 — выберите дату:`,
    buildCalendarKeyboard(now.getFullYear(), now.getMonth() + 1)
  );
});

bot.action('cancel_booking', async (ctx) => {
  await ctx.answerCbQuery('Бронирование отменено');
  endSession(ctx.from.id);
  await ctx.reply('❌ Бронирование отменено.', mainKeyboard);
});

// ============ CALENDAR / TIME PICKER ACTIONS ============
bot.action('cal_noop', (ctx) => ctx.answerCbQuery());

bot.action(/^cal_nav_(\d{4})-(\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const year = parseInt(ctx.match[1]);
  const month = parseInt(ctx.match[2]);
  // Block past months
  const now = new Date();
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return;
  try {
    await ctx.editMessageReplyMarkup(buildCalendarKeyboard(year, month).reply_markup);
  } catch (e) {}
});

bot.action(/^cal_day_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const dateStr = ctx.match[1];
  const session = getSession(ctx.from.id);
  session.date = dateStr;
  const [y, m, d] = dateStr.split('-');
  const displayDate = `${parseInt(d)} ${MONTH_NAMES_GENITIVE[parseInt(m)-1]} ${y}`;
  try {
    await ctx.editMessageText(
      `📅 Дата: ${displayDate}\n\nШаг 2 из 2 — выберите время начала:`,
      { reply_markup: buildTimePickerKeyboard().reply_markup }
    );
  } catch (e) {
    await ctx.reply(`📅 Дата: ${displayDate}\n\nВыберите время:`, buildTimePickerKeyboard());
  }
});

bot.action('back_to_calendar', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  const now = new Date();
  const year = session.date ? parseInt(session.date.split('-')[0]) : now.getFullYear();
  const month = session.date ? parseInt(session.date.split('-')[1]) : now.getMonth() + 1;
  try {
    await ctx.editMessageText(
      `📅 Бронирование: ${session.room || ''}\n\nШаг 1 из 2 — выберите дату:`,
      { reply_markup: buildCalendarKeyboard(year, month).reply_markup }
    );
  } catch (e) {
    await ctx.reply('Выберите дату:', buildCalendarKeyboard(year, month));
  }
});

bot.action(/^time_(\d{2}:\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const timeStr = ctx.match[1];
  const session = getSession(ctx.from.id);
  if (!session.room || !session.date) {
    await ctx.reply('Что-то пошло не так. Начните бронирование заново.', mainKeyboard);
    return;
  }

  const [y, m, d] = session.date.split('-');
  const displayDate = `${parseInt(d)} ${MONTH_NAMES_GENITIVE[parseInt(m)-1]}`;

  try {
    await ctx.editMessageText(`📅 ${session.room}\n🗓 ${displayDate} в ${timeStr}\n\nОформляю бронирование...`);
  } catch (e) {}

  const newSession = startBookingSession(ctx.from.id, session.room, session.date, timeStr);

  try {
    await ctx.sendChatAction('typing');
    const aiReply = await callOpenRouter(newSession.messages);
    newSession.messages.push({ role: 'assistant', content: aiReply });
    // Route through handleBookingReply — same chain as text messages
    await handleBookingReply(ctx, aiReply, newSession);
  } catch (e) {
    console.error('AI time_ start error:', e.message);
    await ctx.reply(`📅 Бронирование: ${session.room}\n\nПозвоните: 📞 8 (812) 401-47-45`, mainKeyboard);
    endSession(ctx.from.id);
  }
});

// ============ POST-BOOKING: PREORDER ============
bot.action(/^preorder_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const bookingId = ctx.match[1];
  const session = getSession(ctx.from.id);
  session.bookingId = parseInt(bookingId);

  const categories = [
    { text: '🍸 КОКТЕЙЛИ', data: 'precat_Классические коктейли' },
    { text: '✨ АВТОРСКИЕ', data: 'precat_Авторские коктейли' },
    { text: '🍷 ВИНА', data: 'precat_wines' },
    { text: '🥃 КРЕПКОЕ', data: 'precat_spirits' },
    { text: '🔥 КАЛЬЯН', data: 'precat_hookah' },
    { text: '✅ ОТПРАВИТЬ', data: `preorder_submit_${bookingId}` },
  ];
  const buttons = [];
  for (let i = 0; i < categories.length; i += 2) {
    const row = [Markup.button.callback(categories[i].text, categories[i].data)];
    if (categories[i + 1]) row.push(Markup.button.callback(categories[i + 1].text, categories[i + 1].data));
    buttons.push(row);
  }

  await ctx.reply(
    '🛒 ПРЕДЗАКАЗ К БРОНИРОВАНИЮ\n\n' +
    'Выберите категорию, добавьте позиции в корзину, затем нажмите "Отправить".\n' +
    `Текущая корзина: ${cartTotal(ctx.from.id)}₽`,
    Markup.inlineKeyboard(buttons)
  );
});

bot.action(/^precat_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const catKey = ctx.match[1];

  if (catKey === 'hookah') {
    for (const h of HOOKAHS) {
      await ctx.reply(`🔥 ${h.name}\n${h.desc}\n💰 ${h.price}₽`, Markup.inlineKeyboard([
        [Markup.button.callback(`➕ В корзину`, `add_${h.name}_${h.price}`)],
      ]));
    }
    return;
  }

  // Support both full name keys ('Классические коктейли') and short code keys ('ck')
  const cat = CAT_TO_CODE[catKey] || catKey;

  try {
    const { rows } = await pool.query(
      'SELECT name, price FROM drinks WHERE category = $1 AND is_active = true ORDER BY sort_order, id',
      [cat]
    );
    if (rows.length === 0) {
      await ctx.reply('Пока пусто в этой категории');
      return;
    }
    for (const item of rows) {
      await ctx.reply(`${item.name}\n💰 ${item.price}₽`, Markup.inlineKeyboard([
        [Markup.button.callback('➕ В корзину', `add_${item.name}_${item.price}`)],
      ]));
    }
  } catch (e) {
    console.error('precat query error:', e.message);
    await ctx.reply('Ошибка загрузки меню');
  }
});

bot.action(/^preorder_submit_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const bookingId = parseInt(ctx.match[1]);
  const cart = getCart(ctx.from.id);

  if (cart.length === 0) {
    await ctx.reply('🛒 Корзина пуста. Добавьте позиции или нажмите кнопку ниже.', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Отправить без предзаказа', 'booking_done')],
    ]));
    return;
  }

  const total = cartTotal(ctx.from.id);

  try {
    await pool.query(
      `INSERT INTO orders (user_id, booking_id, items, total) VALUES ($1, $2, $3, $4)`,
      [ctx.from.id, bookingId, JSON.stringify(cart), total]
    );
    await pool.query(
      `UPDATE bookings SET preorder_items = $1, preorder_total = $2 WHERE id = $3`,
      [JSON.stringify(cart), total, bookingId]
    );
    await logVisit(ctx.from.id, 'preorder');

    // Строим полный текст: бронь + предзаказ
    let bookingInfo = '';
    try {
      const { rows } = await pool.query(
        `SELECT room_name, booking_date, guests_count, guest_name, phone FROM bookings WHERE id = $1`,
        [bookingId]
      );
      if (rows[0]) {
        const b = rows[0];
        bookingInfo = `🏠 ${b.room_name || '?'}\n📅 ${b.booking_date || '?'}\n👥 ${b.guests_count || '?'} чел.\n`;
      }
    } catch (e) {}

    // Уведомляем менеджера (личка)
    let orderText = `📅 БРОНЬ #${bookingId} + ПРЕДЗАКАЗ\n\n`;
    orderText += `👤 ${ctx.from.first_name || ''} (@${ctx.from.username || 'нет'})\n`;
    orderText += bookingInfo + '\n🛒 Предзаказ:\n';
    cart.forEach(i => { orderText += `• ${i.name} x${i.qty} — ${i.price * i.qty}₽\n`; });
    orderText += `\n💰 Итого: ${total}₽`;
    try { await bot.telegram.sendMessage(MANAGER_CHAT_ID, orderText); } catch (e) {}

    // Создаём тикет + отправляем в рабочий чат с предзаказом
    try {
      const ticketText = `Бронь #${bookingId}` + (bookingInfo ? ': ' + bookingInfo.replace(/\n/g, ', ') : '');
      const tr = await pool.query(
        `INSERT INTO support_tickets (user_id, username, cabin_name, request_text, status)
         VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
        [ctx.from.id, ctx.from.username || '', '', ticketText]
      );
      const ticketId = tr.rows[0].id;
      const ticketRef = ` #${ticketId}`;

      let staffText = `📅 БРОНЬ${ticketRef} + ПРЕДЗАКАЗ — 🟡 не подтверждена\n\n`;
      staffText += `👤 ${ctx.from.first_name || ''} (@${ctx.from.username || 'нет'})\n`;
      staffText += bookingInfo + '\n🛒 Предзаказ:\n';
      cart.forEach(i => { staffText += `• ${i.name} x${i.qty} — ${i.price * i.qty}₽\n`; });
      staffText += `\n💰 Итого: ${total}₽`;

      const sent = await bot.telegram.sendMessage(SUPPORT_CHAT_ID, staffText, {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback(`✏️ Ответить${ticketRef}`, `reply_ticket_${ticketId}`)],
          [Markup.button.callback(`✅ Закрыть${ticketRef}`, `close_ticket_${ticketId}`)],
        ]).reply_markup,
      });
      supportMsgToGuest[sent.message_id] = ctx.from.id;
      await pool.query(
        `UPDATE support_tickets SET staff_card_msg_id = $1 WHERE id = $2`,
        [sent.message_id, ticketId]
      ).catch(() => {});
    } catch (e) { console.error('preorder ticket error:', e.message); }

    carts[ctx.from.id] = [];
    endSession(ctx.from.id);

    await ctx.reply(
      `✅ Заявка с предзаказом отправлена в рабочий чат!\n\n💰 Предзаказ: ${total}₽\n\nПерсонал подготовит всё к вашему приходу.`,
      mainKeyboard
    );
  } catch (e) {
    console.error('preorder submit error:', e.message);
    await ctx.reply('Ошибка оформления. Попробуйте позже.', mainKeyboard);
  }
});

bot.action(/^prepay_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  endSession(ctx.from.id);
  await ctx.reply(
    '💳 Предоплата будет доступна позже.\n\n' +
    'Менеджер свяжется с вами для уточнения деталей.\n' +
    '📞 8 (812) 401-47-45',
    mainKeyboard
  );
});

bot.action('booking_done', async (ctx) => {
  await ctx.answerCbQuery('✅');
  endSession(ctx.from.id);
  await ctx.reply('👍 Отлично! Ждём вас в 7Sky!', mainKeyboard);
});

// Гость подтверждает добавление корзины как предзаказ
bot.action(/^cart_confirm_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const bookingId = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  const cart = getCart(ctx.from.id);
  const bookingData = session.pendingBookingData || {};

  if (cart.length > 0) {
    const total = cartTotal(ctx.from.id);
    await pool.query(
      `INSERT INTO orders (user_id, booking_id, items, total) VALUES ($1, $2, $3, $4)`,
      [ctx.from.id, bookingId, JSON.stringify(cart), total]
    ).catch(e => console.error('cart_confirm orders insert:', e.message));
    await pool.query(
      `UPDATE bookings SET preorder_items = $1, preorder_total = $2 WHERE id = $3`,
      [JSON.stringify(cart), total, bookingId]
    ).catch(e => console.error('cart_confirm bookings update:', e.message));
  }

  const ticketId = await createBookingTicket(ctx.from, bookingId, bookingData, session.room, cart);
  if (ticketId) session.ticketId = ticketId;
  clearCart(ctx.from.id);

  await ctx.reply(
    `✅ Заявка с предзаказом отправлена!\n\n🟡 Ожидает подтверждения\nМенеджер свяжется с вами.`,
    mainKeyboard
  );
});

// Гость отказывается от предзаказа
bot.action(/^cart_skip_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const bookingId = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  const bookingData = session.pendingBookingData || {};

  const ticketId = await createBookingTicket(ctx.from, bookingId, bookingData, session.room, null);
  if (ticketId) session.ticketId = ticketId;

  await ctx.reply(
    `✅ Заявка отправлена!\n\n🟡 Ожидает подтверждения\nМенеджер свяжется с вами.`,
    mainKeyboard
  );
});

// ============ КАЛЬЯН ============
const HOOKAHS = [
  { id: 'h1', name: 'Классический кальян', desc: 'Аль-Фахер, мягкий вкус, фруктовые миксы', price: 2997, photo: 'кальян/классический кальян.jpg' },
  { id: 'h2', name: 'Кальян на грейпфруте', desc: 'Освежающий вкус грейпфрута, лёгкий дым', price: 3774, photo: 'кальян/кальян на грейпфруте.png' },
  { id: 'h3', name: 'Кальян на ананасе', desc: 'Экзотический сладкий вкус, насыщенный дым', price: 4474, photo: 'кальян/кальян на ананасе.png' },
];

function hookahListKeyboard() {
  return Markup.inlineKeyboard(
    HOOKAHS.map(h => [Markup.button.callback(`🔥 ${h.name} — ${h.price}₽`, `hookah_${h.id}`)])
  );
}

bot.hears('🔥 Кальян', async (ctx) => {
  endSession(ctx.from.id);
  try {
    await ctx.replyWithPhoto(
      { url: `${PHOTO_BASE}/banner_hookah.png` },
      { caption: '🔥 КАЛЬЯН\n\nВыберите вариант:', ...hookahListKeyboard() }
    );
  } catch (e) {
    await ctx.reply('🔥 КАЛЬЯН\n\nВыберите вариант:', hookahListKeyboard());
  }
});

bot.action(/^hookah_(h\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const hookahId = ctx.match[1];
  const h = HOOKAHS.find(x => x.id === hookahId);
  if (!h) return;

  const caption = `🔥 ${h.name}\n\n${h.desc}\n\n💰 ${h.price}₽`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`➕ В КОРЗИНУ (${h.price}₽)`, `add_${h.name}_${h.price}`)],
    [Markup.button.callback('◀️ Назад к кальяну', 'hookah_back')],
  ]);

  const isPhotoMsg = !!(ctx.callbackQuery?.message?.photo);
  if (isPhotoMsg) {
    try {
      await ctx.editMessageMedia(
        { type: 'photo', media: buildPhotoUrl(h.photo), caption },
        { reply_markup: keyboard.reply_markup }
      );
    } catch (e) {
      await ctx.editMessageCaption(caption, { reply_markup: keyboard.reply_markup }).catch(() => {});
    }
  } else {
    try {
      await ctx.replyWithPhoto({ url: buildPhotoUrl(h.photo) }, { caption, ...keyboard });
    } catch (e) {
      await ctx.reply(caption, keyboard);
    }
  }
});

bot.action('hookah_back', async (ctx) => {
  await ctx.answerCbQuery();
  const caption = '🔥 КАЛЬЯН\n\nВыберите вариант:';
  try {
    await ctx.editMessageMedia(
      { type: 'photo', media: `${PHOTO_BASE}/banner_hookah.png`, caption },
      { reply_markup: hookahListKeyboard().reply_markup }
    );
  } catch (e) {
    try {
      await ctx.editMessageCaption(caption, { reply_markup: hookahListKeyboard().reply_markup });
    } catch (e2) {
      await ctx.reply(caption, hookahListKeyboard());
    }
  }
});

// ============ МЕНЮ (ЕДА) ============
bot.hears('🍽 Меню', async (ctx) => {
  endSession(ctx.from.id);
  const categories = [
    { text: '🥗 САЛАТЫ', data: 'food_Салаты' },
    { text: '🍖 ЗАКУСКИ', data: 'food_Закуски' },
    { text: '🍳 ГОРЯЧЕЕ', data: 'food_Горячее' },
    { text: '🍝 ПАСТА', data: 'food_Паста' },
    { text: '🍣 РОЛЛЫ', data: 'food_Роллы' },
    { text: '🍰 ДЕСЕРТЫ', data: 'food_Десерты' },
  ];
  const buttons = [];
  for (let i = 0; i < categories.length; i += 3) {
    const row = [Markup.button.callback(categories[i].text, categories[i].data)];
    if (categories[i + 1]) row.push(Markup.button.callback(categories[i + 1].text, categories[i + 1].data));
    if (categories[i + 2]) row.push(Markup.button.callback(categories[i + 2].text, categories[i + 2].data));
    buttons.push(row);
  }
  await ctx.reply('🍽 МЕНЮ — выберите категорию:', Markup.inlineKeyboard(buttons));
});

bot.action(/^food_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const category = ctx.match[1];

  try {
    const { rows } = await pool.query(
      `SELECT name, price FROM menu WHERE category = $1 ORDER BY price`,
      [category]
    );
    if (rows.length === 0) {
      await ctx.reply('Пока пусто в этой категории');
      return;
    }

    const buttons = [];
    for (let i = 0; i < rows.length; i += 3) {
      const row = [];
      for (let j = 0; j < 3; j++) {
        if (rows[i + j]) {
          const item = rows[i + j];
          row.push(Markup.button.callback(
            `${item.name}\n${item.price}₽`,
            `add_${item.name}_${item.price}`
          ));
        }
      }
      buttons.push(row);
    }

    const emoji = { Салаты: '🥗', Закуски: '🍖', Горячее: '🍳', Паста: '🍝', Роллы: '🍣', Десерты: '🍰' };
    await ctx.reply(
      `${emoji[category] || '🍽'} ${category.toUpperCase()} — нажмите для добавления в корзину:`,
      Markup.inlineKeyboard(buttons)
    );
  } catch (e) {
    console.error('food cat error:', e.message);
    await ctx.reply('Ошибка загрузки меню');
  }
});

// ============ ИИ АГЕНТ ============
bot.hears('🤖 ИИ Агент', async (ctx) => {
  endSession(ctx.from.id);
  const session = getSession(ctx.from.id);
  session.active = true;
  session.type = 'agent';
  session.messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
  ];

  await ctx.reply(
    '🤖 Привет! Я ИИ-ассистент караоке-клуба 7Sky.\n\n' +
    'Спрашивай что угодно:\n' +
    '• Цены и акции\n' +
    '• Песни и репертуар\n' +
    '• Как добраться\n' +
    '• Или просто поболтаем 😊\n\n' +
    'Напиши свой вопрос!',
    Markup.inlineKeyboard([
      [Markup.button.callback('❌ Закрыть чат', 'cancel_agent')],
    ])
  );
});

bot.action('cancel_agent', async (ctx) => {
  await ctx.answerCbQuery('Чат закрыт');
  endSession(ctx.from.id);
  await ctx.reply('До встречи! 🎵', mainKeyboard);
});

// ============ КОНТАКТЫ ============
bot.hears('📞 Контакты', async (ctx) => {
  endSession(ctx.from.id);
  const contactText =
    '📍 Караоке-клуб 7Sky\n\n' +
    '🏠 Ковенский пер., 5, 7 этаж\n' +
    '📞 8 (812) 401-47-45\n' +
    '⏰ Ежедневно 18:00–06:00\n\n' +
    '🌐 spb7sky.ru\n' +
    '📱 VK: vk.com/club64123942\n\n' +
    '🚇 Метро: Площадь Восстания / Чернышевская';
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🆘 Связаться с персоналом', 'support_start')],
  ]);
  try {
    await ctx.replyWithPhoto(
      { url: `${PHOTO_BASE}/main.jpg` },
      { caption: contactText, ...kb }
    );
  } catch (e) {
    await ctx.reply(contactText, kb);
  }
});

bot.action('support_start', async (ctx) => {
  await ctx.answerCbQuery();
  startSupportSession(ctx.from.id);
  await ctx.reply(
    '🆘 Связь с персоналом\n\nОпишите вашу просьбу или проблему — передадим сотруднику:',
    Markup.inlineKeyboard([
      [Markup.button.callback('❌ Отмена', 'support_cancel')],
    ])
  );
});

bot.action('support_cancel', async (ctx) => {
  await ctx.answerCbQuery('Отменено');
  endSession(ctx.from.id);
  await ctx.reply('Хорошо, если что — обращайтесь!', mainKeyboard);
});

// ============ ПРОФИЛЬ ============
// Feature 1: Visit history + order history
// Feature 5: Taxi button
bot.hears('👤 Профиль', async (ctx) => {
  endSession(ctx.from.id);

  const [profile, bookingCount] = await Promise.all([
    getUserProfile(ctx.from.id),
    pool.query(
      `SELECT COUNT(*) as cnt FROM bookings WHERE user_id = $1`,
      [ctx.from.id]
    ).then(r => parseInt(r.rows[0]?.cnt || 0)).catch(() => 0),
  ]);

  const name = profile?.first_name || ctx.from.first_name || 'не указано';
  const username = profile?.username || ctx.from.username;

  let text = '👤 ВАШ ПРОФИЛЬ\n\n';
  text += `Имя: ${name}\n`;
  if (username) text += `@${username}\n`;
  text += `\n📊 Вы посещали нас ${bookingCount} раз`;

  await ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback('🆘 ВЫЗВАТЬ ПОМОЩНИКА', 'start_help')],
  ]));
});

// ============ AI ПОМОЩНИК ============
bot.action('start_help', async (ctx) => {
  await ctx.answerCbQuery();
  await startHelpSession(ctx.from.id);

  try {
    await ctx.sendChatAction('typing');
    const session = getSession(ctx.from.id);
    session.messages.push({ role: 'user', content: 'Мне нужна помощь' });
    const aiReply = await callOpenRouter(session.messages);
    session.messages.push({ role: 'assistant', content: aiReply });

    await ctx.reply('🤖 ' + aiReply, Markup.inlineKeyboard([
      [Markup.button.callback('❌ Отмена', 'cancel_help')],
    ]));
  } catch (e) {
    console.error('Help AI start error:', e.message);
    await ctx.reply(
      'Для связи с менеджером позвоните:\n📞 8 (812) 401-47-45',
      mainKeyboard
    );
    endSession(ctx.from.id);
  }
});

bot.action('cancel_help', async (ctx) => {
  await ctx.answerCbQuery('Отменено');
  endSession(ctx.from.id);
  await ctx.reply('Если нужна помощь — обращайтесь!', mainKeyboard);
});

// Booking history
bot.action('booking_history', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const { rows } = await pool.query(
      `SELECT room_name, room_type, booking_date, guests_count, status, created_at
       FROM bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [ctx.from.id]
    );

    if (rows.length === 0) {
      await ctx.reply('📋 У вас пока нет бронирований.', mainKeyboard);
      return;
    }

    let text = '📋 ИСТОРИЯ БРОНИРОВАНИЙ\n\n';
    rows.forEach((b, i) => {
      text += `${i + 1}. ${b.room_name || b.room_type || '?'}`;
      if (b.booking_date) text += ` — ${b.booking_date}`;
      if (b.guests_count) text += `, ${b.guests_count} чел.`;
      text += ` [${b.status || '?'}]\n`;
    });

    await ctx.reply(text, mainKeyboard);
  } catch (e) {
    console.error('booking_history error:', e.message);
    await ctx.reply('Ошибка загрузки истории', mainKeyboard);
  }
});

// ============ CATCH-ALL: AI session or ignore ============
bot.on('text', async (ctx, next) => {
  const session = getSession(ctx.from.id);
  if (session.active) {
    await handleAIMessage(ctx, ctx.message.text);
  } else {
    return next();
  }
});

// ============ SUPPORT CHAT RELAY ============

// Персонал нажимает "Ответить на #N" — входит в режим ответа
bot.action(/^reply_ticket_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Введите ответ следующим сообщением');
  const ticketId = parseInt(ctx.match[1]);
  if (!ticketId) return;

  staffReplyMode[ctx.from.id] = ticketId;

  // Уведомляем гостя о начале работы
  try {
    const { rows } = await pool.query(
      `SELECT user_id FROM support_tickets WHERE id = $1`,
      [ticketId]
    );
    if (rows[0]) {
      await bot.telegram.sendMessage(rows[0].user_id,
        `🟢 Администратор начал работу с вашим запросом #${ticketId}. Ответ уже готовится.`,
        { reply_markup: Markup.inlineKeyboard([[Markup.button.callback(`🚫 Отменить запрос #${ticketId}`, `cancel_ticket_${ticketId}`)]]).reply_markup }
      );
      await pool.query(
        `UPDATE support_tickets SET status = 'in_progress' WHERE id = $1`,
        [ticketId]
      );
    }
  } catch (e) { console.error('reply_ticket notify guest:', e.message); }

  await ctx.reply(`✏️ Напишите ответ следующим сообщением. ИИ отполирует текст и отправит гостю (#${ticketId}).`);
});

// Персонал пишет сообщение в чате поддержки
bot.on('message', async (ctx, next) => {
  if (String(ctx.chat.id) !== String(SUPPORT_CHAT_ID)) return next();
  if (!ctx.message.text) return next();

  const staffId = ctx.from.id;

  // Режим прямого ответа через кнопку reply_ticket
  if (staffReplyMode[staffId]) {
    const ticketId = staffReplyMode[staffId];
    delete staffReplyMode[staffId];

    try {
      const { rows } = await pool.query(
        `SELECT user_id, request_text FROM support_tickets WHERE id = $1`,
        [ticketId]
      );
      if (!rows[0]) {
        await ctx.reply(`Тикет #${ticketId} не найден`);
        return;
      }
      const guestId = rows[0].user_id;
      const context = rows[0].request_text;

      // Полируем ответ через AI
      const polished = await polishStaffResponse(context, ctx.message.text);

      await bot.telegram.sendMessage(guestId, polished,
        { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('❌ Завершить чат', 'support_end_guest')]]).reply_markup }
      );

      await ctx.reply(`✅ Ответ отправлен гостю по тикету #${ticketId}`);
    } catch (e) {
      console.error('staffReplyMode relay error:', e.message);
      await ctx.reply('Ошибка при отправке ответа');
    }
    return;
  }

  // Fallback: старый relay через reply на сообщение
  if (!ctx.message.reply_to_message) return next();

  const origMsgId = ctx.message.reply_to_message.message_id;
  const guestId = supportMsgToGuest[origMsgId];
  if (!guestId) return next();

  const staffName = ctx.from.first_name || 'Персонал';
  try {
    await bot.telegram.sendMessage(guestId,
      `👤 ${staffName}: ${ctx.message.text}`,
      { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('❌ Завершить чат', 'support_end_guest')]]).reply_markup }
    );
    supportMsgToGuest[ctx.message.message_id] = guestId;
  } catch (e) {
    console.error('relay to guest error:', e.message);
  }
});

// Персонал закрывает тикет (по ticketId)
// Персонал подтверждает или отклоняет бронирование
bot.action(/^confirm_booking_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Бронь подтверждена ✅');
  const ticketId = parseInt(ctx.match[1]);
  try {
    const { rows } = await pool.query(
      `UPDATE support_tickets SET status = 'confirmed' WHERE id = $1 RETURNING user_id`,
      [ticketId]
    );
    if (rows[0]) {
      await bot.telegram.sendMessage(rows[0].user_id,
        `✅ Ваша бронь #${ticketId} подтверждена!\n\nДо встречи в 7Sky 🎤`,
        mainKeyboard
      ).catch(() => {});
    }
    const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    await ctx.editMessageText(
      (ctx.callbackQuery.message.text || '') + `\n\n✅ ПОДТВЕРЖДЕНО — ${now}`,
      { reply_markup: Markup.inlineKeyboard([[Markup.button.callback(`✏️ Написать гостю #${ticketId}`, `reply_ticket_${ticketId}`)]]).reply_markup }
    ).catch(() => {});
  } catch (e) { console.error('confirm_booking error:', e.message); }
});

bot.action(/^reject_booking_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Бронь отклонена ❌');
  const ticketId = parseInt(ctx.match[1]);
  try {
    const { rows } = await pool.query(
      `UPDATE support_tickets SET status = 'closed' WHERE id = $1 RETURNING user_id`,
      [ticketId]
    );
    if (rows[0]) {
      await bot.telegram.sendMessage(rows[0].user_id,
        `❌ Ваша бронь #${ticketId} отклонена.\n\nСвяжитесь с нами: 📞 8 (812) 401-47-45`,
        mainKeyboard
      ).catch(() => {});
    }
    const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    await ctx.editMessageText(
      (ctx.callbackQuery.message.text || '') + `\n\n❌ ОТКЛОНЕНО — ${now}`,
      { reply_markup: Markup.inlineKeyboard([[Markup.button.callback(`✏️ Написать гостю #${ticketId}`, `reply_ticket_${ticketId}`)]]).reply_markup }
    ).catch(() => {});
  } catch (e) { console.error('reject_booking error:', e.message); }
});

bot.action(/^close_ticket_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Тикет закрыт');
  const ticketId = parseInt(ctx.match[1]);

  try {
    const { rows } = await pool.query(
      `UPDATE support_tickets SET status = 'closed' WHERE id = $1 RETURNING user_id`,
      [ticketId]
    );
    if (!rows[0]) return;

    const guestId = rows[0].user_id;
    endSession(guestId);

    await bot.telegram.sendMessage(guestId,
      `✅ Персонал завершил чат по запросу #${ticketId}. Спасибо за обращение!\nЕсли понадобится — обращайтесь снова.`,
      mainKeyboard
    );
  } catch (e) { console.error('close ticket error:', e.message); }

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
});

// Гость отменяет свой запрос
bot.action(/^cancel_ticket_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Запрос отменён');
  const ticketId = parseInt(ctx.match[1]);
  const guestId = ctx.from.id;

  endSession(guestId);

  try {
    await pool.query(
      `UPDATE support_tickets SET status = 'cancelled' WHERE id = $1 AND user_id = $2`,
      [ticketId, guestId]
    );
  } catch (e) {}

  try {
    await bot.telegram.sendMessage(SUPPORT_CHAT_ID,
      `ℹ️ Гость ${ctx.from.first_name || 'Гость'} (@${ctx.from.username || 'нет'}) отменил запрос #${ticketId}`
    );
  } catch (e) {}

  await ctx.reply('Запрос отменён. Если что — обращайтесь!', mainKeyboard);
});

// Гость завершает чат
bot.action('support_end_guest', async (ctx) => {
  await ctx.answerCbQuery('Чат завершён');
  const guestId = ctx.from.id;
  const guestName = ctx.from.first_name || 'Гость';
  const session = getSession(guestId);
  const ticketId = session.ticketId;

  endSession(guestId);

  try {
    await bot.telegram.sendMessage(SUPPORT_CHAT_ID,
      `ℹ️ Гость ${guestName} (@${ctx.from.username || 'нет'}) завершил чат${ticketId ? ` [#${ticketId}]` : ''}`
    );
  } catch (e) {}

  try {
    if (ticketId) {
      await pool.query(
        `UPDATE support_tickets SET status = 'closed' WHERE id = $1`,
        [ticketId]
      );
    } else {
      await pool.query(
        `UPDATE support_tickets SET status = 'closed' WHERE user_id = $1 AND status = 'open'`,
        [guestId]
      );
    }
  } catch (e) {}

  await ctx.reply('Чат завершён. Если что — обращайтесь! 📞 8 (812) 401-47-45', mainKeyboard);
});

// ============ START BOT ============
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('🎵 Karaoke 7Sky bot started');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
