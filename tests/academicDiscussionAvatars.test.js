const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CUSTOM_ACADEMIC_DISCUSSION_AVATAR_PATHS,
  buildAcademicDiscussionAvatarMap,
  resolveAcademicDiscussionAvatar,
  resolveCustomAcademicDiscussionAvatar
} = require("../lib/academicDiscussionAvatars.ts");

const rows = [
  {
    participant_name: "Dr. Achebe",
    participant_type: "professor",
    avatar_path: "/avatars/academic-discussion/dr-achebe.webp"
  },
  {
    participant_name: "Claire",
    participant_type: "student",
    avatar_path: "/avatars/academic-discussion/claire.webp"
  },
  {
    participant_name: "Paul",
    participant_type: "student",
    avatar_path: "/avatars/academic-discussion/paul.webp"
  },
  {
    participant_name: "Shared Name",
    participant_type: "professor",
    avatar_path: "/professor.webp"
  },
  {
    participant_name: "Shared Name",
    participant_type: "student",
    avatar_path: "/student.webp"
  }
];

const assignmentRows = [
  { participant_name: "Dr. Gupta", participant_type: "professor", avatar_path: "/avatars/academic-discussion/dr-gupta.webp" },
  { participant_name: "Kelly", participant_type: "student", avatar_path: "/avatars/academic-discussion/kelly.webp" },
  { participant_name: "Andrew", participant_type: "student", avatar_path: "/avatars/academic-discussion/andrew.webp" }
];

test("Dr. Achebe, Claire, and Paul resolve their real existing avatar assets", () => {
  const avatarMap = buildAcademicDiscussionAvatarMap(rows);
  for (const [name, type, avatarPath] of [
    ["Dr. Achebe", "professor", "/avatars/academic-discussion/dr-achebe.webp"],
    ["Claire", "student", "/avatars/academic-discussion/claire.webp"],
    ["Paul", "student", "/avatars/academic-discussion/paul.webp"]
  ]) {
    assert.equal(resolveAcademicDiscussionAvatar(avatarMap, name, type), avatarPath);
    assert.equal(
      fs.existsSync(path.join(process.cwd(), "public", avatarPath)),
      true,
      `${name} avatar must exist`
    );
  }
});

test("avatar lookup uses exact participant_name together with participant_type", () => {
  const avatarMap = buildAcademicDiscussionAvatarMap(rows);
  assert.equal(resolveAcademicDiscussionAvatar(avatarMap, "Shared Name", "professor"), "/professor.webp");
  assert.equal(resolveAcademicDiscussionAvatar(avatarMap, "Shared Name", "student"), "/student.webp");
  assert.equal(resolveAcademicDiscussionAvatar(avatarMap, "dr. achebe", "professor"), null);
  assert.equal(resolveAcademicDiscussionAvatar(avatarMap, "Dr. Achebe", "student"), null);
  assert.equal(resolveAcademicDiscussionAvatar(avatarMap, "Missing", "student"), null);
});

test("assignment bank participants resolve Dr. Gupta, Kelly, and Andrew through the real map", () => {
  const avatarMap = buildAcademicDiscussionAvatarMap(assignmentRows);
  for (const [name, type, avatarPath] of [
    ["Dr. Gupta", "professor", "/avatars/academic-discussion/dr-gupta.webp"],
    ["Kelly", "student", "/avatars/academic-discussion/kelly.webp"],
    ["Andrew", "student", "/avatars/academic-discussion/andrew.webp"]
  ]) {
    assert.equal(resolveAcademicDiscussionAvatar(avatarMap, name, type), avatarPath);
    assert.equal(fs.existsSync(path.join(process.cwd(), "public", avatarPath)), true);
  }
});

test("custom Academic Discussion avatar types resolve only to the four fixed assets", () => {
  for (const [avatarType, participantType] of [
    ["male_professor", "professor"],
    ["female_professor", "professor"],
    ["male_student", "student"],
    ["female_student", "student"]
  ]) {
    const avatarPath = resolveCustomAcademicDiscussionAvatar(avatarType, participantType);
    assert.equal(avatarPath, CUSTOM_ACADEMIC_DISCUSSION_AVATAR_PATHS[avatarType]);
    assert.equal(fs.existsSync(path.join(process.cwd(), "public", avatarPath)), true);
  }
  assert.equal(resolveCustomAcademicDiscussionAvatar(undefined, "professor"), null);
  assert.equal(resolveCustomAcademicDiscussionAvatar("male_student", "professor"), null);
});

test("review and practice reuse one avatar loader and renderer with fallback only for a missing path", () => {
  const review = read("components/student/StudentWritingReview.tsx");
  const practice = read("components/writing/WritingPractice.tsx");
  const prompt = read("components/writing/WritingQuestionPrompt.tsx");
  const route = read("app/api/writing/academic-discussion-avatars/route.ts");
  const assignmentPreview = read("components/teacher/WritingAssignmentQuestionPreview.tsx");
  const assignmentRoute = read("app/api/teacher/writing/assignments/avatars/route.ts");
  assert.match(review, /STUDENT_ACADEMIC_DISCUSSION_AVATARS_CACHE_KEY/);
  assert.match(review, /loadAcademicDiscussionAvatars/);
  assert.match(practice, /loadAcademicDiscussionAvatars/);
  assert.equal(review.includes('if (name === "Dr. Achebe")'), false);
  assert.match(prompt, /question\.professor_name,\s*"professor"/);
  assert.match(prompt, /resolveAcademicDiscussionAvatar\(avatarMap, name, "student"\)/);
  assert.match(prompt, /\{avatarPath \? \(/);
  assert.match(route, /participant_name, participant_type, avatar_path/);
  assert.match(assignmentPreview, /TEACHER_WRITING_ASSIGNMENT_AVATARS_CACHE_KEY/);
  assert.match(assignmentPreview, /avatarMap=\{avatarState\.data\?\.avatars \?\? \{\}\}/);
  assert.match(assignmentRoute, /academic_discussion_avatars/);
  assert.match(prompt, /source_labels === "custom"/);
  assert.match(prompt, /resolveCustomAcademicDiscussionAvatar/);
});

function read(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}
