<script lang="ts" module>
  import type { DocumentSummary, FolderSummary } from "./workspaceApi";

  export type InfoTarget =
    | { kind: "doc"; doc: DocumentSummary }
    | { kind: "folder"; folder: FolderSummary };
</script>

<script lang="ts">
  // Drive-style details panel: docked on the right of the files pane, follows
  // the current selection. Document → location / modified / size / links /
  // sharing; folder → location / contents / modified. Yjs-free (REST only).
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import Star from "@lucide/svelte/icons/star";
  import X from "@lucide/svelte/icons/x";
  import { createGraphApi, type DocumentLinks } from "./graphApi";
  import { t } from "./i18n/index.svelte";
  import { httpBase, type AuthInfo } from "./identity";
  import { gotoDoc, gotoFolder, gotoHome } from "./route.svelte";
  import { driveDate, fullDateTime, relativeTime } from "./time";
  import {
    WorkspaceApiError,
    type ShareRole,
    type WorkspaceApi,
  } from "./workspaceApi";

  let {
    target,
    docs,
    folders,
    workspaceNames,
    api,
    auth,
    onstar,
    onclose,
  }: {
    target: InfoTarget | null;
    docs: DocumentSummary[];
    folders: FolderSummary[];
    workspaceNames: Record<string, string>;
    api: WorkspaceApi;
    auth: AuthInfo;
    /** Toggle the starred flag of a document (migration 0011); owner persists + reloads. */
    onstar: (doc: DocumentSummary) => void;
    onclose: () => void;
  } = $props();

  const graphApi = createGraphApi({ httpBase });

  const name = $derived(
    target === null
      ? ""
      : target.kind === "doc"
        ? target.doc.title?.trim() || target.doc.slug
        : target.folder.name,
  );
  const trashed = $derived(
    target !== null &&
      (target.kind === "doc" ? target.doc.deleted_at : target.folder.deleted_at) != null,
  );
  const updatedAt = $derived(
    target === null ? "" : target.kind === "doc" ? target.doc.updated_at : target.folder.updated_at,
  );
  const workspaceId = $derived(
    target === null
      ? null
      : target.kind === "doc"
        ? target.doc.workspace_id
        : target.folder.workspace_id,
  );

  /** Ancestor folder chain (root-first) of the target's containing folder. */
  const folderPath = $derived.by(() => {
    if (!target) return [];
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
  });

  const childCounts = $derived.by(() => {
    if (target?.kind !== "folder") return { folders: 0, docs: 0 };
    const id = target.folder.id;
    return {
      folders: folders.filter((f) => f.parent_id === id).length,
      docs: docs.filter((d) => d.folder_id === id).length,
    };
  });

  // --- per-document extras (size + links), fetched on selection change --------
  let size: { bytes: number; words: number } | null = $state(null);
  let links: DocumentLinks | null = $state(null);
  let extrasError = $state("");

  $effect(() => {
    size = null;
    links = null;
    extrasError = "";
    if (target?.kind !== "doc" || trashed) return; // trashed docs 410 on per-doc REST
    const slug = target.doc.slug;
    let stale = false;
    void (async () => {
      try {
        const { text } = await api.getDocumentText(slug);
        if (stale) return;
        size = {
          bytes: new TextEncoder().encode(text).length,
          words: (text.match(/\S+/g) ?? []).length,
        };
      } catch (e) {
        if (!stale)
          extrasError = t("common.errorWithDetail", {
            detail: e instanceof Error ? e.message : String(e),
          });
      }
      try {
        const l = await graphApi.getDocumentLinks(slug);
        if (!stale) links = l;
      } catch {
        // graph disabled (volatile mode) — links section just stays empty
      }
    })();
    return () => {
      stale = true;
    };
  });

  // --- sharing (mirrors the editor's share dropdown) ---------------------------
  let shareRole: ShareRole = $state("editor");
  let shareUrl = $state("");
  let shareError = $state("");
  $effect(() => {
    void target;
    shareUrl = "";
    shareError = "";
  });

  async function share() {
    if (target?.kind !== "doc") return;
    shareError = "";
    try {
      const link = await api.createShareLink(target.doc.slug, shareRole);
      shareUrl = link.url;
      await navigator.clipboard.writeText(link.url).catch(() => {});
    } catch (e) {
      shareError =
        e instanceof WorkspaceApiError && e.status === 403
          ? t("info.onlyEditorsShare")
          : t("common.errorWithDetail", {
              detail: e instanceof Error ? e.message : String(e),
            });
    }
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

{#snippet row(label: string)}
  <!-- sentence case (not all-caps): i18n values are already capitalized, so we
       drop the `uppercase` transform rather than rename keys. -->
  <p class="mt-3 text-xs font-medium opacity-50">{label}</p>
{/snippet}

<aside class="flex w-80 shrink-0 flex-col border-l border-base-300">
  <div class="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
    <div class="flex min-w-0 items-center gap-2">
      {#if target}
        {#if target.kind === "folder"}
          <Folder class="h-5 w-5 shrink-0 opacity-70" fill="currentColor" aria-hidden="true" />
        {:else}
          <FileText class="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        {/if}
        <h2 class="truncate font-medium" title={name}>{name}</h2>
      {:else}
        <h2 class="font-medium opacity-60">{t("info.details")}</h2>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <!-- Starred / favourites toggle (migration 0011): documents only, not in trash. -->
      {#if target?.kind === "doc" && !trashed}
        <button
          class="btn btn-circle btn-ghost btn-sm"
          title={target.doc.starred ? t("ctx.removeFromStarred") : t("ctx.addToStarred")}
          aria-pressed={target.doc.starred ?? false}
          onclick={() => target.kind === "doc" && onstar(target.doc)}
        >
          <Star
            class="h-4 w-4 {target.doc.starred ? 'text-warning' : ''}"
            fill={target.doc.starred ? "currentColor" : "none"}
            aria-hidden="true"
          />
        </button>
      {/if}
      <button class="btn btn-circle btn-ghost btn-sm" title={t("info.closeDetails")} onclick={onclose}>
        <X class="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4 text-sm">
    {#if !target}
      <p class="mt-8 text-center text-sm opacity-50">{t("info.selectItem")}</p>
    {:else}
      {#if trashed}
        <span class="badge badge-warning badge-sm mt-1">{t("info.inTrash")}</span>
      {/if}

      {@render row(t("info.location"))}
      <div class="flex flex-wrap items-center gap-1">
        <button class="link-hover link" onclick={() => gotoHome()}>
          {workspaceId ? (workspaceNames[workspaceId] ?? t("common.shared")) : t("home.myDocuments")}
        </button>
        {#each folderPath as f (f.id)}
          <span class="opacity-40">›</span>
          <button class="link-hover link" onclick={() => gotoFolder(f.id)}>{f.name}</button>
        {/each}
      </div>

      {#if target.kind === "doc"}
        {@render row(t("info.file"))}
        <p class="font-mono text-xs opacity-70">{target.doc.slug}.md</p>

        {@render row(t("info.owner"))}
        <p>
          {target.doc.is_owner === false
            ? target.doc.owner?.display_name?.trim() || t("common.unknown")
            : t("common.me")}
        </p>
      {/if}

      {@render row(t("info.modified"))}
      <p title={fullDateTime(updatedAt)}>
        {driveDate(updatedAt)}
        <span class="opacity-50">· {relativeTime(updatedAt)}</span>
      </p>

      {#if target.kind === "folder"}
        {@render row(t("info.contents"))}
        <p>
          {t(childCounts.folders === 1 ? "common.folderCount.one" : "common.folderCount.other", {
            count: childCounts.folders,
          })} ·
          {t(childCounts.docs === 1 ? "common.documentCount.one" : "common.documentCount.other", {
            count: childCounts.docs,
          })}
        </p>
      {:else}
        {@render row(t("info.size"))}
        {#if size}
          <p>
            {fmtBytes(size.bytes)}
            <span class="opacity-50">
              · {t(size.words === 1 ? "info.wordCount.one" : "info.wordCount.other", {
                count: size.words,
              })}
            </span>
          </p>
        {:else if extrasError}
          <p class="text-xs opacity-50">{extrasError}</p>
        {:else if !trashed}
          <div class="skeleton h-4 w-24"></div>
        {:else}
          <p class="opacity-50">—</p>
        {/if}

        {#if links && (links.outgoing.length || links.incoming.length)}
          {@render row(t("info.linksOut", { count: links.outgoing.length }))}
          <ul class="flex flex-col gap-0.5">
            {#each links.outgoing as l}
              <li>
                {#if l.resolved && l.slug}
                  <button class="link-hover link" onclick={() => gotoDoc(l.slug!)}>
                    {l.raw_target}
                  </button>
                {:else}
                  <span class="opacity-50" title={t("info.noDocForLink")}>
                    {l.raw_target} ∅
                  </span>
                {/if}
              </li>
            {/each}
            {#if links.outgoing.length === 0}
              <li class="opacity-50">{t("common.none")}</li>
            {/if}
          </ul>
          {@render row(t("info.linksIn", { count: links.incoming.length }))}
          <ul class="flex flex-col gap-0.5">
            {#each links.incoming as l}
              <li>
                <button class="link-hover link" onclick={() => gotoDoc(l.slug)}>{l.slug}</button>
              </li>
            {/each}
            {#if links.incoming.length === 0}
              <li class="opacity-50">{t("common.none")}</li>
            {/if}
          </ul>
        {/if}

        {#if auth.mode === "oidc" && auth.user && !trashed}
          {@render row(t("info.sharing"))}
          <div class="mt-1 flex items-center gap-2">
            <select class="select select-sm flex-1" bind:value={shareRole}>
              <option value="viewer">{t("common.shareRole.viewer")}</option>
              <option value="commenter">{t("common.shareRole.commenter")}</option>
              <option value="editor">{t("common.shareRole.editor")}</option>
            </select>
            <button class="btn btn-sm" onclick={share}>{t("common.createLink")}</button>
          </div>
          {#if shareUrl}
            <input
              class="input input-sm mt-2 w-full font-mono text-xs"
              readonly
              value={shareUrl}
              onfocus={(e) => e.currentTarget.select()}
            />
            <p class="mt-1 text-xs opacity-60">{t("common.copiedToClipboard")}</p>
          {/if}
          {#if shareError}
            <p class="mt-1 text-xs text-error">{shareError}</p>
          {/if}
        {/if}
      {/if}
    {/if}
  </div>
</aside>
