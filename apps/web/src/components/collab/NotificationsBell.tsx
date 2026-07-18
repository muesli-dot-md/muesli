// Notification bell + unread badge + inbox panel (sub-project ④c). Lives in the
// doc top bar. React port of NotificationsBell.svelte (web semantics), using the
// desktop NotificationsBell.tsx as the skeleton:
//   - cookie auth: the api client defaults to identity's httpBase (the optional
//     `server` prop overrides it, per the wave contract)
//   - clicking a notification marks it read AND navigates to its document via
//     gotoDoc (the desktop build only marks read — documented limitation there)
//   - the panel is a simple right-aligned dropdown under the bell (the web bell
//     sits at the right edge of the header; no viewport-clamp service needed)
//   - close on outside pointerdown or Escape while open (web listener set —
//     no scroll/resize close; WebKit doesn't focus buttons on click, so the
//     panel is driven purely by `open`)
// Auth-only: the caller renders this only when signed in. A mid-session
// 401/403 shows a sign-in prompt when the host passed onSignIn, else the
// generic load error.

import { useEffect, useMemo, useState } from "react";
import { Bell, BellOff, LogIn, TriangleAlert } from "lucide-react";

import { httpBase } from "@/services/identity";
import { ApiError, createNotificationsApi, type Notification } from "@/services/notificationsApi";
import { colorFromId } from "@/services/presence";
import { gotoDoc } from "@/state/route";
import { useT } from "@/state/i18n";
import { relativeTime } from "@/state/collabStore";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export interface NotificationsBellProps {
  /** API origin override; defaults to the session's httpBase (cookie auth). */
  server?: string;
  /** Optional: lets a mid-session auth lapse point at the fix. */
  onSignIn?: () => void;
}

export function NotificationsBell({ server, onSignIn }: NotificationsBellProps) {
  const t = useT();
  const api = useMemo(() => createNotificationsApi({ httpBase: server ?? httpBase }), [server]);

  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  // Session lapsed mid-flight (401/403 on a cookie-auth fetch). Only shown as
  // its own state when the host gave us a sign-in entry point.
  const [forbidden, setForbidden] = useState(false);

  const [root, setRoot] = useState<HTMLDivElement | null>(null);

  // Subtle staggered enter for list rows — skipped under reduced-motion so the
  // panel just appears. ~60ms/row, capped so a long list never feels slow.
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  async function refreshCount() {
    try {
      setUnread((await api.unreadCount()).count);
    } catch {
      // silent — the badge just stays put on a transient failure.
    }
  }

  async function loadList() {
    setLoading(true);
    setErrored(false);
    setForbidden(false);
    try {
      setItems((await api.list()).notifications);
    } catch (e) {
      setItems([]);
      if (onSignIn && e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setErrored(true);
      }
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    setOpen((prev) => {
      if (!prev) void loadList();
      return !prev;
    });
  }

  // While open, close on outside-click or Escape. We can't rely on focus/blur
  // because WebKit doesn't focus a <button> on click, so the panel is driven
  // purely by `open`.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, root]);

  function actorOf(n: Notification): string {
    return n.payload.actor_name || t("notifications.someone");
  }
  function docOf(n: Notification): string {
    return n.payload.doc_title || n.payload.doc_slug || "";
  }

  async function activate(n: Notification) {
    setOpen(false);
    if (!n.read) {
      // Optimistic local read; the badge reflects it immediately.
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setUnread((prev) => Math.max(0, prev - 1));
      try {
        await api.markRead(n.id);
      } catch {
        void refreshCount();
      }
    }
    const slug = n.payload.doc_slug;
    if (slug) gotoDoc(slug);
  }

  async function markAll() {
    try {
      await api.markAllRead();
      setItems((prev) => prev.map((x) => ({ ...x, read: true })));
      setUnread(0);
    } catch {
      void refreshCount();
    }
  }

  // Badge polling: piggy-backs the same cadence collab polling uses elsewhere.
  useEffect(() => {
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const hasUnreadRows = items.some((n) => !n.read);

  return (
    <div className="relative" ref={setRoot}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="relative rounded-full text-muted-foreground hover:text-foreground"
        title={t("notifications.title")}
        aria-label={t("notifications.title")}
        onClick={toggle}
      >
        {unread > 0 ? (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium tabular-nums text-primary-foreground">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
        <Bell size={16} aria-hidden="true" />
      </Button>

      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 max-h-96 w-80 overflow-y-auto rounded-lg bg-surface-raised p-2 shadow-[var(--menu-shadow)] ring-1 ring-surface-border">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-sm font-semibold">{t("notifications.title")}</span>
            {hasUnreadRows ? (
              <Button variant="ghost" size="xs" onClick={() => void markAll()}>
                {t("notifications.markAllRead")}
              </Button>
            ) : null}
          </div>

          {loading ? (
            <ul className="flex w-full flex-col gap-0.5" aria-hidden="true">
              {Array.from({ length: 4 }, (_, i) => (
                <li key={i} className="flex items-start gap-2 rounded-md p-2">
                  <Skeleton className="mt-0.5 h-6 w-6 shrink-0 rounded-full" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-full rounded" />
                    <Skeleton className="h-3 w-1/3 rounded" />
                  </span>
                </li>
              ))}
            </ul>
          ) : forbidden ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm opacity-60">
              <LogIn size={20} aria-hidden="true" />
              <span>{t("common.signInToDo")}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  setOpen(false);
                  onSignIn?.();
                }}
              >
                {t("common.signIn")}
              </Button>
            </div>
          ) : errored ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm opacity-60">
              <TriangleAlert size={20} aria-hidden="true" />
              <span>{t("notifications.loadError")}</span>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm opacity-60">
              <BellOff size={20} aria-hidden="true" />
              <span>{t("notifications.empty")}</span>
            </div>
          ) : (
            <ul className="flex w-full flex-col gap-0.5">
              {items.map((n, i) => {
                const color = n.actor_id ? colorFromId(n.actor_id).color : "var(--text-muted)";
                return (
                  <li
                    key={n.id}
                    className={
                      reducedMotion
                        ? undefined
                        : "animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-backwards duration-150"
                    }
                    style={
                      reducedMotion ? undefined : { animationDelay: `${Math.min(i, 6) * 60}ms` }
                    }
                  >
                    <button
                      type="button"
                      className={`arc-tap flex min-h-10 w-full items-start gap-2 rounded-md p-2 text-left transition-colors hover:bg-surface-hover ${
                        n.read ? "opacity-70" : "bg-surface-hover/60 font-medium"
                      }`}
                      onClick={() => void activate(n)}
                    >
                      <span
                        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-semibold text-white"
                        style={{ backgroundColor: color }}
                        aria-hidden="true"
                      >
                        {actorOf(n).trim().charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">
                          {t("notifications.mentionedYou", { actor: actorOf(n), doc: docOf(n) })}
                        </span>
                        <span className="block text-xs opacity-50">
                          {relativeTime(n.created_at)}
                        </span>
                      </span>
                      {!n.read ? (
                        <span
                          className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary"
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default NotificationsBell;
