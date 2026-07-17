<script lang="ts">
  // Desktop host for the shared creation wizard. Overlay styling mirrors
  // MoveToModal.svelte (fixed inset, var(--overlay) card, Escape/backdrop close).
  import { openUrl } from "@tauri-apps/plugin-opener";
  import WorkspaceWizard from "@muesli/workspace-setup/WorkspaceWizard.svelte";
  import type {
    WizardHost,
    CreateStorageBody,
    SharePointSetup,
    SharePointLibraries,
    SharePointCredentials,
  } from "@muesli/workspace-setup/host";
  import {
    ALL_STORAGE_AVAILABLE,
    parseStorageCapabilities,
  } from "@muesli/workspace-setup/capabilities";
  import { apiRequest } from "$lib/collab/apiRequest";
  import { httpBaseOf } from "$lib/httpBase";
  import { prepareCloneDir } from "$lib/tauri";
  import { workspaces } from "$lib/workspaces.svelte";

  let { onclose }: { onclose: () => void } = $props();

  const server = workspaces.activeServer;
  let pendingName = "";

  const host: WizardHost = {
    createWorkspace: async (name: string) => {
      pendingName = name;
      return apiRequest<{ id: string; name: string; status?: string }>(server, {
        method: "POST",
        path: "/api/workspaces",
        body: { name },
      });
    },
    createStorageConnection: (id: string, body: CreateStorageBody) =>
      apiRequest(server, {
        method: "POST",
        path: `/api/workspaces/${encodeURIComponent(id)}/storage`,
        body,
      }),
    getS3Policy: (bucket: string, prefix: string) =>
      apiRequest(server, { path: "/api/storage/s3/policy", query: { bucket, prefix } }),
    getStorageStatus: (id: string) =>
      apiRequest(server, { path: `/api/workspaces/${encodeURIComponent(id)}/storage/status` }),
    getSharePointSetup: () =>
      apiRequest<SharePointSetup>(server, { path: "/api/storage/sharepoint/setup" }),
    listSharePointLibraries: (
      id: string,
      body: { tenant: string; site_url: string } & SharePointCredentials,
    ) =>
      apiRequest<SharePointLibraries>(server, {
        method: "POST",
        path: `/api/workspaces/${encodeURIComponent(id)}/storage/sharepoint/libraries`,
        body,
      }),
    startDriveOAuth: (id: string) => {
      // The OAuth start authenticates with the BROWSER session cookie, not the
      // desktop's bearer token — the user signs in to the web app if prompted,
      // then the wizard's poll (driveFlow: "poll") sees the binding land.
      // `server` is the ws:// sync endpoint (e.g. ws://localhost:8787/ws); the system
      // browser needs a real http(s) URL, so normalize it first.
      void openUrl(
        `${httpBaseOf(server)}/api/workspaces/${encodeURIComponent(id)}/storage/google/start?wizard=1`,
      );
    },
    storageCapabilities: async () => {
      // /api/me reports which backends the server can serve; older servers omit
      // the field and any failure keeps everything offered (fail open, as before).
      try {
        const res = await apiRequest<{ storage?: Record<string, boolean> }>(server, {
          path: "/api/me",
        });
        return parseStorageCapabilities(res.storage);
      } catch {
        return { ...ALL_STORAGE_AVAILABLE };
      }
    },
    onDone: async (workspaceId: string) => {
      // prepareCloneDir opens the Rust-owned folder dialog for the destination
      // parent; null = the user cancelled, so stay on the done screen to retry.
      const path = await prepareCloneDir(pendingName);
      if (!path) return;
      onclose();
      await workspaces.finishRemoteWorkspace(workspaceId, pendingName, path);
    },
    onCancel: () => onclose(),
    driveFlow: "poll",
  };

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh]"
  onclick={handleBackdropClick}
  onkeydown={(e) => {
    if (e.key === "Escape") onclose();
  }}
>
  <div
    class="mx-4 flex max-h-[78vh] w-full max-w-xl flex-col overflow-y-auto p-5"
    style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
    role="dialog"
    aria-modal="true"
    aria-label="Create workspace"
  >
    <WorkspaceWizard {host} />
  </div>
</div>
