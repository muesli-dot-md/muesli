// Storage capability flags (GET /api/me `storage`): which backends this server can
// actually connect. The picker disables the rest instead of letting users run into
// the connect endpoint's raw config error (the "Google Drive on a server with no
// OAuth client" bug). Rune-free so it unit-tests in node.

import type { BackendKind } from "./machine";

export type StorageCapabilities = Record<BackendKind, boolean>;

/** The optimistic default while the probe is in flight (and the answer for hosts
 *  that cannot know): everything offered, like before capabilities existed. */
export const ALL_STORAGE_AVAILABLE: StorageCapabilities = {
  s3: true,
  gdrive: true,
  github: true,
  sharepoint: true,
};

/** Parse the `storage` field of a GET /api/me payload. Defensive on purpose:
 *  a missing/malformed field or flag means an OLDER server that doesn't report
 *  capabilities — treat those as available so the wizard behaves exactly as it
 *  did before (the connect step still reports honest errors). Only an explicit
 *  `false` disables a backend. */
export function parseStorageCapabilities(raw: unknown): StorageCapabilities {
  const obj = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const flag = (kind: BackendKind): boolean => obj[kind] !== false;
  return {
    s3: flag("s3"),
    gdrive: flag("gdrive"),
    github: flag("github"),
    sharepoint: flag("sharepoint"),
  };
}
