// Synthetic browser fixtures, NOT canonical Reading assets or production data.
const categories = ["事实信息题","否定信息题","主旨题","词汇题","选句题","句子简化题","指代题","推断题","修辞目的题","句子插入题"];
const category = "推断题";
function fixtureContent(groupIndex) {
  const id = `reading-rap-${String(groupIndex + 1).padStart(24, "0")}`;
  const paragraphId = `paragraph-${groupIndex}`;
  const sentences = [0,1,2].map((i) => ({ sentenceId: `sentence-${groupIndex}-${i}`, sentenceOrder: i + 1, text: [
    "Researchers compared the growth of plants in two controlled environments.",
    "Plants receiving more sunlight grew faster than those kept in the shade.",
    "The study suggests that access to sunlight can influence plant growth."
  ][i] }));
  const questions = Array.from({ length: 5 }, (_, i) => ({
    questionId: `question-${groupIndex}-${i}`, questionOrder: i + 1, questionType: "rap_multiple_choice",
    stem: `What can be inferred from this study? (source ${groupIndex + 1}, target ${i + 1})`, highlightRanges: [],
    options: [{ optionId: `option-${groupIndex}-${i}-a`, optionLabel: "A", text: "Access to sunlight influenced growth." },
      { optionId: `option-${groupIndex}-${i}-b`, optionLabel: "B", text: "All plants grew at the same rate." }]
  }));
  return {
    item: { itemId: id, module: "rap", title: `Synthetic Passage ${groupIndex + 1}`, productName: "Read an Academic Passage", questionCount: 5, scoringPointCount: 5 },
    material: null, passage: { passageId: `passage-${groupIndex}`, title: `Synthetic Passage ${groupIndex + 1}`,
      paragraphs: [{ paragraphId, paragraphOrder: 1, text: sentences.map((s) => s.text).join(" "), sentences }] }, questions
  };
}
function createFixtureServer() {
  const content = Array.from({ length: 7 }, (_, index) => fixtureContent(index));
  const sessions = new Map();
  const calls = [];
  let sequence = 0;
  function create(questionCategory, amount) {
    const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    const groups = content.slice(0, Math.ceil(amount / 3)).map((practice, index) => ({
      logicalItemId: practice.item.itemId, title: practice.item.title,
      targets: practice.questions.slice(0, Math.min(3, amount - index * 3)).map((q) => ({ questionId: q.questionId, slotId: null }))
    }));
    const payload = { session: { sessionId: id, questionCategory, amount, groups, progress: {}, status: "active",
      elapsedSeconds: 0, totalPoints: 0, correctPoints: 0, createdAt: new Date().toISOString(), completedAt: null, draft: {} }, answers: [] };
    sessions.set(id, payload); return payload;
  }
  return { content, sessions, calls, categories, create,
    handle(url, method, body) {
      calls.push({ path: url.pathname, method });
      if (url.pathname === "/api/reading/question-category") {
        if (method === "GET") return { categories: categories.map((name, i) => ({ questionCategory: name, count: i === 0 ? 8 : 35 })) };
        return create(body.questionCategory, body.amount);
      }
      const match = url.pathname.match(/^\/api\/reading\/question-category\/sessions\/([^/]+)(?:\/groups\/([^/]+)(\/review)?)?$/);
      if (match) {
        const payload = sessions.get(match[1]);
        if (!payload) return { error: "Fixture session not found" };
        if (!match[2]) return payload;
        const itemId = decodeURIComponent(match[2]);
        const group = payload.session.groups.find((g) => g.logicalItemId === itemId);
        if (method === "PATCH") { payload.session.draft = { logicalItemId: itemId, workspace: body }; return { saved: true }; }
        if (match[3]) {
          const rows = payload.answers.filter((answer) => answer.logicalItemId === itemId).map((a) => ({ attempt_answer_id: a.answerId,
            question_id: a.questionId, slot_id: null, answer_kind: a.answerKind, student_answer: a.studentAnswer,
            is_correct: a.isCorrect, question_time_seconds: a.questionTimeSeconds }));
          const disclosures = Object.fromEntries(rows.map((row) => [row.attempt_answer_id, {
            correctAnswer: { kind: "text", text: "Access to sunlight influenced growth." }, studentAnswer: row.student_answer ? "Access to sunlight influenced growth." : "未作答",
            reviewState: { kind: "choice", correctAnswerId: `${row.question_id.replace('question', 'option')}-a`, studentAnswerId: row.student_answer }
          }]));
          return { rows, disclosures };
        }
        const alreadySubmitted = Boolean(payload.session.progress[itemId]);
        if (!alreadySubmitted) {
          const newAnswers = group.targets.map((target, index) => {
            const a = body.answers.find((a) => a.questionId === target.questionId);
            return { answerId: `${match[1]}-${itemId}-${index}`, questionId: target.questionId, logicalItemId: itemId,
              answerKind: a.kind, studentAnswer: a.studentAnswer || null, isCorrect: Boolean(a.studentAnswer?.endsWith("-a")), questionTimeSeconds: a.questionTimeSeconds };
          });
          payload.answers.push(...newAnswers);
          const progress = { correctPoints: newAnswers.filter((a) => a.isCorrect).length, totalPoints: newAnswers.length, elapsedSeconds: body.elapsedSeconds, submittedAt: new Date().toISOString() };
          payload.session.progress[itemId] = progress;
          payload.session.correctPoints += progress.correctPoints;
          payload.session.totalPoints += progress.totalPoints;
          payload.session.elapsedSeconds += progress.elapsedSeconds;
          payload.session.draft = {};
          if (payload.session.groups.every((g) => payload.session.progress[g.logicalItemId])) {
            payload.session.status = "completed"; payload.session.completedAt = progress.submittedAt;
          }
        }
        return { alreadySubmitted, session: payload.session, group: payload.session.progress[itemId], answers: payload.answers.filter((a) => a.logicalItemId === itemId) };
      }
      const practice = content.find((practice) => url.pathname === `/api/reading/practice/${practice.item.itemId}`);
      if (practice) return { practice };
      return null;
    }
  };
}
module.exports = { createFixtureServer, category };
