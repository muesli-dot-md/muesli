// Desktop host for the shared creation wizard: a shadcn Dialog hosting
// WorkspaceWizard with the apiRequest-backed WizardHost. React port of
// src/lib/CreateWorkspaceModal.svelte.
//
// All authenticated calls route through the Rust `api_request` command (the
// bearer token lives in the Keychain; the webview never sees it). Drive OAuth
// opens the system browser (plugin-opener) and the wizard polls storage
// status (driveFlow: "poll").

import { useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { apiRequest } from "@/services/collab/apiRequest";
import { httpBaseOf } from "@/services/httpBase";
import { pickFolder, prepareCloneDir } from "@/services/tauri";
import { workspacesStore } from "@/state/workspaces";
import {
  ALL_STORAGE_AVAILABLE,
  parseStorageCapabilities,
} from "@muesli/workspace-setup/capabilities";
import type {
  CreateStorageBody,
  SharePointCredentials,
  SharePointLibraries,
  SharePointSetup,
  WizardHost,
} from "@muesli/workspace-setup/host";
import { WorkspaceWizard } from "./WorkspaceWizard";

export function CreateWorkspaceModal({ onClose }: { onClose: () => void }) {
  // Captured once at mount, matching the Svelte component's `const server`.
  const [server] = useState<string>(() => workspacesStore.getState().activeServer);
  const pendingNameRef = useRef("");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const host = useMemo<WizardHost>(
    () => ({
      createWorkspace: async (name: string) => {
        pendingNameRef.current = name;
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
        // `server` is the ws:// sync endpoint (e.g. ws://localhost:8787/ws); the
        // system browser needs a real http(s) URL, so normalize it first.
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
        const parent = await pickFolder();
        if (!parent) return; // stay on the done screen; the user can retry
        const path = await prepareCloneDir(parent, pendingNameRef.current);
        onCloseRef.current();
        await workspacesStore
          .getState()
          .finishRemoteWorkspace(workspaceId, pendingNameRef.current, path);
      },
      onCancel: () => onCloseRef.current(),
      driveFlow: "poll",
    }),
    [server],
  );

  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-label="Create workspace"
        showCloseButton={false}
        className="max-h-[78vh] gap-0 overflow-y-auto p-5 sm:max-w-xl"
        onKeyDown={(e: React.KeyboardEvent) => {
          // Escape contract: the modal handles its own Escape with preventDefault
          // so the global keymap fallback (services/keymap.ts) stays quiet.
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <DialogTitle className="sr-only">Create workspace</DialogTitle>
        <WorkspaceWizard host={host} />
      </DialogContent>
    </Dialog>
  );
}

// AppShell (F1) imports this as a default export; keep both forms.
export default CreateWorkspaceModal;
