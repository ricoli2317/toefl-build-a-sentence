const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WritingIdeaAssistantError,
  buildWritingIdeaSelection,
  countHanCharacters,
  getEmailRequirements,
  getWritingIdeaAssistantResult,
  isRequirementEcho,
  normalizeIdeaText,
  normalizeWritingIdeaPool,
  selectEmailIdeaDetails,
  writingIdeaSlotsConflict
} = require("../lib/writingIdeaAssistant.ts");
const {
  buildWritingIdeaMessages,
  generateWritingIdeaPool,
  getWritingIdeaAiConfig,
  parseWritingIdeaJson
} = require("../lib/writingIdeaAssistantAi.ts");
const {
  buildCustomWritingQuestionSnapshot
} = require("../lib/writingAssignments.ts");

const CHINESE_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

function reasons(prefix) {
  return CHINESE_NUMERALS.map((numeral) => `${prefix}的具体理由${numeral}`);
}

function generalDetails(label, count = 8) {
  return Array.from({ length: count }, (_, index) => ({
    text: `${label}第${index + 1}条具体细节`,
    slot: "general"
  }));
}

const conflictingDetails = [
  { text: "下周三下午三点面谈", slot: "proposed_datetime" },
  { text: "下周四上午十点视频", slot: "proposed_datetime" },
  { text: "下周三这一天的安排", slot: "proposed_date" },
  { text: "下周五这一天的安排", slot: "proposed_date" },
  { text: "下午三点左右开始", slot: "proposed_time" },
  { text: "上午十点左右开始", slot: "proposed_time" },
  { text: "在学校咖啡厅见面", slot: "location" },
  { text: "通过视频会议进行", slot: "interview_method" },
  { text: "大约持续半个小时", slot: "duration" },
  { text: "顺便带上采访提纲", slot: "general" },
  { text: "提前准备几个问题", slot: "general" },
  { text: "邀请摄影同学同行", slot: "participant" }
];

function academicQuestion() {
  return {
    question_id: "ad-1",
    set_id: "ad-set-1",
    set_title: "Discussion Set 1",
    year_month: "202611",
    source_labels: "official",
    professor_name: "Dr. Lee",
    professor_prompt: "Should companies consider all groups affected by their decisions?",
    student_1_name: "Paul",
    student_1_response: "Companies should focus on shareholder profits.",
    student_2_name: "Kelly",
    student_2_response: "Companies should consider employees and communities."
  };
}

function emailQuestion(overrides = {}) {
  return {
    question_id: "email-1",
    set_id: "email-set-1",
    set_title: "Email Set 1",
    year_month: "202611",
    source_labels: "official",
    scenario: "You attended a guest lecture and want to interview the speaker.",
    task_instruction: "Write an email to Dr. Green.",
    requirement_1: "Explain what you liked about the lecture.",
    requirement_2: "Request an interview with a specific date and time.",
    requirement_3: "Describe the purpose of the interview.",
    closing_instruction: "Use an appropriate closing.",
    recipient: "Dr. Green",
    subject: "Interview request",
    ...overrides
  };
}

function academicPool() {
  return {
    side_a_reasons: reasons("支持甲方"),
    side_b_reasons: reasons("支持乙方")
  };
}

function emailPool() {
  return {
    requirements: [
      { index: 1, details: generalDetails("喜欢讲座", 8) },
      { index: 2, details: conflictingDetails },
      { index: 3, details: generalDetails("采访目的", 8) }
    ]
  };
}

function academicAttempt(overrides = {}) {
  return {
    attempt_id: "attempt-ad-1",
    user_id: "student-1",
    task_type: "academic_discussion",
    question_id: "ad-1",
    writing_mode: "practice",
    status: "draft",
    attempt_kind: "original",
    assignment_id: null,
    ...overrides
  };
}

function emailAttempt(overrides = {}) {
  return {
    attempt_id: "attempt-email-1",
    user_id: "student-1",
    task_type: "email",
    question_id: "email-1",
    writing_mode: "practice",
    status: "draft",
    attempt_kind: "original",
    assignment_id: null,
    ...overrides
  };
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function createMemoryRepository({
  claim,
  initialSelection = null
} = {}) {
  let selection = initialSelection;
  let poolContent = null;
  let poolId = "pool-1";
  let tokenCounter = 0;
  const calls = { load: 0, claim: 0, save: 0, complete: 0, fail: 0 };
  const identities = [];

  return {
    calls,
    identities,
    get poolContent() {
      return poolContent;
    },
    async loadSelection() {
      calls.load += 1;
      return selection;
    },
    async claimPool(identity) {
      calls.claim += 1;
      identities.push(identity);
      if (claim) return claim(identity, calls.claim);
      tokenCounter += 1;
      return { kind: "claimed", poolId, token: `token-${tokenCounter}` };
    },
    async completePool(input) {
      calls.complete += 1;
      poolContent = input.content;
      poolId = input.poolId;
      return true;
    },
    async failPool() {
      calls.fail += 1;
      return true;
    },
    async saveSelection(input) {
      calls.save += 1;
      if (selection) return selection;
      selection = input.selection;
      return selection;
    }
  };
}

function generated(raw, model = "fake-model") {
  return async () => ({ raw, model });
}

test("AD pool accepts 10-12 reasons per side and selects exactly 3 each", () => {
  const pool = normalizeWritingIdeaPool({
    raw: academicPool(),
    taskType: "academic_discussion",
    question: academicQuestion()
  });
  assert.equal(pool.side_a_reasons.length, 10);
  assert.equal(pool.side_b_reasons.length, 10);

  const selection = buildWritingIdeaSelection(pool, lcg(7));
  assert.equal(selection.task_type, "academic_discussion");
  assert.equal(selection.sides.length, 2);
  assert.equal(selection.sides[0].reasons.length, 3);
  assert.equal(selection.sides[1].reasons.length, 3);
  assert.deepEqual(
    selection.sides.map((side) => side.key),
    ["a", "b"]
  );
});

test("AD pool rejects insufficient, duplicate, long, English and mechanical content", () => {
  assert.throws(() => normalizeWritingIdeaPool({
    raw: {
      side_a_reasons: reasons("支持甲方").slice(0, 9),
      side_b_reasons: reasons("支持乙方")
    },
    taskType: "academic_discussion",
    question: academicQuestion()
  }));

  assert.throws(() => normalizeWritingIdeaPool({
    raw: {
      side_a_reasons: [
        ...reasons("支持甲方").slice(0, 9),
        reasons("支持甲方")[0]
      ],
      side_b_reasons: reasons("支持乙方")
    },
    taskType: "academic_discussion",
    question: academicQuestion()
  }));

  const longReason = "教授介绍了某城市过去十年气温不断升高的现象并说明全球变暖严重程度";
  assert.throws(() => normalizeWritingIdeaPool({
    raw: {
      side_a_reasons: Array(10).fill(longReason),
      side_b_reasons: reasons("支持乙方")
    },
    taskType: "academic_discussion",
    question: academicQuestion()
  }));

  assert.throws(() => normalizeWritingIdeaPool({
    raw: {
      side_a_reasons: [
        "I really enjoyed the lecture because it was useful",
        ...reasons("支持甲方").slice(1)
      ],
      side_b_reasons: reasons("支持乙方")
    },
    taskType: "academic_discussion",
    question: academicQuestion()
  }));

  assert.throws(() => normalizeWritingIdeaPool({
    raw: {
      side_a_reasons: reasons("支持甲方"),
      side_b_reasons: reasons("支持甲方")
    },
    taskType: "academic_discussion",
    question: academicQuestion()
  }));

  assert.throws(() => normalizeWritingIdeaPool({
    raw: {
      side_a_reasons: reasons("支持甲方"),
      side_b_reasons: reasons("支持甲方").map((reason) => `不${reason}`)
    },
    taskType: "academic_discussion",
    question: academicQuestion()
  }));
});

test("concise text validation rejects explanations, examples and restated instructions", () => {
  assert.equal(normalizeIdeaText("城市极端高温的案例"), "城市极端高温的案例");
  assert.equal(normalizeIdeaText("下午3:00开始面谈"), "下午3:00开始面谈");
  assert.equal(normalizeIdeaText("说明喜欢这场讲座的原因"), null);
  assert.equal(normalizeIdeaText("例如工厂安全培训"), null);
  assert.equal(
    normalizeIdeaText("教授介绍了某城市过去十年气温不断升高的现象并通过数据说明全球变暖"),
    null
  );
  assert.equal(
    normalizeIdeaText("I really enjoyed the lecture because it was useful"),
    null
  );
  assert.equal(
    normalizeIdeaText("城市极端高温的案例\n并说明影响"),
    null
  );
  assert.ok(countHanCharacters("城市极端高温的案例") >= 8);
});

test("requirement echo detection catches restated instructions", () => {
  assert.equal(
    isRequirementEcho("介绍大学气候变化研究项目", "介绍大学气候变化研究项目"),
    true
  );
  assert.equal(
    isRequirementEcho("城市极端高温的案例", "说明喜欢这场讲座的原因"),
    false
  );
});

test("WE pool uses every actual requirement, not a fixed count of three", () => {
  const question = emailQuestion({ requirement_3: "" });
  assert.equal(getEmailRequirements(question).length, 2);

  const pool = normalizeWritingIdeaPool({
    raw: {
      requirements: [
        { index: 1, details: generalDetails("喜欢讲座", 8) },
        { index: 2, details: conflictingDetails }
      ]
    },
    taskType: "email",
    question
  });
  assert.equal(pool.requirements.length, 2);
  assert.equal(pool.requirements[0].requirement, question.requirement_1);
  assert.equal(pool.requirements[1].requirement, question.requirement_2);

  const selection = buildWritingIdeaSelection(pool, lcg(11));
  assert.equal(selection.task_type, "email");
  assert.equal(selection.requirements.length, 2);
  assert.deepEqual(
    selection.requirements.map((requirement) => requirement.index),
    [1, 2]
  );
  for (const requirement of selection.requirements) {
    assert.ok(requirement.details.length >= 2 && requirement.details.length <= 3);
  }
});

test("WE selection always shows 2-3 details and never combines conflicting slots", () => {
  const question = emailQuestion();
  const pool = normalizeWritingIdeaPool({
    raw: emailPool(),
    taskType: "email",
    question
  });
  const slotByText = new Map();
  for (const requirement of pool.requirements) {
    for (const detail of requirement.details) {
      slotByText.set(detail.text, detail.slot);
    }
  }

  for (let seed = 1; seed <= 200; seed += 1) {
    const selection = selectEmailIdeaDetails(pool, lcg(seed));
    assert.ok(selection, `seed ${seed} should produce a selection`);
    assert.deepEqual(
      selection.requirements.map((requirement) => requirement.index),
      [1, 2, 3]
    );
    for (const requirement of selection.requirements) {
      assert.ok(requirement.details.length >= 2 && requirement.details.length <= 3);
    }
    const slots = selection.requirements.flatMap((requirement) =>
      requirement.details.map((detail) => slotByText.get(detail))
    );
    for (let left = 0; left < slots.length; left += 1) {
      for (let right = left + 1; right < slots.length; right += 1) {
        assert.equal(
          writingIdeaSlotsConflict(slots[left], slots[right]),
          false,
          `seed ${seed} combined conflicting slots ${slots[left]} and ${slots[right]}`
        );
      }
    }
  }
});

test("WE selection rejects a pool that cannot produce a conflict-free combination", () => {
  const question = emailQuestion({
    requirement_2: "",
    requirement_3: ""
  });
  const raw = {
    requirements: [
      {
        index: 1,
        details: Array.from({ length: 8 }, (_, index) => ({
          text: `下周三下午${index + 1}点面谈`,
          slot: "proposed_datetime"
        }))
      }
    ]
  };
  assert.throws(() => normalizeWritingIdeaPool({
    raw,
    taskType: "email",
    question
  }));
});

test("AI config defaults to DeepSeek Flash and sends no reasoning request", async () => {
  const config = getWritingIdeaAiConfig({});
  assert.equal(config.provider, "deepseek");
  assert.equal(config.model, "deepseek-v4-flash");

  const requests = [];
  const rawPool = academicPool();
  const { raw } = await generateWritingIdeaPool(
    {
      taskType: "academic_discussion",
      question: academicQuestion(),
      attemptNumber: 1
    },
    {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_API_BASE_URL: "https://deepseek.test",
        WRITING_IDEA_ASSISTANT_MODEL: "deepseek-v4-flash"
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({
          model: "deepseek-v4-flash",
          choices: [{ message: { content: JSON.stringify(rawPool) } }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://deepseek.test/chat/completions");
  assert.equal(requests[0].body.thinking.type, "disabled");
  assert.equal(requests[0].body.reasoning_effort, undefined);
  assert.equal(requests[0].body.response_format.type, "json_object");
  assert.equal(requests[0].body.stream, false);
  assert.deepEqual(raw, rawPool);
});

test("AI prompt is task-specific and JSON parsing accepts fenced objects", () => {
  const academicMessages = buildWritingIdeaMessages({
    taskType: "academic_discussion",
    question: academicQuestion()
  });
  assert.match(academicMessages[0].content, /ONLY the reason/);
  assert.match(academicMessages[1].content, /Student 1 \(Paul\)/);

  const emailMessages = buildWritingIdeaMessages({
    taskType: "email",
    question: emailQuestion()
  });
  assert.match(emailMessages[0].content, /proposed_datetime/);
  assert.match(emailMessages[1].content, /1\. Explain what you liked/);

  assert.deepEqual(
    parseWritingIdeaJson("```json\n{\"side_a_reasons\":[]}\n```"),
    { side_a_reasons: [] }
  );
  assert.throws(() => parseWritingIdeaJson("not json"));
});

test("service returns an existing attempt selection without calling AI", async () => {
  const existingSelection = {
    schema_version: 1,
    task_type: "academic_discussion",
    sides: [
      { key: "a", reasons: reasons("支持甲方").slice(0, 3) },
      { key: "b", reasons: reasons("支持乙方").slice(0, 3) }
    ]
  };
  const repository = createMemoryRepository({ initialSelection: existingSelection });
  let aiCalls = 0;

  const result = await getWritingIdeaAssistantResult(
    {
      attempt: academicAttempt(),
      question: academicQuestion(),
      questionSource: "question_bank",
      assignmentAvailable: true
    },
    {
      repository,
      generatePool: async () => {
        aiCalls += 1;
        return { raw: academicPool(), model: "fake" };
      }
    }
  );

  assert.equal(result.status, "ready");
  assert.equal(result.generated, false);
  assert.deepEqual(result.selection, existingSelection);
  assert.equal(aiCalls, 0);
  assert.deepEqual(repository.calls, {
    load: 1,
    claim: 0,
    save: 0,
    complete: 0,
    fail: 0
  });
});

test("service generates and stores one pool, then reuses the same attempt selection", async () => {
  const repository = createMemoryRepository();
  let aiCalls = 0;
  const dependencies = {
    repository,
    generatePool: async () => {
      aiCalls += 1;
      return { raw: academicPool(), model: "fake-model" };
    },
    rng: lcg(3)
  };

  const first = await getWritingIdeaAssistantResult(
    {
      attempt: academicAttempt(),
      question: academicQuestion(),
      questionSource: "question_bank",
      assignmentAvailable: true
    },
    dependencies
  );
  assert.equal(first.status, "ready");
  assert.equal(first.generated, true);
  assert.equal(aiCalls, 1);
  assert.equal(repository.calls.claim, 1);
  assert.equal(repository.calls.complete, 1);
  assert.equal(repository.calls.save, 1);
  assert.equal(repository.poolContent.side_a_reasons.length, 10);

  const second = await getWritingIdeaAssistantResult(
    {
      attempt: academicAttempt(),
      question: academicQuestion(),
      questionSource: "question_bank",
      assignmentAvailable: true
    },
    dependencies
  );
  assert.equal(second.status, "ready");
  assert.equal(second.generated, false);
  assert.equal(aiCalls, 1);
  assert.deepEqual(second.selection, first.selection);
  assert.equal(repository.calls.claim, 1);
  assert.equal(repository.calls.save, 1);
});

test("service uses an existing ready pool and does not call AI", async () => {
  const rawPool = academicPool();
  const repository = createMemoryRepository({
    claim: async () => ({ kind: "ready", poolId: "pool-ready", content: rawPool })
  });
  let aiCalls = 0;

  const result = await getWritingIdeaAssistantResult(
    {
      attempt: academicAttempt(),
      question: academicQuestion(),
      questionSource: "question_bank",
      assignmentAvailable: true
    },
    {
      repository,
      generatePool: async () => {
        aiCalls += 1;
        return { raw: rawPool, model: "fake" };
      },
      rng: lcg(5)
    }
  );

  assert.equal(result.status, "ready");
  assert.equal(result.generated, false);
  assert.equal(aiCalls, 0);
  assert.equal(repository.calls.claim, 1);
  assert.equal(repository.calls.complete, 0);
  assert.equal(repository.calls.save, 1);
});

test("service retries invalid AI output once and then succeeds", async () => {
  const repository = createMemoryRepository();
  let calls = 0;

  const result = await getWritingIdeaAssistantResult(
    {
      attempt: academicAttempt(),
      question: academicQuestion(),
      questionSource: "question_bank",
      assignmentAvailable: true
    },
    {
      repository,
      generatePool: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            raw: { side_a_reasons: ["太短"], side_b_reasons: ["太短"] },
            model: "fake"
          };
        }
        return { raw: academicPool(), model: "fake" };
      },
      rng: lcg(9)
    }
  );

  assert.equal(result.status, "ready");
  assert.equal(calls, 2);
  assert.equal(repository.calls.complete, 1);
  assert.equal(repository.calls.fail, 0);
});

test("service marks the pool failed after two invalid AI responses", async () => {
  const repository = createMemoryRepository();

  await assert.rejects(
    getWritingIdeaAssistantResult(
      {
        attempt: academicAttempt(),
        question: academicQuestion(),
        questionSource: "question_bank",
        assignmentAvailable: true
      },
      {
        repository,
        generatePool: async () => ({
          raw: { side_a_reasons: [], side_b_reasons: [] },
          model: "fake"
        })
      }
    ),
    (error) => error instanceof WritingIdeaAssistantError &&
      error.code === "GENERATION_FAILED" &&
      error.status === 502
  );
  assert.equal(repository.calls.fail, 1);
  assert.equal(repository.calls.complete, 0);
  assert.equal(repository.calls.save, 0);
});

test("service returns a bounded generating response while another instance owns the lease", async () => {
  const repository = createMemoryRepository({
    claim: async () => ({ kind: "busy", retryAfterMs: 100 })
  });
  let aiCalls = 0;

  const result = await getWritingIdeaAssistantResult(
    {
      attempt: academicAttempt(),
      question: academicQuestion(),
      questionSource: "question_bank",
      assignmentAvailable: true
    },
    {
      repository,
      generatePool: async () => {
        aiCalls += 1;
        return { raw: academicPool(), model: "fake" };
      }
    }
  );

  assert.deepEqual(result, { status: "generating", retryAfterMs: 750 });
  assert.equal(aiCalls, 0);
  assert.equal(repository.calls.save, 0);
});

test("service rejects exam mode before touching the assistant storage", async () => {
  const repository = createMemoryRepository();
  await assert.rejects(
    getWritingIdeaAssistantResult(
      {
        attempt: academicAttempt({ writing_mode: "exam" }),
        question: academicQuestion(),
        questionSource: "question_bank",
        assignmentAvailable: true
      },
      {
        repository,
        generatePool: generated(academicPool())
      }
    ),
    (error) => error instanceof WritingIdeaAssistantError &&
      error.code === "EXAM_MODE" &&
      error.status === 403
  );
  assert.deepEqual(repository.calls, {
    load: 0,
    claim: 0,
    save: 0,
    complete: 0,
    fail: 0
  });
});

test("service rejects submitted attempts and withdrawn assignments", async () => {
  const repository = createMemoryRepository();
  await assert.rejects(
    getWritingIdeaAssistantResult(
      {
        attempt: academicAttempt({ status: "submitted" }),
        question: academicQuestion(),
        questionSource: "question_bank",
        assignmentAvailable: true
      },
      { repository, generatePool: generated(academicPool()) }
    ),
    (error) => error instanceof WritingIdeaAssistantError && error.status === 409
  );

  await assert.rejects(
    getWritingIdeaAssistantResult(
      {
        attempt: academicAttempt({ assignment_id: "assignment-1" }),
        question: academicQuestion(),
        questionSource: "question_bank",
        assignmentAvailable: false
      },
      { repository, generatePool: generated(academicPool()) }
    ),
    (error) => error instanceof WritingIdeaAssistantError &&
      error.code === "ASSIGNMENT_UNAVAILABLE"
  );
});

test("service binds custom questions by canonical question identity", async () => {
  const question = {
    ...academicQuestion(),
    question_id: "custom:question-1",
    source_labels: "custom"
  };
  const repository = createMemoryRepository();
  const result = await getWritingIdeaAssistantResult(
    {
      attempt: academicAttempt({
        assignment_id: "assignment-1",
        question_id: "custom:question-1"
      }),
      question,
      questionSource: "custom",
      assignmentAvailable: true
    },
    {
      repository,
      generatePool: generated(academicPool()),
      rng: lcg(4)
    }
  );

  assert.equal(result.status, "ready");
  assert.deepEqual(repository.identities[0], {
    taskType: "academic_discussion",
    questionId: "custom:question-1",
    questionSource: "custom",
    promptVersion: "writing_idea_pool_v1_2026_11_22"
  });
});

test("service generates and selects one detail group per actual WE requirement", async () => {
  const question = emailQuestion({ requirement_3: "" });
  const repository = createMemoryRepository();
  const result = await getWritingIdeaAssistantResult(
    {
      attempt: emailAttempt(),
      question,
      questionSource: "question_bank",
      assignmentAvailable: true
    },
    {
      repository,
      generatePool: generated({
        requirements: [
          { index: 1, details: generalDetails("喜欢讲座", 8) },
          { index: 2, details: conflictingDetails }
        ]
      }),
      rng: lcg(12)
    }
  );

  assert.equal(result.status, "ready");
  assert.equal(result.selection.task_type, "email");
  assert.equal(result.selection.requirements.length, 2);
  assert.deepEqual(
    result.selection.requirements.map((requirement) => requirement.requirement),
    [question.requirement_1, question.requirement_2]
  );
  for (const requirement of result.selection.requirements) {
    assert.ok(requirement.details.length >= 2 && requirement.details.length <= 3);
  }
});

test("different attempts receive different random combinations from a ready pool", async () => {
  const rawPool = academicPool();
  const results = [];
  for (const [attemptId, seed] of [["attempt-1", 0.01], ["attempt-2", 0.99]]) {
    const repository = createMemoryRepository({
      claim: async () => ({ kind: "ready", poolId: "pool-ready", content: rawPool })
    });
    const result = await getWritingIdeaAssistantResult(
      {
        attempt: academicAttempt({ attempt_id: attemptId }),
        question: academicQuestion(),
        questionSource: "question_bank",
        assignmentAvailable: true
      },
      {
        repository,
        generatePool: generated(rawPool),
        rng: () => seed
      }
    );
    results.push(result.selection);
  }
  assert.notDeepEqual(results[0], results[1]);
});

test("service returns 502 for a corrupt ready pool and 500 for storage failures", async () => {
  const corruptRepository = createMemoryRepository({
    claim: async () => ({
      kind: "ready",
      poolId: "pool-corrupt",
      content: { side_a_reasons: [], side_b_reasons: [] }
    })
  });
  await assert.rejects(
    getWritingIdeaAssistantResult(
      {
        attempt: academicAttempt(),
        question: academicQuestion(),
        questionSource: "question_bank",
        assignmentAvailable: true
      },
      { repository: corruptRepository, generatePool: generated(academicPool()) }
    ),
    (error) => error instanceof WritingIdeaAssistantError &&
      error.code === "CACHE_INVALID" &&
      error.status === 502
  );

  const failingRepository = createMemoryRepository();
  failingRepository.loadSelection = async () => {
    throw new Error("read failed");
  };
  await assert.rejects(
    getWritingIdeaAssistantResult(
      {
        attempt: academicAttempt(),
        question: academicQuestion(),
        questionSource: "question_bank",
        assignmentAvailable: true
      },
      { repository: failingRepository, generatePool: generated(academicPool()) }
    ),
    (error) => error instanceof WritingIdeaAssistantError &&
      error.code === "STORAGE_FAILED" &&
      error.status === 500
  );
});

test("service retries AI transport failures and then releases the lease", async () => {
  const repository = createMemoryRepository();
  let calls = 0;

  await assert.rejects(
    getWritingIdeaAssistantResult(
      {
        attempt: academicAttempt(),
        question: academicQuestion(),
        questionSource: "question_bank",
        assignmentAvailable: true
      },
      {
        repository,
        generatePool: async () => {
          calls += 1;
          throw new Error("AI timeout");
        }
      }
    ),
    (error) => error instanceof WritingIdeaAssistantError &&
      error.code === "GENERATION_FAILED" &&
      error.status === 502
  );
  assert.equal(calls, 2);
  assert.equal(repository.calls.fail, 1);
  assert.equal(repository.calls.complete, 0);
});

test("service rejects a mismatched question before reading assistant storage", async () => {
  const repository = createMemoryRepository();
  const question = { ...academicQuestion(), question_id: "different-question" };

  await assert.rejects(
    getWritingIdeaAssistantResult(
      {
        attempt: academicAttempt(),
        question,
        questionSource: "question_bank",
        assignmentAvailable: true
      },
      { repository, generatePool: generated(academicPool()) }
    ),
    (error) => error instanceof WritingIdeaAssistantError &&
      error.code === "QUESTION_MISMATCH" &&
      error.status === 409
  );
  assert.deepEqual(repository.calls, {
    load: 0,
    claim: 0,
    save: 0,
    complete: 0,
    fail: 0
  });
});

test("idea SQL has a shared pool identity, an atomic lease and no client policies", () => {
  const fs = require("node:fs");
  const sql = fs.readFileSync("supabase/writing_idea_assistant_v1.sql", "utf8");
  assert.match(sql, /unique \(task_type, question_source, question_id\)/);
  assert.match(sql, /writing_idea_claim_pool/);
  assert.match(sql, /for update/);
  assert.match(sql, /generation_token = p_token/);
  assert.match(sql, /enable row level security/g);
  assert.doesNotMatch(sql, /create policy/i);
  assert.match(sql, /grant execute on function public\.writing_idea_claim_pool/);
  assert.match(sql, /to service_role/);
});

test("custom question IDs are server-generated per creation and ignore client fields", () => {
  function customDiscussionFields() {
    return {
      title: "Custom discussion",
      professor_name: "Dr. Lee",
      professor_prompt: "Should universities require internships?",
      student_1_name: "Mia",
      student_1_response: "Yes, practical experience matters.",
      student_2_name: "Noah",
      student_2_response: "No, students need flexibility."
    };
  }

  const first = buildCustomWritingQuestionSnapshot({
    taskType: "academic_discussion",
    fields: customDiscussionFields()
  });
  const second = buildCustomWritingQuestionSnapshot({
    taskType: "academic_discussion",
    fields: customDiscussionFields()
  });
  const withClientId = buildCustomWritingQuestionSnapshot({
    taskType: "academic_discussion",
    fields: {
      ...customDiscussionFields(),
      question_id: "custom:client-supplied",
      set_id: "custom:client-supplied"
    }
  });

  const uuidPattern = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.match(first.question_id, uuidPattern);
  assert.match(second.question_id, uuidPattern);
  assert.match(withClientId.question_id, uuidPattern);
  assert.notEqual(first.question_id, second.question_id);
  assert.notEqual(first.question_id, withClientId.question_id);
  assert.notEqual(withClientId.question_id, "custom:client-supplied");
  assert.equal(withClientId.set_id, withClientId.question_id);

  const fs = require("node:fs");
  const source = fs.readFileSync("lib/writingAssignmentMutation.server.ts", "utf8");
  assert.match(
    source,
    /buildCustomWritingQuestionSnapshot\(\{[\s\S]{0,200}id: crypto\.randomUUID\(\)/
  );
});

test("idea assistant header stays 52px when the result body expands", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    "components/writing/WritingIdeaAssistant.tsx",
    "utf8"
  );
  assert.match(source, /flex h-\[52px\] w-full items-center/);
  assert.doesNotMatch(source, /h-full min-h-\[52px\]/);
  assert.match(
    source,
    /expanded \? "min-h-\[52px\]" : "h-\[52px\]"/
  );
});
