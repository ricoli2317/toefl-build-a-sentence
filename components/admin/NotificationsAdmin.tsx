"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useCurrentAccount } from "@/components/RoleGate";
import { ModalShell, ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { TeacherCard, TeacherEmptyState } from "@/components/teacher/TeacherUI";
import { notificationRequest } from "@/lib/notifications.client";
import { createLatestRequestGate } from "@/lib/clientRefreshPolicy";
import { NotificationEditor } from "@/components/notifications/NotificationEditor";
import { NotificationBody } from "@/components/notifications/NotificationBody";
import { NOTIFICATION_TARGETS, NOTIFICATION_TYPES, notificationTime,
  type AdminNotification, type NotificationDraft } from "@/lib/notifications";

const emptyDraft: NotificationDraft = { title: "", content: "", type: "announcement", target_role: "all" };
const statuses = { draft: "草稿", published: "已发布", withdrawn: "已撤回" };

export function NotificationsAdmin() {
  const { userId } = useCurrentAccount();
  const [rows, setRows] = useState<AdminNotification[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ row: AdminNotification | null; draft: NotificationDraft } | null>(null);
  const [preview, setPreview] = useState<AdminNotification | null>(null);
  const [operation, setOperation] = useState<{ row: AdminNotification; action: "publish" | "withdraw" | "delete" } | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const mutationLock = useRef(false);
  const loadGate = useRef(createLatestRequestGate());
  const [formError, setFormError] = useState("");

  const load = useCallback(async () => {
    const token = loadGate.current.begin();
    setLoading(true);
    setError("");
    try {
      const result = await notificationRequest<{ notifications: AdminNotification[]; hasMore: boolean }>(`/api/admin/notifications?page=${page}`, userId);
      if (loadGate.current.isCurrent(token)) { setRows(result.notifications); setHasMore(result.hasMore); }
    } catch (cause) { if (loadGate.current.isCurrent(token)) setError(cause instanceof Error ? cause.message : "通知加载失败。"); }
    finally { if (loadGate.current.isCurrent(token)) setLoading(false); }
  }, [page, userId]);
  useEffect(() => { const requests = loadGate.current; void load(); return () => requests.invalidate(); }, [load]);

  async function save(action: "draft" | "publish", event?: FormEvent) {
    event?.preventDefault();
    if (!editor || mutationLock.current || uploading) return;
    mutationLock.current = true;
    loadGate.current.invalidate();
    setSaving(true);
    setFormError("");
    try {
      await notificationRequest(editor.row ? `/api/admin/notifications/${editor.row.id}` : "/api/admin/notifications", userId, {
        method: editor.row ? "PATCH" : "POST",
        body: JSON.stringify({ ...editor.draft, ...(editor.row ? { action: "edit", updated_at: editor.row.updated_at } : { action }) })
      });
      setEditor(null);
      setNotice(action === "publish" ? "通知已创建并发布。" : "草稿已保存。");
      await load();
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : "保存失败。"); }
    finally { mutationLock.current = false; setSaving(false); }
  }

  async function mutate() {
    if (!operation || mutationLock.current) return;
    mutationLock.current = true;
    loadGate.current.invalidate();
    setSaving(true);
    setFormError("");
    try {
      await notificationRequest(`/api/admin/notifications/${operation.row.id}`, userId, { method: operation.action === "delete" ? "DELETE" : "PATCH",
        body: JSON.stringify({ action: operation.action, updated_at: operation.row.updated_at }) });
      setNotice(operation.action === "publish" ? "通知已发布。" : operation.action === "delete" ? "已从管理列表删除，未撤回或删除用户端已发布通知。" : "通知已撤回，用户端刷新通知后将不可见。");
      setOperation(null);
      await load();
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : "操作失败。"); }
    finally { mutationLock.current = false; setSaving(false); }
  }

  return <div className="grid gap-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-student-muted">仅草稿可编辑。已发布内容不可修改；撤回后如需重新发布，请创建新通知。</p>
      <button className="teacher-button-primary" type="button" disabled={loading || saving} onClick={() => { setEditor({ row: null, draft: { ...emptyDraft } }); setFormError(""); }}>创建通知</button>
    </div>
    {notice ? <p role="status" className="text-sm text-student-primary">{notice}</p> : null}
    {error ? <div role="alert" className="teacher-error">{error} <button type="button" className="underline" onClick={() => { void load(); }}>重试</button></div> : null}
    <TeacherCard className="overflow-hidden p-5">
      {loading ? <p role="status">正在加载通知…</p> : !error && rows.length === 0 ? <TeacherEmptyState text="暂无通知。" /> :
        <ul className="divide-y divide-student-border">{rows.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="min-w-0 flex-1">
            <button type="button" className="break-words text-left font-semibold text-student-primary hover:underline" onClick={() => setPreview(row)}>{row.title}</button>
            <p className="mt-2 text-sm text-student-muted">{statuses[row.status]} · {NOTIFICATION_TYPES[row.type]} · {NOTIFICATION_TARGETS[row.target_role]}</p>
            <p className="mt-1 text-xs text-student-muted">{row.published_at ? `发布于 ${notificationTime(row.published_at)}` : `创建于 ${notificationTime(row.created_at)}`}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {row.status === "draft" ? <>
              <button type="button" className="teacher-button-secondary" onClick={() => { setEditor({ row, draft: { title: row.title, content: row.content, content_document: row.content_document, type: row.type, target_role: row.target_role } }); setFormError(""); }}>编辑草稿</button>
              <button type="button" className="teacher-button-primary" onClick={() => { setOperation({ row, action: "publish" }); setFormError(""); }}>发布</button>
            </> : row.status === "published" ? <button type="button" className="teacher-button-secondary" onClick={() => { setOperation({ row, action: "withdraw" }); setFormError(""); }}>撤回</button> : null}
            <button type="button" className="teacher-button-secondary text-red-600" onClick={() => { setOperation({ row, action: "delete" }); setFormError(""); }}>删除</button>
          </div>
        </li>)}</ul>}
      <div className="mt-4 flex items-center justify-end gap-3">
        <button type="button" className="teacher-button-secondary" disabled={page === 0 || loading || saving} onClick={() => setPage(value => value - 1)}>上一页</button>
        <span className="text-sm">第 {page + 1} 页</span>
        <button type="button" className="teacher-button-secondary" disabled={!hasMore || loading || saving} onClick={() => setPage(value => value + 1)}>下一页</button>
      </div>
    </TeacherCard>
    <ModalShell open={!!editor} label={editor?.row ? "编辑通知草稿" : "创建通知"} size="wide" containFocus dismissible={!saving && !uploading} onClose={() => { if (!saving && !uploading) setEditor(null); }}>
      {editor ? <form onSubmit={event => { void save("draft", event); }} className="grid gap-4">
        <h2 className="text-lg font-bold">{editor.row ? "编辑通知草稿" : "创建通知"}</h2>
        <label className="grid gap-2 text-sm font-semibold">标题（最多 160 字）
          <input className="rounded-xl border border-student-border p-3" required maxLength={160} value={editor.draft.title} disabled={saving}
            onChange={event => setEditor({ ...editor, draft: { ...editor.draft, title: event.target.value } })} />
        </label>
        <label className="grid gap-2 text-sm font-semibold">通知类型
          <select className="rounded-xl border border-student-border p-3" value={editor.draft.type} disabled={saving}
            onChange={event => setEditor({ ...editor, draft: { ...editor.draft, type: event.target.value as NotificationDraft["type"] } })}>
            {Object.entries(NOTIFICATION_TYPES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-semibold">接收对象
          <select className="rounded-xl border border-student-border p-3" value={editor.draft.target_role} disabled={saving}
            onChange={event => setEditor({ ...editor, draft: { ...editor.draft, target_role: event.target.value as NotificationDraft["target_role"] } })}>
            {Object.entries(NOTIFICATION_TARGETS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <div className="grid gap-2 text-sm"><span className="font-semibold">正文（最多 20000 字）</span>
          <NotificationEditor content={editor.draft.content} document={editor.draft.content_document} disabled={saving}
            onBusyChange={setUploading} onChange={(content, document) => setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, content, content_document: document } } : null)} />
        </div>
        {formError ? <p role="alert" className="teacher-error">{formError}</p> : null}
        <div className="flex justify-end gap-3">
          <button type="button" className="teacher-button-secondary" disabled={saving || uploading} onClick={() => setEditor(null)}>取消</button>
          <button type="submit" className="teacher-button-secondary" disabled={saving || uploading}>{saving ? "正在保存…" : "保存草稿"}</button>
          {!editor.row ? <button type="button" className="teacher-button-primary" disabled={saving || uploading} onClick={() => { void save("publish"); }}>发布</button> : null}
        </div>
      </form> : null}
    </ModalShell>
    <ModalShell open={!!preview} label="通知详情" size="wide" containFocus onClose={() => setPreview(null)}>
      {preview ? <><h2 className="break-words text-xl font-bold">{preview.title}</h2>
        <p className="mt-2 text-sm text-student-muted">{statuses[preview.status]} · {NOTIFICATION_TARGETS[preview.target_role]}</p>
        <div className="mt-4"><NotificationBody content={preview.content} document={preview.content_document} admin /></div>
        <button type="button" className="teacher-button-secondary mt-5" onClick={() => setPreview(null)}>关闭</button></> : null}
    </ModalShell>
    <ConfirmDialog open={!!operation} title={operation?.action === "publish" ? "确认发布通知？" : operation?.action === "delete" ? "确认删除通知？" : "确认撤回通知？"}
      message={operation ? <><p className="break-words font-semibold">{operation.row.title}</p>
        <p className="mt-2">接收对象：{NOTIFICATION_TARGETS[operation.row.target_role]}</p>
        <p className="mt-2">{operation.action === "publish" ? "发布后不可修改内容，接收用户将看到通知。" : operation.action === "delete"
          ? "仅从 Admin 管理列表移除。已发布通知在教师/学生端仍按原角色规则可见，正文、图片和阅读记录保留；删除不是撤回。"
          : "撤回后用户无法继续查看；历史阅读记录保留，不能将此通知重新发布。"}</p></> : null}
      confirmText={operation?.action === "publish" ? "确认发布" : operation?.action === "delete" ? "确认删除" : "确认撤回"} cancelText="取消" confirming={saving} error={formError}
      onCancel={() => { if (!saving) setOperation(null); }} onConfirm={() => { void mutate(); }} />
  </div>;
}
