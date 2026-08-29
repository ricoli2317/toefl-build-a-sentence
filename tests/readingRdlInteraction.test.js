const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  calculateReadingElapsedSeconds,
  createReadingNavigation,
  moveReadingNavigation,
  setReadingAnswer
} = require("../lib/reading/practiceState.ts");
const { toStudentReadingPracticePayload } = require("../lib/reading/studentPractice.ts");

function rdlPackage() {
  const source = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../data/reading/fixtures/reading-source.fixture.json"),
    "utf8"
  ));
  const packageData = structuredClone(groupReadingSourceOccurrences(source.occurrences).packages.find(
    (candidate) => candidate.item.module === "rdl"
  ));
  packageData.materials[0] = {
    ...packageData.materials[0],
    materialId: "RDL-999",
    bindingStatus: "bound",
    imageAssetPath: "reading/rdl/RDL-999/material_final.png",
    hitboxDataPath: "reading/rdl/RDL-999/selection_map.json"
  };
  for (const question of packageData.questions) question.payload.materialId = "RDL-999";
  return packageData;
}

test("RDL payload shares one resolved material across its structured question group", () => {
  const packageData = rdlPackage();
  const firstQuestion = packageData.questions[0];
  packageData.questions.push({
    ...structuredClone(firstQuestion),
    questionId: `${firstQuestion.questionId}-second`,
    questionOrder: 2,
    stem: "A second question about the same material"
  });
  packageData.item.questionCount = 2;
  packageData.item.scoredItemCount = 2;

  const payload = toStudentReadingPracticePayload(packageData, "https://assets.example.com");
  assert.equal(payload.material.materialId, "RDL-999");
  assert.equal(payload.material.imageUrl, "https://assets.example.com/reading/rdl/RDL-999/material_final.png");
  assert.equal(payload.material.selectionMapUrl, "https://assets.example.com/reading/rdl/RDL-999/selection_map.json");
  assert.equal(payload.questions.length, 2);
  assert.ok(payload.questions.every((question) => question.questionType === "rdl"));
  assert.equal(JSON.stringify(payload).includes("correctOptionId"), false);
});

test("RDL single-choice answers replace per question and survive previous/next navigation", () => {
  const startedAt = 20_000;
  let answers = {};
  let navigation = createReadingNavigation("rdl", 2, 2);

  answers = setReadingAnswer(answers, "question-1", { kind: "choice", optionId: "option-1" });
  answers = setReadingAnswer(answers, "question-1", { kind: "choice", optionId: "option-3" });
  navigation = moveReadingNavigation(navigation, 1);
  answers = setReadingAnswer(answers, "question-2", { kind: "choice", optionId: "option-2" });
  navigation = moveReadingNavigation(navigation, -1);

  assert.equal(navigation.currentIndex, 0);
  assert.deepEqual(answers["question-1"], { kind: "choice", optionId: "option-3" });
  assert.deepEqual(answers["question-2"], { kind: "choice", optionId: "option-2" });
  assert.equal(calculateReadingElapsedSeconds(startedAt, 27_900), 7);
});

test("RDL workspace uses the shared fixed 52:48 shell and separator-free custom radios", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const rdlSource = source.slice(
    source.indexOf("function RdlPracticeWorkspace"),
    source.indexOf("function sameRdlRect")
  );

  assert.match(source, /testId="rdl-workspace"/);
  assert.match(source, /function ReadingTwoColumnPracticeShell/);
  assert.match(source, /lg:grid-cols-\[minmax\(0,52fr\)_minmax\(0,48fr\)\]/);
  assert.match(source, /src=\{material\.imageUrl\}/);
  assert.match(source, /object-contain/);
  assert.match(rdlSource, /items-start justify-center/);
  assert.match(rdlSource, /style=\{\{ objectPosition: "center top" \}\}/);
  assert.match(rdlSource, /top: imageBounds\.top - stageBounds\.top/);
  assert.match(rdlSource, /title=\{material\.materialType[\s\S]*?rdlMaterialInstruction\(material\.materialType\)/);
  assert.doesNotMatch(rdlSource, />Read in Daily Life</);
  assert.doesNotMatch(source, /object-cover/);
  assert.doesNotMatch(rdlSource, /Click a word or drag across characters|<figcaption/);
  assert.doesNotMatch(source, /lg:divide-x|lg:grid-cols-\[minmax\(0,1\.18fr\)/);
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /role="radio"/);
  assert.match(source, /aria-checked=\{selected\}/);
  assert.match(source, /<span className="font-normal">\{option\.text\}<\/span>/);
  assert.match(source, /onSelect=\{\(optionId\) => onAnswerChange\(question\.questionId, \{ kind: "choice", optionId \}\)\}/);
  assert.match(source, /function ChoiceOptionList/);
  const choices = source.slice(source.indexOf("function ChoiceOptionList"), source.indexOf("function ReadingQuestionNavigation"));
  assert.doesNotMatch(choices, /border-y|optionIndex|border-t/);
  assert.doesNotMatch(source, /String\.fromCharCode|optionIndex \+ 65|r2\.dev|\/Users\/rico\/Desktop/);
});
