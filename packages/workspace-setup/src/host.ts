// The adapter each app injects. Web: fetch-based (workspaceApi). Desktop: Tauri
// api_request. The wizard components ONLY talk to this interface.

import type { StorageCapabilities } from "./capabilities";

export type CreateStorageBody =
  | {
      kind: "s3";
      endpoint: string;
      bucket: string;
      region?: string;
      prefix?: string;
      access_key_id: string;
      secret_key: string;
    }
  | {
      kind: "github";
      api_base: string;
      owner: string;
      repo: string;
      branch: string;
      prefix?: string;
      token?: string;
    }
  | ({
      kind: "sharepoint";
      tenant: string;
      site_url: string;
      site_id: string;
      drive_id: string;
      drive_name: string;
      prefix?: string;
    } & SharePointCredentials);

export type SharePointCredentials = {
  client_id?: string;
  client_secret?: string;
  client_certificate_pem?: string;
  client_private_key_pem?: string;
};

export type SharePointSetup = {
  configured: boolean;
  client_id: string | null;
  consent_url_template: string;
  grant_snippet_graph: string;
  grant_snippet_powershell: string;
};

export type SharePointLibraries = {
  site_id: string;
  site_name: string;
  libraries: { drive_id: string; name: string; is_default: boolean }[];
};

export type ConnectResult = {
  storage_conn_id: string;
  kind: string;
  workspace_status: string | null;
  attached_documents: number;
};

export type StorageStatus = {
  bound: boolean;
  status?: string;
  kind?: string;
  healthy?: boolean | null;
  last_error?: string | null;
};

export type WizardHost = {
  /** POST /api/workspaces {name} → the pending workspace. */
  createWorkspace(name: string): Promise<{ id: string; name: string; status?: string }>;
  /** POST /api/workspaces/{id}/storage — probes, binds, activates (plan 1a). */
  createStorageConnection(workspaceId: string, body: CreateStorageBody): Promise<ConnectResult>;
  /** GET /api/storage/s3/policy — the copy-paste IAM policy JSON. */
  getS3Policy(bucket: string, prefix: string): Promise<unknown>;
  /** GET /api/workspaces/{id}/storage/status — the OAuth poll target. */
  getStorageStatus(workspaceId: string): Promise<StorageStatus>;
  /** GET /api/storage/sharepoint/setup — server app + grant snippet templates. */
  getSharePointSetup(): Promise<SharePointSetup>;
  /** POST /api/workspaces/{id}/storage/sharepoint/libraries — ephemeral site resolve. */
  listSharePointLibraries(
    workspaceId: string,
    body: { tenant: string; site_url: string } & SharePointCredentials,
  ): Promise<SharePointLibraries>;
  /** Kick off the Drive OAuth dance for a pending workspace.
   *  Web: full-page navigation (never returns). Desktop: opens the system browser. */
  startDriveOAuth(workspaceId: string): void;
  /** Which storage backends the server can actually connect (GET /api/me
   *  `storage`, parse with parseStorageCapabilities). The picker disables the
   *  rest. Resolve to ALL_STORAGE_AVAILABLE when the answer isn't knowable. */
  storageCapabilities(): Promise<StorageCapabilities>;
  /** Called when the wizard finishes; the host takes over (select ws / pick folder). */
  onDone(workspaceId: string): void;
  /** Called when the user cancels/closes the wizard. */
  onCancel(): void;
  /** Optional i18n override; defaults to built-in English (copy.ts). */
  t?: (key: string, params?: Record<string, string | number>) => string;
  /** Desktop = poll after OAuth; web = full-page redirect resumes the wizard. */
  driveFlow: "redirect" | "poll";
};

/** What StepConnectSharePoint actually needs — Settings mounts it standalone with a
 *  three-method adapter instead of a full WizardHost. */
export type SharePointHost = Pick<
  WizardHost,
  "createStorageConnection" | "getSharePointSetup" | "listSharePointLibraries"
>;
