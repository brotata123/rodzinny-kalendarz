// ============================================================
//  RODZINNY KALENDARZ — app.js
//  Logika aplikacji: Firebase, PIN, nawigacja, kalendarz
// ============================================================

// --- Haptyczne wibracje (Web Vibration API) ---
function vib(pattern = 40) { if (navigator.vibrate) navigator.vibrate(pattern); }

// --- n8n webhook (lokalny) ---
const N8N_WEBHOOK = 'http://localhost:5678/webhook/rodzinny-kalendarz';

function notifyN8n(data) {
  fetch(N8N_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, familyId })
  }).catch(() => {});
}

// --- Telegram powiadomienia ---
const TG_TOKEN   = '7924720319:AAGqG6LqmFcuiWV8_wpKvWo_EmxtazYEJgA';
const TG_CHAT_ID = '8087307530';

function notifyTelegram(data, action = 'add') {
  const categoryEmoji = {
    'szachy': '♟️', 'sprawdzian': '📝', 'ortodonta': '🦷',
    'konkurs': '🏆', 'inne': '📌'
  };
  const actionPrefix = { add: '➕ Dodano', edit: '✏️ Zmieniono', delete: '🗑 Usunięto' };
  const icon     = categoryEmoji[data.category] || '📅';
  const title    = data.title || data.name || '';
  const time     = data.time ? ` · ${data.time}` : '';
  const date     = data.date ? ` ${data.date}` : '';
  const location = data.location ? `\n📍 ${data.location}` : '';
  const notes    = data.notes    ? `\n📝 ${data.notes}`    : '';
  const text = `${actionPrefix[action]} ${icon} *${title}*\n📆${date}${time}${location}${notes}`;

  fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' })
  }).catch(() => {});
}

// --- Stan globalny ---
let db         = null;   // Firestore instance
let familyId   = null;   // ID rodziny z hasha URL
let familyConfig = null; // Konfiguracja rodziny (imiona, kolory)

// --- Start po załadowaniu DOM ---
document.addEventListener('DOMContentLoaded', initApp);

// ============================================================
//  INICJALIZACJA
// ============================================================
async function initApp() {
  // Rejestracja Service Worker (PWA)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .catch(err => console.warn('SW registration failed:', err));
  }

  // Odczytaj klucz rodziny z hasha URL (np. index.html#abc123)
  const hash = window.location.hash.slice(1);
  if (!hash || hash.length < 4) {
    window.location.replace('./index.html#kalendarz');
    return;
  }
  familyId = hash;

  // Inicjalizuj Firebase
  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    db = firebase.firestore();

    // Cache offline — działa nawet bez internetu
    // (deprecation warning w Firebase 10 compat SDK — nie blokuje działania)
    db.enablePersistence({ synchronizeTabs: true })
      .catch(err => {
        // failed-precondition = wiele zakładek, unimplemented = przeglądarka nie wspiera
        if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
          console.warn('Persistence error:', err);
        }
      });
  } catch (e) {
    console.error('Firebase init error:', e);
    showError('Błąd połączenia z bazą danych. Sprawdź plik firebase-config.js.');
    return;
  }

  // Sprawdź czy sesja jest aktywna (użytkownik już podał PIN)
  const sessionAuth = sessionStorage.getItem('auth_' + familyId);
  if (sessionAuth === 'ok') {
    await loadFamilyConfig();
    showScreen('calendar');
    updateBadges();
  } else {
    showScreen('pin');
  }

  // Przywróć tryb ciemny jeśli włączony
  if (localStorage.getItem('darkMode') === '1') {
    document.body.classList.add('dark');
    const dt = document.getElementById('dark-toggle');
    if (dt) dt.textContent = '☀️';
  }
}

// ============================================================
//  OBSŁUGA BŁĘDÓW
// ============================================================
function showError(msg) {
  document.getElementById('error-message').textContent = msg;
  // Ukryj PIN screen, pokaż error screen
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-error').classList.add('active');
}

// ============================================================
//  NAWIGACJA MIĘDZY EKRANAMI
// ============================================================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById('screen-' + name);
  if (screen) screen.classList.add('active');

  // Pokaż/ukryj FAB i nawigację (ukryte na PIN i error)
  const isAppScreen = !['pin', 'error'].includes(name);
  const fab = document.getElementById('global-fab');
  const nav = document.getElementById('global-nav');
  if (fab) fab.style.display = isAppScreen ? 'flex' : 'none';
  if (nav) nav.style.display = isAppScreen ? 'flex' : 'none';

  // Aktywna zakładka w dolnej nawigacji
  ['calendar', 'grades', 'contests', 'events', 'todo', 'results'].forEach(n => {
    const el = document.getElementById('nav-' + n);
    if (el) el.classList.toggle('active', n === name);
  });

  // Oznacz ekran jako odwiedzony (czyści badge)
  markScreenSeen(name);

  // Załaduj dane dla danego ekranu
  if (name === 'calendar') renderCalendar();
  if (name === 'grades')   renderGrades();
  if (name === 'contests') renderContests();
  if (name === 'events')   renderEvents();
  if (name === 'todo')     renderTasks();
  if (name === 'results')  renderResults();
}

// ============================================================
//  EKRAN PIN
// ============================================================
let pinDigits = [];

function pinPress(n) {
  if (pinDigits.length >= 4) return;
  pinDigits.push(String(n));
  updatePinDots();
  if (pinDigits.length === 4) {
    // Krótkie opóźnienie żeby użytkownik widział 4. kropkę
    setTimeout(verifyPin, 120);
  }
}

function pinDel() {
  if (pinDigits.length > 0) {
    pinDigits.pop();
    updatePinDots();
  }
}

function updatePinDots() {
  for (let i = 1; i <= 4; i++) {
    const dot = document.getElementById('d' + i);
    dot.classList.toggle('filled', i <= pinDigits.length);
    dot.classList.remove('error');
  }
}

async function verifyPin() {
  const pinStr  = pinDigits.join('');
  const pinHash = await sha256(pinStr);

  try {
    const ref = db.collection('families').doc(familyId);
    const doc = await ref.get();

    if (!doc.exists) {
      // ── Pierwsze uruchomienie: ustaw PIN i stwórz dokument rodziny ──
      await ref.set({
        pin_hash:       pinHash,
        child_name:     'Olaf',
        child_grade:    '',
        parent_a_name:  'Tata',
        parent_b_name:  'Mama',
        parent_a_color: '#4a9eff',
        parent_b_color: '#b07af5',
        created_at:     firebase.firestore.FieldValue.serverTimestamp()
      });
      familyConfig = (await ref.get()).data();
      sessionStorage.setItem('auth_' + familyId, 'ok');
      applyFamilyConfig();
      showScreen('calendar');
      updateBadges();

    } else {
      // ── Kolejne logowanie: porównaj hash ──
      const data = doc.data();
      if (data.pin_hash === pinHash) {
        familyConfig = data;
        sessionStorage.setItem('auth_' + familyId, 'ok');
        applyFamilyConfig();
        showScreen('calendar');
        updateBadges();
      } else {
        // Błędny PIN
        pinDigits = [];
        shakePinError();
      }
    }
  } catch (e) {
    console.error('PIN verification error:', e);
    pinDigits = [];
    updatePinDots();
  }
}

function shakePinError() {
  const dotsEl = document.getElementById('pin-dots');
  // Podświetl kropki na czerwono
  for (let i = 1; i <= 4; i++) {
    document.getElementById('d' + i).classList.add('filled', 'error');
  }
  dotsEl.classList.add('shake');
  setTimeout(() => {
    dotsEl.classList.remove('shake');
    updatePinDots(); // reset (wszystkie puste)
  }, 500);
}

// SHA-256 przez Web Crypto API (wbudowane w przeglądarkę)
async function sha256(message) {
  const msgBuffer  = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateSeriesId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getSchoolYearEnd() {
  const now = new Date();
  const year = now.getMonth() < 8 ? now.getFullYear() : now.getFullYear() + 1;
  return `${year}-06-20`;
}

// ============================================================
//  KONFIGURACJA RODZINY
// ============================================================
async function loadFamilyConfig() {
  if (!db || !familyId) return;
  try {
    const doc = await db.collection('families').doc(familyId).get();
    if (doc.exists) {
      familyConfig = doc.data();
      // Jednorazowa migracja: zaktualizuj domyślne wartości dziecka
      if (familyConfig.child_name === 'Dziecko' || familyConfig.child_grade === 'klasa') {
        familyConfig.child_name  = 'Olaf';
        familyConfig.child_grade = '';
        db.collection('families').doc(familyId)
          .update({ child_name: 'Olaf', child_grade: '' })
          .catch(() => {});
      }
      applyFamilyConfig();
    }
  } catch (e) {
    console.error('Config load error:', e);
  }
}

// Aplikuje konfigurację do UI (kolory CSS, imiona, inicjały)
function applyFamilyConfig() {
  if (!familyConfig) return;

  const a = familyConfig.parent_a_name  || 'Tata';
  const b = familyConfig.parent_b_name  || 'Mama';
  const colorA = familyConfig.parent_a_color || '#4a9eff';
  const colorB = familyConfig.parent_b_color || '#b07af5';

  // Kolory CSS rodziców
  document.documentElement.style.setProperty('--tata', colorA);
  document.documentElement.style.setProperty('--mama', colorB);

  // Imiona wszędzie w UI
  document.querySelectorAll('.parent-a-name').forEach(el => el.textContent = a);
  document.querySelectorAll('.parent-b-name').forEach(el => el.textContent = b);

  // Informacja o dziecku
  const childName  = familyConfig.child_name  || 'Olaf';
  const childGrade = familyConfig.child_grade || '';
  const childInfo  = childGrade ? `${childName} • ${childGrade}` : childName;
  document.querySelectorAll('.child-info').forEach(el => el.textContent = childInfo);

  // Inicjały avatarów
  const avatarA = document.getElementById('avatar-a');
  const avatarB = document.getElementById('avatar-b');
  if (avatarA) avatarA.textContent = a[0].toUpperCase();
  if (avatarB) avatarB.textContent = b[0].toUpperCase();
}

// ============================================================
//  KALENDARZ — WIDOK MIESIĘCZNY
// ============================================================
const MONTH_NAMES = [
  'Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec',
  'Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'
];
const MONTH_NAMES_SHORT = [
  'sty','lut','mar','kwi','maj','cze','lip','sie','wrz','paź','lis','gru'
];
const DOW_NAMES = ['Nd','Pn','Wt','Śr','Cz','Pt','Sb'];

// ── Polskie święta i ferie ────────────────────────────────────────────────────
// Święta stałe (MM-DD)
const PL_HOLIDAYS_FIXED = new Set([
  '01-01', // Nowy Rok
  '01-06', // Trzech Króli
  '05-01', // Święto Pracy
  '05-03', // Konstytucja 3 Maja
  '08-15', // Wniebowzięcie NMP
  '11-01', // Wszystkich Świętych
  '11-11', // Niepodległości
  '12-25', // Boże Narodzenie
  '12-26', // Drugi dzień Bożego Narodzenia
]);
// Święta ruchome (YYYY-MM-DD): Wielkanoc, Zielone Świątki, Boże Ciało
const PL_HOLIDAYS_MOVING = new Set([
  '2025-04-20','2025-04-21','2025-06-08','2025-06-19',
  '2026-04-05','2026-04-06','2026-05-24','2026-06-04',
  '2027-03-28','2027-03-29','2027-05-16','2027-05-27',
]);
// Ferie szkolne (Mazowsze)
const PL_SCHOOL_BREAKS = [
  { from: '2025-12-22', to: '2026-01-02' },
  { from: '2026-02-16', to: '2026-03-01' },
  { from: '2026-04-02', to: '2026-04-17' },
  { from: '2026-06-27', to: '2026-08-31' },
  { from: '2026-12-21', to: '2027-01-01' },
  { from: '2027-02-15', to: '2027-02-28' },
  { from: '2027-04-01', to: '2027-04-16' },
  { from: '2027-06-26', to: '2027-08-31' },
];

function isHoliday(dateStr) {
  return PL_HOLIDAYS_MOVING.has(dateStr) || PL_HOLIDAYS_FIXED.has(dateStr.slice(5));
}
function isSchoolBreak(dateStr) {
  return PL_SCHOOL_BREAKS.some(b => dateStr >= b.from && dateStr <= b.to);
}

let currentYear  = new Date().getFullYear();
let currentMonth = new Date().getMonth(); // 0-indexed
let currentView  = 'month';

// Cache danych Firebase dla widocznego miesiąca
let custodyCache = {}; // { 'YYYY-MM-DD': 'a'|'b'|'split' }
let eventsCache  = {}; // { 'YYYY-MM-DD': [{...}, ...] }

// Obiekt przechowujący dane split (godzina przekazania)
let custodyDetailsCache = {}; // { 'YYYY-MM-DD': { type, split_time, split_from } }

function renderCalendar() {
  if (currentView === 'month') renderMonthView();
  else                         renderWeekView();
}

function renderMonthView() {
  const label = `${MONTH_NAMES[currentMonth]} ${currentYear}`;
  document.getElementById('cal-header-title').textContent = label;
  document.getElementById('cal-month-name').textContent   = label;
  loadMonthData(buildMonthGrid);
}

function buildMonthGrid() {
  const grid = document.getElementById('days-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const today      = new Date();
  const isThisMonth = (today.getFullYear() === currentYear && today.getMonth() === currentMonth);
  const firstDayRaw = new Date(currentYear, currentMonth, 1).getDay(); // 0=Nd
  const startOffset = firstDayRaw === 0 ? 6 : firstDayRaw - 1;        // przesuń Pn=0
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

  // Puste komórki przed 1. dniem
  for (let i = 0; i < startOffset; i++) {
    const empty = document.createElement('div');
    empty.className = 'day empty';
    grid.appendChild(empty);
  }

  // Dni miesiąca
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = formatDate(currentYear, currentMonth + 1, d);
    const div     = document.createElement('div');
    div.className = 'day';

    // Kolor opieki
    const custody = custodyCache[dateStr];
    if      (custody === 'split') div.classList.add('split');
    else if (custody === 'a')     div.classList.add('tata-full');
    else if (custody === 'b')     div.classList.add('mama-full');

    // Święta i ferie
    if (isHoliday(dateStr))     div.classList.add('holiday');
    if (isSchoolBreak(dateStr)) div.classList.add('school-break');

    // Dzisiaj — subtelna kropka zamiast wypełnionego kółka
    if (isThisMonth && d === today.getDate()) div.classList.add('today-dot');

    div.innerHTML = `<span class="day-num">${d}</span>`;

    // Kolorowe kropki = typy wydarzeń
    const dayEvs = eventsCache[dateStr] || [];
    if (dayEvs.length > 0) {
      const dotsDiv = document.createElement('div');
      dotsDiv.className = 'day-dots';
      dayEvs.slice(0, 3).forEach(ev => {
        const dot = document.createElement('div');
        dot.className = 'dot ' + getCategoryDotClass(ev.category);
        dotsDiv.appendChild(dot);
      });
      div.appendChild(dotsDiv);
    }

    div.addEventListener('click', () => openDayPopup(dateStr, d));
    grid.appendChild(div);
  }
}

// Ładuje dane opieki i wydarzeń dla bieżącego miesiąca z Firebase
function loadMonthData(callback) {
  if (!db || !familyId) { if (callback) callback(); return; }

  const ym    = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
  const start = ym + '-01';
  const end   = ym + '-31';

  const familyRef  = db.collection('families').doc(familyId);
  const custodyRef = familyRef.collection('custody');
  const eventsRef  = familyRef.collection('events');
  const contestRef = familyRef.collection('contests');

  // Pobierz opiekę, wydarzenia i konkursy równolegle
  Promise.all([
    custodyRef.where(firebase.firestore.FieldPath.documentId(), '>=', start)
              .where(firebase.firestore.FieldPath.documentId(), '<=', end)
              .get(),
    eventsRef.where('date', '>=', start)
             .where('date', '<=', end)
             .orderBy('date')
             .get(),
    contestRef.where('date', '>=', start)
              .where('date', '<=', end)
              .get()
  ])
  .then(([custodySnap, eventsSnap, contestSnap]) => {
    custodyCache        = {};
    custodyDetailsCache = {};
    custodySnap.forEach(doc => {
      const data = doc.data();
      custodyCache[doc.id]        = data.type;
      custodyDetailsCache[doc.id] = data;
    });

    eventsCache = {};
    eventsSnap.forEach(doc => {
      const ev = { ...doc.data(), id: doc.id };
      if (!eventsCache[ev.date]) eventsCache[ev.date] = [];
      eventsCache[ev.date].push(ev);
    });
    // Dołącz konkursy do eventsCache (mapuj name→title, category→'konkurs')
    contestSnap.forEach(doc => {
      const d = doc.data();
      const ev = { ...d, id: doc.id, title: d.name || d.title || '', category: 'konkurs', _col: 'contest' };
      if (!eventsCache[ev.date]) eventsCache[ev.date] = [];
      eventsCache[ev.date].push(ev);
    });

    if (callback) callback();
  })
  .catch(err => {
    console.error('loadMonthData error:', err);
    if (callback) callback(); // Render nawet przy błędzie
  });
}

// Animowana nawigacja między miesiącami
function animateMonth(dir, callback) {
  if (currentView !== 'month') { callback(); return; }
  const wrap = document.querySelector('.calendar-wrap');
  if (!wrap) { callback(); return; }
  const outCls = dir === 'next' ? 'slide-out-left'  : 'slide-out-right';
  const inCls  = dir === 'next' ? 'slide-in-right' : 'slide-in-left';
  wrap.classList.add(outCls);
  setTimeout(() => {
    wrap.classList.remove(outCls);
    callback();
    requestAnimationFrame(() => {
      wrap.classList.add(inCls);
      setTimeout(() => wrap.classList.remove(inCls), 240);
    });
  }, 170);
}

function prevMonth() {
  animateMonth('prev', () => {
    currentMonth--;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    renderMonthView();
  });
}

function nextMonth() {
  animateMonth('next', () => {
    currentMonth++;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    renderMonthView();
  });
}

// ============================================================
//  KALENDARZ — WIDOK TYGODNIOWY
// ============================================================
// Przechowujemy datę początku bieżącego tygodnia (poniedziałek)
let weekStart = getMondayOf(new Date());

function renderWeekView() {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);

  const startLabel = `${weekStart.getDate()} ${MONTH_NAMES_SHORT[weekStart.getMonth()]}`;
  const endLabel   = `${end.getDate()} ${MONTH_NAMES_SHORT[end.getMonth()]} ${end.getFullYear()}`;
  document.getElementById('cal-header-title').textContent = 'Tydzień';
  document.getElementById('cal-week-label').textContent   = `${startLabel}–${endLabel}`;

  loadWeekData(buildWeekGrid);
}

function loadWeekData(callback) {
  if (!db || !familyId) { if (callback) callback(); return; }

  const days = getWeekDays(weekStart);
  const start = formatDateObj(days[0]);
  const end   = formatDateObj(days[6]);

  const familyRef  = db.collection('families').doc(familyId);
  const custodyRef = familyRef.collection('custody');
  const eventsRef  = familyRef.collection('events');
  const contestRef = familyRef.collection('contests');

  Promise.all([
    custodyRef.where(firebase.firestore.FieldPath.documentId(), '>=', start)
              .where(firebase.firestore.FieldPath.documentId(), '<=', end)
              .get(),
    eventsRef.where('date', '>=', start)
             .where('date', '<=', end)
             .orderBy('date')
             .get(),
    contestRef.where('date', '>=', start)
              .where('date', '<=', end)
              .get()
  ])
  .then(([custodySnap, eventsSnap, contestSnap]) => {
    custodyCache        = {};
    custodyDetailsCache = {};
    custodySnap.forEach(doc => {
      custodyCache[doc.id]        = doc.data().type;
      custodyDetailsCache[doc.id] = doc.data();
    });
    eventsCache = {};
    eventsSnap.forEach(doc => {
      const ev = { ...doc.data(), id: doc.id };
      if (!eventsCache[ev.date]) eventsCache[ev.date] = [];
      eventsCache[ev.date].push(ev);
    });
    contestSnap.forEach(doc => {
      const d = doc.data();
      const ev = { ...d, id: doc.id, title: d.name || d.title || '', category: 'konkurs', _col: 'contest' };
      if (!eventsCache[ev.date]) eventsCache[ev.date] = [];
      eventsCache[ev.date].push(ev);
    });
    if (callback) callback();
  })
  .catch(err => { console.error('loadWeekData error:', err); if (callback) callback(); });
}

function buildWeekGrid() {
  const container = document.getElementById('wk-hourly');
  if (!container) return;
  container.innerHTML = '';

  const today      = new Date();
  const weekDays   = getWeekDays(weekStart);
  const DOW_SHORT  = ['Nd','Pn','Wt','Śr','Cz','Pt','Sb'];
  const HOUR_START = 7;
  const HOUR_END   = 22;
  const PX_PER_HR  = 56;
  const HOURS      = [];
  for (let h = HOUR_START; h <= HOUR_END; h++) HOURS.push(h);
  const totalH = (HOUR_END - HOUR_START) * PX_PER_HR;

  // ── Nagłówek ──────────────────────────────────────────────────
  const head = document.createElement('div');
  head.className = 'wkh-head';
  head.appendChild(document.createElement('div')); // gutter spacer

  weekDays.forEach(dayDate => {
    const dateStr = formatDateObj(dayDate);
    const custody = custodyCache[dateStr];
    const isToday = sameDay(dayDate, today);
    const dname   = DOW_SHORT[dayDate.getDay()];

    const cell = document.createElement('div');
    cell.className = 'wkh-head-day';
    if (custody === 'a')     cell.style.background = 'rgba(74,158,255,0.22)';
    if (custody === 'b')     cell.style.background = 'rgba(176,122,245,0.18)';
    if (custody === 'split') cell.style.background =
      'linear-gradient(135deg,rgba(74,158,255,0.28) 50%,rgba(176,122,245,0.28) 50%)';

    // Święta i ferie w widoku tygodniowym
    if (isHoliday(dateStr))     cell.classList.add('wkh-holiday');
    if (isSchoolBreak(dateStr)) cell.classList.add('wkh-break');

    const dnameEl = document.createElement('div');
    dnameEl.className = 'wkh-dname';
    dnameEl.textContent = dname;

    const numEl = document.createElement('div');
    numEl.className = isToday ? 'wkh-today-num' : 'wkh-dnum';
    numEl.textContent = dayDate.getDate();

    cell.appendChild(dnameEl);
    cell.appendChild(numEl);
    cell.addEventListener('click', () => openDayPopup(dateStr, dayDate.getDate()));
    head.appendChild(cell);
  });
  container.appendChild(head);

  // ── Przewijalny obszar ────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'wkh-body';

  // Wiersz "cały dzień"
  const alldayRow = document.createElement('div');
  alldayRow.className = 'wkh-allday-row';
  const alldayLbl = document.createElement('div');
  alldayLbl.className = 'wkh-allday-label';
  alldayLbl.textContent = 'całodz.';
  alldayRow.appendChild(alldayLbl);

  weekDays.forEach(dayDate => {
    const dateStr   = formatDateObj(dayDate);
    const alldayEvs = (eventsCache[dateStr] || []).filter(ev => !ev.time);
    const cell = document.createElement('div');
    cell.className = 'wkh-allday-cell';
    const shown = alldayEvs.slice(0, 2);
    const extra = alldayEvs.length - shown.length;
    shown.forEach(ev => {
      const { icon } = getCategoryDisplay(ev.category);
      const cls = getEventWeekClass(ev.category);
      const evEl = document.createElement('div');
      evEl.className = `wkh-ev ${cls}`;
      evEl.textContent = `${icon} ${ev.title.substring(0,8)}`;
      evEl.title = ev.title;
      evEl.addEventListener('click', e => { e.stopPropagation(); openDayPopup(dateStr, dayDate.getDate()); });
      cell.appendChild(evEl);
    });
    if (extra > 0) {
      const more = document.createElement('div');
      more.className = 'wkh-ev wkh-more';
      more.textContent = `+${extra}`;
      more.addEventListener('click', e => { e.stopPropagation(); openDayPopup(dateStr, dayDate.getDate()); });
      cell.appendChild(more);
    }
    cell.addEventListener('click', () => openDayPopup(dateStr, dayDate.getDate()));
    alldayRow.appendChild(cell);
  });
  body.appendChild(alldayRow);

  // ── Kolumny z absolutnie pozycjonowanymi eventami ─────────────
  const colsWrap = document.createElement('div');
  colsWrap.className = 'wkh-cols-wrap';
  colsWrap.style.height = `${totalH}px`;

  // Lewa kolumna z etykietami godzin
  const gutterCol = document.createElement('div');
  gutterCol.className = 'wkh-gutter-col';
  HOURS.forEach((h, i) => {
    const lbl = document.createElement('div');
    lbl.className = 'wkh-time-lbl';
    lbl.style.top = `${i * PX_PER_HR}px`;
    lbl.textContent = `${h}:00`;
    gutterCol.appendChild(lbl);
  });
  colsWrap.appendChild(gutterCol);

  // Kolumny dni
  weekDays.forEach(dayDate => {
    const dateStr = formatDateObj(dayDate);
    const custody = custodyCache[dateStr];

    const col = document.createElement('div');
    col.className = 'wkh-day-col';
    if (custody === 'a')     col.style.background = 'rgba(74,158,255,0.05)';
    if (custody === 'b')     col.style.background = 'rgba(176,122,245,0.05)';
    col.addEventListener('click', () => openDayPopup(dateStr, dayDate.getDate()));

    // Linie godzinowe
    HOURS.forEach((h, i) => {
      const line = document.createElement('div');
      line.className = 'wkh-hour-line';
      line.style.top = `${i * PX_PER_HR}px`;
      col.appendChild(line);
      // Linia półgodzinna
      const half = document.createElement('div');
      half.className = 'wkh-hour-line-half';
      half.style.top = `${i * PX_PER_HR + PX_PER_HR / 2}px`;
      col.appendChild(half);
    });

    // Wydarzenia z godziną
    const timedEvs = (eventsCache[dateStr] || []).filter(ev => ev.time);
    timedEvs.forEach(ev => {
      const [sh, sm] = ev.time.split(':').map(Number);
      if (sh < HOUR_START || sh >= HOUR_END) return;

      // Czas trwania: użyj timeEnd jeśli dostępny, domyślnie 60 min
      let durMins = 60;
      if (ev.timeEnd) {
        const [eh, em] = ev.timeEnd.split(':').map(Number);
        durMins = Math.max(30, eh * 60 + em - (sh * 60 + sm));
      }

      const topPx = ((sh - HOUR_START) + sm / 60) * PX_PER_HR;
      const hPx   = Math.max(26, (durMins / 60) * PX_PER_HR - 2);

      const { icon } = getCategoryDisplay(ev.category);
      const cls = getEventWeekClass(ev.category);

      const evEl = document.createElement('div');
      evEl.className = `wkh-event-block ${cls}`;
      evEl.style.top    = `${topPx}px`;
      evEl.style.height = `${hPx}px`;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'wkh-ev-icon';
      iconSpan.textContent = icon;

      const bodySpan = document.createElement('span');
      bodySpan.className = 'wkh-ev-body';

      const timeSpan = document.createElement('span');
      timeSpan.className = 'wkh-ev-time';
      timeSpan.textContent = ev.time + (ev.timeEnd ? `–${ev.timeEnd}` : '');

      const titleSpan = document.createElement('span');
      titleSpan.className = 'wkh-ev-title';
      titleSpan.textContent = ev.title;

      bodySpan.appendChild(timeSpan);
      bodySpan.appendChild(titleSpan);
      evEl.appendChild(iconSpan);
      evEl.appendChild(bodySpan);

      evEl.addEventListener('click', e => { e.stopPropagation(); openDayPopup(dateStr, dayDate.getDate()); });
      col.appendChild(evEl);
    });

    colsWrap.appendChild(col);
  });

  body.appendChild(colsWrap);
  container.appendChild(body);
}

function prevWeek() {
  weekStart.setDate(weekStart.getDate() - 7);
  renderWeekView();
}

function nextWeek() {
  weekStart.setDate(weekStart.getDate() + 7);
  renderWeekView();
}

// ============================================================
//  PRZEŁĄCZNIK WIDOKU
// ============================================================
function switchView(v) {
  currentView = v;
  document.getElementById('vt-month').classList.toggle('active', v === 'month');
  document.getElementById('vt-week').classList.toggle('active', v === 'week');
  document.getElementById('view-month').style.display = v === 'month' ? 'flex' : 'none';
  document.getElementById('view-week').style.display  = v === 'week'  ? 'flex' : 'none';
  renderCalendar();
}

// ============================================================
//  POPUP DNIA
// ============================================================
let selectedDate = null; // dla formularza dodawania

function openDayPopup(dateStr, dayNum) {
  selectedDate = dateStr;

  const date  = new Date(dateStr + 'T12:00:00');
  const dow   = DOW_NAMES[date.getDay()];
  const mon   = MONTH_NAMES_SHORT[date.getMonth()];

  document.getElementById('popup-date-title').textContent = `📅 ${dow}, ${dayNum} ${mon}`;

  const custody    = custodyCache[dateStr];
  const custDetail = custodyDetailsCache[dateStr] || {};
  const dayEvs     = eventsCache[dateStr] || [];
  const nameA      = familyConfig?.parent_a_name || 'Tata';
  const nameB      = familyConfig?.parent_b_name || 'Mama';

  let html = '';

  // Blok opieki
  if (custody === 'split') {
    const splitTime = custDetail.split_time || '';
    const fromA     = custDetail.split_from === 'a';
    html += `
      <div class="custody-bar" style="margin-bottom:12px">
        <div class="custody-half tata">
          <div class="custody-name t">${nameA.toUpperCase()}</div>
          <div class="custody-time">${fromA ? 'od rana' : `do ${splitTime}`}</div>
        </div>
        <div class="custody-arrow">⇄${splitTime ? '<br><small>' + splitTime + '</small>' : ''}</div>
        <div class="custody-half mama">
          <div class="custody-name m">${nameB.toUpperCase()}</div>
          <div class="custody-time">${fromA ? `od ${splitTime}` : 'od rana'}</div>
        </div>
      </div>`;
  } else if (custody === 'a') {
    html += `
      <div class="event-item" style="background:rgba(74,158,255,0.07);margin-bottom:8px">
        <div class="event-icon">👨</div>
        <div class="event-info">
          <div class="event-name">Opieka — ${nameA}</div>
          <div class="event-time">cały dzień</div>
        </div>
        <button class="del-btn" onclick="editEntry('custody','${dateStr}')" title="Edytuj">✏️</button>
        <button class="del-btn" onclick="deleteEntry('custody','${dateStr}')" title="Usuń">🗑</button>
      </div>`;
  } else if (custody === 'b') {
    html += `
      <div class="event-item" style="background:rgba(176,122,245,0.07);margin-bottom:8px">
        <div class="event-icon">👩</div>
        <div class="event-info">
          <div class="event-name">Opieka — ${nameB}</div>
          <div class="event-time">cały dzień</div>
        </div>
        <button class="del-btn" onclick="editEntry('custody','${dateStr}')" title="Edytuj">✏️</button>
        <button class="del-btn" onclick="deleteEntry('custody','${dateStr}')" title="Usuń">🗑</button>
      </div>`;
  }

  // Lista wydarzeń — sortuj rosnąco po godzinie (brak godziny = na końcu)
  const sortedEvs = [...dayEvs].sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });
  sortedEvs.forEach(ev => {
    const { icon, tagClass, tagName } = getCategoryDisplay(ev.category);
    const timeStr = ev.time ? ev.time : 'cały dzień';
    const locStr  = ev.location ? ` • ${ev.location}` : '';
    html += `
      <div class="event-item" style="margin-bottom:8px">
        <div class="event-icon">${icon}</div>
        <div class="event-info">
          <div class="event-name">${escHtml(ev.title)}</div>
          <div class="event-time">${timeStr}${locStr}</div>
        </div>
        <button class="del-btn" onclick="editEntry('${ev._col||'event'}','${ev.id}')" title="Edytuj">✏️</button>
        <button class="del-btn" onclick="deleteEntry('${ev._col||'event'}','${ev.id}','${ev.seriesId||''}')" title="Usuń">🗑</button>
      </div>`;
  });

  if (!custody && dayEvs.length === 0) {
    html += `<div style="text-align:center;padding:24px 0;color:var(--text-light);font-size:13px;">
               Brak wpisów tego dnia
             </div>`;
  }

  html += `<button class="add-btn" onclick="closeDayPopupDirect(); openModal()">+ Dodaj wpis</button>`;

  document.getElementById('popup-content').innerHTML = html;
  document.getElementById('day-popup').classList.add('open');
}

// Otwiera formularz edycji wypełniony istniejącymi danymi
async function editEntry(type, id) {
  try {
    const familyRef = db.collection('families').doc(familyId);

    if (type === 'custody') {
      openAddForm('custody');
      document.getElementById('f-date').value = id;
      const d = custodyDetailsCache[id];
      if (d) {
        selectParent(d.type);
        if (d.type === 'split') {
          document.getElementById('f-split-time').value = d.split_time || '15:00';
          if (d.split_from) selectSplitFrom(d.split_from);
        }
      }
      editMode = true; editDocId = id;
      document.getElementById('form-title').textContent = 'Edytuj opiekę';
      document.getElementById('btn-save').textContent   = 'Zaktualizuj';

    } else if (type === 'contest') {
      const snap = await familyRef.collection('contests').doc(id).get();
      if (!snap.exists) return;
      const data = snap.data();
      openAddForm('contest');
      document.getElementById('f-date').value = data.date || '';
      document.getElementById('f-name').value = data.name || data.title || '';
      const timeEl = document.getElementById('f-time'), timeEndEl = document.getElementById('f-time-end');
      const locEl  = document.getElementById('f-location'), notEl = document.getElementById('f-notes');
      if (timeEl)    timeEl.value    = data.time     || '';
      if (timeEndEl) timeEndEl.value = data.timeEnd  || '';
      if (locEl)     locEl.value     = data.location || '';
      if (notEl)     notEl.value     = data.notes    || '';
      editMode = true; editDocId = id;
      document.getElementById('form-title').textContent = 'Edytuj konkurs';
      document.getElementById('btn-save').textContent   = 'Zaktualizuj';

    } else {
      const snap = await familyRef.collection('events').doc(id).get();
      if (!snap.exists) return;
      const data = snap.data();
      if (data.seriesId) {
        showConfirmDialog(
          '✏️ Edycja zdarzenia',
          'Ten wpis jest częścią serii cyklicznej.',
          [
            { label: 'Anuluj',     cls: 'btn-cancel',                           action: () => {} },
            { label: 'Tylko ten',  cls: 'btn-save',                             action: () => _fillEditForm(id, data, null) },
            { label: 'Całą serię', cls: 'btn-save', style: 'background:var(--event)', action: () => _fillEditForm(id, data, data.seriesId) }
          ]
        );
        return;
      }
      _fillEditForm(id, data, null);
    }
  } catch (err) { alert('Błąd: ' + err.message); }
}

function _fillEditForm(id, data, seriesId) {
  const catToType = {
    'szachy': 'chess', 'sprawdzian': 'exam', 'ortodonta': 'orthodontist', 'inne': 'other',
    'zajęcia': 'chess', 'wizyta': 'orthodontist', 'wydarzenie': 'other'
  };
  openAddForm(catToType[data.category] || 'other');
  document.getElementById('f-date').value  = data.date  || '';
  document.getElementById('f-title').value = data.title || '';
  const timeEl = document.getElementById('f-time'), timeEndEl = document.getElementById('f-time-end');
  const locEl  = document.getElementById('f-location'), notEl = document.getElementById('f-notes');
  if (timeEl)    timeEl.value    = data.time     || '';
  if (timeEndEl) timeEndEl.value = data.timeEnd  || '';
  if (locEl)     locEl.value     = data.location || '';
  if (notEl)     notEl.value     = data.notes    || '';
  editMode     = true;
  editDocId    = id;
  editSeriesId = seriesId;
  document.getElementById('form-title').textContent = seriesId ? 'Edytuj serię' : 'Edytuj wpis';
  document.getElementById('btn-save').textContent   = seriesId ? 'Zaktualizuj serię' : 'Zaktualizuj';
}

function deleteEntry(type, id, seriesId) {
  const hasSeries = !!seriesId;
  const buttons = [
    { label: 'Anuluj', cls: 'btn-cancel', action: () => {} }
  ];
  if (hasSeries) {
    buttons.push({ label: 'Usuń ten wpis',   cls: 'btn-danger soft', action: () => doDeleteEntry(type, id) });
    buttons.push({ label: 'Usuń całą serię', cls: 'btn-danger',      action: () => doDeleteSeries(seriesId) });
  } else {
    buttons.push({ label: 'Usuń', cls: 'btn-danger', action: () => doDeleteEntry(type, id) });
  }
  showConfirmDialog(
    'Usunąć wpis?',
    hasSeries ? 'Ten wpis należy do serii cyklicznej.' : '',
    buttons
  );
}

async function doDeleteEntry(type, id) {
  vib([30, 50, 80]);
  try {
    const familyRef = db.collection('families').doc(familyId);
    let notifyData = null;
    if (type === 'custody') {
      await familyRef.collection('custody').doc(id).delete();
    } else if (type === 'contest') {
      const snap = await familyRef.collection('contests').doc(id).get();
      if (snap.exists) notifyData = { ...snap.data(), title: snap.data().name, category: 'konkurs' };
      await familyRef.collection('contests').doc(id).delete();
    } else {
      const snap = await familyRef.collection('events').doc(id).get();
      if (snap.exists) notifyData = snap.data();
      await familyRef.collection('events').doc(id).delete();
    }
    if (notifyData) notifyTelegram(notifyData, 'delete');
    closeDayPopupDirect();
    renderCalendar();
    renderEvents();
    updateBadges();
  } catch (err) { alert('Błąd usuwania: ' + err.message); }
}

async function doDeleteSeries(seriesId) {
  vib([30, 50, 80]);
  try {
    const snap = await db.collection('families').doc(familyId)
      .collection('events').where('seriesId', '==', seriesId).get();
    if (snap.empty) return;
    // Powiadomienie Telegram przed usunięciem (dane z pierwszego wpisu)
    const sample = snap.docs[0].data();
    notifyTelegram(
      { ...sample, title: `${sample.title} (cała seria, ${snap.size} wpisów)` },
      'delete'
    );
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    closeDayPopupDirect();
    renderCalendar();
    renderEvents();
    updateBadges();
  } catch (err) { alert('Błąd usuwania serii: ' + err.message); }
}

function closeDayPopup(e) {
  if (e.target === document.getElementById('day-popup')) {
    document.getElementById('day-popup').classList.remove('open');
  }
}

function closeDayPopupDirect() {
  document.getElementById('day-popup').classList.remove('open');
}

// Swipe down = zamknij popup lub formularz; swipe lewo/prawo = zmień miesiąc/tydzień
(function initSwipeHandlers() {
  let startX = 0, startY = 0;
  const popup   = document.getElementById('day-popup');
  const form    = document.getElementById('form-modal');
  const confirm = document.getElementById('confirm-modal');

  function closeWithAnim(el) {
    el.classList.add('closing');
    setTimeout(() => el.classList.remove('open', 'closing'), 260);
  }

  function navigateWithAnim(direction) { // direction: -1 = next (swipe left), 1 = prev (swipe right)
    if (currentView === 'week') {
      direction < 0 ? nextWeek() : prevWeek();
      return;
    }
    // nextMonth()/prevMonth() już zawierają animację
    direction < 0 ? nextMonth() : prevMonth();
  }

  document.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    // Nie obsługuj swipe gdy confirm-modal jest otwarty
    if (confirm && confirm.classList.contains('open')) return;

    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;

    // Swipe w dół — zamknij z animacją
    if (dy > 60 && Math.abs(dy) > Math.abs(dx)) {
      if (popup.classList.contains('open')) closeWithAnim(popup);
      else if (form.classList.contains('open')) closeWithAnim(form);
      return;
    }

    // Swipe lewo/prawo — nawigacja z animacją
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) &&
        !popup.classList.contains('open') && !form.classList.contains('open')) {
      navigateWithAnim(dx < 0 ? -1 : 1);
    }
  }, { passive: true });
})();

// ============================================================
//  MODAL WYBORU TYPU WPISU
// ============================================================
function openModal() {
  if (document.getElementById('screen-todo')?.classList.contains('active')) {
    openTaskForm(); return;
  }
  if (document.getElementById('screen-results')?.classList.contains('active')) {
    openResultForm(); return;
  }
  document.getElementById('modal').classList.add('open');
}

function closeModal(e) {
  if (e.target === document.getElementById('modal')) {
    document.getElementById('modal').classList.remove('open');
  }
}

function closeModalDirect() {
  document.getElementById('modal').classList.remove('open');
}

// ============================================================
//  FORMULARZE DODAWANIA
// ============================================================
let currentFormType    = null;
let currentCustodyType = null;
let currentSplitFrom   = null;
let currentGrade       = null;
let editMode           = false;
let editDocId          = null;
let editSeriesId       = null;

function openAddForm(type) {
  closeModalDirect();
  currentFormType    = type;
  currentCustodyType = null;
  currentSplitFrom   = null;
  currentGrade       = null;
  editMode           = false;
  editDocId          = null;
  editSeriesId       = null;

  const titles = {
    custody:      'Dodaj opiekę',
    contest:      'Dodaj konkurs',
    chess:        'Dodaj szachy',
    exam:         'Dodaj sprawdzian',
    orthodontist: 'Dodaj ortodontę',
    other:        'Dodaj wpis'
  };

  document.getElementById('btn-save').onclick = submitForm;
  document.getElementById('form-title').textContent = titles[type] || 'Dodaj wpis';
  document.getElementById('form-body').innerHTML    = buildFormHtml(type);
  document.getElementById('form-error').textContent = '';
  const btn = document.getElementById('btn-save');
  btn.textContent = 'Zapisz';
  btn.disabled    = false;
  document.getElementById('form-modal').classList.add('open');
}

function buildFormHtml(type) {
  const date  = selectedDate || formatDateObj(new Date());
  const nameA = (familyConfig && familyConfig.parent_a_name) || 'Tata';
  const nameB = (familyConfig && familyConfig.parent_b_name) || 'Mama';

  const dateField = `
    <div class="form-group">
      <label class="form-label">Data</label>
      <input type="date" class="form-input" id="f-date" value="${date}">
    </div>`;

  // --- OPIEKA ---
  if (type === 'custody') {
    return `
      ${dateField}
      <div class="form-group">
        <label class="form-label">Kto sprawuje opiekę?</label>
        <div class="parent-btns">
          <button class="parent-btn" id="pb-a"     onclick="selectParent('a')">${nameA}</button>
          <button class="parent-btn" id="pb-b"     onclick="selectParent('b')">${nameB}</button>
          <button class="parent-btn" id="pb-split" onclick="selectParent('split')">Dzielona</button>
        </div>
      </div>
      <div id="split-fields" style="display:none">
        <div class="form-group">
          <label class="form-label">Godzina przekazania</label>
          <input type="time" class="form-input" id="f-split-time" value="15:00">
        </div>
        <div class="form-group">
          <label class="form-label">Kto ma dziecko rano?</label>
          <div class="parent-btns">
            <button class="parent-btn" id="pb-from-a" onclick="selectSplitFrom('a')">${nameA}</button>
            <button class="parent-btn" id="pb-from-b" onclick="selectSplitFrom('b')">${nameB}</button>
          </div>
        </div>
      </div>`;
  }

  // --- OCENA ---
  if (type === 'grade') {
    return `
      <div class="form-group">
        <label class="form-label">Przedmiot</label>
        <input type="text" class="form-input" id="f-subject" placeholder="np. Matematyka" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Ocena</label>
        <div class="grade-btns">
          <button class="grade-btn grade-1" id="gb-1" onclick="selectGrade(1)">1</button>
          <button class="grade-btn grade-2" id="gb-2" onclick="selectGrade(2)">2</button>
          <button class="grade-btn grade-3" id="gb-3" onclick="selectGrade(3)">3</button>
          <button class="grade-btn grade-4" id="gb-4" onclick="selectGrade(4)">4</button>
          <button class="grade-btn grade-5" id="gb-5" onclick="selectGrade(5)">5</button>
          <button class="grade-btn grade-6" id="gb-6" onclick="selectGrade(6)">6</button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Rodzaj</label>
        <select class="form-select" id="f-grade-type">
          <option value="sprawdzian">Sprawdzian</option>
          <option value="kartkówka">Kartkówka</option>
          <option value="odpowiedź">Odpowiedź ustna</option>
          <option value="projekt">Projekt</option>
          <option value="inne">Inne</option>
        </select>
      </div>
      ${dateField}
      <div class="form-group">
        <label class="form-label">Notatki (opcjonalnie)</label>
        <textarea class="form-textarea" id="f-notes" placeholder="np. temat rozdziału..."></textarea>
      </div>`;
  }

  // --- KONKURS ---
  if (type === 'contest') {
    return `
      <div class="form-group">
        <label class="form-label">Nazwa konkursu</label>
        <input type="text" class="form-input" id="f-name" placeholder="np. Olimpiada Matematyczna" autocomplete="off">
      </div>
      ${dateField}
      <div class="form-group">
        <label class="form-label">Godzina</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="time" class="form-input" id="f-time" style="flex:1">
          <span style="font-size:12px;color:var(--text-light);flex-shrink:0;">do</span>
          <input type="time" class="form-input" id="f-time-end" style="flex:1">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Miejsce</label>
        <input type="text" class="form-input" id="f-location" placeholder="np. Szkoła Podstawowa nr 1" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Notatki (opcjonalnie)</label>
        <textarea class="form-textarea" id="f-notes" placeholder="..."></textarea>
      </div>`;
  }

  // --- WYDARZENIA (event, visit, barber, activity, birthday, trip) ---
  const placeholders = {
    chess:        'np. Turniej szachowy',
    exam:         'np. Matematyka — ułamki',
    orthodontist: 'np. Kontrola — dr Kowalski',
    other:        'np. Urodziny Kacpra'
  };
  const defaults = {
    chess: 'Zajęcia szachowe',
  };
  const showLocation = ['chess', 'orthodontist', 'other'].includes(type);

  return `
    ${dateField}
    <div class="form-group">
      <label class="form-label">Tytuł</label>
      <input type="text" class="form-input" id="f-title"
             placeholder="${placeholders[type] || 'Tytuł'}"
             value="${defaults[type] || ''}" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label">Godzina</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="time" class="form-input" id="f-time" style="flex:1">
        <span style="font-size:12px;color:var(--text-light);flex-shrink:0;">do</span>
        <input type="time" class="form-input" id="f-time-end" style="flex:1">
      </div>
    </div>
    ${showLocation ? `
    <div class="form-group">
      <label class="form-label">Miejsce (opcjonalnie)</label>
      <input type="text" class="form-input" id="f-location"
             placeholder="np. ul. Szkolna 1" autocomplete="off">
    </div>` : ''}
    <div class="form-group">
      <label class="form-label">Notatki (opcjonalnie)</label>
      <textarea class="form-textarea" id="f-notes" placeholder="..."></textarea>
    </div>
    <div class="form-group">
      <div class="recurring-row" id="recurring-row" onclick="toggleRecurring()">
        <input type="checkbox" id="f-recurring" style="display:none">
        <div class="tog-track" id="tog-track"><div class="tog-thumb"></div></div>
        <span style="font-size:13px;font-weight:500;color:var(--text-dark);">Powtarzaj co tydzień</span>
      </div>
    </div>
    <div id="recurring-fields" style="display:none">
      <div class="form-group">
        <label class="form-label">Do kiedy</label>
        <input type="date" class="form-input" id="f-recurring-until" value="${getSchoolYearEnd()}">
      </div>
    </div>`;
}

// Wybór rodzica w formularzu opieki
function selectParent(type) {
  currentCustodyType = type;
  ['a', 'b', 'split'].forEach(t => {
    const btn = document.getElementById('pb-' + t);
    if (btn) btn.className = 'parent-btn' + (t === type ? ' sel-' + t : '');
  });
  const sf = document.getElementById('split-fields');
  if (sf) sf.style.display = (type === 'split') ? 'block' : 'none';
}

function selectSplitFrom(who) {
  currentSplitFrom = who;
  ['a', 'b'].forEach(t => {
    const btn = document.getElementById('pb-from-' + t);
    if (btn) btn.className = 'parent-btn' + (t === who ? ' sel-' + t : '');
  });
}

// Wybór oceny 1–6
function selectGrade(g) {
  currentGrade = g;
  [1, 2, 3, 4, 5, 6].forEach(n => {
    const btn = document.getElementById('gb-' + n);
    if (btn) btn.style.opacity = (n === g) ? '1' : '0.3';
  });
}

function toggleRecurring() {
  const cb    = document.getElementById('f-recurring');
  if (!cb) return;
  cb.checked  = !cb.checked;
  const track = document.getElementById('tog-track');
  const row   = document.getElementById('recurring-row');
  const flds  = document.getElementById('recurring-fields');
  if (cb.checked) {
    track && track.classList.add('on');
    row   && row.classList.add('on');
    flds  && (flds.style.display = 'block');
  } else {
    track && track.classList.remove('on');
    row   && row.classList.remove('on');
    flds  && (flds.style.display = 'none');
  }
}

// Zamknięcie formularza
function closeFormModal(e) {
  if (e.target === document.getElementById('form-modal')) {
    document.getElementById('form-modal').classList.remove('open');
  }
}

function closeFormModalDirect() {
  document.getElementById('form-modal').classList.remove('open');
  const btn = document.getElementById('btn-save');
  btn.disabled = false;
  btn.textContent = 'Zapisz';
}

// ============================================================
//  CUSTOM CONFIRM DIALOG
// ============================================================
function showConfirmDialog(title, msg, buttons) {
  document.getElementById('confirm-title').textContent = title;
  const msgEl = document.getElementById('confirm-msg');
  if (msg) { msgEl.textContent = msg; msgEl.style.display = 'block'; }
  else      { msgEl.style.display = 'none'; }
  const actionsEl = document.getElementById('confirm-actions');
  actionsEl.innerHTML = '';
  buttons.forEach(btn => {
    const el = document.createElement('button');
    el.textContent = btn.label;
    el.className   = btn.cls || 'btn-cancel';
    if (btn.style) el.style.cssText = btn.style;
    el.style.width = '100%';
    el.onclick = () => { closeConfirmDialog(); if (btn.action) btn.action(); };
    actionsEl.appendChild(el);
  });
  document.getElementById('confirm-modal').classList.add('open');
}

function closeConfirmDialog(e) {
  if (!e || e.target === document.getElementById('confirm-modal')) {
    document.getElementById('confirm-modal').classList.remove('open');
  }
}

// Zapis do Firebase
async function submitForm() {
  const saveBtn = document.getElementById('btn-save');
  const errorEl = document.getElementById('form-error');
  errorEl.textContent = '';
  saveBtn.textContent = 'Zapisuję…';
  saveBtn.disabled    = true;

  try {
    const familyRef = db.collection('families').doc(familyId);

    if (currentFormType === 'custody') {
      const date = document.getElementById('f-date').value;
      if (!date)               throw new Error('Wybierz datę');
      if (!currentCustodyType) throw new Error('Wybierz kto sprawuje opiekę');

      const data = { type: currentCustodyType };
      if (currentCustodyType === 'split') {
        data.split_time = document.getElementById('f-split-time').value || '15:00';
        if (!currentSplitFrom) throw new Error('Wybierz kto ma dziecko rano');
        data.split_from = currentSplitFrom;
      }
      await familyRef.collection('custody').doc(date).set(data);
      // Natychmiast aktualizuj cache — Firestore query cache może być nieaktualne
      custodyCache[date] = data.type;
      custodyDetailsCache[date] = { ...data };

    } else if (currentFormType === 'grade') {
      const subject = document.getElementById('f-subject').value.trim();
      if (!subject)      throw new Error('Wpisz nazwę przedmiotu');
      if (!currentGrade) throw new Error('Wybierz ocenę (1–6)');
      const date = document.getElementById('f-date').value;
      if (!date)         throw new Error('Wybierz datę');

      await familyRef.collection('grades').add({
        subject,
        grade:      currentGrade,
        grade_type: document.getElementById('f-grade-type').value,
        date,
        notes:      document.getElementById('f-notes').value.trim() || null,
        created_at: firebase.firestore.FieldValue.serverTimestamp()
      });

    } else if (currentFormType === 'contest') {
      const name = document.getElementById('f-name').value.trim();
      if (!name) throw new Error('Wpisz nazwę konkursu');
      const date = document.getElementById('f-date').value;
      if (!date) throw new Error('Wybierz datę');

      const cTimeEl    = document.getElementById('f-time');
      const cTimeEndEl = document.getElementById('f-time-end');
      const contestData = {
        name,
        date,
        time:     cTimeEl    ? cTimeEl.value    || null : null,
        timeEnd:  cTimeEndEl ? cTimeEndEl.value || null : null,
        location: document.getElementById('f-location').value.trim() || '',
        notes:    document.getElementById('f-notes').value.trim() || null,
        result:   null,
        created_at: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (editMode && editDocId) {
        await familyRef.collection('contests').doc(editDocId).update(contestData);
        notifyTelegram({ ...contestData, title: name, category: 'konkurs' }, 'edit');
      } else {
        await familyRef.collection('contests').add(contestData);
        notifyN8n({ ...contestData, title: name, category: 'konkurs' });
        notifyTelegram({ ...contestData, title: name, category: 'konkurs' }, 'add');
        // Automatycznie utwórz wpis w Wynikach (wynik do uzupełnienia później)
        await familyRef.collection('results').add({
          title: name, date: contestData.date,
          place: null, points: null, notes: null,
          created_at: firebase.firestore.FieldValue.serverTimestamp()
        });
      }

    } else {
      // Wszystkie typy wydarzeń
      const categoryMap = {
        chess:        'szachy',
        exam:         'sprawdzian',
        orthodontist: 'ortodonta',
        other:        'inne'
      };
      const title = document.getElementById('f-title').value.trim();
      if (!title) throw new Error('Wpisz tytuł');
      const date = document.getElementById('f-date').value;
      if (!date)  throw new Error('Wybierz datę');
      const locEl  = document.getElementById('f-location');
      const timeEl = document.getElementById('f-time');

      const timeEndEl = document.getElementById('f-time-end');
      const evData = {
        title,
        date,
        time:     timeEl    ? timeEl.value    || null : null,
        timeEnd:  timeEndEl ? timeEndEl.value || null : null,
        category: categoryMap[currentFormType] || 'inne',
        location: locEl  ? locEl.value.trim() || null : null,
        notes:    document.getElementById('f-notes').value.trim() || null,
      };
      if (editMode && editDocId) {
        if (editSeriesId) {
          // Aktualizuj całą serię (wszystkie wpisy z tym seriesId, bez zmiany dat)
          const seriesSnap = await familyRef.collection('events')
            .where('seriesId', '==', editSeriesId).get();
          const batch = db.batch();
          const upd = { title: evData.title, time: evData.time, timeEnd: evData.timeEnd,
                        category: evData.category, location: evData.location, notes: evData.notes };
          seriesSnap.forEach(doc => batch.update(doc.ref, upd));
          await batch.commit();
          notifyTelegram({ ...evData, title: `${evData.title} (cała seria)` }, 'edit');
        } else {
          await familyRef.collection('events').doc(editDocId).update(evData);
          notifyTelegram(evData, 'edit');
        }
      } else {
        // Sprawdź czy cykliczne
        const isRecurring = document.getElementById('f-recurring')?.checked;
        const untilStr    = document.getElementById('f-recurring-until')?.value;
        if (isRecurring && untilStr) {
          const seriesId  = generateSeriesId();
          const startDate = new Date(evData.date + 'T12:00:00');
          const untilDate = new Date(untilStr + 'T12:00:00');
          if (untilDate < startDate) throw new Error('Data końcowa musi być późniejsza niż startowa');
          const batch = db.batch();
          let cur = new Date(startDate), count = 0;
          while (cur <= untilDate && count < 52) {
            const ref = familyRef.collection('events').doc();
            batch.set(ref, { ...evData, date: formatDateObj(cur), seriesId,
                             created_by: 'a', created_at: firebase.firestore.FieldValue.serverTimestamp() });
            cur.setDate(cur.getDate() + 7);
            count++;
          }
          await batch.commit();
          notifyTelegram({ ...evData, title: `${evData.title} (seria ×${count})` });
        } else {
          const newRef = await familyRef.collection('events').add({
            ...evData, created_by: 'a', created_at: firebase.firestore.FieldValue.serverTimestamp()
          });
          if (!eventsCache[evData.date]) eventsCache[evData.date] = [];
          eventsCache[evData.date].push({ ...evData, id: newRef.id });
          notifyN8n(evData);
          notifyTelegram(evData);
        }
      }
    }

    // Sukces — zamknij i odśwież widoki
    vib(30); // wibracja przy zapisie
    closeFormModalDirect();
    renderCalendar();
    if (currentFormType === 'grade')   renderGrades();
    if (currentFormType === 'contest') renderContests();
    updateBadges();
    if (['event','visit','barber','activity','birthday','trip'].includes(currentFormType)) {
      renderEvents();
    }

  } catch (err) {
    errorEl.textContent = err.message || 'Błąd zapisu — sprawdź połączenie.';
    saveBtn.textContent = 'Zapisz';
    saveBtn.disabled    = false;
  }
}

// ============================================================
//  OCENY (pełna implementacja w kroku 7)
// ============================================================
function renderGrades() {
  if (!db || !familyId) return;

  db.collection('families').doc(familyId)
    .collection('grades')
    .orderBy('date', 'desc')
    .get()
    .then(snapshot => {
      if (snapshot.empty) return; // zostaje empty state

      // Grupuj oceny po przedmiocie
      const bySubject = {};
      snapshot.forEach(doc => {
        const g = { ...doc.data(), id: doc.id };
        if (!bySubject[g.subject]) bySubject[g.subject] = [];
        bySubject[g.subject].push(g);
      });

      // Oblicz średnią ogólną
      const allGrades  = snapshot.docs.map(d => d.data().grade);
      const overall    = (allGrades.reduce((a, b) => a + b, 0) / allGrades.length).toFixed(1);
      const avgDisplay = document.getElementById('grades-avg-display');
      if (avgDisplay) avgDisplay.textContent = overall.replace('.', ',');

      // Renderuj karty przedmiotów
      const list = document.getElementById('grades-list');
      list.innerHTML = '';
      Object.entries(bySubject).forEach(([subject, grades]) => {
        const avg = (grades.reduce((a, g) => a + g.grade, 0) / grades.length).toFixed(1);
        const chipsHtml = grades.map(g => `
          <div>
            <div class="grade-chip grade-${g.grade}">${g.grade}</div>
            <div class="grade-label">${shortGradeType(g.grade_type)}</div>
          </div>`).join('');

        list.innerHTML += `
          <div class="subject-card">
            <div class="subject-header">
              <div class="subject-name">${escHtml(subject)}</div>
              <div class="subject-avg">${avg.replace('.', ',')}</div>
            </div>
            <div class="grades-row">${chipsHtml}</div>
          </div>`;
      });
    })
    .catch(err => console.error('renderGrades error:', err));
}

function shortGradeType(type) {
  const map = {
    sprawdzian: 'spr.', kartkówka: 'kart.', odpowiedź: 'odp.',
    projekt: 'proj.', inne: 'inne'
  };
  return map[type] || type || '';
}

// ============================================================
//  KONKURSY (pełna implementacja w kroku 8)
// ============================================================
function renderContests() {
  if (!db || !familyId) return;

  const today = formatDateObj(new Date());

  db.collection('families').doc(familyId)
    .collection('contests')
    .orderBy('date')
    .get()
    .then(snapshot => {
      if (snapshot.empty) return;

      const upcoming = [], history = [];
      snapshot.forEach(doc => {
        const c = { ...doc.data(), id: doc.id };
        (c.date >= today ? upcoming : history).push(c);
      });

      const list = document.getElementById('contests-list');
      list.innerHTML = '';

      if (upcoming.length > 0) {
        list.innerHTML += `<div class="section-label">Nadchodzące</div>`;
        upcoming.forEach(c => list.innerHTML += renderContestCard(c, false));
      }

      if (history.length > 0) {
        list.innerHTML += `<div class="section-label" style="margin-top:14px">Historia</div>`;
        history.forEach(c => list.innerHTML += renderContestCard(c, true));
      }
    })
    .catch(err => console.error('renderContests error:', err));
}

function renderContestCard(c, past) {
  const d   = new Date(c.date + 'T12:00:00');
  const day = d.getDate();
  const mon = MONTH_NAMES_SHORT[d.getMonth()].toUpperCase();
  const resultHtml = c.result
    ? `<div class="contest-result">${escHtml(c.result)}</div>`
    : `<div class="contest-result pending">—</div>`;
  const boxClass = past ? 'contest-date-box past' : 'contest-date-box';
  return `
    <div class="contest-card">
      <div class="${boxClass}">
        <div class="contest-day">${day}</div>
        <div class="contest-mon">${mon}</div>
      </div>
      <div class="contest-info">
        <div class="contest-name">${escHtml(c.name)}</div>
        <div class="contest-meta">📍 ${escHtml(c.location || '—')}${c.notes ? ' • ' + escHtml(c.notes) : ''}</div>
      </div>
      ${resultHtml}
    </div>`;
}

// ============================================================
//  WYDARZENIA (pełna implementacja w kroku 9)
// ============================================================
let activeFilter = 'all';
let eventsListMap = {}; // id → ev — do openEventDetail

function openEventDetail(evId) {
  const ev = eventsListMap[evId];
  if (!ev) return;
  selectedDate = ev.date;

  const date   = new Date(ev.date + 'T12:00:00');
  const dow    = DOW_NAMES[date.getDay()];
  const dayNum = date.getDate();
  const mon    = MONTH_NAMES_SHORT[date.getMonth()];
  document.getElementById('popup-date-title').textContent = `📅 ${dow}, ${dayNum} ${mon}`;

  const { icon } = getCategoryDisplay(ev.category);
  const timeStr  = ev.time ? ev.time : 'cały dzień';
  const locStr   = ev.location ? ` • ${escHtml(ev.location)}` : '';
  const notesHtml = ev.notes
    ? `<div class="event-time" style="margin-top:4px;font-style:italic">${escHtml(ev.notes)}</div>` : '';

  document.getElementById('popup-content').innerHTML = `
    <div class="event-item" style="margin-bottom:8px">
      <div class="event-icon">${icon}</div>
      <div class="event-info">
        <div class="event-name">${escHtml(ev.title)}</div>
        <div class="event-time">${timeStr}${locStr}</div>
        ${notesHtml}
      </div>
      <button class="del-btn" onclick="editEntry('${ev._col || 'event'}','${ev.id}')" title="Edytuj">✏️</button>
      <button class="del-btn" onclick="deleteEntry('${ev._col || 'event'}','${ev.id}','${ev.seriesId||''}')" title="Usuń">🗑</button>
    </div>`;
  document.getElementById('day-popup').classList.add('open');
}

function filterEvents(el, category) {
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  activeFilter = category;
  renderEvents();
}

function renderEvents() {
  if (!db || !familyId) return;

  const filterMap = {
    chess:        ['szachy'],
    exam:         ['sprawdzian'],
    orthodontist: ['ortodonta'],
    contest:      ['konkurs'],
    other:        ['inne'],
  };

  const list = document.getElementById('events-list');
  list.innerHTML = '<div class="empty-state"><div class="es-icon">⏳</div><p>Ładowanie...</p></div>';

  const familyRef  = db.collection('families').doc(familyId);
  const categories = filterMap[activeFilter] || null;

  // Pobierz events i contests równolegle
  Promise.all([
    familyRef.collection('events').orderBy('date').get(),
    familyRef.collection('contests').orderBy('date').get()
  ])
  .then(([evSnap, conSnap]) => {
    const all = [];
    evSnap.forEach(doc  => all.push({ ...doc.data(), id: doc.id, _col: 'event' }));
    conSnap.forEach(doc => all.push({ ...doc.data(), id: doc.id, _col: 'contest',
                                      title: doc.data().name || doc.data().title || '',
                                      category: 'konkurs' }));

    // Filtruj i sortuj po dacie
    const filtered = all
      .filter(ev => !categories || categories.includes(ev.category))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (filtered.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="es-icon">📋</div><p>Brak wydarzeń w tej kategorii.</p></div>`;
      return;
    }

    // Grupuj po miesiącu
    const byMonth = {};
    filtered.forEach(ev => {
      const ym = ev.date.substring(0, 7);
      if (!byMonth[ym]) byMonth[ym] = [];
      byMonth[ym].push(ev);
    });

    eventsListMap = {};
    list.innerHTML = '';

    // Delegacja zdarzeń — niezawodna na mobile
    list.onclick = e => {
      const card = e.target.closest('.ev-card');
      if (card) openEventDetail(card.dataset.evid);
    };

    Object.entries(byMonth).forEach(([ym, events]) => {
      const [y, m] = ym.split('-');
      const label = document.createElement('div');
      label.className = 'events-month-label';
      label.textContent = `${MONTH_NAMES[parseInt(m) - 1]} ${y}`;
      list.appendChild(label);

      events.forEach(ev => {
        eventsListMap[ev.id] = ev;
        const d    = new Date(ev.date + 'T12:00:00');
        const day  = d.getDate();
        const dow  = ['ND','PN','WT','ŚR','CZ','PT','SB'][d.getDay()];
        const { icon, tagClass, tagName } = getCategoryDisplay(ev.category);
        const timeStr = ev.time ? `🕐 ${ev.time}` : '';
        const locStr  = ev.location ? ` • ${escHtml(ev.location)}` : '';
        const card = document.createElement('div');
        card.className = 'ev-card';
        card.dataset.evid = ev.id;
        card.innerHTML = `
          <div class="ev-left">
            <div class="ev-day">${day}</div>
            <div class="ev-dow">${dow}</div>
          </div>
          <div class="ev-divider"></div>
          <div class="ev-content">
            <div class="ev-title">${escHtml(ev.title)}</div>
            <div class="ev-meta">${timeStr}${locStr}</div>
            <span class="ev-tag ${tagClass}">${tagName}</span>
          </div>
          <div class="ev-badge">${icon}</div>`;
        list.appendChild(card);
      });
    });
  })
  .catch(err => console.error('renderEvents error:', err));
}

// ============================================================
//  ZADANIA (TO DO)
// ============================================================

let tasksMap = {};

function renderTasks() {
  if (!db || !familyId) return;
  const list = document.getElementById('todo-list');
  if (!list) return;
  list.innerHTML = '<div class="empty-state"><div class="es-icon">⏳</div><p>Ładowanie...</p></div>';

  db.collection('families').doc(familyId)
    .collection('tasks')
    .orderBy('createdAt', 'asc')
    .get()
    .then(snapshot => {
      const now = Date.now();
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      const tasks = { new: [], in_progress: [], done: [] };
      tasksMap = {};

      snapshot.forEach(doc => {
        const task = { ...doc.data(), id: doc.id };
        // Auto-usuń zadania "Zrobione" starsze niż 7 dni
        if (task.status === 'done' && task.doneAt) {
          const doneMs = task.doneAt.toMillis ? task.doneAt.toMillis() : (task.doneAt * 1000);
          if (now - doneMs > SEVEN_DAYS) {
            db.collection('families').doc(familyId).collection('tasks').doc(doc.id).delete();
            return;
          }
        }
        tasksMap[task.id] = task;
        const s = task.status || 'new';
        if (tasks[s]) tasks[s].push(task); else tasks.new.push(task);
      });

      const total = tasks.new.length + tasks.in_progress.length + tasks.done.length;
      if (total === 0) {
        list.innerHTML = `<div class="empty-state"><div class="es-icon">✅</div><p>Brak zadań.<br>Dodaj pierwsze zadanie przyciskiem +</p></div>`;
        return;
      }

      list.innerHTML = '';
      const sections = [
        { key: 'new',         label: 'Nowe',      dotClass: 'dot-new',      arr: tasks.new },
        { key: 'in_progress', label: 'W trakcie', dotClass: 'dot-progress', arr: tasks.in_progress },
        { key: 'done',        label: 'Zrobione',  dotClass: 'dot-done',     arr: tasks.done },
      ];

      sections.forEach(({ key, label, dotClass, arr }) => {
        if (!arr.length) return;
        list.innerHTML += `
          <div class="todo-section-header">
            <div class="todo-section-dot ${dotClass}"></div>
            ${label} <span style="opacity:0.5;font-weight:400;margin-left:4px;">(${arr.length})</span>
          </div>`;
        arr.forEach(task => {
          const checkMark = key === 'done' ? '✓' : '';
          const assigneeLabel = { mama: 'Mama', tata: 'Tata', both: 'Oboje' }[task.assignee] || 'Oboje';
          const chipClass     = { mama: 'chip-mama', tata: 'chip-tata', both: 'chip-both' }[task.assignee] || 'chip-both';
          const dueStr  = task.dueDate ? `📅 do ${formatDisplayDate(task.dueDate)}` : '';
          const noteStr = task.notes ? escHtml(task.notes.substring(0, 40)) : '';
          const meta    = [dueStr, noteStr].filter(Boolean).join(' · ');
          const doneClass = key === 'done' ? 'done-card' : '';
          list.innerHTML += `
            <div class="todo-card ${doneClass}" onclick="openTaskDetail('${task.id}')">
              <div class="todo-status-circle status-${key}">${checkMark}</div>
              <div class="todo-content">
                <div class="todo-title">${escHtml(task.title)}</div>
                ${meta ? `<div class="todo-meta">${meta}</div>` : ''}
              </div>
              <div class="assignee-chip ${chipClass}">${assigneeLabel}</div>
            </div>`;
        });
      });
    })
    .catch(err => console.error('renderTasks error:', err));
}

function openTaskDetail(id) {
  const task = tasksMap[id];
  if (!task) return;

  const assigneeLabel = { mama: 'Mama', tata: 'Tata', both: 'Oboje' }[task.assignee] || 'Oboje';
  const dueStr  = task.dueDate ? `📅 do ${formatDisplayDate(task.dueDate)}` : '';

  const statusDefs = [
    { key: 'new',         lbl: '🔵 Nowe' },
    { key: 'in_progress', lbl: '🟡 W trakcie' },
    { key: 'done',        lbl: '✅ Zrobione' },
  ];
  const statusBtns = statusDefs.map(({ key, lbl }) => {
    const isActive = (task.status || 'new') === key;
    const cls = isActive ? 'task-status-btn active-status' : 'task-status-btn';
    return `<button class="${cls}" onclick="updateTaskStatus('${id}','${key}')">${lbl}</button>`;
  }).join('');

  document.getElementById('popup-date-title').textContent = '☑️ Zadanie';
  document.getElementById('popup-content').innerHTML = `
    <div style="margin-bottom:14px;">
      <div style="font-size:16px;font-weight:700;color:var(--navy);margin-bottom:5px;">${escHtml(task.title)}</div>
      ${dueStr  ? `<div style="font-size:12px;color:var(--text-light);margin-bottom:3px;">${dueStr}</div>` : ''}
      ${task.notes ? `<div style="font-size:12px;color:var(--text-light);margin-bottom:3px;">${escHtml(task.notes)}</div>` : ''}
      <div style="font-size:12px;color:var(--text-light);">👤 ${assigneeLabel}</div>
    </div>
    <div style="font-size:10px;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px;">Zmień status</div>
    <div class="task-status-row">${statusBtns}</div>
    <div style="display:flex;gap:8px;margin-top:14px;">
      <button class="del-btn" style="flex:1;justify-content:center;" onclick="editTask('${id}')">✏️ Edytuj</button>
      <button class="del-btn" style="flex:1;justify-content:center;" onclick="deleteTask('${id}')">🗑 Usuń</button>
    </div>`;
  document.getElementById('day-popup').classList.add('open');
}

function updateTaskStatus(id, status) {
  if (!db || !familyId) return;
  vib(status === 'done' ? [20, 30, 60] : 25);
  const data = { status };
  if (status === 'done') data.doneAt = firebase.firestore.FieldValue.serverTimestamp();
  db.collection('families').doc(familyId).collection('tasks').doc(id)
    .update(data)
    .then(() => { closeDayPopupDirect(); renderTasks(); })
    .catch(err => alert('Błąd: ' + err.message));
}

function deleteTask(id) {
  showConfirmDialog('Usunąć zadanie?', '', [
    { label: 'Anuluj', cls: 'btn-cancel', action: () => {} },
    { label: 'Usuń',   cls: 'btn-danger', action: () => {
      vib([30,50,80]);
      db.collection('families').doc(familyId).collection('tasks').doc(id)
        .delete()
        .then(() => { closeDayPopupDirect(); renderTasks(); updateBadges(); })
        .catch(err => alert('Błąd: ' + err.message));
    }}
  ]);
}

function editTask(id) {
  const task = tasksMap[id];
  if (!task) return;
  closeDayPopupDirect();
  openTaskForm(task);
}

function openTaskForm(existingTask = null) {
  editMode   = !!existingTask;
  editDocId  = existingTask ? existingTask.id : null;
  currentFormType = 'task';
  document.getElementById('form-title').textContent = existingTask ? 'Edytuj zadanie' : 'Nowe zadanie';
  document.getElementById('form-body').innerHTML    = buildTaskFormHtml(existingTask);
  document.getElementById('form-error').textContent = '';
  const taskBtn = document.getElementById('btn-save');
  taskBtn.onclick   = submitTaskForm;
  taskBtn.disabled  = false;
  taskBtn.textContent = 'Zapisz';
  document.getElementById('form-modal').classList.add('open');
}

function buildTaskFormHtml(task) {
  const title    = task ? escHtml(task.title)         : '';
  const notes    = task ? escHtml(task.notes    || '') : '';
  const dueDate  = task ? (task.dueDate         || '') : '';
  const assignee = task ? (task.assignee        || 'both') : 'both';
  const selBtn = (val) => assignee === val ? 'active' : '';
  return `
    <div class="form-group">
      <label class="form-label">Nazwa zadania *</label>
      <input class="form-input" id="task-title" placeholder="np. Zapisać do dentysty" value="${title}">
    </div>
    <div class="form-group">
      <label class="form-label">Kto odpowiada</label>
      <div class="parent-btns">
        <button type="button" class="parent-btn ${selBtn('tata')}" onclick="selectTaskAssignee(this,'tata')">Tata</button>
        <button type="button" class="parent-btn ${selBtn('mama')}" onclick="selectTaskAssignee(this,'mama')">Mama</button>
        <button type="button" class="parent-btn ${selBtn('both')}" onclick="selectTaskAssignee(this,'both')">Oboje</button>
      </div>
      <input type="hidden" id="task-assignee" value="${assignee}">
    </div>
    <div class="form-group">
      <label class="form-label">Termin (opcjonalny)</label>
      <input class="form-input" type="date" id="task-due" value="${dueDate}">
    </div>
    <div class="form-group">
      <label class="form-label">Notatka (opcjonalna)</label>
      <input class="form-input" id="task-notes" placeholder="Dodatkowe info..." value="${notes}">
    </div>`;
}

function selectTaskAssignee(btn, val) {
  btn.closest('.parent-btns').querySelectorAll('.parent-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('task-assignee').value = val;
}

async function submitTaskForm() {
  const title    = document.getElementById('task-title').value.trim();
  const assignee = document.getElementById('task-assignee').value;
  const dueDate  = document.getElementById('task-due').value;
  const notes    = document.getElementById('task-notes').value.trim();

  if (!title) {
    document.getElementById('form-error').textContent = 'Podaj nazwę zadania.';
    return;
  }
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  try {
    const ref = db.collection('families').doc(familyId).collection('tasks');
    if (editMode && editDocId) {
      await ref.doc(editDocId).update({ title, assignee, dueDate: dueDate || '', notes: notes || '' });
    } else {
      await ref.add({
        title, assignee,
        dueDate: dueDate || '',
        notes:   notes   || '',
        status:  'new',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    closeFormModalDirect();
    renderTasks();
    updateBadges();
  } catch (err) {
    document.getElementById('form-error').textContent = 'Błąd: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  const months = ['sty','lut','mar','kwi','maj','cze','lip','sie','wrz','paź','lis','gru'];
  return `${parseInt(parts[2])} ${months[parseInt(parts[1]) - 1]}`;
}

// ============================================================
//  POMOCNICZE
// ============================================================

// Formatuj datę jako 'YYYY-MM-DD'
function formatDate(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function formatDateObj(date) {
  return formatDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

// Zwróć tablicę 7 obiektów Date (Pn–Nd) dla tygodnia
function getWeekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });
}

// Znajdź poniedziałek danego tygodnia
function getMondayOf(date) {
  const d   = new Date(date);
  const day = d.getDay(); // 0=Nd
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Uciekaj HTML (zapobieganie XSS przy wyświetlaniu danych z Firebase)
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Definicje kategorii — emoji, klasa tagu, etykieta
function getCategoryDisplay(category) {
  const map = {
    'szachy':      { icon: '♟️',  tagClass: 'tag-chess',  tagName: 'SZACHY'     },
    'sprawdzian':  { icon: '📝',  tagClass: 'tag-school', tagName: 'SPRAWDZIAN' },
    'ortodonta':   { icon: '🦷',  tagClass: 'tag-school', tagName: 'ORTODONTA'  },
    'konkurs':     { icon: '🏆',  tagClass: 'tag-event',  tagName: 'KONKURS'    },
    'inne':        { icon: '📌',  tagClass: 'tag-tata',   tagName: 'INNE'       },
    // zachowane dla wstecznej zgodności
    'zajęcia':    { icon: '♟️',  tagClass: 'tag-chess',  tagName: 'ZAJĘCIA'    },
    'ortodonta':  { icon: '🦷',  tagClass: 'tag-school', tagName: 'ORTODONTA'  },
    'lekarz':     { icon: '👨‍⚕️', tagClass: 'tag-school', tagName: 'LEKARZ'     },
    'fryzjer':    { icon: '✂️',  tagClass: 'tag-tata',   tagName: 'FRYZJER'    },
    'urodziny':   { icon: '🎂',  tagClass: 'tag-mama',   tagName: 'URODZINY'   },
    'wydarzenie': { icon: '🎉',  tagClass: 'tag-event',  tagName: 'WYDARZENIE' },
    'wycieczka':  { icon: '🚌',  tagClass: 'tag-event',  tagName: 'WYCIECZKA'  },
    'wizyta':     { icon: '🏥',  tagClass: 'tag-school', tagName: 'WIZYTA'     },
    'szkoła':     { icon: '📝',  tagClass: 'tag-school', tagName: 'SZKOŁA'     },
    'wyjazd':     { icon: '✈️',  tagClass: 'tag-event',  tagName: 'WYJAZD'     },
  };
  return map[category] || { icon: '📌', tagClass: 'tag-school', tagName: 'INNE' };
}

// Klasa CSS dla kropki w widoku tygodniowym
function getEventWeekClass(category) {
  const map = {
    'zajęcia': 'mint-ev', 'szkoła': 'red-ev', 'ortodonta': 'red-ev',
    'lekarz':  'red-ev',  'wizyta': 'red-ev',  'wydarzenie': 'orange-ev',
    'wycieczka': 'orange-ev', 'wyjazd': 'orange-ev', 'urodziny': 'orange-ev',
  };
  return map[category] || 'mint-ev';
}

// Klasa kropki na siatce miesięcznej
function getCategoryDotClass(category) {
  const map = {
    'szachy':     'mint',   'sprawdzian': 'red',    'ortodonta': 'red',
    'konkurs':    'orange', 'inne':       'gray',
    // wsteczna zgodność
    'zajęcia': 'mint', 'wydarzenie': 'orange', 'wizyta': 'red',
    'urodziny': 'purple', 'wyjazd': 'orange',
  };
  return map[category] || 'gray';
}

// ============================================================
//  WYNIKI
// ============================================================
let resultsMap = {}; // id → result

function medalEmoji(place) {
  if (!place) return '🏅';
  const p = place.toLowerCase();
  if (p.includes('1') || p.includes('złot') || p.includes('pierwsze')) return '🥇';
  if (p.includes('2') || p.includes('srebrn') || p.includes('drugie'))  return '🥈';
  if (p.includes('3') || p.includes('brąz')  || p.includes('trzecie'))  return '🥉';
  if (p.includes('wyróżn'))                                               return '🌟';
  return '🏅';
}

function openResultForm(existingResult = null) {
  const isEdit  = !!existingResult;
  const date    = existingResult ? existingResult.date  : (selectedDate || formatDateObj(new Date()));
  const title   = existingResult ? escHtml(existingResult.title  || '') : '';
  const place   = existingResult ? escHtml(existingResult.place  || '') : '';
  const points  = existingResult ? escHtml(existingResult.points || '') : '';
  const notes   = existingResult ? escHtml(existingResult.notes  || '') : '';

  document.getElementById('form-title').textContent = isEdit ? 'Edytuj wynik' : 'Dodaj wynik';
  document.getElementById('form-body').innerHTML = `
    <div class="form-group">
      <label class="form-label">Nazwa wydarzenia</label>
      <input type="text" class="form-input" id="r-title" placeholder="np. Konkurs matematyczny Kangur" value="${title}" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label">Data</label>
      <input type="date" class="form-input" id="r-date" value="${date}">
    </div>
    <div class="form-group">
      <label class="form-label">Wynik / Miejsce</label>
      <input type="text" class="form-input" id="r-place" placeholder="np. 1 miejsce, Wyróżnienie, Finalista" value="${place}" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label">Punkty (opcjonalnie)</label>
      <input type="text" class="form-input" id="r-points" placeholder="np. 31/35, 95%, 4:52" value="${points}" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label">Notatka (opcjonalnie)</label>
      <textarea class="form-input" id="r-notes" rows="2" placeholder="Dodatkowe informacje...">${notes}</textarea>
    </div>`;
  document.getElementById('form-error').textContent = '';

  const btn = document.getElementById('btn-save');
  btn.textContent = isEdit ? 'Zaktualizuj' : 'Zapisz';
  btn.disabled = false;
  btn.onclick = () => submitResultForm(isEdit ? existingResult.id : null);

  document.getElementById('modal').classList.remove('open');
  document.getElementById('form-modal').classList.add('open');
}

async function submitResultForm(editId = null) {
  const btn    = document.getElementById('btn-save');
  const errEl  = document.getElementById('form-error');
  const title  = document.getElementById('r-title').value.trim();
  const date   = document.getElementById('r-date').value;
  const place  = document.getElementById('r-place').value.trim();
  const points = document.getElementById('r-points').value.trim();
  const notes  = document.getElementById('r-notes').value.trim();

  if (!title) { errEl.textContent = 'Podaj nazwę wydarzenia.'; return; }
  if (!date)  { errEl.textContent = 'Wybierz datę.';          return; }

  btn.textContent = 'Zapisuję…'; btn.disabled = true;
  const data = { title, date, place, points: points || null, notes: notes || null };

  try {
    const col = db.collection('families').doc(familyId).collection('results');
    if (editId) {
      await col.doc(editId).update(data);
    } else {
      data.created_at = firebase.firestore.FieldValue.serverTimestamp();
      await col.add(data);
      notifyTelegram({ ...data, category: 'wynik' }, 'new');
    }
    closeFormModalDirect();
    renderResults();
    updateBadges();
  } catch (err) {
    errEl.textContent = 'Błąd: ' + err.message;
    btn.textContent = 'Zapisz'; btn.disabled = false;
  }
}

function deleteResult(id) {
  showConfirmDialog('Usunąć wynik?', '', [
    { label: 'Anuluj', cls: 'btn-cancel', action: () => {} },
    { label: 'Usuń',   cls: 'btn-danger', action: async () => {
      vib([30,50,80]);
      try {
        await db.collection('families').doc(familyId).collection('results').doc(id).delete();
        closeDayPopupDirect();
        renderResults();
        updateBadges();
      } catch (err) { alert('Błąd: ' + err.message); }
    }}
  ]);
}

function openResultDetail(id) {
  const r = resultsMap[id];
  if (!r) return;
  const medal = medalEmoji(r.place);
  const d = new Date(r.date + 'T12:00:00');
  const dow = DOW_NAMES[d.getDay()];
  const mon = MONTH_NAMES_SHORT[d.getMonth()];
  document.getElementById('popup-date-title').textContent = `${medal} ${r.title}`;

  let html = `
    <div class="event-item" style="margin-bottom:8px">
      <div class="event-icon">${medal}</div>
      <div class="event-info">
        <div class="event-name">${escHtml(r.title)}</div>
        <div class="event-time">📅 ${dow}, ${d.getDate()} ${mon}</div>
        ${r.place  ? `<div class="event-time" style="margin-top:2px">🏆 ${escHtml(r.place)}</div>`  : ''}
        ${r.points ? `<div class="event-time" style="margin-top:2px">📊 ${escHtml(r.points)}</div>` : ''}
        ${r.notes  ? `<div class="event-time" style="margin-top:2px;font-style:italic">💬 ${escHtml(r.notes)}</div>` : ''}
      </div>
      <button class="del-btn" onclick="closePopupAndEdit('${id}')" title="Edytuj">✏️</button>
      <button class="del-btn" onclick="deleteResult('${id}')" title="Usuń">🗑</button>
    </div>`;
  document.getElementById('popup-content').innerHTML = html;
  document.getElementById('day-popup').classList.add('open');
}

function closePopupAndEdit(id) {
  closeDayPopupDirect();
  openResultForm(resultsMap[id]);
}

// ============================================================
//  TRYB CIEMNY
// ============================================================
function toggleDarkMode() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('darkMode', isDark ? '1' : '0');
  const btn = document.getElementById('dark-toggle');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
  vib(25);
}

// ============================================================
//  ODZNAKI (BADGES) — powiadomienia na ikonach nawigacji
// ============================================================
function updateBadges() {
  if (!db || !familyId) return;
  const familyRef = db.collection('families').doc(familyId);

  // Badge TODO: niezakończone zadania (Nowe + W trakcie)
  familyRef.collection('tasks')
    .where('status', 'in', ['new', 'in_progress'])
    .get()
    .then(snap => setBadge('todo', snap.size))
    .catch(() => {});

  // Badge WYNIKI: przeszłe konkursy (data < dziś) bez wpisanego miejsca
  const today = formatDateObj(new Date());
  familyRef.collection('results').get()
    .then(snap => {
      const pending = snap.docs.filter(d => {
        const r = d.data();
        return !r.place && r.date && r.date < today;
      }).length;
      setBadge('results', pending);
    })
    .catch(() => {});

  // Badge WYDARZENIA: nowe (dodane od ostatniej wizyty na ekranie)
  const lastSeen = parseInt(localStorage.getItem('lastSeen_' + familyId + '_events') || '0');
  familyRef.collection('events').get()
    .then(snap => {
      const newCount = snap.docs.filter(d => {
        const ca = d.data().created_at;
        if (!ca) return false;
        const ms = ca.toMillis ? ca.toMillis() : (ca.seconds * 1000);
        return ms > lastSeen;
      }).length;
      setBadge('events', newCount);
    })
    .catch(() => {});
}

function setBadge(screen, count) {
  const badge = document.getElementById('badge-' + screen);
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }
}

function markScreenSeen(name) {
  // Oznacz "events" jako widziane — zeruje badge nowych wydarzeń
  if (name === 'events') {
    localStorage.setItem('lastSeen_' + familyId + '_events', Date.now());
    setBadge('events', 0);
  }
  // Todo i wyniki mają badge statyczny (aktualna liczba) — nie zerujemy ręcznie
}

function renderResults() {
  if (!db || !familyId) return;
  const list = document.getElementById('results-list');
  if (!list) return;
  list.innerHTML = '<div class="empty-state"><div class="es-icon">⏳</div><p>Ładowanie...</p></div>';

  db.collection('families').doc(familyId).collection('results')
    .orderBy('date', 'desc').get()
    .then(snap => {
      resultsMap = {};
      if (snap.empty) {
        list.innerHTML = '<div class="empty-state"><div class="es-icon">🏅</div><p>Brak wyników. Dodaj pierwszy!</p></div>';
        return;
      }
      list.innerHTML = '';
      // Delegacja zdarzeń
      snap.forEach(doc => {
        const r = { ...doc.data(), id: doc.id };
        resultsMap[r.id] = r;
        const medal = medalEmoji(r.place);
        const d   = new Date(r.date + 'T12:00:00');
        const day = d.getDate();
        const mon = MONTH_NAMES_SHORT[d.getMonth()];
        const year = d.getFullYear();
        const card = document.createElement('div');
        card.className = 'result-card';
        card.innerHTML = `
          <div class="result-medal">${medal}</div>
          <div class="result-info">
            <div class="result-title">${escHtml(r.title)}</div>
            <div class="result-meta">${day} ${mon} ${year}</div>
          </div>
          <div class="result-badge">
            ${r.place  ? `<div class="result-place">${escHtml(r.place)}</div>`  : ''}
            ${r.points ? `<div class="result-pts">${escHtml(r.points)}</div>`   : ''}
          </div>`;
        card.addEventListener('click', () => openResultDetail(r.id));
        list.appendChild(card);
      });
    })
    .catch(err => console.error('renderResults error:', err));
}
