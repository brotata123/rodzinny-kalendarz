// ─── Firebase init ───────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore();

// ─── State ───────────────────────────────────────────────────
let currentCategory = null;  // selected category object
let currentTest = null;      // loaded test JSON
let answers = [];
let currentQ = 0;
let timerInterval = null;
let secondsLeft = 0;
let testFinished = false;

// ─── Zapis postępu (localStorage) ────────────────────────────
function saveKey(year) {
  const catId = currentCategory ? currentCategory.id : 'alfik4';
  return `testy_progress_${catId}_${year}`;
}

function saveProgress() {
  if (!currentTest || testFinished) return;
  const data = { year: currentTest.year, file: currentTest._file, answers, currentQ, secondsLeft, savedAt: Date.now() };
  localStorage.setItem(saveKey(currentTest.year), JSON.stringify(data));
}

function loadProgress(year) {
  try {
    const raw = localStorage.getItem(saveKey(year));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function clearProgress(year) {
  localStorage.removeItem(saveKey(year));
}

// ─── Helpers ─────────────────────────────────────────────────
function getFamilyId() {
  return window.location.hash.replace('#', '') || null;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

// ─── Ekran kategorii ─────────────────────────────────────────
async function loadCategories() {
  const grid = document.getElementById('category-grid');
  grid.innerHTML = '<p style="padding:20px;color:#9ca3af">Ładowanie…</p>';

  try {
    const resp = await fetch('data/categories.json?v=' + Date.now());
    const data = await resp.json();
    grid.innerHTML = '';

    data.categories.forEach(cat => {
      const card = document.createElement('div');
      card.className = 'category-card' + (cat.available ? '' : ' category-unavailable');
      card.style.setProperty('--cat-color', cat.color);
      card.innerHTML = `
        <div class="category-emoji">${cat.emoji}</div>
        <div class="category-info">
          <div class="category-name">${cat.name}</div>
          <div class="category-class">${cat.class}</div>
        </div>
        ${!cat.available ? '<div class="category-soon">Wkrótce</div>' : '<div class="category-arrow">→</div>'}
      `;
      if (cat.available) card.onclick = () => selectCategory(cat);
      grid.appendChild(card);
    });
  } catch (e) {
    grid.innerHTML = `<p style="padding:20px;color:red">Błąd: ${e.message}</p>`;
  }
}

function showCategories() {
  stopTimer();
  currentTest = null;
  currentCategory = null;
  testFinished = false;
  showScreen('screen-categories');
  loadCategories();
}

async function selectCategory(cat) {
  currentCategory = cat;
  document.getElementById('list-title').textContent = cat.name;
  document.getElementById('list-subtitle').textContent = cat.class;
  showScreen('screen-list');
  loadTestList();
}

// ─── Lista testów ─────────────────────────────────────────────
function showList() {
  stopTimer();
  currentTest = null;
  testFinished = false;
  if (currentCategory) {
    showScreen('screen-list');
    loadTestList();
  } else {
    showCategories();
  }
}

async function loadTestList() {
  const grid = document.getElementById('test-grid');
  grid.innerHTML = '<p style="padding:20px;color:#9ca3af">Ładowanie testów…</p>';

  if (!currentCategory) { showCategories(); return; }

  // Pobierz wyniki z Firestore (dla bieżącej kategorii)
  const doneMap = {};
  const familyId = getFamilyId();
  if (familyId) {
    try {
      const snap = await db.collection('families').doc(familyId).collection('tests')
        .where('category', '==', currentCategory.id)
        .get();
      // Fallback: jeśli brak wyników z filtrem category, pobierz bez filtru (stare wpisy alfik4)
      const docs = snap.docs.length > 0 ? snap.docs : (currentCategory.id === 'alfik4'
        ? (await db.collection('families').doc(familyId).collection('tests').get()).docs.filter(d => !d.data().category)
        : []);
      docs.forEach(doc => {
        const d = doc.data();
        if (!d.year) return;
        const key = String(d.year);
        if (!doneMap[key] || d.points > doneMap[key].points) {
          doneMap[key] = {
            points: d.points, maxPoints: d.maxPoints,
            tasks: d.tasks, maxTasks: d.maxTasks,
            createdAt: d.createdAt?.toDate ? d.createdAt.toDate() : null
          };
        }
      });
    } catch (e) {
      console.warn('Nie udało się pobrać wyników:', e.message);
    }
  }

  try {
    const resp = await fetch(currentCategory.folder + '/index.json?v=' + Date.now());
    const idx = await resp.json();
    grid.innerHTML = '';

    idx.tests.forEach(t => {
      const saved = loadProgress(t.year);
      const savedBadge = saved ? (() => {
        const d = new Date(saved.savedAt);
        const timeStr = d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' })
          + ' ' + d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
        const answered = saved.answers.filter(a => hasAnyAnswer(a)).length;
        const total = saved.answers.length;
        const m = Math.floor(saved.secondsLeft / 60);
        const s = String(saved.secondsLeft % 60).padStart(2, '0');
        return `<div class="saved-badge">▶ W toku — ${answered}/${total} odpowiedzi · pozostało ${m}:${s} · zapisano ${timeStr}</div>`;
      })() : '';

      const done = doneMap[String(t.year)];
      let doneBadge = '';
      if (done) {
        const pct = Math.round((done.points / done.maxPoints) * 100);
        const taskPct = done.maxTasks ? Math.round((done.tasks / done.maxTasks) * 100) : null;
        const scoreClass = p => p >= 75 ? 'score-hi' : p >= 50 ? 'score-mid' : 'score-lo';
        const colorClass = p => p >= 75 ? 'hi-color' : p >= 50 ? 'mid-color' : 'lo-color';
        const dateStr = done.createdAt
          ? done.createdAt.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })
          : '';
        doneBadge = `
          <div class="done-block">
            <div class="done-date">✓ Rozwiązano${dateStr ? ' · ' + dateStr : ''}</div>
            <div class="done-metrics">
              <div class="done-metric ${scoreClass(pct)}">
                <div class="done-metric-label">Punkty</div>
                <div class="done-metric-row">
                  <span class="done-metric-pct ${colorClass(pct)}">${pct}%</span>
                  <span class="done-metric-sub">${done.points} / ${done.maxPoints}</span>
                </div>
              </div>
              ${taskPct !== null ? `
              <div class="done-metric ${scoreClass(taskPct)}">
                <div class="done-metric-label">Zadania</div>
                <div class="done-metric-row">
                  <span class="done-metric-pct ${colorClass(taskPct)}">${taskPct}%</span>
                  <span class="done-metric-sub">${done.tasks} / ${done.maxTasks}</span>
                </div>
              </div>` : ''}
            </div>
          </div>`;
      }

      const card = document.createElement('div');
      card.className = 'test-card' + (saved ? ' has-progress' : '') + (done ? ' is-done' : '');
      card.innerHTML = `
        <div class="year">${t.year}</div>
        <div class="edition">${t.edition || ''}</div>
        <div class="meta">
          <span>📝 <strong>${t.totalQuestions}</strong> zadań</span>
          <span>🏆 max <strong>${t.maxPoints}</strong> pkt</span>
          <span>⏱ <strong>${t.timeMinutes || 75}</strong> min</span>
        </div>
        ${t.startingPoints ? `<div style="margin-top:8px;font-size:0.82rem;color:#92400e;background:#fef3c7;padding:4px 8px;border-radius:6px">+${t.startingPoints} pkt startowych</div>` : ''}
        ${doneBadge}
        ${savedBadge}
      `;
      card.onclick = () => loadTest(t.file);
      grid.appendChild(card);
    });
  } catch (e) {
    grid.innerHTML = `<p style="padding:20px;color:red">Błąd ładowania testów: ${e.message}</p>`;
  }
}

// ─── Load single test & show rules ───────────────────────────
async function loadTest(file) {
  try {
    const resp = await fetch(file + '?v=' + Date.now());
    currentTest = await resp.json();
    currentTest._file = file;
    const saved = loadProgress(currentTest.year);
    if (saved) showResumeModal(saved);
    else showRules();
  } catch (e) {
    alert('Nie udało się załadować testu: ' + e.message);
  }
}

function showResumeModal(saved) {
  const answered = saved.answers.filter(a => hasAnyAnswer(a)).length;
  const total = saved.answers.length;
  const m = Math.floor(saved.secondsLeft / 60);
  const s = String(saved.secondsLeft % 60).padStart(2, '0');
  const d = new Date(saved.savedAt);
  const timeStr = d.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' })
    + ' o ' + d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

  document.getElementById('resume-info').innerHTML =
    `Masz zapisany postęp: <strong>${answered} z ${total}</strong> pytań.<br>
     Pozostały czas: <strong>${m}:${s}</strong>.<br>
     Zapisano: ${timeStr}.`;
  document.getElementById('modal-resume').style.display = 'flex';
}

function resumeTest() {
  const saved = loadProgress(currentTest.year);
  document.getElementById('modal-resume').style.display = 'none';
  answers = saved.answers;
  currentQ = saved.currentQ;
  secondsLeft = saved.secondsLeft;
  testFinished = false;
  buildQuestionDots();
  renderQuestion();
  showScreen('screen-test');
  startTimer();
}

function restartTest() {
  document.getElementById('modal-resume').style.display = 'none';
  clearProgress(currentTest.year);
  showRules();
}

function closeResume(e) {
  if (e && e.target !== document.getElementById('modal-resume')) return;
  document.getElementById('modal-resume').style.display = 'none';
  showList();
}

function showRules() {
  const t = currentTest;
  document.getElementById('rules-title').textContent = t.name;

  // Dynamiczna treść zasad zależna od kategorii
  document.getElementById('rules-q-count').textContent = t.totalQuestions + ' zadań';
  document.getElementById('rules-time').textContent = (t.timeMinutes || 75) + ' minut';

  // Tabela punktacji z JSON testu (jeśli jest) lub domyślna
  const scoringEl = document.getElementById('rules-scoring');
  const isSzpakTest = t.questions && t.questions[0] && isSzpak(t.questions[0]);
  if (isSzpakTest) {
    document.getElementById('rules-list').innerHTML = `
      <li>Test zawiera <strong>${t.totalQuestions} zadań</strong>, każde z 4 stwierdzeniami (A, B, C, D)</li>
      <li>Każde stwierdzenie oceniasz <strong>niezależnie</strong>: PRAWDA lub FAŁSZ</li>
      <li>Łącznie ${t.totalQuestions * 4} decyzji do podjęcia</li>
      <li>Czas na rozwiązanie: <strong>${t.timeMinutes || 90} minut</strong></li>`;
    scoringEl.innerHTML = `
      <div class="score-row header"><span>Decyzja</span><span>Poprawna</span><span>Błędna</span><span>Brak</span></div>
      <div class="score-row"><span>każda (×${t.totalQuestions * 4})</span><span class="green">+1 pkt</span><span class="red">−1 pkt</span><span>0 pkt</span></div>`;
  } else if (t.scoringTable) {
    scoringEl.innerHTML = `
      <div class="score-row header"><span>Zadania</span><span>Poprawna</span><span>Błędna</span><span>Brak</span></div>
      ${t.scoringTable.map(row => `
        <div class="score-row">
          <span>${row.range}</span>
          <span class="green">+${row.correct} pkt</span>
          <span class="red">−${row.wrong} pkt</span>
          <span>0 pkt</span>
        </div>`).join('')}`;
  } else {
    scoringEl.innerHTML = `
      <div class="score-row header"><span>Zadania</span><span>Poprawna</span><span>Błędna</span><span>Brak</span></div>
      <div class="score-row"><span>1–10</span><span class="green">+3 pkt</span><span class="red">−¾ pkt</span><span>0 pkt</span></div>
      <div class="score-row"><span>11–20</span><span class="green">+4 pkt</span><span class="red">−1 pkt</span><span>0 pkt</span></div>
      <div class="score-row"><span>21–30</span><span class="green">+5 pkt</span><span class="red">−1¼ pkt</span><span>0 pkt</span></div>`;
  }

  const bonusEl = document.getElementById('rules-bonus');
  if (t.startingPoints > 0) {
    bonusEl.style.display = 'block';
    bonusEl.textContent = `⭐ W tej edycji startujemy z ${t.startingPoints} punktami bonusowymi! Maksimum: ${t.maxPoints} pkt.`;
  } else {
    bonusEl.style.display = 'none';
  }
  document.getElementById('rules-maxpoints').textContent = isSzpakTest
    ? `${t.maxPoints} punktów (${t.totalQuestions} zadań × 4 stwierdzenia × 1 pkt)`
    : `${t.maxPoints} punktów (${t.totalQuestions} zadań × wartość zadania)`;

  showScreen('screen-rules');
}

// ─── Start test ───────────────────────────────────────────────
function startTest() {
  const t = currentTest;
  answers = t.questions.map(q => isSzpak(q) ? {A:null,B:null,C:null,D:null} : null);
  currentQ = 0;
  testFinished = false;
  secondsLeft = (t.timeMinutes || 75) * 60;
  buildQuestionDots();
  renderQuestion();
  showScreen('screen-test');
  startTimer();
}

function startTimer() {
  stopTimer();
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    secondsLeft--;
    updateTimerDisplay();
    if (secondsLeft <= 0) { stopTimer(); finishTest(); }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function updateTimerDisplay() {
  const el = document.getElementById('timer');
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  el.className = 'timer';
  if (secondsLeft <= 300) el.classList.add(secondsLeft <= 60 ? 'danger' : 'warning');
}

// ─── Multi-answer helpers ─────────────────────────────────────
function isMultiAnswer(q) {
  return Array.isArray(q.correct) || (currentTest && currentTest.multiAnswer);
}

function isSzpak(q) {
  return q && q.correct !== null && typeof q.correct === 'object' && !Array.isArray(q.correct);
}

function getSelectedLetters(idx) {
  const a = answers[idx];
  if (a === null) return [];
  if (Array.isArray(a)) return a;
  return [a];
}

// ─── Render question ──────────────────────────────────────────
function renderQuestion() {
  const t = currentTest;
  const q = t.questions[currentQ];
  const total = t.questions.length;
  const multi = isMultiAnswer(q);

  document.getElementById('q-counter').textContent = `Zadanie ${currentQ + 1}/${total}`;
  document.getElementById('q-number').textContent = `Zadanie ${q.id}`;
  document.getElementById('q-points').textContent = `${q.points} pkt`;
  document.getElementById('q-text').textContent = q.text;

  const answered = answers.filter(a => hasAnyAnswer(a)).length;
  document.getElementById('progress-bar').style.width = `${(answered / total) * 100}%`;

  const pagesDiv = document.getElementById('question-pages');
  const imgEl = document.getElementById('page-img');
  const pageIdx = q.id <= 15 ? 0 : 1;
  const pageUrl = t.pages && t.pages[pageIdx];
  if (pageUrl) {
    imgEl.src = pageUrl;
    imgEl.style.display = 'block';
    pagesDiv.classList.add('visible');
  } else {
    imgEl.style.display = 'none';
    pagesDiv.classList.remove('visible');
  }

  const optsDiv = document.getElementById('options');
  optsDiv.innerHTML = '';

  if (isSzpak(q)) {
    // SZPAK: each option independently TRUE/FALSE/unanswered
    const hint = document.createElement('p');
    hint.className = 'multi-hint';
    hint.textContent = '🐦 Oceń każde stwierdzenie: PRAWDA lub FAŁSZ';
    optsDiv.appendChild(hint);
    const state = answers[currentQ] || {A:null,B:null,C:null,D:null};
    Object.entries(q.options).forEach(([letter, text]) => {
      const row = document.createElement('div');
      row.className = 'szpak-row';
      const textSpan = document.createElement('span');
      textSpan.className = 'szpak-text';
      textSpan.innerHTML = `<span class="option-letter">${letter}</span> ${text}`;
      const btnTrue = document.createElement('button');
      btnTrue.className = 'szpak-btn szpak-true' + (state[letter] === true ? ' active' : '');
      btnTrue.textContent = 'PRAWDA';
      btnTrue.onclick = () => setSzpakAnswer(letter, state[letter] === true ? null : true);
      const btnFalse = document.createElement('button');
      btnFalse.className = 'szpak-btn szpak-false' + (state[letter] === false ? ' active' : '');
      btnFalse.textContent = 'FAŁSZ';
      btnFalse.onclick = () => setSzpakAnswer(letter, state[letter] === false ? null : false);
      row.appendChild(textSpan);
      row.appendChild(btnTrue);
      row.appendChild(btnFalse);
      optsDiv.appendChild(row);
    });
  } else if (multi) {
    // Multi-answer: checkbox style
    const hint = document.createElement('p');
    hint.className = 'multi-hint';
    hint.textContent = '✓ Zaznacz wszystkie poprawne odpowiedzi';
    optsDiv.appendChild(hint);
    const selected = getSelectedLetters(currentQ);
    Object.entries(q.options).forEach(([letter, text]) => {
      const btn = document.createElement('button');
      const isSelected = selected.includes(letter);
      btn.className = 'option-btn multi' + (isSelected ? ' selected' : '');
      btn.innerHTML = `<span class="option-letter">${isSelected ? '☑' : '☐'}</span><span>${text}</span>`;
      btn.onclick = () => toggleAnswer(letter);
      optsDiv.appendChild(btn);
    });
  } else {
    // Single-answer: radio style
    const selected = answers[currentQ];
    Object.entries(q.options).forEach(([letter, text]) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn' + (selected === letter ? ' selected' : '');
      btn.innerHTML = `<span class="option-letter">${letter}</span><span>${text}</span>`;
      btn.onclick = () => selectAnswer(letter);
      optsDiv.appendChild(btn);
    });
  }

  document.getElementById('btn-prev').disabled = currentQ === 0;
  document.getElementById('btn-next').textContent = currentQ === total - 1 ? 'Zakończ ✓' : 'Następne →';
  updateDots();
}

function selectAnswer(letter) {
  answers[currentQ] = letter;
  renderQuestion();
  saveProgress();
}

function setSzpakAnswer(letter, value) {
  if (!answers[currentQ] || typeof answers[currentQ] !== 'object') {
    answers[currentQ] = {A:null,B:null,C:null,D:null};
  }
  answers[currentQ] = {...answers[currentQ], [letter]: value};
  renderQuestion();
  saveProgress();
}

function toggleAnswer(letter) {
  let current = getSelectedLetters(currentQ);
  if (current.includes(letter)) {
    current = current.filter(l => l !== letter);
  } else {
    current = [...current, letter].sort();
  }
  answers[currentQ] = current.length === 0 ? null : current;
  renderQuestion();
  saveProgress();
}

function prevQuestion() {
  if (currentQ > 0) { currentQ--; renderQuestion(); saveProgress(); }
}

function nextQuestion() {
  const total = currentTest.questions.length;
  if (currentQ < total - 1) { currentQ++; renderQuestion(); saveProgress(); }
  else finishTest();
}

function skipQuestion() {
  answers[currentQ] = null;
  const total = currentTest.questions.length;
  if (currentQ < total - 1) { currentQ++; renderQuestion(); saveProgress(); }
}

// ─── Dots ─────────────────────────────────────────────────────
function buildQuestionDots() {
  const div = document.getElementById('question-dots');
  div.innerHTML = '';
  currentTest.questions.forEach((_, i) => {
    const btn = document.createElement('button');
    btn.className = 'dot';
    btn.textContent = i + 1;
    btn.onclick = () => { currentQ = i; renderQuestion(); };
    div.appendChild(btn);
  });
}

function hasAnyAnswer(a) {
  if (a === null) return false;
  if (Array.isArray(a)) return a.length > 0;
  if (typeof a === 'object') return Object.values(a).some(v => v !== null);
  return true;
}

function updateDots() {
  document.querySelectorAll('#question-dots .dot').forEach((d, i) => {
    d.className = 'dot' + (hasAnyAnswer(answers[i]) ? ' answered' : '') + (i === currentQ ? ' current' : '');
  });
}

// ─── Finish / Results ─────────────────────────────────────────
function confirmQuit() { document.getElementById('modal-quit').style.display = 'flex'; }
function closeQuit(e) {
  if (!e || e.target === document.getElementById('modal-quit'))
    document.getElementById('modal-quit').style.display = 'none';
}

function saveAndExit() {
  saveProgress();
  stopTimer();
  document.getElementById('modal-quit').style.display = 'none';
  showList();
}

function finishTest() {
  stopTimer();
  testFinished = true;
  document.getElementById('modal-quit').style.display = 'none';
  clearProgress(currentTest.year);
  calculateAndShowResults();
}

function isAnswerCorrect(q, given) {
  if (given === null) return false;
  if (isSzpak(q)) {
    if (!given || typeof given !== 'object') return false;
    return Object.keys(q.correct).every(letter =>
      given[letter] !== null && given[letter] === q.correct[letter]
    );
  }
  const correct = Array.isArray(q.correct) ? [...q.correct].sort() : [q.correct];
  const givenArr = Array.isArray(given) ? [...given].sort() : [given];
  return JSON.stringify(correct) === JSON.stringify(givenArr);
}

function calculateAndShowResults() {
  const t = currentTest;
  let points = t.startingPoints || 0;
  let correctCount = 0;
  const wrongQuestions = [];
  const skippedQuestions = [];

  t.questions.forEach((q, i) => {
    const given = answers[i];

    if (isSzpak(q)) {
      // Score each option independently
      const state = (given && typeof given === 'object') ? given : {A:null,B:null,C:null,D:null};
      let allSkipped = true;
      let allCorrect = true;
      Object.keys(q.correct).forEach(letter => {
        const userVal = state[letter];
        if (userVal === null) {
          allCorrect = false; // unanswered = 0 pts, no penalty
        } else {
          allSkipped = false;
          if (userVal === q.correct[letter]) {
            points += 1;
          } else {
            points -= 1;
            allCorrect = false;
          }
        }
      });
      if (allSkipped) {
        skippedQuestions.push(q.id);
      } else if (allCorrect) {
        correctCount++;
      } else {
        wrongQuestions.push(q.id);
      }
      return;
    }

    if (given === null) {
      skippedQuestions.push(q.id);
      return;
    }
    if (isAnswerCorrect(q, given)) {
      points += q.points;
      correctCount++;
    } else {
      const penalty = q.penalty !== undefined ? Math.abs(q.penalty) : q.points * 0.25;
      points -= penalty;
      wrongQuestions.push(q.id);
    }
  });

  points = Math.max(0, Math.round(points * 100) / 100);
  const maxPts = t.maxPoints;
  const pctPts = Math.round((points / maxPts) * 100);
  const pctTasks = Math.round((correctCount / t.totalQuestions) * 100);

  document.getElementById('results-name').textContent = t.name;
  document.getElementById('res-points').textContent = `${points} / ${maxPts}`;
  document.getElementById('res-points-pct').textContent = `${pctPts}%`;
  document.getElementById('res-tasks').textContent = `${correctCount} / ${t.totalQuestions}`;
  document.getElementById('res-tasks-pct').textContent = `${pctTasks}%`;

  const comment = getComment(pctPts);
  document.getElementById('res-comment').innerHTML =
    `<div class="comment-box"><span class="comment-emoji">${comment.emoji}</span>${comment.text}</div>`;

  showScreen('screen-results');
  saveToFirestore(points, maxPts, correctCount, t.totalQuestions, comment.text, wrongQuestions, skippedQuestions);
}

function getComment(pct) {
  if (pct >= 95) return { emoji: '🏆', text: 'Fenomenalny wynik! Jesteś mistrzem matematyki!' };
  if (pct >= 85) return { emoji: '🌟', text: 'Świetny wynik! Bardzo dobrze opanujesz matematykę.' };
  if (pct >= 70) return { emoji: '😊', text: 'Dobry wynik! Warto jeszcze trochę poćwiczyć.' };
  if (pct >= 50) return { emoji: '📚', text: 'Niezły wynik, ale jest jeszcze pole do poprawy.' };
  if (pct >= 30) return { emoji: '💪', text: 'Trudne zadania! Przejrzyj rozwiązania i spróbuj ponownie.' };
  return { emoji: '🔄', text: 'Czas na naukę! Sprawdź rozwiązania – na pewno następnym razem pójdzie lepiej.' };
}

async function saveToFirestore(points, maxPoints, tasks, maxTasks, comment, wrongQuestions = [], skippedQuestions = []) {
  const familyId = getFamilyId();
  if (!familyId) return;
  try {
    const t = currentTest;
    const today = new Date().toISOString().slice(0, 10);
    await db.collection('families').doc(familyId).collection('tests').add({
      name: t.name,
      year: t.year,
      date: today,
      class: t.class || null,
      category: currentCategory ? currentCategory.id : 'alfik4',
      points, maxPoints, tasks, maxTasks, comment,
      wrongQuestions,
      skippedQuestions,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    console.log('Wynik zapisany do Firestore');
  } catch (e) {
    console.warn('Nie udało się zapisać wyniku:', e.message);
  }
}

// ─── Review ───────────────────────────────────────────────────
function showReview() {
  const t = currentTest;
  const list = document.getElementById('review-list');
  list.innerHTML = '';

  t.questions.forEach((q, i) => {
    const given = answers[i];
    const isSkipped = given === null;
    const isCorrect = !isSkipped && isAnswerCorrect(q, given);
    const penalty = q.penalty !== undefined ? q.penalty : q.points * 0.25;
    const pts = isCorrect ? `+${q.points}` : isSkipped ? '0' : `−${penalty % 1 === 0 ? penalty : penalty.toFixed(2).replace('.00', '')}`;

    const item = document.createElement('div');
    item.className = `review-item ${isSkipped ? 'skipped' : isCorrect ? 'correct' : 'wrong'}`;

    // Format answer display
    let answersHtml = '';
    if (isSzpak(q)) {
      const state = (given && typeof given === 'object') ? given : {};
      answersHtml = Object.entries(q.correct).map(([letter, correctVal]) => {
        const userVal = state[letter] !== undefined ? state[letter] : null;
        const optCorrect = userVal === correctVal;
        const valStr = userVal === null ? '—' : (userVal ? 'PRAWDA' : 'FAŁSZ');
        const correctStr = correctVal ? 'PRAWDA' : 'FAŁSZ';
        return `<span class="ans-label ${userVal === null ? '' : optCorrect ? 'ans-given correct' : 'ans-given'}">${letter}: ${valStr}${!optCorrect ? ` <em>(${correctStr})</em>` : ''}</span>`;
      }).join('');
    } else {
      const givenStr = isSkipped ? '' : (Array.isArray(given) ? given.join(', ') : given);
      const correctStr = Array.isArray(q.correct) ? q.correct.join(', ') : q.correct;
      if (!isSkipped) answersHtml += `<span class="ans-label ${isCorrect ? 'ans-given correct' : 'ans-given'}">Twoja: ${givenStr}</span>`;
      if (!isCorrect) answersHtml += `<span class="ans-label ans-correct-show">Poprawna: ${correctStr}</span>`;
    }

    item.innerHTML = `
      <div class="review-item-header">
        <span class="q-label">Zadanie ${q.id} (${q.points} pkt) → <strong>${pts} pkt</strong></span>
        <span class="result-badge ${isSkipped ? 'badge-skipped' : isCorrect ? 'badge-correct' : 'badge-wrong'}">
          ${isSkipped ? 'Pominięte' : isCorrect ? '✓ Poprawnie' : '✗ Błędnie'}
        </span>
      </div>
      <p class="review-q-text">${q.text}</p>
      <div class="review-answers">${answersHtml}</div>
      <button class="review-solution-btn" onclick="showSolution(${i})">💡 Pokaż rozwiązanie</button>
    `;
    list.appendChild(item);
  });

  showScreen('screen-review');
}

function backToResults() { showScreen('screen-results'); }

// ─── Solution modal ───────────────────────────────────────────
const AI_SOLUTION_URL = 'http://158.180.27.32:5678/webhook/testy-rozwiazanie';
const AI_AVAILABLE = true;

function showSolution(idx) {
  const q = currentTest.questions[idx];
  document.getElementById('modal-title').textContent = `Rozwiązanie – Zadanie ${q.id}`;
  document.getElementById('modal-q-text').textContent = q.text;
  if (isSzpak(q)) {
    const answerLines = Object.entries(q.correct).map(([letter, val]) =>
      `${letter}) ${q.options[letter] || ''} → ${val ? 'PRAWDA' : 'FAŁSZ'}`
    ).join('\n');
    document.getElementById('modal-answer').textContent = answerLines;
  } else {
    document.getElementById('modal-answer').textContent =
      `Poprawna odpowiedź: ${q.correct}  —  ${q.options[q.correct]}`;
  }

  const solutionEl = document.getElementById('modal-solution-text');
  solutionEl.textContent = q.solution || '';

  const aiBtn = document.getElementById('modal-ai-btn');
  if (AI_AVAILABLE) {
    aiBtn.style.display = 'inline-flex';
    aiBtn.disabled = false;
    aiBtn.style.background = '';
    aiBtn.innerHTML = '✨ Wyjaśnij z AI';
    aiBtn.onclick = () => generateAISolution(idx);
  } else {
    aiBtn.style.display = 'none';
  }

  document.getElementById('modal-solution').style.display = 'flex';
}

function renderMarkdown(text) {
  const lines = text.split('\n');
  let html = '';
  let i = 0;

  function escape(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function bold(s) {
    s = s.replace(/\$\$?.+?\$\$?/g, m => m.replace(/\$/g, '').replace(/\\[a-z]+\{?/g, '').replace(/\}/g, ''));
    s = escape(s);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }
  function isNumbered(l) { return /^\d+\.\s/.test(l); }
  function isBullet(l)   { return /^[-*]\s/.test(l); }
  function isIndented(l) { return /^[ \t]{2,}[-*]\s/.test(l); }
  function isEmpty(l)    { return l.trim() === ''; }

  while (i < lines.length) {
    const line = lines[i];
    if (isNumbered(line)) {
      html += '<ol>';
      while (i < lines.length && (isNumbered(lines[i]) || isIndented(lines[i]) || isEmpty(lines[i]))) {
        if (isEmpty(lines[i])) { i++; continue; }
        if (isNumbered(lines[i])) {
          const itemText = bold(lines[i].replace(/^\d+\.\s*/, ''));
          i++;
          let subHtml = '';
          while (i < lines.length && isIndented(lines[i])) {
            subHtml += `<li>${bold(lines[i].replace(/^[ \t]+[-*]\s*/, ''))}</li>`;
            i++;
          }
          html += `<li>${itemText}${subHtml ? `<ul>${subHtml}</ul>` : ''}</li>`;
        } else { i++; }
      }
      html += '</ol>';
      continue;
    }
    if (isBullet(line) && !isIndented(line)) {
      html += '<ul>';
      while (i < lines.length && isBullet(lines[i]) && !isIndented(lines[i])) {
        html += `<li>${bold(lines[i].replace(/^[-*]\s*/, ''))}</li>`;
        i++;
      }
      html += '</ul>';
      continue;
    }
    if (isEmpty(line)) { i++; continue; }
    html += `<p>${bold(line)}</p>`;
    i++;
  }
  return html;
}

async function generateAISolution(idx) {
  const q = currentTest.questions[idx];
  const solutionEl = document.getElementById('modal-solution-text');
  const aiBtn = document.getElementById('modal-ai-btn');

  aiBtn.disabled = true;
  aiBtn.innerHTML = '<span class="ai-loading">✨ Generuję…</span>';

  try {
    const resp = await fetch(AI_SOLUTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questionId: q.id, question: q.text, options: q.options,
        correct: q.correct, points: q.points, year: currentTest.year
      })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.solution) {
      solutionEl.innerHTML = `<span class="ai-badge">✨ AI</span>${renderMarkdown(data.solution)}`;
      aiBtn.style.display = 'none';
    } else {
      throw new Error('limit');
    }
  } catch (e) {
    console.warn('AI solution unavailable:', e.message);
    aiBtn.disabled = false;
    aiBtn.innerHTML = '⚠️ Dzienny limit AI wyczerpany — spróbuj jutro';
    aiBtn.style.background = '#6b7280';
  }
}

function closeSolution(e) {
  if (!e || e.target === document.getElementById('modal-solution'))
    document.getElementById('modal-solution').style.display = 'none';
}

// ─── Init ─────────────────────────────────────────────────────
loadCategories();
