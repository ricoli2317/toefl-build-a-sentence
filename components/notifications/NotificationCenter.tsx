"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { useCurrentAccount } from "@/components/RoleGate";
import { ModalShell } from "@/components/shared/ConfirmDialog";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { NotificationCache } from "@/lib/notificationCache";
import { notificationRequest, NotificationRequestError } from "@/lib/notifications.client";
import { isNotificationSafePage, NOTIFICATION_TYPES, notificationTime,
  type NotificationCursor, type NotificationItem, type NotificationPage } from "@/lib/notifications";

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
      value = new NotificationCache(async () => (await notificationRequest<{ unreadCount: number }>(
        "/api/notifications?view=summary", userId)).unreadCount);
      caches.set(key, value);
    }
    return value;
  }, [userId, role]);
  const [count, setCount] = useState(cache.unreadCount);
  const [open, setOpen] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [next, setNext] = useState<NotificationCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const pageRef = useRef<NotificationCursor | null>(null);
  const modeRef = useRef(false);
  const openRef = useRef(false);
  const safeRef = useRef(safe);
  safeRef.current = safe;
  const mounted = useRef(true);
  const sequence = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  const loadPage = useCallback(async (cursor: NotificationCursor | null, auto: boolean, show = true) => {
    const requestId = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ unread: String(auto) });
      if (cursor) { params.set("before", cursor.before); params.set("beforeId", cursor.beforeId); }
      const result = await notificationRequest<NotificationPage>(`/api/notifications?${params}`, userId);
      if (!mounted.current || !safeRef.current || requestId !== sequence.current) return;
      const rows = cache.overlay(result.notifications);
      setItems(rows);
      setNext(result.nextCursor);
      pageRef.current = cursor;
      modeRef.current = auto;
      setAutomatic(auto);
      setSelectedId(previous => rows.some(row => row.id === previous) ? previous : rows[0]?.id ?? null);
      if (show && (!auto || rows.some(row => !row.read_at))) {
        cache.autoOffered = true;
        setOpen(true);
        openRef.current = true;
      } else if (auto && rows.length === 0) {
        setOpen(false);
        openRef.current = false;
      }
    } catch (cause) {
      if (mounted.current && requestId === sequence.current) setError(cause instanceof Error ? cause.message : "通知加载失败。");
    } finally {
      if (mounted.current && requestId === sequence.current) setLoading(false);
    }
  }, [cache, userId]);

  useEffect(() => {
    mounted.current = true;
    const { data: { subscription } } = createBrowserSupabase().auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || session?.user.id !== userId) {
        mounted.current = false;
        for (const value of Array.from(caches.values())) value.clear();
        caches.clear();
        sequence.current += 1;
        setCount(null);
        setItems([]);
        setOpen(false);
        openRef.current = false;
      }
    });
    return () => { mounted.current = false; sequence.current += 1; subscription.unsubscribe(); };
  }, [userId]);

  useEffect(() => {
    if (!eligible || typeof BroadcastChannel === "undefined") return;
    const broadcast = new BroadcastChannel(`tps-notifications:${userId}`);
    channel.current = broadcast;
    broadcast.onmessage = event => {
      const message = event.data;
      if (typeof message?.id !== "string" || typeof message?.read_at !== "string") return;
      cache.confirm(message.id, message.read_at, true);
      setItems(rows => cache.overlay(rows));
      setCount(cache.unreadCount);
      if (safeRef.current) void cache.refresh(true).then(() => {
        if (mounted.current) setCount(cache.unreadCount);
      }).catch(() => {});
    };
    return () => { channel.current = null; broadcast.close(); };
  }, [cache, eligible, userId]);

  useEffect(() => {
    if (!safe || !eligible) {
      sequence.current += 1;
      setOpen(false);
      setLoading(false);
      openRef.current = false;
      return;
    }
    let cancelled = false;
    async function check(force = false) {
      if (document.visibilityState === "hidden") return;
      try {
        await cache.refresh(force);
        if (cancelled || !mounted.current) return;
        setCount(cache.unreadCount);
        if (openRef.current && !savingRef.current) {
          await loadPage(pageRef.current, modeRef.current, false);
        } else if ((cache.unreadCount ?? 0) > 0 && !cache.autoOffered) {
          cache.autoOffered = true;
          await loadPage(null, true);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "通知检查失败。");
      }
    }
    void check();
    const timer = window.setInterval(() => { void check(); }, 60000);
    const focus = () => { void check(); };
    window.addEventListener("focus", focus);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [cache, eligible, safe, loadPage]);

  const selected = items.find(item => item.id === selectedId);

  async function acknowledge(close: boolean) {
    if (saving || loading) return;
    if (selected && !selected.read_at) {
      savingRef.current = true;
      setSaving(true);
      setError("");
      try {
        const result = await notificationRequest<{ read_at: string }>(`/api/notifications/${selected.id}/read`, userId, { method: "POST" });
        // Invalidate any in-flight list before applying the server receipt.
        if (!mounted.current) return;
        sequence.current += 1;
        cache.confirm(selected.id, result.read_at, true);
        channel.current?.postMessage({ id: selected.id, read_at: result.read_at });
        setItems(rows => cache.overlay(rows));
        setCount(cache.unreadCount);
      } catch (cause) {
        if (!mounted.current) return;
        if (cause instanceof NotificationRequestError && cause.status === 404) {
          setItems(rows => rows.filter(row => row.id !== selected.id));
          setSelectedId(null);
        }
        setError(cause instanceof Error ? cause.message : "阅读确认失败，请重试。");
        return; // Failed writes must not silently suppress the next-login popup.
      } finally {
        savingRef.current = false;
        if (mounted.current) { setSaving(false); setLoading(false); }
      }
    }
    if (close) {
      sequence.current += 1;
      setOpen(false);
      openRef.current = false;
    }
  }

  return <CenterContext.Provider value={eligible ? {
    count, safe, error, open: () => { if (safe) void loadPage(null, false); }
  } : null}>
    {children}
    <ModalShell open={open && safe && eligible} label="通知中心" size="wide" containFocus dismissible={!saving && !loading}
      onClose={() => { void acknowledge(true); }}>
      <h2 className="text-xl font-bold text-student-text">{automatic ? "未读通知" : "通知中心"}</h2>
      <p className="mt-2 text-sm text-student-muted">逐条打开查看并确认；关闭仅确认当前展示的通知，不会将其他通知标为已读。</p>
      <div className="mt-3 flex gap-2">
        <button className="student-button-secondary" disabled={loading || saving} onClick={() => { void loadPage(null, false); }} type="button">全部通知</button>
        <button className="student-button-secondary" disabled={loading || saving} onClick={() => { void loadPage(null, true); }} type="button">仅未读</button>
        <button className="student-button-secondary" disabled={loading || saving} onClick={() => { void loadPage(pageRef.current, modeRef.current); }} type="button">刷新</button>
      </div>
      {loading ? <p className="mt-4 text-sm" role="status">正在加载通知…</p> : null}
      {error ? <p className="teacher-error mt-3" role="alert">{error}</p> : null}
      {!loading && items.length === 0 ? <p className="py-6 text-student-muted">暂无通知。</p> : null}
      <ul className="mt-4 grid max-h-44 gap-2 overflow-y-auto" aria-label="通知列表">
        {items.map(item => <li key={item.id}><button type="button" disabled={saving || loading}
          aria-pressed={item.id === selectedId} onClick={() => setSelectedId(item.id)}
          className={`w-full rounded-xl border p-3 text-left ${item.id === selectedId ? "border-student-primary bg-student-primary-soft" : "border-student-border"}`}>
          <span className="block break-words font-semibold">{item.title}</span>
          <span className="mt-1 block text-xs text-student-muted">{item.read_at ? "已读" : "● 未读"} · {NOTIFICATION_TYPES[item.type]} · {notificationTime(item.published_at)}</span>
        </button></li>)}
      </ul>
      {selected && !loading ? <article className="mt-4 rounded-xl border border-student-border p-4" aria-label="通知详情">
        <h3 className="break-words text-lg font-bold">{selected.title}</h3>
        <p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-7">{selected.content}</p>
        {!selected.read_at ? <button type="button" className="student-button-primary mt-4" disabled={saving}
          onClick={() => { void acknowledge(false); }}>{saving ? "正在确认…" : "确认此条已读"}</button> : <p className="mt-3 text-sm text-student-muted">已确认阅读，可随时重复查看。</p>}
      </article> : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {pageRef.current ? <button type="button" className="student-button-secondary" disabled={loading || saving}
          onClick={() => { setSelectedId(null); void loadPage(null, modeRef.current); }}>返回最新</button> : null}
        {next ? <button type="button" className="student-button-secondary" disabled={loading || saving}
          onClick={() => { setSelectedId(null); void loadPage(next, modeRef.current); }}>更早通知</button> : null}
        <button type="button" className="student-button-primary" disabled={saving || loading} onClick={() => { void acknowledge(true); }}>
          {saving ? "正在确认…" : selected && !selected.read_at ? "确认当前通知并关闭" : "关闭"}
        </button>
      </div>
    </ModalShell>
  </CenterContext.Provider>;
}

export function NotificationBell() {
  const center = useContext(CenterContext);
  if (!center) return null;
  const label = `通知中心${center.count === null ? "" : `，${center.count} 条未读`}`;
  return <button type="button" className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-student-primary hover:bg-student-primary-soft disabled:opacity-50"
    aria-label={label} disabled={!center.safe} onClick={center.open}
    title={!center.safe ? "练习及工作页面暂不打开通知，请返回首页查看" : center.error || label}>
    <Bell size={21} aria-hidden="true" />
    {(center.count ?? 0) > 0 ? <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-red-600 px-1 text-center text-[10px] leading-5 text-white" aria-hidden="true">
      {center.count! > 99 ? "99+" : center.count}
    </span> : null}
    {center.error ? <span className="absolute bottom-0 right-0 text-xs text-red-600" aria-hidden="true">!</span> : null}
  </button>;
}
