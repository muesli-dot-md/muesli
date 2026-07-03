// REST data layer for workspace management (ADR 0011) + the documents list.
//
// Deliberately DOM-free and self-contained (no relative imports), so the
// headless integration test (scripts/workspace-ui-e2e.mjs) can import this
// file directly under node 22 type-stripping and drive the EXACT functions
// the UI uses against a live server.
//
// Conventions (server contract, see scripts/workspace-s3-e2e.mjs):
//   - routes live under {httpBase}/api/workspaces and {httpBase}/api/documents
//   - requests carry credentials (session cookie)
//   - non-2xx responses throw WorkspaceApiError (status + plain-text body);
//     callers map 401 → signed-out, 403 → not allowed, 409 → last-admin
//     guard, 503 → open mode (workspace UI hidden entirely)

export type WorkspaceRole = "admin" | "member";

export type WorkspaceSummary = {
  id: string;
  name: string;
  role: WorkspaceRole;
  is_personal: boolean;
  /** Lifecycle state (plan 1a): e.g. "pending" until storage is bound, "active" after. */
  status?: string;
};

export type WorkspaceMember = {
  user_id: string;
  display_name: string | null;
  email: string | null;
  kind: string; // "human" | "agent"
  role: WorkspaceRole;
};

export type WorkspaceInvite = {
  id: string;
  email: string;
  role: WorkspaceRole;
  created_at: string;
};

export type WorkspaceSso = {
  issuer: string;
  client_id: string;
  /** The secret itself is never echoed by the server (redacted like gdrive tokens). */
  has_client_secret: boolean;
  email_domains: string[];
};

export type WorkspaceDetail = {
  id: string;
  name: string;
  role: WorkspaceRole;
  members: WorkspaceMember[];
  /** Lifecycle state (plan 1a): e.g. "pending" until storage is bound, "active" after. */
  status?: string;
  /** The bound storage connection, or null until one is attached (plan 1a task 2). */
  storage_conn_id?: string | null;
  /** Retention knob (plan 1a task 9); only present when the caller is an admin. */
  retention?: string | null;
  /** Only present when the caller is an admin of the workspace. */
  invites?: WorkspaceInvite[];
  /** Per-workspace IdP config (Phase 5); admins only, secret redacted. */
  sso?: WorkspaceSso;
};

export type AuditActor = {
  id: string;
  display_name: string | null;
  kind: string; // "human" | "agent"
} | null;

export type AuditEntry = {
  id: number;
  action: string;
  actor: AuditActor;
  actor_label: string | null;
  document_id: string | null;
  detail: unknown;
  created_at: string;
};

export type InviteResult =
  | { status: "added"; user_id: string; role: WorkspaceRole }
  | { status: "invited"; invite_id: string; email: string; role: WorkspaceRole };

export type DocumentOwner = {
  id: string;
  display_name: string | null;
};

export type DocumentSummary = {
  document_id: string;
  slug: string;
  title: string | null;
  folder_id: string | null;
  updated_at: string;
  workspace_id: string | null;
  deleted_at: string | null;
  /** Starred / favourite (migration 0011); drives the "~starred" view + card star. */
  starred?: boolean;
  /** Creation-time owner; null in open mode and for pre-auth (ownerless) docs. */
  owner?: DocumentOwner | null;
  /** false ⇔ "shared with me" (delegated agent tokens count as their human owner). */
  is_owner?: boolean;
};

export type FolderSummary = {
  id: string;
  workspace_id: string | null;
  parent_id: string | null;
  name: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ShareRole = "viewer" | "commenter" | "editor";

// --- storage connections (ADR 0013; managed in Settings → Connections) -------------
// Secrets never appear: for s3/github, `config.credentials` tells the UI whether the
// connection carries a per-workspace credential ("workspace", plan 1a task 4) or falls
// back to the server environment ("server-env"); s3's `access_key_id` is truncated to
// its last 4 chars. gdrive configs are redacted server-side to has_refresh_token.
// `google.configured` is the Drive-OAuth readiness flag so the UI can render an
// honest "setup required" card instead of bouncing into a 503.

export type StorageConnection = {
  id: string;
  kind: string; // "s3" | "github" | "gdrive" | "sharepoint"
  config: Record<string, unknown>;
  created_at: string;
};

export type StorageConnectionList = {
  connections: StorageConnection[];
  google: { configured: boolean };
};

// --- sharepoint (BYO storage phase 2) ----------------------------------------------
// Setup metadata for the wizard's grant step: templates keep {tenant}/{site_url}/
// {client_id} placeholders the client substitutes (a bring-your-own Entra app
// substitutes its OWN client id instead of the server's).

export type SharePointSetupResponse = {
  configured: boolean;
  client_id: string | null;
  consent_url_template: string;
  grant_snippet_graph: string;
  grant_snippet_powershell: string;
};

export type SharePointLibrariesRequest = {
  tenant: string;
  site_url: string;
  client_id?: string;
  client_secret?: string;
  client_certificate_pem?: string;
  client_private_key_pem?: string;
};

export type SharePointLibrariesResponse = {
  site_id: string;
  site_name: string;
  libraries: { drive_id: string; name: string; is_default: boolean }[];
};

// access_key_id/secret_key/token stay OPTIONAL here (unlike @muesli/workspace-setup's
// CreateStorageBody, which always collects them): the server's CreateStorageReq
// (crates/muesli-server/src/workspace.rs) treats them as Option<String> too — a
// workspace-scoped credential (plan 1a) if given, else the legacy server-env
// fallback (MUESLI_S3_*/MUESLI_GITHUB_TOKEN). StorageS3Form.svelte now collects
// access_key_id/secret_key like the wizard's StepConnectS3 does (task 1b-T5);
// StorageGitForm.svelte still relies on the server-env token only.
export type CreateStorageRequest =
  | {
      kind: "s3";
      endpoint: string;
      bucket: string;
      region?: string;
      prefix?: string;
      access_key_id?: string;
      secret_key?: string;
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
  | {
      kind: "sharepoint";
      tenant: string;
      site_url: string;
      site_id: string;
      drive_id: string;
      drive_name: string;
      prefix?: string;
      client_id?: string;
      client_secret?: string;
      client_certificate_pem?: string;
      client_private_key_pem?: string;
    };

/** GET /api/workspaces/{id}/storage/status response (plan 1a task 10). */
export type StorageStatusResponse = {
  bound: boolean;
  status?: string;
  kind?: string;
  healthy?: boolean | null;
  last_ok_unix?: number | null;
  last_error?: string | null;
  last_error_unix?: number | null;
};

// --- search (GET /api/search, migration 0009) -------------------------------------
// Results come ranked: title prefix > title substring > content FTS > content ILIKE.
// For field "title" the snippet IS the title; for "content" it is a ±60-char window
// around the first hit ("…"-truncated, whitespace flattened).

export type SearchSource = {
  kind: "native" | "s3" | "github" | "gdrive";
  label: string;
};

export type SearchMatch = {
  field: "title" | "content";
  snippet: string;
};

export type SearchResult = {
  document_id: string;
  slug: string;
  title: string;
  folder_id: string | null;
  workspace_id: string | null;
  updated_at: string;
  source: SearchSource;
  owner: DocumentOwner | null;
  is_owner: boolean;
  match: SearchMatch;
};

export class WorkspaceApiError extends Error {
  status: number;
  bodyText: string;
  constructor(status: number, bodyText: string) {
    super(bodyText.trim() || `HTTP ${status}`);
    this.name = "WorkspaceApiError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

export type WorkspaceApiConfig = {
  httpBase: string;
  /** Override fetch (tests inject a cookie-carrying wrapper); defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
};

export function createWorkspaceApi(cfg: WorkspaceApiConfig) {
  const fetchFn = cfg.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function req<T>(
    path: string,
    opts: {
      method?: string;
      body?: unknown;
      query?: Record<string, string | undefined>;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const url = new URL(`${cfg.httpBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    const res = await fetchFn(url.toString(), {
      method: opts.method ?? "GET",
      credentials: "include",
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new WorkspaceApiError(res.status, text);
    // DELETE responses may have an empty body.
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    // --- workspaces ---
    listWorkspaces: () => req<{ workspaces: WorkspaceSummary[] }>("/api/workspaces"),
    /** POST /api/workspaces {name} → 201 { id, name, role: "admin", is_personal: false }. */
    createWorkspace: (name: string) =>
      req<WorkspaceSummary>("/api/workspaces", { method: "POST", body: { name } }),
    getWorkspace: (id: string) =>
      req<WorkspaceDetail>(`/api/workspaces/${encodeURIComponent(id)}`),
    renameWorkspace: (id: string, name: string) =>
      req<{ id: string; name: string }>(`/api/workspaces/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { name },
      }),

    // --- invites (admin) ---
    createInvite: (id: string, email: string, role: WorkspaceRole) =>
      req<InviteResult>(`/api/workspaces/${encodeURIComponent(id)}/invites`, {
        method: "POST",
        body: { email, role },
      }),
    revokeInvite: (id: string, inviteId: string) =>
      req<unknown>(
        `/api/workspaces/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`,
        { method: "DELETE" },
      ),

    // --- members ---
    setMemberRole: (id: string, userId: string, role: WorkspaceRole) =>
      req<unknown>(
        `/api/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
        { method: "PATCH", body: { role } },
      ),
    removeMember: (id: string, userId: string) =>
      req<unknown>(
        `/api/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      ),

    // --- audit log (admin; Phase 5) ---
    getAudit: (id: string, opts: { limit?: number; beforeId?: number } = {}) =>
      req<{ entries: AuditEntry[] }>(`/api/workspaces/${encodeURIComponent(id)}/audit`, {
        query: {
          limit: opts.limit !== undefined ? String(opts.limit) : undefined,
          before_id: opts.beforeId !== undefined ? String(opts.beforeId) : undefined,
        },
      }),

    // --- storage connections (Settings → Connections) ---
    listStorageConnections: (id: string) =>
      req<StorageConnectionList>(`/api/workspaces/${encodeURIComponent(id)}/storage`),
    /** Admin. The backend is probed before the row is created: a typo'd config fails
     *  THIS request (502 → "couldn't reach"), never the sync loops. */
    createStorageConnection: (id: string, body: CreateStorageRequest) =>
      req<{
        storage_conn_id: string;
        kind: string;
        config: Record<string, unknown>;
        workspace_status: string | null;
        attached_documents: number;
      }>(`/api/workspaces/${encodeURIComponent(id)}/storage`, { method: "POST", body }),
    /** Admin. 409 (bodyText `{"attached_documents":n}`) while documents still
     *  reference the connection — detach them first; no force flag in v1. */
    deleteStorageConnection: (id: string, connId: string) =>
      req<{ deleted: boolean }>(
        `/api/workspaces/${encodeURIComponent(id)}/storage/${encodeURIComponent(connId)}`,
        { method: "DELETE" },
      ),
    /** GET /api/storage/s3/policy — the copy-paste IAM policy for the wizard. */
    getS3Policy: (bucket: string, prefix: string) =>
      req<{ policy: unknown }>("/api/storage/s3/policy", { query: { bucket, prefix } }),
    /** GET /api/workspaces/{id}/storage/status — storage health (plan 1a task 10). */
    getStorageStatus: (id: string) =>
      req<StorageStatusResponse>(`/api/workspaces/${encodeURIComponent(id)}/storage/status`),
    /** GET /api/storage/sharepoint/setup — server app + grant snippet templates. */
    getSharePointSetup: () => req<SharePointSetupResponse>("/api/storage/sharepoint/setup"),
    /** POST /api/workspaces/{id}/storage/sharepoint/libraries — ephemeral site resolve
     *  + library list (admin); nothing is persisted server-side. */
    listSharePointLibraries: (id: string, body: SharePointLibrariesRequest) =>
      req<SharePointLibrariesResponse>(
        `/api/workspaces/${encodeURIComponent(id)}/storage/sharepoint/libraries`,
        { method: "POST", body },
      ),

    // --- per-workspace IdP (admin; Phase 5) ---
    setSso: (
      id: string,
      sso: { issuer: string; client_id: string; client_secret: string; email_domains: string[] },
    ) =>
      req<WorkspaceSso>(`/api/workspaces/${encodeURIComponent(id)}/sso`, {
        method: "PUT",
        body: sso,
      }),
    removeSso: (id: string) =>
      req<unknown>(`/api/workspaces/${encodeURIComponent(id)}/sso`, { method: "DELETE" }),

    // --- documents (works in open mode too) ---
    // trashed=true flips BOTH arrays to trashed-only rows.
    listDocuments: (query?: string, opts?: { trashed?: boolean }) =>
      req<{ documents: DocumentSummary[]; folders?: FolderSummary[] }>("/api/documents", {
        query: { query: query || undefined, trashed: opts?.trashed ? "true" : undefined },
      }),
    /** Server-side ranked search; empty/whitespace q answers {results:[]} without auth fuss. */
    search: (q: string, opts: { limit?: number; signal?: AbortSignal } = {}) =>
      req<{ results: SearchResult[] }>("/api/search", {
        query: { q, limit: opts.limit !== undefined ? String(opts.limit) : undefined },
        signal: opts.signal,
      }),
    // PATCH semantics: absent key = keep; title null/"" clears back to the slug
    // fallback; folder_id null = move to root; starred true/false toggles the star.
    updateDocument: (
      slug: string,
      patch: { title?: string | null; folder_id?: string | null; starred?: boolean },
    ) =>
      req<{
        document_id: string;
        slug: string;
        title: string | null;
        folder_id: string | null;
        starred: boolean;
      }>(`/api/documents/${encodeURIComponent(slug)}`, { method: "PATCH", body: patch }),
    trashDocument: (slug: string) =>
      req<{ trashed: boolean; document_id: string }>(
        `/api/documents/${encodeURIComponent(slug)}`,
        { method: "DELETE" },
      ),
    restoreDocument: (slug: string) =>
      req<{ restored: boolean; document_id: string; folder_id: string | null }>(
        `/api/documents/${encodeURIComponent(slug)}/restore`,
        { method: "POST" },
      ),
    /** Hard delete — gone from live AND trash. Irreversible. */
    purgeDocument: (slug: string) =>
      req<{ purged: boolean; document_id: string }>(
        `/api/documents/${encodeURIComponent(slug)}/purge`,
        { method: "DELETE" },
      ),
    /** Current markdown (REST snapshot, no ws needed) — download + the info panel's size. */
    getDocumentText: (slug: string) =>
      req<{ seq: number; text: string }>(`/api/documents/${encodeURIComponent(slug)}/text`),
    createShareLink: (slug: string, role: ShareRole) =>
      req<{ url: string; role: ShareRole }>(
        `/api/documents/${encodeURIComponent(slug)}/share`,
        { method: "POST", body: { role } },
      ),

    // --- folders (migration 0008) ---
    createFolder: (name: string, parentId?: string | null, workspaceId?: string) =>
      req<FolderSummary>("/api/folders", {
        method: "POST",
        body: {
          name,
          ...(parentId ? { parent_id: parentId } : {}),
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
        },
      }),
    // PATCH semantics: absent key = keep; parent_id null = move to root.
    updateFolder: (id: string, patch: { name?: string; parent_id?: string | null }) =>
      req<FolderSummary>(`/api/folders/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: patch,
      }),
    /** Trashes the whole subtree; returns affected counts. */
    trashFolder: (id: string) =>
      req<{ trashed: boolean; folders: number; documents: number }>(
        `/api/folders/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    restoreFolder: (id: string) =>
      req<{ restored: boolean; folders: number; documents: number }>(
        `/api/folders/${encodeURIComponent(id)}/restore`,
        { method: "POST" },
      ),
  };
}

export type WorkspaceApi = ReturnType<typeof createWorkspaceApi>;

/** "My Notes!" → "my-notes" — mirrors the slugs the server mints for new docs. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
