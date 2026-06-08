// ─── Firebase init ───────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore();

// ─── State ───────────────────────────────────────────────────
let currentTest = null;     // loaded test JSON
let answers = [];           // user answers (null = skipped)
let currentQ = 0;           // 0-based question index
let timerInterval = null;
let secondsLeft = 0;
let testFinished = false;

// ─── Zapis postępu (localStorage) ────────────────────────────
function saveKey(year) { return `testy_progress_${year}`; }

function saveProgress() {
  if (!currentTest || testFinished) return;
  const data = {
    year: currentTest.year,
    file: currentTest._file,
    answers,
    currentQ,
    secondsLeft,
    savedAt: Date.now()
  };
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

function savedAt(year) {
  const p = loadProgress(year);
  if (!p) return null;
  return new Date(p.savedAt);
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

function showList() {
  stopTimer();
  currentTest = null;
  testFinished = false;
  showScreen('screen-list');
  loadTestList(); // odśwież listę, żeby zaktualizować badge z postępem
}

// ─── Load test list ───────────────────────────────────────────
async function loadTestList() {
  const grid = document.getElementById('test-grid');
  grid.innerHTML = '<p style="padding:20px;color:#9ca3af">Ładowanie testów…</p>';

  // Pobierz wyniki z Firestore (mapa rok → najlepszy wynik)
  const doneMap = {};
  const familyId = getFamilyId();
  if (familyId) {
    try {
      const snap = await db.collection('families').doc(familyId).collection('tests').get();
      snap.forEach(doc => {
        const d = doc.data();
        if (!d.year) return;
        const key = String(d.year);
        if (!doneMap[key] || d.points > doneMap[key].points) {
          doneMap[key] = {
            points: d.points,
            maxPoints: d.maxPoints,
            tasks: d.tasks,
            maxTasks: d.maxTasks,
            createdAt: d.createdAt?.toDate ? d.createdAt.toDate() : null
          };
        }
      });
    } catch (e) {
      console.warn('Nie udało się pobrać wyników:', e.message);
    }
  }

  try {
    const resp = await fetch('data/alfik4/index.json');
    const idx = await resp.json();
    grid.innerHTML = '';
    idx.tests.forEach(t => {
      const saved = loadProgress(t.year);
      const savedBadge = saved ? (() => {
        const d = new Date(saved.savedAt);
        const timeStr = d.toLocaleDateString('pl-PL', { day:'numeric', month:'short' })
          + ' ' + d.toLocaleTimeString('pl-PL', { hour:'2-digit', minute:'2-digit' });
        const answered = saved.answers.filter(a => a !== null).length;
        const m = Math.floor(saved.secondsLeft / 60);
        const s = String(saved.secondsLeft % 60).padStart(2,'0');
        return `<div class="saved-badge">▶ W toku — ${answered}/30 odpowiedzi · pozostało ${m}:${s} · zapisano ${timeStr}</div>`;
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
        <div class="edition">${t.edition}</div>
        <div class="meta">
          <span>📝 <strong>${t.totalQuestions}</strong> zadań</span>
          <span>🏆 max <strong>${t.maxPoints}</strong> pkt</span>
          <span>⏱ <strong>75</strong> min</span>
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
    if (saved) {
      showResumeModal(saved);
    } else {
      showRules();
    }
  } catch (e) {
    alert('Nie udało się załadować testu: ' + e.message);
  }
}

function showResumeModal(saved) {
  const answered = saved.answers.filter(a => a !== null).length;
  const m = Math.floor(saved.secondsLeft / 60);
  const s = String(saved.secondsLeft % 60).padStart(2,'0');
  const d = new Date(saved.savedAt);
  const timeStr = d.toLocaleDateString('pl-PL', { weekday:'long', day:'numeric', month:'long' })
    + ' o ' + d.toLocaleTimeString('pl-PL', { hour:'2-digit', minute:'2-digit' });

  document.getElementById('resume-info').innerHTML =
    `Odpowiedziałeś na <strong>${answered} z 30</strong> pytań.<br>
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

  const bonusEl = document.getElementById('rules-bonus');
  if (t.startingPoints > 0) {
    bonusEl.style.display = 'block';
    bonusEl.textContent = `⭐ W tej edycji startujemy z ${t.startingPoints} punktami bonusowymi! Maksimum: ${t.maxPoints} pkt.`;
  } else {
    bonusEl.style.display = 'none';
  }
  document.getElementById('rules-maxpoints').textContent =
    `${t.maxPoints} punktów (${t.totalQuestions} zadań × wartość zadania)`;

  showScreen('screen-rules');
}

// ─── Start test ───────────────────────────────────────────────
function startTest() {
  const t = currentTest;
  answers = new Array(t.questions.length).fill(null);
  currentQ = 0;
  testFinished = false;
  secondsLeft = t.timeMinutes * 60;

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
    if (secondsLeft <= 0) {
      stopTimer();
      finishTest();
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function updateTimerDisplay() {
  const el = document.getElementById('timer');
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  el.className = 'timer';
  if (secondsLeft <= 300) el.classList.add(secondsLeft <= 60 ? 'danger' : 'warning');
}

// ─── Render question ──────────────────────────────────────────
function renderQuestion() {
  const t = currentTest;
  const q = t.questions[currentQ];
  const total = t.questions.length;

  // header
  document.getElementById('q-counter').textContent = `Zadanie ${currentQ + 1}/${total}`;
  document.getElementById('q-number').textContent = `Zadanie ${q.id}`;
  document.getElementById('q-points').textContent = `${q.points} pkt`;
  document.getElementById('q-text').textContent = q.text;

  // progress bar
  const answered = answers.filter(a => a !== null).length;
  document.getElementById('progress-bar').style.width = `${(answered / total) * 100}%`;

  // page image (show always the correct page based on question number)
  const pagesDiv = document.getElementById('question-pages');
  const imgEl = document.getElementById('page-img');
  const pageIdx = q.id <= 15 ? 0 : 1;
  const pageUrl = t.pages[pageIdx];
  if (pageUrl) {
    imgEl.src = pageUrl;
    imgEl.style.display = 'block';
    pagesDiv.classList.add('visible');
  } else {
    imgEl.style.display = 'none';
    pagesDiv.classList.remove('visible');
  }

  // options
  const optsDiv = document.getElementById('options');
  optsDiv.innerHTML = '';
  const selected = answers[currentQ];
  Object.entries(q.options).forEach(([letter, text]) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn' + (selected === letter ? ' selected' : '');
    btn.innerHTML = `<span class="option-letter">${letter}</span><span>${text}</span>`;
    btn.onclick = () => selectAnswer(letter);
    optsDiv.appendChild(btn);
  });

  // nav buttons
  document.getElementById('btn-prev').disabled = currentQ === 0;
  document.getElementById('btn-next').textContent =
    currentQ === total - 1 ? 'Zakończ ✓' : 'Następne →';

  // dots
  updateDots();
}

function selectAnswer(letter) {
  answers[currentQ] = letter;
  renderQuestion();
  saveProgress();
}

function prevQuestion() {
  if (currentQ > 0) { currentQ--; renderQuestion(); saveProgress(); }
}

function nextQuestion() {
  const total = currentTest.questions.length;
  if (currentQ < total - 1) {
    currentQ++;
    renderQuestion();
    saveProgress();
  } else {
    finishTest();
  }
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

function updateDots() {
  const dots = document.querySelectorAll('#question-dots .dot');
  dots.forEach((d, i) => {
    d.className = 'dot' +
      (answers[i] !== null ? ' answered' : '') +
      (i === currentQ ? ' current' : '');
  });
}

// ─── Finish / Results ─────────────────────────────────────────
function confirmQuit() {
  document.getElementById('modal-quit').style.display = 'flex';
}
function closeQuit(e) {
  if (!e || e.target === document.getElementById('modal-quit')) {
    document.getElementById('modal-quit').style.display = 'none';
  }
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

function calculateAndShowResults() {
  const t = currentTest;
  let points = t.startingPoints || 0;
  let correctCount = 0;

  t.questions.forEach((q, i) => {
    const given = answers[i];
    if (given === null) return;
    if (given === q.correct) {
      points += q.points;
      correctCount++;
    } else {
      points -= q.points * 0.25;
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
  saveToFirestore(points, maxPts, correctCount, t.totalQuestions, comment.text);
}

function getComment(pct) {
  if (pct >= 95) return { emoji: '🏆', text: 'Fenomenalny wynik! Jesteś mistrzem matematyki!' };
  if (pct >= 85) return { emoji: '🌟', text: 'Świetny wynik! Bardzo dobrze opanujesz matematykę.' };
  if (pct >= 70) return { emoji: '😊', text: 'Dobry wynik! Warto jeszcze trochę poćwiczyć.' };
  if (pct >= 50) return { emoji: '📚', text: 'Niezły wynik, ale jest jeszcze pole do poprawy.' };
  if (pct >= 30) return { emoji: '💪', text: 'Trudne zadania! Przejrzyj rozwiązania i spróbuj ponownie.' };
  return { emoji: '🔄', text: 'Czas na naukę! Sprawdź rozwiązania – na pewno następnym razem pójdzie lepiej.' };
}

async function saveToFirestore(points, maxPoints, tasks, maxTasks, comment) {
  const familyId = getFamilyId();
  if (!familyId) return;
  try {
    const t = currentTest;
    await db.collection('families').doc(familyId).collection('tests').add({
      name: t.name,
      year: t.year,
      date: t.date,
      class: t.class,
      points: points,
      maxPoints: maxPoints,
      tasks: tasks,
      maxTasks: maxTasks,
      comment: comment,
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
    const isCorrect = given === q.correct;
    const isSkipped = given === null;
    const pts = isCorrect ? `+${q.points}` : isSkipped ? '0' : `−${(q.points * 0.25).toFixed(2).replace('.00','')}`;

    const item = document.createElement('div');
    item.className = `review-item ${isSkipped ? 'skipped' : isCorrect ? 'correct' : 'wrong'}`;

    let answersHtml = '';
    if (!isSkipped) {
      answersHtml += `<span class="ans-label ${isCorrect ? 'ans-given correct' : 'ans-given'}">Twoja: ${given}</span>`;
    }
    if (!isCorrect) {
      answersHtml += `<span class="ans-label ans-correct-show">Poprawna: ${q.correct}</span>`;
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

function backToResults() {
  showScreen('screen-results');
}

// ─── Solution modal ───────────────────────────────────────────
const AI_SOLUTION_URL = 'http://localhost:5678/webhook/testy-rozwiazanie';

function showSolution(idx) {
  const q = currentTest.questions[idx];
  document.getElementById('modal-title').textContent = `Rozwiązanie – Zadanie ${q.id}`;
  document.getElementById('modal-q-text').textContent = q.text;
  document.getElementById('modal-answer').textContent =
    `Poprawna odpowiedź: ${q.correct}  —  ${q.options[q.correct]}`;

  const solutionEl = document.getElementById('modal-solution-text');
  solutionEl.textContent = q.solution;

  // Przycisk AI
  const aiBtn = document.getElementById('modal-ai-btn');
  aiBtn.style.display = 'inline-flex';
  aiBtn.disabled = false;
  aiBtn.innerHTML = '✨ Wyjaśnij z AI';
  aiBtn.onclick = () => generateAISolution(idx);

  document.getElementById('modal-solution').style.display = 'flex';
}

function renderMarkdown(text) {
  const lines = text.split('\n');
  let html = '';
  let i = 0;

  function escape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function bold(s) {
    // Usuń LaTeX $...$ i $$...$$
    s = s.replace(/\$\$?.+?\$\$?/g, m => m.replace(/\$/g, '').replace(/\\[a-z]+\{?/g, '').replace(/\}/g, ''));
    // Zamień backtick `kod` na <code>
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

    // Numbered list item (may have indented sub-bullets after)
    if (isNumbered(line)) {
      html += '<ol>';
      while (i < lines.length && (isNumbered(lines[i]) || isIndented(lines[i]) || isEmpty(lines[i]))) {
        if (isEmpty(lines[i])) { i++; continue; }
        if (isNumbered(lines[i])) {
          const itemText = bold(lines[i].replace(/^\d+\.\s*/, ''));
          i++;
          // Collect sub-bullets
          let subHtml = '';
          while (i < lines.length && (isIndented(lines[i]) || (isBullet(lines[i]) && !isNumbered(lines[i-1] || '')))) {
            if (isIndented(lines[i])) {
              subHtml += `<li>${bold(lines[i].replace(/^[ \t]+[-*]\s*/, ''))}</li>`;
              i++;
            } else break;
          }
          html += `<li>${itemText}${subHtml ? `<ul>${subHtml}</ul>` : ''}</li>`;
        } else {
          // Orphan indented line — skip
          i++;
        }
      }
      html += '</ol>';
      continue;
    }

    // Top-level bullet list
    if (isBullet(line) && !isIndented(line)) {
      html += '<ul>';
      while (i < lines.length && isBullet(lines[i]) && !isIndented(lines[i])) {
        html += `<li>${bold(lines[i].replace(/^[-*]\s*/, ''))}</li>`;
        i++;
      }
      html += '</ul>';
      continue;
    }

    // Empty line → paragraph break
    if (isEmpty(line)) {
      i++;
      continue;
    }

    // Regular line → paragraph
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
        questionId: q.id,
        question: q.text,
        options: q.options,
        correct: q.correct,
        points: q.points,
        year: currentTest.year
      })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.solution) {
      solutionEl.innerHTML = `<span class="ai-badge">✨ AI</span>${renderMarkdown(data.solution)}`;
      aiBtn.style.display = 'none';
    } else {
      throw new Error('Brak rozwiązania');
    }
  } catch (e) {
    console.warn('AI solution unavailable:', e.message);
    aiBtn.disabled = false;
    aiBtn.innerHTML = '✨ Spróbuj ponownie';
  }
}

function closeSolution(e) {
  if (!e || e.target === document.getElementById('modal-solution')) {
    document.getElementById('modal-solution').style.display = 'none';
  }
}

// ─── Init ─────────────────────────────────────────────────────
loadTestList();

// Ustaw link powrotu do Kalendarza z familyId
(function() {
  const fid = getFamilyId();
  const backBtn = document.getElementById('btn-back-kalendarz');
  if (backBtn && fid) backBtn.href = '../index.html#' + fid;
})();
