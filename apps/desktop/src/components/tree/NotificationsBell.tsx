// Notification bell + unread badge + inbox panel, desktop edition — ported
// from NotificationsBell.svelte. Routes through the authenticated
// `api_request` Tauri command (token stays in the Keychain). Polls the
// unread-count for the badge; opening the panel loads the list; clicking a row
// marks it read. Desktop deep-linking from a notification is a later nicety
// (inbox links target the webapp), so a click marks-read only — it does not
// navigate. Shown only when signed in (the caller gates on
// workspaces.identity).

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellOff, LogIn, TriangleAlert } from "lucide-react";
import { relativeTime } from "@/state/collabStore";
import { useSidebars } from "@/state/sidebars";
import { ApiError } from "@/services/collab/apiRequest";
import { colorFromId } from "@/services/presence";
import {
  createNotificationsApi,
  type Notification,
} from "@/services/notifications/notificationsApi";
import {
  clampPanelLeft,
  clampPanelMaxHeight,
  clampPanelTop,
} from "@/services/notifications/panelPosition";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export interface NotificationsBellProps {
  server: string;
  /** Opens AppShell's sign-in dialog — reused verbatim from WorkspaceMenu's
   *  `onSignIn` prop so there is exactly one sign-in entry point in the app. */
  onSignIn: () => void;
}

export function NotificationsBell({ server, onSignIn }: NotificationsBellProps) {
  const api = useMemo(() => createNotificationsApi(server), [server]);

  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  // A 403 specifically means the stored Bearer token is not (or no longer)
  // recognized as the desktop's own device-login token (a pre-migration token,
  // or one somehow revoked/reissued as delegated). Retrying won't help; only a
  // fresh sign-in mints a new token. Kept distinct from `errored` so the panel
  // can point at the fix instead of a generic "couldn't load" dead end.
  const [forbidden, setForbidden] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // The bell lives in the sidebar header, near the window's left edge, so a
  // fixed-width panel right-aligned under it can extend past the left edge of
  // the window. Position it ourselves and clamp into the viewport instead —
  // same fix as ContextMenu's viewport clamp, both horizontal (left) and
  // vertical (top). `panelMaxHeight` is the same idea applied to height: a
  // static max-h-96 still overflows in a short window (the fixed panel has no
  // page scroll to fall back on), so clamp it to whatever room is actually
  // left below `panelTop`.
  const [panelLeft, setPanelLeft] = useState(0);
  const [panelTop, setPanelTop] = useState(0);
  const [panelMaxHeight, setPanelMaxHeight] = useState(384);

  // Track the left sidebar's width: dragging the resize handle moves the bell
  // itself, so the panel must re-measure its anchor when that happens, not
  // just on open — otherwise it is stranded at pre-drag coordinates.
  const sidebarLeft: number = useSidebars((s) => s.left);

  function reposition() {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;
    const anchor = root.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    const left = clampPanelLeft(anchor.right - size.width, size.width, window.innerWidth);
    const top = clampPanelTop(anchor.bottom + 4, size.height, window.innerHeight);
    setPanelLeft(left);
    setPanelTop(top);
    setPanelMaxHeight(clampPanelMaxHeight(top, window.innerHeight));
  }

  useEffect(() => {
    if (!open) return;
    reposition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sidebarLeft]);

  // The measurement above can run while the loading skeleton is still showing
  // (loadList isn't awaited from `toggle`) and never again once the real list
  // swaps in — so a panel that grows taller than the skeleton (or shrinks/
  // grows again on a later refresh) drifts out of its clamped position/height.
  // A ResizeObserver re-measures whenever the panel's own content changes
  // size, independent of what caused it.
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const ro = new ResizeObserver(() => reposition());
    ro.observe(panelRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Subtle staggered enter for list rows — skipped under reduced-motion so
  // the panel just appears. ~60ms/row, capped so a long list never feels slow.
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  async function refreshCount() {
    try {
      setUnread((await api.unreadCount()).count);
    } catch {
      // silent — transient failures leave the badge as-is.
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
      if (e instanceof ApiError && e.status === 403) {
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

  // While open, close on outside-click, Escape, an outside scroll, or a window
  // resize. We can't rely on focus/blur because WebKit (the WKWebView) doesn't
  // focus a <button> on click, so the panel is driven purely by `open`.
  // Listener style matches ContextMenu (capture-phase pointerdown/keydown/
  // scroll, close outright on resize rather than reposition), with one
  // deliberate difference: the scroll listener ignores scrolls that originate
  // inside the panel itself, because unlike the context menu this panel has
  // genuine scrollable content — closing on every internal scroll tick would
  // make the list unusable.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  function actorOf(n: Notification): string {
    return n.payload.actor_name || "Someone";
  }
  function docOf(n: Notification): string {
    return n.payload.doc_title || n.payload.doc_slug || "";
  }

  async function activate(n: Notification) {
    if (n.read) return;
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    setUnread((prev) => Math.max(0, prev - 1));
    try {
      await api.markRead(n.id);
    } catch {
      void refreshCount();
    }
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

  // Badge polling on the same cadence the collab layer uses.
  useEffect(() => {
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const hasUnreadRows = items.some((n) => !n.read);

  return (
    <div className="relative" ref={rootRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="relative text-muted-foreground hover:text-foreground"
        title="Notifications"
        aria-label="Notifications"
        onClick={toggle}
      >
        {unread > 0 ? (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium tabular-nums text-primary-foreground">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
        <Bell size={16} />
      </Button>

      {open ? (
        <div
          ref={panelRef}
          className="fixed z-30 w-80 overflow-y-auto rounded-lg bg-surface-raised p-2 shadow-[var(--menu-shadow)] ring-1 ring-surface-border"
          style={{
            left: panelLeft,
            top: panelTop,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: panelMaxHeight,
          }}
        >
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-sm font-semibold">Notifications</span>
            {hasUnreadRows ? (
              <Button variant="ghost" size="xs" onClick={() => void markAll()}>
                Mark all read
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
              <span>Sign in again to see notifications.</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  setOpen(false);
                  onSignIn();
                }}
              >
                Sign in
              </Button>
            </div>
          ) : errored ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm opacity-60">
              <TriangleAlert size={20} aria-hidden="true" />
              <span>Couldn't load notifications.</span>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm opacity-60">
              <BellOff size={20} aria-hidden="true" />
              <span>You're all caught up.</span>
            </div>
          ) : (
            <ul className="flex w-full flex-col gap-0.5">
              {items.map((n, i) => {
                const color = n.actor_id
                  ? colorFromId(n.actor_id).color
                  : "var(--muted-foreground)";
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
                          {actorOf(n)} mentioned you in «{docOf(n)}»
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
