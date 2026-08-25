/* Познай 5 — разпознаване на отговори.
   matchAnswer(input, answers) -> индекс на уцеленото поле или -1.

   Ред на проверките (спира при първо съвпадение):
     1. Нормализация (trim, малки букви, без пунктуация, единични интервали)
     2. Ако е писано на латиница -> транслитерация към кирилица (сравняват се и двете форми)
     3. Точно съвпадение с text или с елемент от accept
     4. Махане на определителния член в края и нов опит
     5. Левенщайн: <=1 за 5-7 букви, <=2 за 8+; под 5 букви няма fuzzy */

/* --- 1. нормализация --- */
function normalize(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[^0-9a-zЀ-ӿ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* --- 2. шльокавица -> кирилица --- */
var TRANSLIT_MULTI = [
  ["sht", "щ"],
  ["sh", "ш"],
  ["ch", "ч"],
  ["zh", "ж"],
  ["ts", "ц"],
  ["yu", "ю"],
  ["ya", "я"]
];

var TRANSLIT_SINGLE = {
  a: "а", b: "б", c: "ц", d: "д", e: "е", f: "ф", g: "г", h: "х",
  i: "и", j: "ж", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п",
  q: "я", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "х",
  y: "ъ", z: "з", "4": "ч", "6": "ш"
};

function hasLatin(text) {
  return /[a-z]/.test(text);
}

function transliterate(text) {
  var out = "";
  var i = 0;
  while (i < text.length) {
    var matched = false;
    for (var m = 0; m < TRANSLIT_MULTI.length; m++) {
      var pair = TRANSLIT_MULTI[m];
      if (text.substr(i, pair[0].length) === pair[0]) {
        out += pair[1];
        i += pair[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    var ch = text.charAt(i);
    out += Object.prototype.hasOwnProperty.call(TRANSLIT_SINGLE, ch) ? TRANSLIT_SINGLE[ch] : ch;
    i++;
  }
  return out;
}

/* --- 4. определителен член --- */
var ARTICLES = ["ът", "та", "то", "те", "я", "а"];

function stripArticle(word) {
  for (var i = 0; i < ARTICLES.length; i++) {
    var art = ARTICLES[i];
    if (word.length - art.length >= 3 && word.slice(-art.length) === art) {
      return word.slice(0, word.length - art.length);
    }
  }
  return word;
}

function stripArticles(phrase) {
  if (!phrase) return phrase;
  return phrase.split(" ").map(stripArticle).join(" ");
}

/* --- 5. Левенщайн --- */
function levenshtein(a, b) {
  var la = a.length;
  var lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  var prev = new Array(lb + 1);
  var curr = new Array(lb + 1);
  for (var j = 0; j <= lb; j++) prev[j] = j;
  for (var i = 1; i <= la; i++) {
    curr[0] = i;
    for (var k = 1; k <= lb; k++) {
      var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
      curr[k] = Math.min(curr[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
    }
    for (var c = 0; c <= lb; c++) prev[c] = curr[c];
  }
  return prev[lb];
}

function fuzzyEqual(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  var la = a.length;
  var lb = b.length;
  if (Math.min(la, lb) < 5) return false;
  var limit = Math.max(la, lb) <= 7 ? 1 : 2;
  if (Math.abs(la - lb) > limit) return false;
  return levenshtein(a, b) <= limit;
}

/* --- сглобяване --- */
function answerVariants(answer) {
  var list = [answer.text].concat(answer.accept || []);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var norm = normalize(list[i]);
    if (norm && out.indexOf(norm) === -1) out.push(norm);
  }
  return out;
}

function inputVariants(input) {
  var norm = normalize(input);
  if (!norm) return [];
  var out = [norm];
  if (hasLatin(norm)) {
    var cyr = transliterate(norm);
    if (cyr !== norm) out.push(cyr);
  }
  return out;
}

function matchAnswer(input, answers) {
  var forms = inputVariants(input);
  if (!forms.length || !answers || !answers.length) return -1;

  var variants = [];
  var i, f, v;
  for (i = 0; i < answers.length; i++) variants.push(answerVariants(answers[i]));

  /* 3. точно съвпадение */
  for (i = 0; i < variants.length; i++) {
    for (f = 0; f < forms.length; f++) {
      for (v = 0; v < variants[i].length; v++) {
        if (forms[f] === variants[i][v]) return i;
      }
    }
  }

  /* 4. без определителен член */
  var strippedForms = forms.map(stripArticles);
  for (i = 0; i < variants.length; i++) {
    for (f = 0; f < strippedForms.length; f++) {
      for (v = 0; v < variants[i].length; v++) {
        if (strippedForms[f] === stripArticles(variants[i][v])) return i;
      }
    }
  }

  /* 5. Левенщайн */
  for (i = 0; i < variants.length; i++) {
    for (f = 0; f < forms.length; f++) {
      for (v = 0; v < variants[i].length; v++) {
        if (fuzzyEqual(forms[f], variants[i][v])) return i;
        if (fuzzyEqual(strippedForms[f], stripArticles(variants[i][v]))) return i;
      }
    }
  }

  return -1;
}
