/* Познай 5 — състояние и логика на играта. */

(function () {
  "use strict";

  var STORAGE_KEY = "poznay5";
  var SAVE_VERSION = 2;      /* смяната на версията изчиства стария запис */
  var FREE_LEVELS = 5;       /* първите пет нива са отключени от начало */
  var START_COINS = 50;
  var LEVEL_REWARD = 20;
  var LETTER_COST = 10;
  var ANSWER_COST = 40;

  /* open[i]: 0 = скрито, 1 = отгатнато от играча, 2 = отворено с монети */
  var state = null;
  var els = {};
  var audioCtx = null;

  /* ---------- запазване ---------- */

  function defaultState() {
    return { v: SAVE_VERSION, level: 0, progress: 0, done: {}, coins: START_COINS,
             sound: true, levels: {} };
  }

  function isUnlocked(index) {
    return index < FREE_LEVELS || index <= state.progress;
  }

  function doneCount() {
    var n = 0;
    for (var key in state.done) {
      if (Object.prototype.hasOwnProperty.call(state.done, key)) n++;
    }
    return n;
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (!raw) return defaultState();
    var saved;
    try { saved = JSON.parse(raw); } catch (e) { return defaultState(); }
    if (!saved || typeof saved !== "object") return defaultState();
    if (saved.v !== SAVE_VERSION) return defaultState();
    var s = defaultState();
    if (typeof saved.level === "number") s.level = saved.level;
    if (typeof saved.progress === "number") s.progress = saved.progress;
    if (typeof saved.coins === "number") s.coins = saved.coins;
    if (typeof saved.sound === "boolean") s.sound = saved.sound;
    if (saved.levels && typeof saved.levels === "object") s.levels = saved.levels;
    if (saved.done && typeof saved.done === "object") s.done = saved.done;
    s.progress = Math.max(0, Math.min(s.progress, QUESTIONS.length));
    s.level = Math.max(0, Math.min(s.level, QUESTIONS.length - 1));
    return s;
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* частен режим */ }
  }

  function resetAll() {
    state = defaultState();
    save();
  }

  /* ---------- състояние на ниво ---------- */

  function levelState(index) {
    var key = String(index);
    var ls = state.levels[key];
    if (!ls || !ls.open || ls.open.length !== 5) {
      ls = { open: [0, 0, 0, 0, 0], hints: [] };
      for (var i = 0; i < 5; i++) ls.hints.push({ n: 0, letters: [] });
      state.levels[key] = ls;
    }
    return ls;
  }

  function currentQuestion() {
    return QUESTIONS[state.level];
  }

  function isLevelDone(index) {
    var ls = levelState(index);
    for (var i = 0; i < 5; i++) if (!ls.open[i]) return false;
    return true;
  }

  /* ---------- букви и подсказки ---------- */

  function letterPositions(text) {
    var out = [];
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) !== " ") out.push(i);
    }
    return out;
  }

  function hiddenPositions(text, revealed) {
    return letterPositions(text).filter(function (p) { return revealed.indexOf(p) === -1; });
  }

  /* Втората подсказка винаги дава първата буква, останалите са случайни. */
  function pickHintPosition(text, revealed, hintNumber) {
    var hidden = hiddenPositions(text, revealed);
    if (!hidden.length) return -1;
    if (hintNumber === 2) {
      var first = letterPositions(text)[0];
      if (hidden.indexOf(first) !== -1) return first;
    }
    return hidden[Math.floor(Math.random() * hidden.length)];
  }

  function buyLetter(index) {
    var ls = levelState(state.level);
    if (ls.open[index]) return "open";
    if (state.coins < LETTER_COST) return "coins";
    var text = currentQuestion().answers[index].text;
    var hint = ls.hints[index];
    var pos = pickHintPosition(text, hint.letters, hint.n + 1);
    if (pos === -1) return "open";
    state.coins -= LETTER_COST;
    hint.n += 1;
    hint.letters.push(pos);
    if (!hiddenPositions(text, hint.letters).length) ls.open[index] = 2;
    save();
    return "ok";
  }

  function buyAnswer() {
    var ls = levelState(state.level);
    var index = -1;
    for (var i = 0; i < 5; i++) {
      if (!ls.open[i]) { index = i; break; }
    }
    if (index === -1) return "open";
    if (state.coins < ANSWER_COST) return "coins";
    state.coins -= ANSWER_COST;
    ls.open[index] = 2;
    ls.hints[index].letters = letterPositions(currentQuestion().answers[index].text);
    save();
    return index;
  }

  /* ---------- отговори ---------- */

  function submitGuess(value) {
    var q = currentQuestion();
    var index = matchAnswer(value, q.answers);
    if (index === -1) return { result: "miss" };
    var ls = levelState(state.level);
    if (ls.open[index]) return { result: "repeat", index: index };
    ls.open[index] = 1;
    save();
    return { result: "hit", index: index };
  }

  function completeLevel() {
    var reward = 0;
    if (!state.done[state.level]) {
      state.done[state.level] = 1;
      reward = LEVEL_REWARD;
      state.coins += reward;
    }
    if (state.level + 1 > state.progress) state.progress = state.level + 1;
    save();
    return reward;
  }

  /* ---------- звук ---------- */

  function beep(freq, duration, type) {
    if (!state.sound) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = type || "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration + 0.02);
    } catch (e) { /* без звук */ }
  }

  function soundHit() { beep(880, 0.12); setTimeout(function () { beep(1320, 0.14); }, 90); }
  function soundMiss() { beep(180, 0.16, "square"); }
  function soundCoin() { beep(1100, 0.08); }
  function soundLevel() {
    beep(660, 0.12);
    setTimeout(function () { beep(880, 0.12); }, 110);
    setTimeout(function () { beep(1320, 0.22); }, 220);
  }

  /* ---------- изглед ---------- */

  function screen(name) {
    ["home", "levels", "game"].forEach(function (id) {
      els["screen-" + id].hidden = id !== name;
    });
    if (name === "levels") { setTheme("purple"); renderLevels(); }
    if (name === "home") setTheme(null);
    if (name === "game") renderGame();
    renderCoins();
  }

  function renderCoins() {
    var nodes = document.querySelectorAll(".js-coins");
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = String(state.coins);
    els["btn-reveal"].disabled = state.coins < ANSWER_COST;
  }

  function levelColor(levelNumber) {
    return ["green", "purple", "red", "yellow", "blue"][levelNumber % 5];
  }

  var THEME_TINT = {
    purple: "#e7d9f0", red: "#fbd9d7", yellow: "#fef1cd", blue: "#d9e6fd", green: "#d6eddc"
  };

  function setTheme(color) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", color ? THEME_TINT[color] : "#ffffff");
  }

  function renderLevels() {
    els["levels-title"].textContent = doneCount() + "/" + QUESTIONS.length;
    var grid = els["level-grid"];
    grid.innerHTML = "";
    for (var i = 0; i < QUESTIONS.length; i++) {
      var number = i + 1;
      var btn = document.createElement("button");
      btn.className = "level-cell c-" + levelColor(number);
      btn.textContent = String(number);
      btn.dataset.level = String(i);
      if (state.done[i]) {
        btn.classList.add("is-done");
        btn.insertAdjacentHTML("beforeend",
          '<svg class="tick" viewBox="0 0 24 24"><use href="#i-check"/></svg>');
      }
      if (!isUnlocked(i)) { btn.classList.add("is-locked"); btn.disabled = true; }
      grid.appendChild(btn);
    }
  }

  function answerMarkup(index) {
    var ls = levelState(state.level);
    var answer = currentQuestion().answers[index];
    if (ls.open[index]) return { text: answer.text, open: true };
    var hint = ls.hints[index];
    if (!hint.n) return { text: "", open: false };
    var out = "";
    for (var i = 0; i < answer.text.length; i++) {
      var ch = answer.text.charAt(i);
      if (ch === " ") out += " ";
      else if (hint.letters.indexOf(i) !== -1) out += ch;
      else out += "_";
    }
    return { text: out, open: false };
  }

  /* Въпросът стои на един ред, както на снимките, и се смалява ако не се събира. */
  function unit() {
    return Math.min(window.innerWidth, 480) / 393;
  }

  function fitQuestion() {
    var el = els["question"];
    var u = unit();
    var size = 23 * u;
    el.style.whiteSpace = "nowrap";
    el.style.fontSize = size + "px";
    while (size > 16 * u && el.scrollWidth > el.clientWidth) {
      size -= 0.5 * u;
      el.style.fontSize = size + "px";
    }
    if (el.scrollWidth > el.clientWidth) {
      el.style.whiteSpace = "normal";
      el.style.fontSize = (20 * u) + "px";
    }
  }

  function renderGame() {
    var q = currentQuestion();
    var number = state.level + 1;
    var color = levelColor(number);
    els["screen-game"].className = "screen c-" + color;
    els["overlay"].className = "overlay c-" + color;
    setTheme(color);
    els["game-title"].textContent = String(number);
    els["question"].textContent = q.question;
    fitQuestion();
    var list = els["answers"];
    list.innerHTML = "";
    for (var i = 0; i < 5; i++) {
      var view = answerMarkup(i);
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.className = "answer shade-" + (i + 1);
      btn.dataset.index = String(i);
      btn.textContent = view.text;
      if (view.open) btn.classList.add("is-open");
      else if (view.text) btn.classList.add("is-hint");
      li.appendChild(btn);
      list.appendChild(li);
    }
    renderCoins();
  }

  function flashInput() {
    var field = els["guess"];
    field.classList.remove("is-wrong");
    void field.offsetWidth;
    field.classList.add("is-wrong");
    setTimeout(function () { field.classList.remove("is-wrong"); }, 500);
  }

  function pulseAnswer(index, cls) {
    var btn = els["answers"].querySelector('[data-index="' + index + '"]');
    if (!btn) return;
    btn.classList.remove(cls);
    void btn.offsetWidth;
    btn.classList.add(cls);
    setTimeout(function () { btn.classList.remove(cls); }, 600);
  }

  function showOverlay(kind, reward) {
    var last = state.level >= QUESTIONS.length - 1;
    els["overlay"].hidden = false;
    els["overlay"].dataset.kind = kind;
    if (kind === "end") {
      els["overlay-title"].textContent = "Край!";
      els["overlay-text"].textContent = "Изигра всички " + QUESTIONS.length + " нива.";
      els["overlay-next"].textContent = "Нулирай прогреса";
      els["overlay-next"].dataset.action = "reset";
    } else {
      els["overlay-title"].textContent = "Ниво завършено!";
      els["overlay-text"].textContent = reward ? "+" + reward + " монети" : "";
      els["overlay-next"].textContent = "Следващо ниво";
      els["overlay-next"].dataset.action = "next";
    }
    return last;
  }

  function hideOverlay() {
    els["overlay"].hidden = true;
  }

  function afterOpen() {
    if (!isLevelDone(state.level)) return;
    var last = state.level >= QUESTIONS.length - 1;
    var reward = completeLevel();
    renderCoins();
    setTimeout(function () {
      soundLevel();
      showOverlay(last ? "end" : "level", reward);
    }, 500);
  }

  /* ---------- събития ---------- */

  function onSubmit(event) {
    event.preventDefault();
    var field = els["guess"];
    var value = field.value;
    if (!value.trim()) return;
    var res = submitGuess(value);
    if (res.result === "hit") {
      field.value = "";
      renderGame();
      pulseAnswer(res.index, "just-opened");
      soundHit();
      afterOpen();
    } else if (res.result === "repeat") {
      field.value = "";
      pulseAnswer(res.index, "just-opened");
    } else {
      flashInput();
      soundMiss();
      field.value = "";
    }
    field.focus();
  }

  function onAnswerClick(event) {
    var btn = event.target.closest ? event.target.closest(".answer") : null;
    if (!btn) return;
    var index = Number(btn.dataset.index);
    var res = buyLetter(index);
    if (res === "coins") { flashCoins(); return; }
    if (res !== "ok") return;
    renderGame();
    soundCoin();
    afterOpen();
  }

  function flashCoins() {
    var bar = document.querySelector(".screen:not([hidden]) .coins");
    if (!bar) return;
    bar.classList.remove("is-empty");
    void bar.offsetWidth;
    bar.classList.add("is-empty");
    setTimeout(function () { bar.classList.remove("is-empty"); }, 600);
  }

  function onReveal() {
    var res = buyAnswer();
    if (res === "coins") { flashCoins(); return; }
    if (typeof res !== "number") return;
    renderGame();
    pulseAnswer(res, "just-opened");
    soundCoin();
    afterOpen();
  }

  function onOverlayNext() {
    var action = els["overlay-next"].dataset.action;
    hideOverlay();
    if (action === "reset") {
      resetAll();
      screen("home");
      return;
    }
    state.level = Math.min(state.level + 1, QUESTIONS.length - 1);
    save();
    screen("game");
    els["guess"].focus();
  }

  function bind() {
    ["screen-home", "screen-levels", "screen-game", "level-grid", "levels-title",
     "game-title", "question", "guess", "answers", "btn-reveal", "overlay",
     "overlay-title", "overlay-text", "overlay-next"].forEach(function (id) {
      els[id] = document.getElementById(id);
    });

    document.getElementById("btn-play").addEventListener("click", function () {
      screen("game");
    });
    document.getElementById("btn-levels").addEventListener("click", function () {
      screen("levels");
    });
    document.getElementById("btn-reset").addEventListener("click", function () {
      if (window.confirm("Да изтрия ли целия прогрес?")) {
        resetAll();
        screen("home");
      }
    });
    document.getElementById("btn-sound").addEventListener("click", function () {
      state.sound = !state.sound;
      save();
      renderSound();
      if (state.sound) soundCoin();
    });
    document.getElementById("levels-back").addEventListener("click", function () {
      screen("home");
    });
    document.getElementById("game-back").addEventListener("click", function () {
      screen("levels");
    });
    els["level-grid"].addEventListener("click", function (event) {
      var cell = event.target.closest ? event.target.closest(".level-cell") : null;
      if (!cell || cell.disabled) return;
      state.level = Number(cell.dataset.level);
      save();
      screen("game");
    });
    var shareBtns = document.querySelectorAll(".js-share");
    for (var s2 = 0; s2 < shareBtns.length; s2++) {
      shareBtns[s2].addEventListener("click", onShare);
    }
    document.getElementById("guess-form").addEventListener("submit", onSubmit);
    els["answers"].addEventListener("click", onAnswerClick);
    els["btn-reveal"].addEventListener("click", onReveal);
    els["overlay-next"].addEventListener("click", onOverlayNext);
  }

  function onShare() {
    var data = { title: "Познай 5", text: "Играй Познай 5", url: location.href };
    if (navigator.share) {
      navigator.share(data).catch(function () { /* отказано */ });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(location.href).catch(function () { /* без клипборд */ });
    }
  }

  function renderSound() {
    document.getElementById("btn-sound").classList.toggle("is-off", !state.sound);
  }

  function onResize() {
    if (!els["screen-game"].hidden) fitQuestion();
  }

  function init() {
    state = load();
    bind();
    renderSound();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    screen("home");
  }

  document.addEventListener("DOMContentLoaded", init);

  if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* без офлайн */ });
    });
  }

  /* за тестове от конзолата */
  window.POZNAY = {
    getState: function () { return state; },
    submitGuess: submitGuess,
    buyLetter: buyLetter,
    buyAnswer: buyAnswer,
    resetAll: function () { resetAll(); screen("home"); },
    screen: screen
  };
})();
