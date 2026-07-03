// The SharePoint connect step's logic, kept rune-free so it unit-tests in node (the
// machine.ts pattern). StepConnectSharePoint.svelte holds an SpState in $state and
// calls these helpers; they mutate the passed state in place.
//
// Stages (spec 2026-07-02 §Connect model): identity (server app or bring-your-own
// Entra app) → grant (copyable admin-consent URL + site-grant snippets) → site
// (tenant + site URL → Find libraries) → connect (library picker with the default
// preselected + prefix + probe).

import type {
  CreateStorageBody,
  SharePointCredentials,
  SharePointLibraries,
  SharePointSetup,
} from "./host";

export type SpStage = "identity" | "grant" | "site" | "connect";

/** Spec rule: a tenant is a GUID or [A-Za-z0-9.-]+ (the server re-validates). */
export const TENANT_RE = /^[A-Za-z0-9.-]+$/;

export type SpLibrary = { drive_id: string; name: string; is_default: boolean };

export type SpState = {
  stage: SpStage;
  /** Bring-your-own Entra app; forced true when the server has no app. */
  ownApp: boolean;
  authMethod: "secret" | "certificate";
  clientId: string;
  clientSecret: string;
  certificatePem: string;
  privateKeyPem: string;
  tenant: string;
  siteUrl: string;
  siteId: string;
  siteName: string;
  libraries: SpLibrary[];
  driveId: string;
  prefix: string;
};

export function initialSpState(configured: boolean): SpState {
  return {
    stage: "identity",
    ownApp: !configured,
    authMethod: "secret",
    clientId: "",
    clientSecret: "",
    certificatePem: "",
    privateKeyPem: "",
    tenant: "",
    siteUrl: "",
    siteId: "",
    siteName: "",
    libraries: [],
    driveId: "",
    prefix: "",
  };
}

/** The client id in play: the workspace's own app, else the server's. */
export function effectiveClientId(s: SpState, setup: SharePointSetup): string {
  return s.ownApp ? s.clientId.trim() : (setup.client_id ?? "");
}

export function identityComplete(s: SpState, setup: SharePointSetup): boolean {
  if (!s.ownApp) return setup.configured;
  if (!s.clientId.trim()) return false;
  return s.authMethod === "secret"
    ? s.clientSecret.trim().length > 0
    : s.certificatePem.trim().length > 0 && s.privateKeyPem.trim().length > 0;
}

export function siteComplete(s: SpState): boolean {
  return TENANT_RE.test(s.tenant.trim()) && /^https:\/\/[^/\s]+/i.test(s.siteUrl.trim());
}

const ORDER: SpStage[] = ["identity", "grant", "site", "connect"];

/** Advance one stage; site → connect only happens through applyLibraries. */
export function nextStage(s: SpState, setup: SharePointSetup): boolean {
  if (s.stage === "identity" && identityComplete(s, setup)) {
    s.stage = "grant";
    return true;
  }
  if (s.stage === "grant") {
    s.stage = "site";
    return true;
  }
  return false;
}

/** Step back one stage; false at the first one (the wizard's Back takes over there). */
export function backStage(s: SpState): boolean {
  const i = ORDER.indexOf(s.stage);
  if (i <= 0) return false;
  s.stage = ORDER[i - 1];
  return true;
}

/** Fill {client_id}/{tenant}/{site_url} in a server template; empty or unknown
 *  placeholders ({site_id}, {hostname}, …) stay literal for the admin. */
export function substitute(template: string, s: SpState, setup: SharePointSetup): string {
  const vars: Record<string, string> = {
    client_id: effectiveClientId(s, setup),
    tenant: s.tenant.trim(),
    site_url: s.siteUrl.trim(),
  };
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] || whole);
}

function credentials(s: SpState): SharePointCredentials {
  if (!s.ownApp) return {};
  const creds: SharePointCredentials = { client_id: s.clientId.trim() };
  if (s.authMethod === "secret") {
    creds.client_secret = s.clientSecret;
  } else {
    creds.client_certificate_pem = s.certificatePem;
    creds.client_private_key_pem = s.privateKeyPem;
  }
  return creds;
}

/** Body for POST …/storage/sharepoint/libraries (ephemeral; plaintext creds in flight
 *  only — the server persists nothing from this call). */
export function librariesBody(s: SpState): { tenant: string; site_url: string } & SharePointCredentials {
  return { tenant: s.tenant.trim(), site_url: s.siteUrl.trim(), ...credentials(s) };
}

/** Store the resolve result and advance; the DEFAULT library is preselected (spec). */
export function applyLibraries(s: SpState, res: SharePointLibraries): void {
  s.siteId = res.site_id;
  s.siteName = res.site_name;
  s.libraries = res.libraries;
  s.driveId = (res.libraries.find((l) => l.is_default) ?? res.libraries[0])?.drive_id ?? "";
  s.stage = "connect";
}

/** The CreateStorageBody for the final connect, or null while incomplete. */
export function connectBody(
  s: SpState,
): Extract<CreateStorageBody, { kind: "sharepoint" }> | null {
  const lib = s.libraries.find((l) => l.drive_id === s.driveId);
  if (!lib || !s.siteId) return null;
  return {
    kind: "sharepoint",
    tenant: s.tenant.trim(),
    site_url: s.siteUrl.trim(),
    site_id: s.siteId,
    drive_id: lib.drive_id,
    drive_name: lib.name,
    ...(s.prefix.trim() ? { prefix: s.prefix.trim() } : {}),
    ...credentials(s),
  };
}
