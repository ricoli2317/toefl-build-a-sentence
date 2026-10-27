# TPS Supabase Auth 同源代理：实施与验收说明

## 1. 状态与边界

- 实施基线：`9136689623e80d54174aedceac75c0907bdd40cb`（2026-10-27 核查时本地 HEAD、`origin/main`、远端 main 一致），工作区起始干净。
- 本轮未访问 Vercel 私有部署配置/部署元数据，因此**没有独立确认 Production 当前部署的 SHA**；上线前仍需核对 Production 与 main，不能把本地测试当作已部署验证。
- 未 commit、push、deploy；未修改数据库、RLS、账号、密码、Supabase 区域、R2 或业务权限。
- 未读取测试账号密码，未用真实学生/教师账号自动化登录，未创建 attempt、作业或数据库记录。
- 本文的 Session/业务验证是 Mock 和真实 SDK 配合的本地测试，不是实际浏览器、Vercel 或中国大陆实网验收。

## 2. 最终方案及依据

采用一个 Next.js **Node.js Route Handler**：

```text
旧：浏览器 → https://<原项目>.supabase.co/auth/v1/…
新：浏览器 → https://www.tuofubas.com/api/supabase/auth/v1/…
           → Vercel Node.js Function (syd1) → 同一个 Supabase /auth/v1/…
```

- `createClient()` 仍使用原项目 URL、原 anon key 和原 Auth 默认选项；只替换浏览器 Fetch 的 Auth 目的地址。
- 不加 External Rewrite，不保留两套重叠代理。`/api/…` 使用普通 App Router 路由，避免以 `_` 开头的目录被 Next.js 当作私有目录。
- External Rewrite 支持外部代理、缓存控制和 Observability，并非“无法观测”。但查阅的公开文档未提供其回源节点可按 Function region 固定为 `syd1` 的保证；Function 的 region 配置不能直接当作 External Rewrite 的区域保证。
- Node Handler 明确声明 `runtime = "nodejs"`、`preferredRegion = "syd1"`、`dynamic = "force-dynamic"`、`maxDuration = 30`。便于验证固定回源、白名单、大小/时间限制和应用级脱敏诊断。实际部署后的 region 仍须在 Vercel 检查。
- 选择依据是可控性和可验证性，**不是已证明 Rewrite 或代理在大陆更稳定**。

## 3. 浏览器/服务端调用清单

| 类型 | 实际入口 | 本轮处理/影响 |
| --- | --- | --- |
| 密码登录 | `components/LoginPanel.tsx` → 单例 `auth.signInWithPassword` | `/token?grant_type=password` 同源化 |
| Session 获取、恢复、自动/主动刷新 | RoleGate、Student/TeacherDataCache、Full Set、写作和各业务组件 → 单例 | 本地有效 Session 不新增请求；需刷新时 `/token?grant_type=refresh_token` 同源化 |
| 主动登出 | `components/SignOutButton.tsx`、`lib/writingClientSession.ts` | `/logout` 同源化；不额外提交 |
| 密码修改 | `components/shared/ChangePassword.tsx` → 验旧密码后 `updateUser` | 原有两个不同操作分别走 `/token` 和 `PUT /user`；代理不会额外重放 |
| 获取 Auth User | `components/TeacherImportQuestions.tsx` → `auth.getUser()` | `GET /user` 同源化 |
| 忘记密码 | LoginPanel → `/api/auth/password-reset-requests` → TPS 审批/服务端 Admin Auth | 原本就走 TPS API，不改审批、权限或密码数据 |
| SDK 恢复/验证/PKCE/JWKS HTTP | 当前没有浏览器邮件恢复 UI；SDK 能力预留 | `/recover`、`POST /verify`、`/token?grant_type=pkce`、`/reauthenticate`、JWKS 纳入严格白名单 |
| **PostgREST 直连** | **`components/TeacherImportQuestions.tsx:133`，`profiles.select("role").eq("id", user.id).single()`** | **保留**。不阻断普通登录，但大陆网络仍可能导致教师导入页 guard 查询失败/不可用；未扩展代理或顺带重构此处 |
| Storage | 未发现浏览器 Storage API 调用 | 不代理；阅读图片依旧通过现有 R2 resolver |
| Realtime | 未发现业务订阅/channel 调用；SDK 会构造 Realtime client | 不改变 URL/WebSocket transport，不新增连接 |
| Edge Functions | 未发现浏览器 `.functions.invoke()` 或直接 Functions URL 调用 | 不代理 |
| TPS 业务 API | 阅读/Full Set、写作保存提交恢复、查词、生词本、教师/管理员等 | 仍为浏览器 → TPS API → 服务端 Supabase，不改路径 |
| 服务端 Auth/PostgREST | `lib/supabase/server.ts`、`lib/studentRequest.server.ts`、API Routes、JWKS server helper 等 | 继续由 Vercel 直连 Supabase，不经过本代理，不产生循环 |

搜索了 `app/`、`components/`、`lib/` 的 SDK 创建点、环境变量、原始 URL 和 Auth/数据调用。实际浏览器客户端创建均经 `lib/supabase/client.ts`；已有测试也检查客户端工厂及订阅清理。脚本中的 `createClient` 不属于浏览器运行链。

**边界：** SDK 的 OAuth/SSO 浏览器跳转、Supabase 发出的邮件验证链接是导航，不是 `global.fetch`。本轮没有这些现用流程，也不改 Auth URL、邮件模板或 Redirect allowlist；不能宣称这些导航已同源化。未来启用 OAuth/MFA/OTP/注册等需单独评估白名单和导航链，不允许静默绕回直连。

## 4. 锁定 SDK 源码核查与 Session 兼容

`pnpm-lock.yaml` 和实际安装的 `@supabase/supabase-js`、`@supabase/auth-js` 均为 **2.110.0**，没有变更依赖。核查安装包的 `src/`：

- `SupabaseClient.ts:314–343`：从原 base URL 构造 Auth、Storage、Realtime、Functions 地址；默认 Storage Key 为 `sb-${baseUrl.hostname.split('.')[0]}-auth-token`。
- `SupabaseClient.ts:580–620`：`settings.global.fetch` 传给 Auth client。REST/Storage/Functions 使用其他 client URL；Realtime WebSocket 不是该 Fetch。
- `GoTrueClient.ts:418, 472–517`：同一个自定义 Fetch；默认持久化选择 localStorage（不可用时内存）；BroadcastChannel 使用相同 Storage Key。
- 密码登录、User 获取/更新、恢复、验证、PKCE 和 logout（经 GoTrueAdminApi）均使用该 HTTP transport，真实 SDK Mock 测试覆盖这些请求。
- `GoTrueClient.ts:4624–4668`：SDK 自带 Refresh 指数退避；`4833–5006`：并发刷新共享 Deferred、失败 cooldown、旋转结果写回和提交保护；`5049–5112`：保存/移除原存储项。**本轮不修改 SDK、锁、自动刷新、跨标签协调或持久化机制。**
- 新 Fetch 和代理本身不重试任何 Auth GET/POST/PUT；不做双路径并发或失败后直连重发。服务端原 Fetch 和非 Auth 读取的既有重试不变。SDK 已有 Refresh 重试仍在同一选定路径上运行，不是本轮新增的无条件 POST 重试。

真实 SDK＋模拟浏览器的两种模式测试：先用旧式直连客户端保存 Session，销毁后用修改后的实际工厂恢复。验证原 Storage Key、原 Session 字节不变、零密码请求恢复、过期刷新写回旋转 Token、重开页面恢复、单例、多标签 BroadcastChannel 事件、退出清理、账号切换、密码更新、恢复/验证、PKCE。模拟标签共享存储，但不是多个真实浏览器进程的压力测试。

**兼容结论：** 同一 TPS origin、同一项目 URL 下，不需要因本次传输切换重新输入密码。不保证原本已过期且刷新 Token 无效、被撤销、禁用、清空存储或换域名的 Session 可继续使用；不绕过 Supabase 或 RoleGate 验证。

## 5. 代理安全与 HTTP 行为

- 上游只从现有 `NEXT_PUBLIC_SUPABASE_URL` 读取；仅接受 HTTPS、单层 `<project>.supabase.co`、根路径、无端口/用户密码/query/hash。现有本地配置已通过此校验，不输出 key。将来改用 Supabase custom domain 必须重新评估，不能直接放宽为任意 URL。
- 客户端不能指定上游。按完整 pathname 精确匹配，拒绝 admin、任意后缀、编码路径、OAuth 导航和 GET 验证 Token；URL 标准化也无法把固定端点变成任意目标。
- 允许：`POST token`（password/refresh_token/pkce）、`POST logout`（原 scope）、`GET/PUT user`、`POST recover`、`POST verify`、`GET reauthenticate`、`GET .well-known/jwks.json`。
- 每个端点有 query 名称白名单，拒绝重复参数；query 最大 4096 字符。`redirect_to` 只作为 Auth 参数原样交上游，仍受 Supabase redirect 策略限制，不作为代理目标。
- 校验 apikey 为当前 public anon key；不读取、不注入、不转发系统 Service Role Key。请求 Authorization 仍由 SDK 提供、由上游验证。
- 拒绝跨站 Origin / `Sec-Fetch-Site: cross-site`，不增加跨域允许头。Origin 缺失的非浏览器请求仍必须过相同 public key 和 Supabase 验证；这不是新增独立认证服务。
- 原样转发方法、query、请求体字节及必要头：Authorization、apikey、Content-Type、Accept、X-Client-Info、X-Supabase-Api-Version、Origin。
- Host 交由 fetch 按固定上游生成。**不传 TPS Cookie/Set-Cookie**：当前 SDK 用 localStorage＋bearer，而原直连请求不会把 TPS 域 cookie 发到 Supabase。浏览器代理请求设置 `credentials: omit`，避免把 TPS cookie 带入代理。
- 不转发客户端可伪造的 X-Forwarded-For / Sb-Forwarded-For。anon key 不具备 Supabase 官方可信转发 IP 的能力（见限流说明）。
- 请求体必须 JSON，最多 **64 KiB**，同时检查声明长度和实际流，拒绝压缩体；响应最多 **1 MiB**。15 秒 deadline 覆盖请求体读取、连接及响应体；客户端取消传递给上游，Function 上限 30 秒。
- 上游 `200/400/401/403/429/500/503` 状态与响应体原样返回；保留 Retry-After、API 版本、WWW-Authenticate 等必要头。错误不变成 200。
- fetch 使用 `redirect: manual`，这些 JSON 端点的意外 3xx 返回 `502/upstream_redirect`；不跟随或外发 Location，不重写成另一个认证 POST。
- 全部应用响应（含拒绝/失败）设置 `Cache-Control: no-store, max-age=0`、`CDN-Cache-Control: no-store`、`Vercel-CDN-Cache-Control: no-store`、Pragma。Next 路由 force-dynamic，上游 fetch no-store。
- Vercel 在 Function 之前的 WAF、平台 body limit 或平台故障可能没有应用诊断头；不能误报为 Supabase 返回的失败。

## 6. 监测与诊断

Vercel Runtime Logs 按 `[auth-proxy]` / `event=auth_proxy` 或路由筛选。每个完成请求一条脱敏结构日志：

```text
requestId, phase, status, result, durationMs, upstreamMs
```

`phase` 为闭集 login/refresh/logout/user_lookup/user_update/recover/verify/pkce/reauthenticate/jwks/rejected。`durationMs` 为应用收到请求后到完成的总时间；`upstreamMs` 为开始 fetch 至上游 body 读完（不是纯 TCP 耗时，不含 Vercel 排队和冷启动）。未发起上游时为 null。

| 情况 | 服务端 result / HTTP | 浏览器控制台附加代码 |
| --- | --- | --- |
| 浏览器 fetch 失败，未拿到 TPS 响应 | 无法单凭客户端确定 Function 是否已收到 | `TPS-AUTH-PROXY-ENTRY` |
| 上游连接/读取失败 | `upstream_network` / 502 | `TPS-AUTH-PROXY-UPSTREAM-NET` |
| Deadline | `timeout` / 504 | `TPS-AUTH-PROXY-TIMEOUT` |
| 上游普通 4xx | `upstream_4xx` / 原状态 | `TPS-AUTH-PROXY-4XX` |
| 上游限流 | `upstream_429` / 429 | `TPS-AUTH-PROXY-429` |
| 上游 5xx | `upstream_5xx` / 原状态 | `TPS-AUTH-PROXY-5XX` |
| 其他代理/平台 HTTP 失败 | configuration、path/method/query/key/origin/body 等分类 | `TPS-AUTH-PROXY-HTTP` |

响应头包含 `X-TPS-Auth-Request-Id` 和 `X-TPS-Auth-Result`。浏览器生成随机 UUIDv4（可用时），服务端只接受合法 UUIDv4，否则自己生成。可将浏览器失败与 Runtime Logs 按该 ID 关联；响应在返回途中丢失时服务端可能已完成，所以 ENTRY **不等于保证上游从未收到**，不能据此重放 POST。

浏览器附加诊断只在控制台，不额外上传到数据库/第三方。登录页面原有 `TPS-PW-NET-NA`、`TPS-PW-AUTH-502/504`、429 等阶段诊断保持不变，不更改账号错误分类。管理员必要时结合控制台中的附加代码/请求 ID。

应用日志不含 URL/query、密码、Authorization、key、请求体、Token、原始响应或用户标识。不要启用会采集 body/敏感 Header 的 Log Drain/APM/SDK debug；也不要保存含 Token 的 HAR。没有新表或第三方监控。

## 7. 回退操作（管理员控制）

```env
NEXT_PUBLIC_SUPABASE_AUTH_TRANSPORT=proxy   # 默认，未设置也为 proxy
# 或
NEXT_PUBLIC_SUPABASE_AUTH_TRANSPORT=direct  # 明确回退
```

1. 在要更改的 Vercel 环境修改此变量（Preview 和 Production 分开设置）。
2. **重新构建并部署该环境**，不要复用嵌入旧 NEXT_PUBLIC 值的 build artifact；本任务没有授权执行此部署。
3. 用户完整刷新/重开 TPS 页面，使浏览器加载新 bundle。已打开的旧标签继续用旧单例和旧模式，直到刷新，不要要求清空 localStorage。
4. 检查新请求地址。direct 模式为原 Supabase 地址，因此大陆直连问题可能重新出现；proxy 模式为 TPS `/api/supabase/auth/v1/…`。
5. 原项目 URL、anon key、Storage Key、数据库/账号均不变。回退无需清空用户 Session；同一 origin 下的新旧标签仍使用同一存储命名空间。

无 URL 参数、localStorage 临时开关或自动 fallback。非法开关值报配置错误，不静默尝试两个目标。代理路由在 direct 模式仍存在，以兼容未刷新的旧页面，但新客户端只选一个路径。

## 8. 测试结果与已知基线问题

执行环境 Node 24.18.0；当前 `node_modules` 是已有共享符号链接，没有安装/升级依赖。

首次 `pnpm exec tsc` 被本机 pnpm 的依赖状态检查拦截，试图触发 install 并因非交互环境中禁止清理 modules 而退出；未强制清理或重装，改用下列已安装工具的直接入口完成检查。

- TypeScript：`node node_modules/typescript/bin/tsc --noEmit --incremental false`，通过。
- 相关 ESLint：`node node_modules/next/dist/bin/next lint --file lib/supabase/client.ts --file lib/supabase/fetch.ts --file lib/supabase/authProxy.server.ts --file 'app/api/supabase/auth/v1/[...path]/route.ts' --file tests/supabaseAuthProxy.test.js --file tests/supabaseAuthSdk.test.js`，无错误/警告。
- `git diff --check`：通过。
- 新代理/真实 SDK＋原登录/Phase 1–4/Fetch 五组测试共 **95 通过、0 失败**。
- 下列扩展针对性回归共 **245 tests：233 通过、0 失败、12 跳过**。跳过的是既有可选测试，不记为已验证。

```bash
node --test tests/supabaseAuthProxy.test.js tests/supabaseAuthSdk.test.js \
  tests/supabaseFetch.test.js tests/loginPhase1.test.js tests/stabilityPhases.test.js \
  tests/accountPermissions.test.js tests/accountPasswordUi.test.js tests/passwordResetRequests.test.js \
  tests/readingDataLayer.test.js tests/readingFullSetAttempts.test.js tests/readingFullSetSaveQueue.test.js \
  tests/writingSessionRecovery.test.js tests/writingAttemptLifecycle.test.js tests/writingSubmissionHistory.test.js \
  tests/studentWordbookReview.test.js tests/lexicalLookup.test.js
```

- 全部 `node --test tests/*.test.js`：**2763 tests：2661 通过、22 失败、80 跳过**；未执行不在既有默认脚本范围内的全部 `.cjs` 专题测试。下表的 17 个失败文件共 22 项失败，使用临时只读 `fs.readFileSync` overlay 将两个已修改现有 TS 文件还原为 HEAD 字节重跑：**202 tests：161 通过、同样 22 失败、19 跳过**，失败名称集合一致。没有 reset/覆盖用户文件；不扩展修复这些历史问题。

| 失败文件（`tests/`） | 项数 | 基线问题概况 |
| --- | ---: | --- |
| areaSwitchAccess.test.js | 1 | RoleGate 旧源码正则断言 |
| basResultReadonlyReview.test.js | 1 | 旧 UI 源码断言 |
| postLaunchRegression.test.js | 1 | LoginPanel 旧内联请求/返回字段断言 |
| readingHistoricalReview.test.js | 1 | 旧阅读组件源码断言 |
| readingHistoryRetake.test.js | 1 | 旧结果标签断言 |
| readingQuestionTimePersistence.test.js | 1 | 旧耗时实现源码断言 |
| readingRapInteraction.test.js | 1 | 旧布局源码断言 |
| readingRapSpecialInteraction.test.js | 1 | 旧 DOM 源码断言 |
| readingRdlInteraction.test.js | 1 | 旧布局源码断言 |
| readingRealData.test.js | 1 | 缺失历史 `public/reading/rdl/rdl-001/material_final.png`；未补建资产库 |
| studentRename.test.js | 1 | RoleGate 旧源码断言 |
| studentWordbookSql.test.js | 1 | 缺失 `docs/student-wordbook-v1-phase-a1.md`；未修改 SQL |
| teacherDashboardHome.test.js | 2 | 旧查询/组件源码断言 |
| teacherStudentPractice.test.js | 1 | 旧 UI 源码断言 |
| teacherStudentReadingDetail.test.js | 1 | 旧请求实现源码断言 |
| wordbookReviewSetupDates.test.js | 5 | Mock 无法解析 `@/components/shared/PracticeHistoryRows` |
| wrongQuestions.test.js | 1 | 旧样式源码断言 |

测试日志位于批准的临时目录 `/private/var/folders/w0/gqcjdk5947vb6k_rc2bvqjp40000gn/T/opencode/`：`tps-auth-targeted-tests.log`、`tps-auth-full-tests.log`、`tps-auth-baseline-tests.log`。没有把测试 Token 或账号复制进报告。

无凭证实网探测：从本机 Node 调用同一代理 helper，固定项目 `GET /auth/v1/.well-known/jwks.json` 返回 **200**、结构正确、no-store；一次样本总耗时 1095 ms / 上游 1092 ms。仅使用 public anon key、无账号凭证，不是 Vercel 或大陆性能数据；不能外推登录成功率。

## 9. 性能、成本与限流风险

- 每个实际 Auth HTTP 请求新增一次 Vercel Function 调用和一段服务端网络路径，localStorage Session 读取不产生新调用；业务 API 不增加代理跳数。请求连接可复用同源 TPS，但无法凭本地测试断言净延迟下降。
- Function 只导入 Node crypto 和代理代码，不初始化 SDK/数据库客户端；仍可能冷启动。deadline 15 秒，上限 30 秒。需 Preview 实测冷/热请求、p50/p95、Function 排队、上游耗时及大陆失败比例，不能保证不存在不可接受的冷启动。
- 月调用量约为 登录＋refresh＋logout＋user/密码/恢复/验证 HTTP＋SDK 原有重试＋拒绝/恶意流量。活跃会话数 A、每小时平均刷新 r、活跃小时 H，则 refresh 约 `A × r × H`，多标签是否增加须实测，不假设恰好每小时一次。
- Vercel Pro 成本增加 Function invocations、CPU、内存驻留、网络传输及日志用量。Fluid compute 的 I/O 等待不算 active CPU，但内存驻留仍收费；实际项目若未启用 Fluid，按该项目实际计费模型。无用户量/资源配置/实测，不能给可靠月费。
- 查阅时公开 Fluid 价格示例为调用 $0.60/百万；syd1 CPU $0.180/小时、内存 $0.0149/GB-hour，网络另计。仅作估算参数，最终以 Vercel 账单与当前价格为准：例如 10 万次额外请求仅调用部分约 $0.06，绝不是完整费用。
- **Supabase 429 上线风险：**现有 anon key 下，Supabase 可能按 Vercel 出口 IP 聚合限流；并发规模/出口复用未实测，**不能保证与原直连相同的每用户 IP 配额**。官方当前文档列 token 默认 150 次/5 分钟/IP、burst 30（实际项目设置可能不同）。
- Supabase 官方 `Sb-Forwarded-For` 可信转发需要 secret API key 和项目显式启用，publishable/legacy anon/service_role 不支持。不得为了绕限流换成 service role、伪造 header 或擅自改限流配置。此轮不新增 secret key/项目设置；Preview 和上线前由管理员核对实际限额、预期峰值与 429。
- 已保留原 429、Retry-After 及诊断；不主动重试 429、不清理有效 Session、不放宽认证/RLS。若聚合限流不可接受，先不要推广代理或管理员切回 direct，再单独评估受信 IP 转发方案。

参考：<https://vercel.com/docs/rewrites>、<https://vercel.com/docs/functions/configuring-functions/region>、<https://vercel.com/docs/functions/usage-and-pricing>、<https://supabase.com/docs/guides/auth/rate-limits>（查阅于 2026-10-27）。

## 10. Preview 验收步骤（仅说明，未执行部署）

1. 先验收代码和上述本地结果；核对实际 Production SHA、当前项目 URL、region 和 Auth 限流。不要使用未经核对的旧 Phase 分支作为上线依据。
2. 获批准后，在已关联 TPS 项目的 checkout 用 Vercel CLI 执行 `vercel deploy`（**不带 `--prod`**）；或由管理员用非生产分支创建 Preview。此步骤会上传代码/触发构建，当前未执行。Preview 配置原 URL/anon key 及 `NEXT_PUBLIC_SUPABASE_AUTH_TRANSPORT=proxy`，不要引入 Service Role 到代理。
3. 确认 Deployment Resources 中该路由为 Node、`syd1`；检查 Runtime Logs 和返回的 no-store 头，查看是否存在平台重定向、WAF challenge 或 body 限制。
4. 可先在 Preview 用无账号的 JWKS 请求验证端到端连通性；不要为测试发送真实登录/refresh/改密 POST。确认 public apikey 对应同一项目。
5. 真账号验收只由获授权的人手动操作：在**同一 Preview origin**先使用 direct build 保存 Session，再将同一 origin 的新 build 切到 proxy（新域名的 localStorage 不共享，不能用 Production→Preview 换域验证 Session 兼容）。不清存储，刷新页面应直接恢复。
6. 手工验证登录、等待/触发正常刷新、重开浏览器、多标签、退出/重登、账号切换；如需真实密码操作，应另行获批且不自动化更改任何学生/教师密码。本轮 Mock 已覆盖相关 HTTP。
7. 手工只读检查 Student/Teacher/Admin 权限、阅读目录/题目、Full Set 的 Session 和已有写作恢复、查词/生词本。不创建真实 attempt、作业、提交或测试记录；保存/提交的写入行为本轮仅 Mock 回归。
8. 同一 Preview origin 用 direct 新 build 重复验证回退及旧 Session；确保无失败后的第二路径 POST。
9. 从多条中国大陆运营商/设备网络观察 TPS 入口可达性、登录/刷新失败、p50/p95、429、冷启动和资源用量。必要时先小范围推广；不要用一次境外 JWKS 成功认定大陆问题已解决。

**尚未验证：**实际 Vercel 回源 region/冷启动/成本，真实平台请求头行为及 WAF，真实浏览器多标签/长时间练习，中国大陆线路成功率与峰值聚合出口限流。没有实测成功率提升数字。

## 11. 工作区交付文件

- `.env.example`：代理/直连 build-time 开关及回退提示。
- `lib/supabase/client.ts`：保留原 URL 和单例，注入仅浏览器 Auth 的传输配置。
- `lib/supabase/fetch.ts`：按原项目 Auth URL 精确改址，脱敏浏览器失败诊断，无 Auth transport 重试/直连 fallback。
- `app/api/supabase/auth/v1/[...path]/route.ts`：Node/syd1 动态路由。
- `lib/supabase/authProxy.server.ts`：固定上游、路径方法限制、透明响应、大小/deadline/脱敏日志。
- `tests/supabaseAuthProxy.test.js`：协议、安全、状态、超时、直连/代理和不重放验证。
- `tests/supabaseAuthSdk.test.js`：真实锁定 SDK 配合全 Mock 的原 Session/刷新/跨标签/密码/恢复验证。
- `docs/supabase-auth-same-origin-proxy.md`：本实施、结果、限制与操作说明。

完成后等待验收；不自行提交或发布。
