/* Познай 5 — тестове за matchAnswer. Резултатите излизат в конзолата. */

var TEST_CASES = [
  /* въпрос, вход, очакван индекс, какво проверява */
  [1, "Рак", 1, "точно съвпадение"],
  [1, "  Сърдечен, УДАР!! ", 0, "нормализация: интервали, пунктуация, главни букви"],
  [1, "инфаркт", 0, "съвпадение през accept"],
  [1, "сърце", 0, "съвпадение през accept"],
  [1, "белодробно заболяване", 2, "accept с два думи"],
  [1, "syrdechen udar", 0, "шльокавица: y=ъ, ch=ч"],
  [1, "insult", 4, "шльокавица: 1:1 букви"],
  [1, "инсулта", 4, "определителен член -а"],
  [1, "рака", 1, "определителен член при къса дума"],
  [1, "инсулд", 4, "Левенщайн 1 при 6 букви"],
  [1, "бак", -1, "къса дума не минава през fuzzy"],
  [1, "динозавър", -1, "няма съвпадение"],

  [2, "ski", 0, "шльокавица за къс отговор"],
  [2, "6eina", 1, "цифра 6=ш + Левенщайн 1"],
  [2, "снежни топки", 2, "accept"],
  [2, "snejen chovek", 3, "шльокавица: j=ж, ch=ч"],
  [2, "чистене на сняг", 4, "accept с три думи"],
  [2, "пързаляне", 1, "accept, част от израза"],

  [3, "колата", 0, "член, изрично в accept"],
  [3, "kola", 0, "шльокавица"],
  [3, "телефонът", 2, "определителен член -ът"],
  [3, "пари", 1, "точно съвпадение, 4 букви"],
  [3, "пара", -1, "4 букви - без fuzzy"],
  [3, "четка", 4, "accept"],

  [4, "kotka", 1, "шльокавица"],
  [4, "мачка", 1, "accept"],
  [4, "хамстър", 4, "Левенщайн 1 при 7 букви"],
  [4, "папагала", 3, "определителен член -а при 8 букви"],
  [4, "морско свинче", 4, "accept с две думи"],

  [5, "ябълката", 0, "accept"],
  [5, "qbalka", 0, "шльокавица q=я + Левенщайн 1"],
  [5, "партокал", 2, "Левенщайн 1 при 8 букви"],
  [5, "партакал", 2, "Левенщайн 2 при 8 букви"],
  [5, "портокалът", 2, "определителен член -ът"],
  [5, "гроздето", 3, "accept"],
  [5, "", -1, "празен вход"],
  [5, "   ", -1, "само интервали"]
];

function findQuestion(id) {
  for (var i = 0; i < QUESTIONS.length; i++) {
    if (QUESTIONS[i].id === id) return QUESTIONS[i];
  }
  return null;
}

function runTests(report) {
  var passed = 0;
  var failed = 0;
  for (var i = 0; i < TEST_CASES.length; i++) {
    var c = TEST_CASES[i];
    var q = findQuestion(c[0]);
    var got = matchAnswer(c[1], q.answers);
    var ok = got === c[2];
    if (ok) passed++; else failed++;
    var line =
      (ok ? "OK   " : "ГРЕШКА ") +
      "въпрос " + c[0] + "  \"" + c[1] + "\"  ->  " + got +
      (ok ? "" : "  (очаквано " + c[2] + ")") +
      "   [" + c[3] + "]";
    report(line, ok);
  }
  report("", true);

  /* Проверка на самите въпроси: всеки text и всеки accept трябва да отваря
     своето поле, а не друго. Хваща сблъсъци при добавяне на нови въпроси. */
  var checked = 0;
  for (var q = 0; q < QUESTIONS.length; q++) {
    var question = QUESTIONS[q];
    for (var a = 0; a < question.answers.length; a++) {
      var variants = [question.answers[a].text].concat(question.answers[a].accept || []);
      for (var v = 0; v < variants.length; v++) {
        var got = matchAnswer(variants[v], question.answers);
        checked++;
        if (got !== a) {
          failed++;
          report("ГРЕШКА ниво " + question.id + ': "' + variants[v] + '" (поле ' +
            (a + 1) + ") отваря поле " + (got + 1), false);
        }
      }
    }
    if (question.answers.length !== 5) {
      failed++;
      report("ГРЕШКА ниво " + question.id + ": " + question.answers.length + " отговора вместо 5", false);
    }
  }
  report("Проверени отговора в " + QUESTIONS.length + " нива: " + checked, true);
  report("", true);

  report("Общо: " + TEST_CASES.length + ", успешни: " + passed + ", неуспешни: " + failed, failed === 0);
  return { passed: passed, failed: failed, total: TEST_CASES.length };
}
