# RAP 按题型分类练习：post-migration 收尾

## 数据库状态

用户已确认 production 完整执行正式 migration，随后完整执行独立 verification，返回 `question_category_verification_passed`。本轮没有重复执行 SQL、生成新 migration、创建测试表／RPC，也没有创建生产 session、提交答案或制造错题。

## 代码/schema 对齐

- 两表：`reading_question_category_sessions`、`reading_question_category_session_answers`；server insert/history/teacher 查询列与已落库 migration 一致。
- 四个公开 RPC：`reading_question_category_counts()`、`get_reading_question_category_session(p_session_id)`、`save_reading_question_category_draft(p_session_id,p_logical_item_id,p_draft)`、`submit_reading_question_category_group(p_session_id,p_logical_item_id,p_elapsed_seconds,p_answers)`。API 使用同名参数与用户 token，不以 service-role 代替 owner RPC。
- manifest：`kind=question_category, version=1, category, groups[{logicalItemId,title,targets[{questionId,slotId:null}]}]`。唯一 passage group、first-encounter passage 顺序、组内 canonical question order；manifest 的 owner/category/amount/targets 永久冻结。
- progress：以 logical item ID 为 key；每组 `correctPoints,totalPoints,elapsedSeconds,submittedAt`，不包含 child attempt。draft 为 `{logicalItemId,workspace:{answers,currentIndex,questionTimes,elapsedSeconds}}`。
- get/result：`{session,answers}`；submit 的 `answers` 只含当前 group，adapter 将其合并到轻量 session cache。result 按 frozen manifest 输出全局 1..N，而非数据库返回顺序。
- RLS：authenticated 仅 owner SELECT；browser 无表写权限；创建在认证后由 Next server service-role 完成；teacher service query 先验证 teacher scope。
- History：共享 student/teacher day/range loader 只查询 completed category sessions；`question_category` source kind、RAP task，一 session 一条，title=`题型分类练习·${questionCategory}`，结果 href 指向 session 聚合页。
- Summary：只由 `active -> completed` trigger 累计 session elapsed，已提交 group retry 在任何写入前返回；rebuild 纳入 completed category sessions，不写 passage item state。
- 项目没有 Supabase generated Database types 文件、typed createClient 或 gen-types workflow；无需更新，不手工伪造类型。

## 业务复核

固定十类与 Sidebar 在语法分类下方；count/draw 同为 RAP + category；共享 5/10/15/20 及 small-pool 规则。session 支持多 passage、全局题号、跨 passage Previous、当前 + 下一 passage 预取，不整场 preload。refresh 加载已 pin 的 session 并恢复 checkpoint。

category 是正常练习：partial submit 只判 frozen targets，不写 ordinary/correction attempts，不更新 student_practice_item_state；复用普通 Reading wrong 事件同时维护今日与历史错题，答对不自动 corrected。辅助 wrong-event 投递策略与普通 Reading 相同，事件故障不回滚权威提交，重试不重放。

聚合 result 用 authoritative correct/total/elapsed；read-only review 精确定位 passage/question；breadcrumb 返回分类页，不显示错题集文案。retake 复用 wrongbook completed-session amount tier 逻辑，保持 category，创建新 session 和重新随机 manifest，不传旧 targets。

## 验证与发布

收尾验证／commit／push／production deployment／非写入 smoke test 结果待本轮执行完成后补充。

保留用户 main checkout 的所有未提交改动；发布使用当前维护 checkout 合并远端 main，不覆盖已发布 lexical lookup。
