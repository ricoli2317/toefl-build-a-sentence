# Binding 规则调整 — 现状审计（2026-09-28）

## 真实数据库结构（通过只读 SQL 核对线上项目）

- `public.teacher_student_bindings`: binding_id / teacher_id / student_id / domain / created_at
  - `teacher_student_bindings_unique unique (teacher_id, student_id, domain)`
  - `teacher_student_bindings_domain_check` → domain in ('reading','writing')
  - 无 source / provenance / class_id 字段；RLS 全禁，仅 service_role API 访问。
- `public.teacher_classes`: subjects text[] NOT NULL
  - `teacher_classes_subjects_check`: `array_length(subjects,1) between 1 and 2`，子集 reading/writing，无 null
  - → **班级授课科目数据库层面禁止 0 个（1..2）**
- `public.class_members`: PK (class_id, student_id)，无 teacher_id 列。
- 已存在 RPC: `sync_class_members(uuid,uuid,uuid[])`、`update_class_subjects(uuid,uuid,text[],boolean)`、
  `remove_class_member(uuid,uuid,uuid,boolean)`、`create_writing_assignment_group(...6 args)`。

## 现有链路

- 新建班级：`createTeacherClass` → insert teacher_classes → 新建学生账号时按班级 subjects 建 binding
  → `sync_class_members` RPC 对全部成员按班级 subjects `insert ... on conflict do nothing`。
- 新增学生进班级：`addTeacherClassMembers` →（新账号按班级 subjects 建 binding）→ `sync_class_members` 补建。
- 班级改科目：`update_class_subjects` → 更新 subjects + 对成员补建缺失 binding；
  旧行为：移除 Writing 且 `p_remove_writing=true` 时删除成员 writing binding。
- 移除班级学生：`remove_class_member` → 删 membership；旧行为：`p_remove_writing=true` 时删除 writing binding。
- 旧提示：班级详情「是否继续接收这些学生的写作练习？」/ 移除学生「是否继续接收他的写作练习？」，
  API 用 `writingDecision=keep|remove` 控制。
- 首页学生列表「学科」：`/api/teacher/students/overview` → `loadTeacherScope`（teacher_student_bindings）→ `entry.domains`。
- 首页班级列表「授课科目」：`/api/teacher/classes` → `teacher_classes.subjects`。
- 学生详情顶部 badge：`/api/teacher/students/[id]/practice` → `loadTeacherScope` → `student.domains`。
- 权限 helper：`requireTeacherOnly`、`loadTeacherScope`、`canManageStudent`、`canAccessStudentDomain`、
  `listVisibleStudentIds`、`listTeacherStudentDomainBindings`（全部 binding 派生，无 owner_id 回退）。
- 教师端已有 `POST /api/teacher/student-bindings`（只增不删）；无删除入口。

## 结论

1. 不需要 schema 变更。班级科目删除时的 binding 删除是 RPC 的可选参数 `p_remove_writing`，
   应用层永远传 false 即可满足新规则（零 SQL 执行）。
2. 班级科目 0 个：数据库明确禁止（1..2），保留限制，UI 阻止。
3. 学生 binding 0 个：数据库/API 允许（管理员可删任意 binding；旧「移除班级学生 + 不再接收」
   也能把 writing-only 学生删到 0）。按现有业务支持：0 binding 时该学生自然离开该教师的学生列表。
