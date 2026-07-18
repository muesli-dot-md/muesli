// Drive-style details panel: docked on the right of the files pane, follows
// the current selection. Document → location / modified / size / links /
// sharing; folder → location / contents / modified. Yjs-free (REST only).
// identity.ts/time.ts, not collab: the home screen opens this panel too and
// must not pull in yjs / open a doc room as a side effect.

import { useEffect, useState, type ReactNode } from "react";
import { FileText, Folder, Star, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/state/i18n";
import { errMsg } from "@/services/apiError";
import { createGraphApi, type DocumentLinks } from "@/services/graphApi";
import { httpBase, type AuthInfo } from "@/services/identity";
import { gotoDoc, gotoFolder, gotoHome } from "@/state/route";
import { driveDate, fullDateTime, relativeTime } from "@/services/time";
import {
  WorkspaceApiError,
  type DocumentSummary,
  type FolderSummary,
  type ShareRole,
  type WorkspaceApi,
} from "@/services/workspaceApi";

export type InfoTarget =
  { kind: "doc"; doc: DocumentSummary } | { kind: "folder"; folder: FolderSummary };

interface Props {
  target: InfoTarget | null;
  docs: DocumentSummary[];
  folders: FolderSummary[];
  workspaceNames: Record<string, string>;
  api: WorkspaceApi;
  auth: AuthInfo;
  /** Toggle the starred flag of a document (migration 0011); owner persists + reloads. */
  onStar: (doc: DocumentSummary) => void;
  onClose: () => void;
}

const graphApi = createGraphApi({ httpBase });

/** Section label row — sentence case (not all-caps): i18n values are already
 *  capitalized, so no uppercase transform. */
function Row({ label }: { label: string }) {
  return <p className="mt-3 text-xs font-medium opacity-50">{label}</p>;
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="cursor-pointer text-left underline-offset-2 hover:underline"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function InfoPanel({
  target,
  docs,
  folders,
  workspaceNames,
  api,
  auth,
  onStar,
  onClose,
}: Props) {
  const t = useT();

  const name =
    target === null
      ? ""
      : target.kind === "doc"
        ? target.doc.title?.trim() || target.doc.slug
        : target.folder.name;
  const trashed =
    target !== null &&
    (target.kind === "doc" ? target.doc.deleted_at : target.folder.deleted_at) != null;
  const updatedAt =
    target === null ? "" : target.kind === "doc" ? target.doc.updated_at : target.folder.updated_at;
  const workspaceId =
    target === null
      ? null
      : target.kind === "doc"
        ? target.doc.workspace_id
        : target.folder.workspace_id;

  /** Ancestor folder chain (root-first) of the target's containing folder. */
  const folderPath = (() => {
    if (!target) return [] as FolderSummary[];
    const byId = new Map(folders.map((f) => [f.id, f]));
    const chain: FolderSummary[] = [];
    let cur =
      target.kind === "doc"
        ? target.doc.folder_id
          ? byId.get(target.doc.folder_id)
          : undefined
        : target.folder.parent_id
          ? byId.get(target.folder.parent_id)
          : undefined;
    let guard = 0;
    while (cur && guard++ < 100) {
      chain.unshift(cur);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return chain;
  })();

  const childCounts =
    target?.kind === "folder"
      ? {
          folders: folders.filter((f) => f.parent_id === target.folder.id).length,
          docs: docs.filter((d) => d.folder_id === target.folder.id).length,
        }
      : { folders: 0, docs: 0 };

  // --- per-document extras (size + links), fetched on selection change --------
  const [size, setSize] = useState<{ bytes: number; words: number } | null>(null);
  const [links, setLinks] = useState<DocumentLinks | null>(null);
  const [extrasError, setExtrasError] = useState("");

  useEffect(() => {
    setSize(null);
    setLinks(null);
    setExtrasError("");
    if (target?.kind !== "doc" || trashed) return; // trashed docs 410 on per-doc REST
    const slug = target.doc.slug;
    let stale = false;
    void (async () => {
      try {
        const { text } = await api.getDocumentText(slug);
        if (stale) return;
        setSize({
          bytes: new TextEncoder().encode(text).length,
          words: (text.match(/\S+/g) ?? []).length,
        });
      } catch (e) {
        if (!stale) setExtrasError(errMsg(e));
      }
      try {
        const l = await graphApi.getDocumentLinks(slug);
        if (!stale) setLinks(l);
      } catch {
        // graph disabled (volatile mode) — links section just stays empty
      }
    })();
    return () => {
      stale = true;
    };
  }, [target, trashed, api]);

  // --- sharing (mirrors the editor's share dropdown) ---------------------------
  const [shareRole, setShareRole] = useState<ShareRole>("editor");
  const [shareUrl, setShareUrl] = useState("");
  const [shareError, setShareError] = useState("");
  useEffect(() => {
    setShareUrl("");
    setShareError("");
  }, [target]);

  async function share() {
    if (target?.kind !== "doc") return;
    setShareError("");
    try {
      const link = await api.createShareLink(target.doc.slug, shareRole);
      setShareUrl(link.url);
      await navigator.clipboard.writeText(link.url).catch(() => {});
    } catch (e) {
      setShareError(
        e instanceof WorkspaceApiError && e.status === 403 ? t("info.onlyEditorsShare") : errMsg(e),
      );
    }
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          {target ? (
            <>
              {target.kind === "folder" ? (
                <Folder
                  className="h-5 w-5 shrink-0 opacity-70"
                  fill="currentColor"
                  aria-hidden="true"
                />
              ) : (
                <FileText className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              )}
              <h2 className="truncate font-medium" title={name}>
                {name}
              </h2>
            </>
          ) : (
            <h2 className="font-medium opacity-60">{t("info.details")}</h2>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Starred / favourites toggle (migration 0011): documents only, not in trash. */}
          {target?.kind === "doc" && !trashed && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              title={target.doc.starred ? t("ctx.removeFromStarred") : t("ctx.addToStarred")}
              aria-pressed={target.doc.starred ?? false}
              onClick={() => target.kind === "doc" && onStar(target.doc)}
            >
              <Star
                className={`h-4 w-4 ${target.doc.starred ? "text-[var(--color-warning)]" : ""}`}
                fill={target.doc.starred ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            title={t("info.closeDetails")}
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 text-sm">
        {!target ? (
          <p className="mt-8 text-center text-sm opacity-50">{t("info.selectItem")}</p>
        ) : (
          <>
            {trashed && (
              <span className="mt-1 inline-flex items-center rounded-full bg-[var(--color-warning)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-warning-content,inherit)]">
                {t("info.inTrash")}
              </span>
            )}

            <Row label={t("info.location")} />
            <div className="flex flex-wrap items-center gap-1">
              <LinkButton onClick={() => gotoHome()}>
                {workspaceId
                  ? (workspaceNames[workspaceId] ?? t("common.shared"))
                  : t("home.myDocuments")}
              </LinkButton>
              {folderPath.map((f) => (
                <span key={f.id} className="contents">
                  <span className="opacity-40">›</span>
                  <LinkButton onClick={() => gotoFolder(f.id)}>{f.name}</LinkButton>
                </span>
              ))}
            </div>

            {target.kind === "doc" && (
              <>
                <Row label={t("info.file")} />
                <p className="font-mono text-xs opacity-70">{target.doc.slug}.md</p>

                <Row label={t("info.owner")} />
                <p>
                  {target.doc.is_owner === false
                    ? target.doc.owner?.display_name?.trim() || t("common.unknown")
                    : t("common.me")}
                </p>
              </>
            )}

            <Row label={t("info.modified")} />
            <p title={fullDateTime(updatedAt)}>
              {driveDate(updatedAt)}
              <span className="opacity-50"> · {relativeTime(updatedAt)}</span>
            </p>

            {target.kind === "folder" ? (
              <>
                <Row label={t("info.contents")} />
                <p>
                  {t(
                    childCounts.folders === 1
                      ? "common.folderCount.one"
                      : "common.folderCount.other",
                    { count: childCounts.folders },
                  )}{" "}
                  ·{" "}
                  {t(
                    childCounts.docs === 1
                      ? "common.documentCount.one"
                      : "common.documentCount.other",
                    { count: childCounts.docs },
                  )}
                </p>
              </>
            ) : (
              <>
                <Row label={t("info.size")} />
                {size ? (
                  <p>
                    {fmtBytes(size.bytes)}
                    <span className="opacity-50">
                      {" "}
                      ·{" "}
                      {t(size.words === 1 ? "info.wordCount.one" : "info.wordCount.other", {
                        count: size.words,
                      })}
                    </span>
                  </p>
                ) : extrasError ? (
                  <p className="text-xs opacity-50">{extrasError}</p>
                ) : !trashed ? (
                  <Skeleton className="h-4 w-24" />
                ) : (
                  <p className="opacity-50">—</p>
                )}

                {links && (links.outgoing.length > 0 || links.incoming.length > 0) && (
                  <>
                    <Row label={t("info.linksOut", { count: links.outgoing.length })} />
                    <ul className="flex flex-col gap-0.5">
                      {links.outgoing.map((l, i) => (
                        <li key={i}>
                          {l.resolved && l.slug ? (
                            <LinkButton onClick={() => gotoDoc(l.slug!)}>{l.raw_target}</LinkButton>
                          ) : (
                            <span className="opacity-50" title={t("info.noDocForLink")}>
                              {l.raw_target} ∅
                            </span>
                          )}
                        </li>
                      ))}
                      {links.outgoing.length === 0 && (
                        <li className="opacity-50">{t("common.none")}</li>
                      )}
                    </ul>
                    <Row label={t("info.linksIn", { count: links.incoming.length })} />
                    <ul className="flex flex-col gap-0.5">
                      {links.incoming.map((l, i) => (
                        <li key={i}>
                          <LinkButton onClick={() => gotoDoc(l.slug)}>{l.slug}</LinkButton>
                        </li>
                      ))}
                      {links.incoming.length === 0 && (
                        <li className="opacity-50">{t("common.none")}</li>
                      )}
                    </ul>
                  </>
                )}

                {auth.mode === "oidc" && auth.user && !trashed && (
                  <>
                    <Row label={t("info.sharing")} />
                    <div className="mt-1 flex items-center gap-2">
                      <select
                        className="h-8 flex-1 rounded-lg border border-border bg-transparent px-2 text-sm"
                        value={shareRole}
                        onChange={(e) => setShareRole(e.currentTarget.value as ShareRole)}
                      >
                        <option value="viewer">{t("common.shareRole.viewer")}</option>
                        <option value="commenter">{t("common.shareRole.commenter")}</option>
                        <option value="editor">{t("common.shareRole.editor")}</option>
                      </select>
                      <Button variant="outline" size="sm" onClick={() => void share()}>
                        {t("common.createLink")}
                      </Button>
                    </div>
                    {shareUrl && (
                      <>
                        <input
                          className="mt-2 h-8 w-full rounded-lg border border-border bg-transparent px-2 font-mono text-xs"
                          readOnly
                          value={shareUrl}
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <p className="mt-1 text-xs opacity-60">{t("common.copiedToClipboard")}</p>
                      </>
                    )}
                    {shareError && <p className="mt-1 text-xs text-destructive">{shareError}</p>}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

export default InfoPanel;
