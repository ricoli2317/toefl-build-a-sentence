"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewCommand, ReviewRound } from "@/lib/lexical/wordbookReview";
import { acknowledgeReview, applyReviewAction, localReview, localReviewKey, readLocalReview,
  reviewLocalState, saveLocalReview, type LocalReview } from "@/lib/lexical/wordbookReviewLocal";
import { ReviewRequestError } from "@/lib/lexical/wordbookReviewRequest";

type RequestRound = <T>(url: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
const ROOT = "/api/student/wordbook/review";
async function locked<T>(name: string, work: () => Promise<T> | T): Promise<T> {
  return navigator.locks ? navigator.locks.request(name, work) : work();
}
export function useWordbookLocalReview(owner: string | null, session: string, request: RequestRound) {
  const [local, setLocal] = useState<LocalReview>(), [error, setError] = useState("");
  const [syncError, setSyncError] = useState(""), [syncing, setSyncing] = useState(false);
  const current = useRef<LocalReview>(), requestRef = useRef(request); requestRef.current = request;
  const generation = useRef(0), worker = useRef(false), retryTimer = useRef<ReturnType<typeof setTimeout>>();
  const syncAbort = useRef<AbortController>(), active = useRef(false), failures = useRef(0);
  const identity = `${owner}:${session}`, lock = `wordbook-edit:${identity}`;
  const publish = useCallback((value: LocalReview) => { current.current = value; setLocal(value); }, []);
  const pumpRef = useRef<() => void>(() => {});
  const edit = useCallback(async (change: (value: LocalReview) => LocalReview) => {
    const mine = generation.current;
    return locked(lock, () => {
    if (!owner || !active.current || mine !== generation.current) return;
    const value = readLocalReview(localStorage, owner, session);
    if (!value || value.owner !== owner || value.round.session.session_id !== session) return;
    const next = change(value); if (next === value) return;
    saveLocalReview(localStorage, next); publish(next);
    if (next.phase === "result" && !next.queue.length && next.confirmed === next.round.session.total)
      localStorage.removeItem(localReviewKey(owner, session));
    });
  }, [lock, owner, session, publish]);

  const pump = useCallback(async () => {
    if (worker.current || !active.current || !owner) return;
    worker.current = true; const mine = generation.current;
    clearTimeout(retryTimer.current);
    try {
      await locked(`wordbook-sync:${identity}`, async () => {
        while (active.current && mine === generation.current) {
          const value = readLocalReview(localStorage, owner, session);
          const command = value?.owner === owner && value.round.session.session_id === session ? value.queue[0] : undefined;
          if (!command) { setSyncError(""); return; }
          setSyncing(true); syncAbort.current = new AbortController();
          const result = await requestRef.current<{ acknowledged: string }>(`${ROOT}/${session}`, { action: "sync", command }, syncAbort.current.signal);
          if (!active.current || mine !== generation.current) return;
          if (result.acknowledged !== command.id) throw new ReviewRequestError("保存结果未确认，待同步记录仍保留。", 502, "REVIEW_ACK");
          await edit(latest => acknowledgeReview(latest, command)); failures.current = 0; setSyncError("");
        }
      });
    } catch (e) {
      if (!active.current || mine !== generation.current) return;
      setSyncError(e instanceof Error ? e.message : "同步失败，本地记录已保留。");
      // Transport/upstream failures back off, never loop on auth or conflicts.
      if (!(e instanceof ReviewRequestError) || e.retryable) {
        const delay = Math.min(30000, 1000 * 2 ** Math.min(failures.current++, 5));
        retryTimer.current = setTimeout(() => pumpRef.current(), delay);
      }
    } finally { if (mine === generation.current) { worker.current = false; if (active.current) setSyncing(false); } }
  }, [owner, session, identity, edit]);
  pumpRef.current = () => { void pump(); };

  const reload = useCallback(async () => {
    if (!owner) return;
    const mine = generation.current; setError("");
    try {
      const pending = readLocalReview(localStorage, owner, session);
      if (pending) { publish(pending); pumpRef.current(); return; }
      const round = await requestRef.current<ReviewRound>(`${ROOT}/${session}?round=1`);
      if (mine !== generation.current || !active.current) return;
      if (!Array.isArray(round.cards) || round.cards.length !== round.session.total) throw new Error("本轮题目未完整读取，请重试。");
      const value = localReview(owner, round);
      // Persist correct-feedback recovery even if it predates the local flow.
      if (value.phase !== "result") saveLocalReview(localStorage, value);
      publish(value);
    } catch (e) { if (mine === generation.current && active.current) setError(e instanceof Error ? e.message : "读取失败，请重试。"); }
  }, [owner, session, publish]);
  useEffect(() => {
    const mine = ++generation.current; active.current = true; worker.current = false; current.current = undefined;
    setLocal(undefined); setError(""); setSyncError(""); setSyncing(false); failures.current = 0;
    void reload();
    const wake = () => pumpRef.current();
    const changed = (event: StorageEvent) => {
      if (!owner || event.key !== localReviewKey(owner, session)) return;
      try {
        const saved = readLocalReview(localStorage, owner, session);
        if (saved) { publish(saved); wake(); }
        else void reload(); // Another tab finished and removed the durable queue.
      }
      catch (e) { setError(e instanceof Error ? e.message : "待同步记录读取失败。"); }
    };
    window.addEventListener("online", wake); window.addEventListener("storage", changed); window.addEventListener("pageshow", wake);
    return () => { active.current = false; generation.current = mine + 1; clearTimeout(retryTimer.current); syncAbort.current?.abort();
      window.removeEventListener("online", wake); window.removeEventListener("storage", changed); window.removeEventListener("pageshow", wake); };
  }, [identity, owner, session, reload, publish]);

  const action = useCallback(async (name: string, answer?: unknown) => {
    const clickedAt = Date.now();
    const itemId = current.current?.round.cards[(current.current?.position ?? 1) - 1]?.itemId;
    if (!itemId) return;
    try {
      await edit(value => applyReviewAction(value, { id: crypto.randomUUID(), action: name as ReviewCommand["action"],
        itemId, ...(answer === undefined ? {} : { answer: answer as ReviewCommand["answer"] }) }, clickedAt));
      setError(""); pumpRef.current();
    } catch (e) { setError(e instanceof Error ? e.message : "本地作答保存失败，请重试。"); }
  }, [edit]);
  const itemId = local?.round.cards[local.position - 1].itemId;
  const correct = itemId && local?.answers[itemId]?.correct;
  const phase = local?.phase, deadline = itemId ? local?.deadlines[itemId] ?? 0 : 0;
  useEffect(() => {
    if (phase !== "test" || !correct || !itemId) return;
    const timer = setTimeout(() => void action("advance"), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [phase, itemId, correct, deadline, action]);
  const visible = local?.owner === owner && local.round.session.session_id === session ? local : undefined;
  const pending = visible?.queue.length ?? 0;
  return { state: visible ? reviewLocalState(visible) : undefined, action, error, reload,
    pending, syncError, syncing, retrySync: () => { failures.current = 0; pumpRef.current(); } };
}
