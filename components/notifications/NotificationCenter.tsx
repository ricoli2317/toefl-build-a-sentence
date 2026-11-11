"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { useCurrentAccount } from "@/components/RoleGate";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { NotificationCache } from "@/lib/notificationCache";
import { createLatestRequestGate, startVisiblePolling } from "@/lib/clientRefreshPolicy";
import { notificationRequest, NotificationRequestError } from "@/lib/notifications.client";
import { isNotificationSafePage, type NotificationCursor, type NotificationItem, type NotificationListItem, type NotificationPage } from "@/lib/notifications";
import { NotificationBody } from "./NotificationBody";
import { NotificationModal } from "./NotificationModal";
import { firstUnreadNotification, nextUnreadNotification, notificationEntryView, type NotificationEntry } from "@/lib/notificationPresentation";

const caches = new Map<string, NotificationCache>();
const CenterContext = createContext<{ count: number | null; open: () => void; safe: boolean; error: string } | null>(null);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { userId, role } = useCurrentAccount();
  const safe = isNotificationSafePage(usePathname());
  const eligible = role === "teacher" || role === "student";
  const cache = useMemo(() => {
    const key = `${userId}:${role}`;
    let value = caches.get(key);
    if (!value) {
      value = new NotificationCache(async () => (await notificationRequest<{ unreadCount: number }>("/api/notifications?view=summary", userId)).unreadCount);
      caches.set(key, value);
    }
    return value;
  }, [userId, role]);
  const [count, setCount] = useState(cache.unreadCount);
  const [open, setOpen] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const entry = useRef<NotificationEntry>("manual");
  const [items, setItems] = useState<NotificationListItem[]>([]);
  const [detail, setDetail] = useState<NotificationItem | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");
  const [next, setNext] = useState<NotificationCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pageRef = useRef<NotificationCursor | null>(null);
  const modeRef = useRef(false);
  const safeRef = useRef(safe); safeRef.current = safe;
  const mounted = useRef(true);
  const gate = useRef(createLatestRequestGate());
  const savingRef = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);

  const openDetail = useCallback(async (id: string, inheritedToken?: number) => {
    const token = inheritedToken ?? gate.current.begin();
    setView("detail"); setDetail(null); setLoading(true); setError("");
    try {
      const result = await notificationRequest<{ notification: NotificationItem }>(`/api/notifications/${id}`, userId);
      if (mounted.current && safeRef.current && gate.current.isCurrent(token)) {
        const current = cache.overlay([result.notification])[0];
        if (inheritedToken !== undefined && current.read_at) {
          // Another tab/device may confirm between the unread-title query and
          // this fresh detail response. Do not automatically show it again.
          cache.confirm(current.id, current.read_at, true);
          setItems(rows => cache.overlay(rows)); setCount(cache.unreadCount);
        } else setDetail(current);
        return current;
      }
    } catch (cause) {
      if (mounted.current && gate.current.isCurrent(token)) {
        if (cause instanceof NotificationRequestError && cause.status === 404) setItems(rows => rows.filter(row => row.id !== id));
        setError(cause instanceof Error ? cause.message : "通知加载失败。");
      }
    } finally { if (mounted.current && gate.current.isCurrent(token)) setLoading(false); }
  }, [cache, userId]);

  // Manual list/filter/refresh never chooses a default detail. In particular,
  // unread=true is a filter, not a signal that this was an automatic entry.
  const loadPage = useCallback(async (cursor: NotificationCursor | null, unreadOnly: boolean) => {
    const token = gate.current.begin();
    entry.current = "manual";
    setAutomatic(false);
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ unread: String(unreadOnly) });
      if (cursor) { params.set("before", cursor.before); params.set("beforeId", cursor.beforeId); }
      const result = await notificationRequest<NotificationPage>(`/api/notifications?${params}`, userId);
      if (!mounted.current || !safeRef.current || !gate.current.isCurrent(token)) return;
      const rows = cache.overlay(result.notifications);
      setItems(rows); setNext(result.nextCursor); setView(notificationEntryView("manual")); setDetail(null);
      pageRef.current = cursor; modeRef.current = unreadOnly;
      cache.autoOffered = true; setOpen(true);
    } catch (cause) {
      if (mounted.current && gate.current.isCurrent(token)) setError(cause instanceof Error ? cause.message : "通知加载失败。");
    } finally { if (mounted.current && gate.current.isCurrent(token)) setLoading(false); }
  }, [cache, userId]);

  const openAutomatic = useCallback(async (cursor: NotificationCursor | null = null) => {
    const token = gate.current.begin();
    entry.current = "automatic";
    setLoading(true); setError("");
    try {
      let before = cursor;
      for (;;) {
        const params = new URLSearchParams({ unread: "true" });
        if (before) { params.set("before", before.before); params.set("beforeId", before.beforeId); }
        const result = await notificationRequest<NotificationPage>(`/api/notifications?${params}`, userId);
        if (!mounted.current || !safeRef.current || !gate.current.isCurrent(token) || entry.current !== "automatic") return;
        const rows = cache.overlay(result.notifications);
        setItems(rows); setNext(result.nextCursor); setAutomatic(true);
        pageRef.current = before; modeRef.current = true;
        let latest = firstUnreadNotification(rows);
        if (latest) {
          cache.autoOffered = true;
          setView(notificationEntryView("automatic")); setDetail(null); setOpen(true);
          // One generation covers title+detail; a newer manual entry always wins.
          while (latest) {
            const resolved = await openDetail(latest.id, token);
            if (!mounted.current || !safeRef.current || !gate.current.isCurrent(token)) return;
            if (!resolved || !resolved.read_at) return;
            latest = firstUnreadNotification(cache.overlay(rows));
          }
        }
        if (!result.nextCursor) { setOpen(false); return; }
        before = result.nextCursor;
      }
    } catch (cause) {
      if (mounted.current && gate.current.isCurrent(token)) setError(cause instanceof Error ? cause.message : "通知加载失败。");
    } finally { if (mounted.current && gate.current.isCurrent(token)) setLoading(false); }
  }, [cache, openDetail, userId]);

  function close() {
    if (savingRef.current) return;
    gate.current.invalidate(); setOpen(false); setLoading(false); setDetail(null); setView("list");
  }

  useEffect(() => {
    mounted.current = true;
    const requests = gate.current;
    const { data: { subscription } } = createBrowserSupabase().auth.onAuthStateChange((event, session) => {
      if (event !== "SIGNED_OUT" && session?.user.id === userId) return;
      mounted.current = false;
      for (const value of Array.from(caches.values())) value.clear();
      caches.clear(); gate.current.invalidate(); setCount(null); setItems([]); setDetail(null); setOpen(false);
    });
    return () => { mounted.current = false; requests.invalidate(); subscription.unsubscribe(); };
  }, [userId]);

  useEffect(() => {
    if (!eligible || typeof BroadcastChannel === "undefined") return;
    const broadcast = new BroadcastChannel(`tps-notifications:${userId}`);
    channel.current = broadcast;
    broadcast.onmessage = event => {
      const message = event.data;
      if (!mounted.current || typeof message?.id !== "string" || typeof message?.read_at !== "string") return;
      cache.confirm(message.id, message.read_at, true);
      setItems(rows => cache.overlay(rows)); setDetail(row => row ? cache.overlay([row])[0] : null); setCount(cache.unreadCount);
      if (safeRef.current) void cache.refresh(true).then(() => { if (mounted.current) setCount(cache.unreadCount); }).catch(() => {});
    };
    return () => { channel.current = null; broadcast.close(); };
  }, [cache, eligible, userId]);

  useEffect(() => {
    if (!safe || !eligible) { gate.current.invalidate(); setOpen(false); setLoading(false); setDetail(null); return; }
    let cancelled = false;
    async function check() {
      try {
        await cache.refresh();
        if (cancelled || !mounted.current) return;
        setCount(cache.unreadCount);
        if ((cache.unreadCount ?? 0) > 0 && !cache.autoOffered) { cache.autoOffered = true; await openAutomatic(); }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : "通知检查失败。"); }
    }
    void check();
    // Poll only the small badge. NEVER reload an open list/detail, clear its
    // content, or wake a request because the browser window regained focus.
    const stop = startVisiblePolling(() => { void check(); }, 60000);
    return () => { cancelled = true; stop(); };
  }, [cache, eligible, safe, openAutomatic]);

  async function acknowledge() {
    if (savingRef.current || loading || !detail || detail.read_at) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const result = await notificationRequest<{ read_at: string }>(`/api/notifications/${detail.id}/read`, userId, { method: "POST" });
      if (!mounted.current) return;
      gate.current.invalidate();
      cache.confirm(detail.id, result.read_at, true);
      channel.current?.postMessage({ id: detail.id, read_at: result.read_at });
      setItems(rows => cache.overlay(rows)); setDetail(row => row ? cache.overlay([row])[0] : null); setCount(cache.unreadCount);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "阅读确认失败，请重试。"); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  }

  const following = nextUnreadNotification(items, detail?.id);
  const footer = view === "list" ? <>
    {pageRef.current ? <button type="button" className="student-button-secondary" disabled={loading} onClick={() => { void loadPage(null, modeRef.current); }}>返回最新</button> : null}
    {next ? <button type="button" className="student-button-secondary" disabled={loading} onClick={() => { void loadPage(next, modeRef.current); }}>更早通知</button> : null}
    <button type="button" className="student-button-primary" onClick={close}>关闭</button>
  </> : <>
    <button type="button" className="student-button-secondary" disabled={saving} onClick={() => { gate.current.invalidate(); setView("list"); setDetail(null); setLoading(false); setError(""); }}>返回通知列表</button>
    {detail && !detail.read_at ? <button type="button" className="student-button-primary" disabled={saving || loading} onClick={() => { void acknowledge(); }}>{saving ? "正在确认…" : "确认已读"}</button> : null}
    {automatic && (following || next) ? <button type="button" className="student-button-secondary" disabled={loading || saving}
      onClick={() => { if (following) void openDetail(following.id); else if (next) void openAutomatic(next); }}>下一条未读通知</button> : null}
    <button type="button" className="student-button-secondary" disabled={saving} onClick={close}>关闭</button>
  </>;

  return <CenterContext.Provider value={eligible ? { count, safe, error, open: () => { if (safe) void loadPage(null, false); } } : null}>
    {children}
    <NotificationModal open={open && safe && eligible} title={view === "detail" ? "通知详情" : "通知中心"} dismissible={!saving} onClose={close} footer={footer}>
      {error ? <p className="teacher-error mt-3" role="alert">{error}</p> : null}
      {view === "list" ? <>
        <div className="mt-4 flex gap-2">
          <button className="student-button-secondary" disabled={loading} onClick={() => { void loadPage(null, false); }} type="button">全部通知</button>
          <button className="student-button-secondary" disabled={loading} onClick={() => { void loadPage(null, true); }} type="button">仅未读</button>
          <button className="student-button-secondary" disabled={loading} onClick={() => { void loadPage(pageRef.current, modeRef.current); }} type="button">刷新</button>
        </div>
        {loading ? <p className="mt-4 text-sm" role="status">正在加载通知…</p> : null}
        {!loading && items.length === 0 ? <p className="py-6 text-student-muted">暂无通知。</p> : null}
        <ul className="mt-4 grid gap-2" aria-label="通知列表">
          {items.map(item => <li key={item.id}><button type="button" disabled={loading}
            onClick={() => { void openDetail(item.id); }} className="flex w-full items-start gap-2 rounded-xl border border-student-border p-3 text-left hover:border-student-primary">
            {!item.read_at ? <span className="text-student-primary" aria-label="未读">●</span> : null}
            <span className="break-words font-semibold">{item.title}</span>
          </button></li>)}
        </ul>
      </> : <>
        {loading ? <p className="py-6 text-sm" role="status">正在加载详情…</p> : null}
        {detail ? <article className="grid min-w-0 grid-cols-1 gap-4" aria-label="通知详情">
          <h3 className="break-words text-lg font-bold">{detail.title}</h3>
          <NotificationBody content={detail.content} document={detail.content_document} notificationId={detail.id} />
        </article> : null}
      </>}
    </NotificationModal>
  </CenterContext.Provider>;
}

export function NotificationBell() {
  const center = useContext(CenterContext);
  if (!center) return null;
  const label = `通知中心${center.count === null ? "" : `，${center.count} 条未读`}`;
  return <button type="button" className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-student-primary hover:bg-student-primary-soft disabled:opacity-50"
    aria-label={label} disabled={!center.safe} onClick={center.open} title={!center.safe ? "练习及工作页面暂不打开通知，请返回首页查看" : center.error || label}>
    <Bell size={21} aria-hidden="true" />
    {(center.count ?? 0) > 0 ? <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-red-600 px-1 text-center text-[10px] leading-5 text-white" aria-hidden="true">{center.count! > 99 ? "99+" : center.count}</span> : null}
    {center.error ? <span className="absolute bottom-0 right-0 text-xs text-red-600" aria-hidden="true">!</span> : null}
  </button>;
}
