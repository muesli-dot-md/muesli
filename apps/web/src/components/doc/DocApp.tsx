// DocApp — the doc shell. Port of src/DocApp.svelte: opens the collab session
// (Y.Doc + ws provider + CollabStore), header (wordmark→home, inline title
// rename, search, disconnect dot, presence stack + roster popover,
// notifications, share dropdown, account menu), toolbar, outline rail +
// editor + collab sidebar, workspace panel modal, toast, and the read-only
// history-snapshot modal.
//
// One collab session per mounted DocApp; App keys this component on
// `${docId} ${shareToken}`, so switching docs unmounts (destroying the
// session — websocket closed) and remounts fresh. The props are immutable for
// this component's lifetime, which is what lets every effect below use
// mount-once semantics.
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { DocSessionContext, openSession, type DocSession } from "@/state/session";
import { useCollabSnapshot } from "@/state/collabStore";
import { useT } from "@/state/i18n";
import { gotoHome } from "@/state/route";
import { presenceStore, usePresence } from "@/state/presence";
import { openSearchPalette, searchShortcutHint } from "@/components/search/SearchPalette";

import { fetchMe, httpBase, logout, me, setMeIdentity, type AuthInfo } from "@/services/identity";
import { classifyDocError, type ErrorKind } from "@/services/errorKind";
import { errMsg } from "@/services/apiError";
import { createWorkspaceApi, WorkspaceApiError } from "@/services/workspaceApi";
import { initials, splitForStack } from "@/services/presence";

import ErrorPage from "@/components/auth/ErrorPage";
import NotFound from "@/components/auth/NotFound";
import AccountMenu from "@/components/home/AccountMenu";
import WorkspacePanel from "@/components/home/WorkspacePanel";
import NotificationsBell from "@/components/collab/NotificationsBell";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import Editor from "./Editor";
import Toolbar from "./Toolbar";
import OutlineRail from "./OutlineRail";
import CollabSidebar from "./CollabSidebar";
import SnapshotModal from "./SnapshotModal";

const api = createWorkspaceApi({ httpBase });

type ShareRole = "viewer" | "commenter" | "editor";

export default function DocApp({
  docId,
  shareToken,
}: {
  docId: string;
  shareToken: string | null;
}) {
  const t = useT();

  // The session is created once per keyed mount (no StrictMode — the lazy
  // useState initializer runs exactly once) and destroyed in the mount
  // effect's cleanup below, AFTER the children (Editor) have already torn
  // down their view against it (React unmounts children first).
  const [session] = useState<DocSession>(() => openSession(docId, shareToken));
  const collab = session.store;
  // Re-render on collab store changes (toast, snapshot, availability, …).
  useCollabSnapshot(collab);

  const [connected, setConnected] = useState(session.provider.wsconnected);
  const [auth, setAuth] = useState<AuthInfo>({ mode: "open", user: null });
  // A failed document load (404 missing / 403 no-access / other) routes to a
  // friendly dedicated error page instead of surfacing the raw error.
  const [docError, setDocError] = useState<ErrorKind | null>(null);
  const [shareRole, setShareRole] = useState<ShareRole>("editor");
  const [shareUrl, setShareUrl] = useState("");
  const [shareError, setShareError] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  // --- title (inline rename, §Header) ---------------------------------------
  const [title, setTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const displayTitle = title.trim() || docId;
  const showSignInHint = auth.mode === "oidc" && !connected && !auth.user;

  // ── Session wiring (mount-once; props/session immutable per keyed mount) ──
  useEffect(() => {
    let disposed = false;
    const provider = session.provider;

    // Awareness → presence store: the store groups raw [clientId, user] pairs
    // into one entry per person (dedup by userId, guests by clientId, self
    // excluded by selfKey). Re-published with a fresh selfKey after auth
    // resolves (guest:clientId → userId).
    const publishPresence = () => {
      const selfKey = me.userId ?? `guest:${session.localClientId}`;
      presenceStore.getState().update(provider.awareness.getStates(), selfKey);
    };
    const onStatus = ({ status }: { status: string }) => setConnected(status === "connected");
    provider.awareness.on("change", publishPresence);
    provider.on("status", onStatus);
    publishPresence();
    setConnected(provider.wsconnected);

    fetchMe().then((a) => {
      if (disposed) return;
      setAuth(a);
      // Promote `me` to the authenticated identity (userId is the presence
      // dedup key; color re-derives from it; avatar rides along), then
      // re-publish the local awareness `user` so other clients collapse our
      // tabs into one chip — and regroup our own roster under the new selfKey.
      if (a.user) {
        setMeIdentity(a.user);
        session.publishLocalUser();
        publishPresence();
      }
    });

    // A doc created from Home hands its title/folder here via sessionStorage
    // (the row is only minted on first ws connect, so Home can't PATCH it —
    // a timed retry from Home raced and lost; "synced" is the reliable moment).
    const pendingKey = `muesli:pending-place:${docId}`;
    const pendingRaw = sessionStorage.getItem(pendingKey);
    if (pendingRaw) {
      const onSynced = (synced: boolean) => {
        if (!synced) return;
        provider.off("sync", onSynced);
        try {
          const pending = JSON.parse(pendingRaw) as { title?: string; folder_id?: string };
          if (pending.title && !disposed) setTitle(pending.title);
          api
            .updateDocument(docId, pending)
            .then(() => sessionStorage.removeItem(pendingKey))
            .catch(() => {}); // next Home visit shows the slug; rename recovers
        } catch {
          sessionStorage.removeItem(pendingKey);
        }
      };
      provider.on("sync", onSynced);
      if (provider.synced) onSynced(true);
    }

    // stored display title (fallback: the slug shown until the list answers)
    api
      .listDocuments()
      .then(({ documents }) => {
        if (disposed) return;
        const mine = documents.find((d) => d.slug === docId);
        if (mine?.title) setTitle(mine.title);
      })
      .catch(() => {}); // signed out / open-mode quirks: the slug is fine

    // Existence / permission probe. A 404/403 on the canonical text routes us
    // to a friendly "doesn't exist" / "no access" page instead of a blank
    // editor or raw error. Skipped when:
    //   - a brand-new doc is being minted from Home (pending-place flag) — it
    //     doesn't exist via REST yet; the ws connect creates it.
    //   - a guest arrives with a share token — the REST text route is
    //     cookie-authed (no guest cookie), so the ws/collab layer is the
    //     authority for share access, not this probe.
    if (!pendingRaw && !shareToken) {
      api.getDocumentText(docId).catch((e) => {
        if (disposed) return;
        if (e instanceof WorkspaceApiError) setDocError(classifyDocError(e.status));
        // network/other: leave the editor to its own connection status UI
      });
    }

    const stopCollab = collab.start();

    return () => {
      disposed = true;
      provider.awareness.off("change", publishPresence);
      provider.off("status", onStatus);
      stopCollab();
      presenceStore.getState().reset();
      // Editor's cleanup already ran (child first): the view is destroyed and
      // the seams cleared. Now close the websocket and free the Y.Doc.
      session.destroy();
    };
    // Mount-once by design: session/docId/shareToken are immutable per keyed mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- title edit ------------------------------------------------------------
  function startTitleEdit() {
    setTitleDraft(title.trim() || "");
    setEditingTitle(true);
  }

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  async function commitTitle() {
    if (!editingTitle) return;
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (next === title.trim()) return;
    try {
      const res = await api.updateDocument(docId, { title: next || null });
      setTitle(res.title ?? "");
      collab.showToast(t("toast.renamed"));
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 401) {
        collab.showToast(t("common.signInToDo"));
      } else {
        collab.showToast(errMsg(e));
      }
    }
  }

  function cancelTitleEdit() {
    setEditingTitle(false);
    setTitleDraft("");
  }

  // --- presence (§Header) ----------------------------------------------------
  // One indicator per *person* — the presence store already grouped raw
  // awareness entries (dedup by userId, guests by clientId, self excluded).
  const roster = usePresence((s) => s.people);
  const stack = useMemo(() => splitForStack(roster), [roster]);

  // ⊕N roster popover (lists everyone; closes on outside-click / Escape).
  const [rosterOpen, setRosterOpen] = useState(false);
  const rosterElRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!rosterOpen) return;
    const onPointer = (e: PointerEvent) => {
      const el = rosterElRef.current;
      if (el && !el.contains(e.target as Node)) setRosterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setRosterOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [rosterOpen]);

  // --- share -----------------------------------------------------------------
  async function share() {
    setShareError("");
    try {
      const link = await session.createShareLink(shareRole);
      setShareUrl(link.url);
      await navigator.clipboard.writeText(link.url).catch(() => {});
    } catch (e) {
      setShareError(errMsg(e));
    }
  }

  async function signOut() {
    // true = the browser is off to the IdP's end_session URL (RP-initiated
    // logout); navigating home now would race that page unload.
    if (await logout()) return;
    // The doc room's ws auth is gone with the cookie; go home, which unmounts
    // this component and destroys the session (and shows the sign-in screen).
    gotoHome();
  }

  // A hairline outline keeps avatar photos from melting into the chrome on
  // either theme; outline (not border) so it doesn't shift layout.
  const avatarOutline =
    "outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10";

  if (docError === "doc-not-found") return <NotFound kind="doc" />;
  if (docError === "no-access")
    return (
      <ErrorPage title={t("error.noAccessTitle")} message={t("error.noAccessBody")} action="home" />
    );
  if (docError === "generic")
    return (
      <ErrorPage title={t("error.genericTitle")} message={t("error.genericBody")} action="home" />
    );

  return (
    <DocSessionContext.Provider value={session}>
      <div className="flex h-screen flex-col bg-[var(--floor)]">
        <header className="flex min-h-0 items-center border-b border-border bg-background px-4 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 px-2"
              title={t("doc.allDocuments")}
              onClick={() => gotoHome()}
            >
              {/* Wordmark matches the marketing site's nav: lowercase, Sentient, 1.4rem */}
              <span className="wordmark text-[1.4rem] leading-none">muesli</span>
            </Button>
            <div className="flex min-w-0 items-baseline gap-2">
              {editingTitle ? (
                <Input
                  ref={titleInputRef}
                  className="h-7 w-64 text-base font-medium"
                  placeholder={docId}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={() => void commitTitle()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitTitle();
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancelTitleEdit();
                    }
                  }}
                />
              ) : (
                <button
                  className="max-w-72 truncate rounded px-1.5 py-0.5 text-base font-medium hover:bg-muted"
                  title={t("modal.renameDocTitle")}
                  onClick={startTitleEdit}
                >
                  {displayTitle}
                </button>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              title={t("doc.searchTitle", { hint: searchShortcutHint })}
              onClick={() => openSearchPalette()}
            >
              <Search aria-hidden="true" />
            </Button>
            {/* Connected is the web's steady state — only the EXCEPTION gets a dot. */}
            {!connected && (
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-destructive"
                title={t("doc.disconnected")}
              />
            )}
            {showSignInHint ? (
              <span className="text-xs opacity-60">{t("doc.signInToOpen")}</span>
            ) : !connected ? (
              <span className="text-xs opacity-60">{t("doc.offline")}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {roster.length > 0 && (
              <div className="relative flex items-center pl-1.5" ref={rosterElRef}>
                {stack.visible.map((p, i) => (
                  <div key={p.key} className={i === 0 ? "" : "-ml-1.5"} title={p.name}>
                    {p.avatar ? (
                      <img
                        className={`h-7 w-7 rounded-full ring-2 ring-background ${avatarOutline}`}
                        src={p.avatar}
                        alt={p.name}
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span
                        className="flex h-7 w-7 items-center justify-center rounded-full text-[0.65rem] font-semibold text-white ring-2 ring-background"
                        style={{ backgroundColor: p.color }}
                        aria-label={p.name}
                      >
                        {p.kind === "agent" ? "✦" : initials(p.name)}
                      </span>
                    )}
                  </div>
                ))}
                {stack.overflow > 0 && (
                  <button
                    type="button"
                    className="-ml-1.5 flex h-10 min-w-10 items-center justify-center rounded-full ring-2 ring-background transition-transform active:scale-[0.96]"
                    title={t("doc.presenceMore", { count: stack.overflow })}
                    aria-haspopup="true"
                    aria-expanded={rosterOpen}
                    onClick={() => setRosterOpen((v) => !v)}
                  >
                    <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-muted px-1 text-[0.65rem] font-semibold">
                      ⊕{stack.overflow}
                    </span>
                  </button>
                )}
                {rosterOpen && (
                  <div
                    className="absolute right-0 top-full z-20 mt-1.5 max-h-80 w-56 overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-md"
                    role="menu"
                  >
                    <p className="px-1.5 pb-1 text-xs font-semibold opacity-60">
                      {t("doc.peopleHere")}
                    </p>
                    <ul className="flex flex-col gap-0.5">
                      {roster.map((p) => (
                        <li key={p.key} className="flex items-center gap-2 rounded px-1.5 py-1">
                          {p.avatar ? (
                            <img
                              className={`h-6 w-6 shrink-0 rounded-full ${avatarOutline}`}
                              src={p.avatar}
                              alt={p.name}
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <span
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-semibold text-white"
                              style={{ backgroundColor: p.color }}
                              aria-hidden="true"
                            >
                              {p.kind === "agent" ? "✦" : initials(p.name)}
                            </span>
                          )}
                          <span className="truncate text-sm">{p.name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {auth.mode === "oidc" && auth.user && <NotificationsBell />}
            {auth.mode === "oidc" && auth.user && (
              <Popover>
                <PopoverTrigger render={<Button size="sm" className="ml-1" />}>
                  {t("common.share")}
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-3">
                  <div className="flex items-center gap-2">
                    <select
                      className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
                      value={shareRole}
                      onChange={(e) => setShareRole(e.target.value as ShareRole)}
                    >
                      <option value="viewer">{t("common.shareRole.viewer")}</option>
                      <option value="commenter">{t("common.shareRole.commenter")}</option>
                      <option value="editor">{t("common.shareRole.editor")}</option>
                    </select>
                    <Button size="sm" variant="outline" onClick={() => void share()}>
                      {t("common.createLink")}
                    </Button>
                  </div>
                  {shareUrl && (
                    <>
                      <Input
                        className="mt-2 h-7 w-full font-mono text-xs"
                        readOnly
                        value={shareUrl}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <p className="mt-1 text-xs opacity-60">{t("common.copiedToClipboard")}</p>
                    </>
                  )}
                  {shareError && <p className="mt-1 text-xs text-destructive">{shareError}</p>}
                </PopoverContent>
              </Popover>
            )}
            <AccountMenu
              auth={auth}
              toast={(m: string) => collab.showToast(m)}
              onSignOut={() => void signOut()}
              onWorkspace={() => setWorkspaceOpen(true)}
            />
          </div>
        </header>

        <Toolbar title={displayTitle} />

        <main className="flex min-h-0 flex-1 bg-[var(--floor)]">
          <OutlineRail />
          <section className="doc-sheet min-h-0 min-w-0 flex-1">
            <Editor />
          </section>
          <CollabSidebar store={collab} docId={docId} shareToken={shareToken} />
        </main>

        {workspaceOpen && auth.mode === "oidc" && auth.user && (
          <WorkspacePanel
            user={auth.user}
            toast={(m: string) => collab.showToast(m)}
            onClose={() => setWorkspaceOpen(false)}
          />
        )}

        {collab.toast && (
          <div className="fixed bottom-4 right-4 z-50">
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm shadow-lg backdrop-blur">
              {collab.toast}
            </div>
          </div>
        )}

        {collab.snapshot && (
          <SnapshotModal snapshot={collab.snapshot} onClose={() => collab.closeSnapshot()} />
        )}
      </div>
    </DocSessionContext.Provider>
  );
}
