import { describe, it, expect } from "vitest";
import { ALL_STORAGE_AVAILABLE, parseStorageCapabilities } from "./capabilities";

describe("parseStorageCapabilities (GET /api/me `storage`)", () => {
  it("maps the server's flat booleans onto the picker's backends", () => {
    // The prod bug: no Google OAuth client on the server → gdrive must be off.
    expect(
      parseStorageCapabilities({ s3: true, github: true, gdrive: false, sharepoint: true }),
    ).toEqual({ s3: true, github: true, gdrive: false, sharepoint: true });
    expect(
      parseStorageCapabilities({ s3: false, github: false, gdrive: false, sharepoint: false }),
    ).toEqual({ s3: false, github: false, gdrive: false, sharepoint: false });
  });

  it("treats an absent field as an older server: everything stays offered", () => {
    // Older servers don't report capabilities; the wizard must behave exactly
    // as it did before (the connect step still reports honest errors).
    expect(parseStorageCapabilities(undefined)).toEqual(ALL_STORAGE_AVAILABLE);
    expect(parseStorageCapabilities(null)).toEqual(ALL_STORAGE_AVAILABLE);
    expect(parseStorageCapabilities({})).toEqual(ALL_STORAGE_AVAILABLE);
  });

  it("only an explicit false disables a backend (malformed flags fail open)", () => {
    expect(parseStorageCapabilities({ gdrive: false })).toEqual({
      s3: true,
      gdrive: false,
      github: true,
      sharepoint: true,
    });
    expect(parseStorageCapabilities({ s3: "nope", gdrive: 0, github: null })).toEqual(
      ALL_STORAGE_AVAILABLE,
    );
    expect(parseStorageCapabilities("garbage")).toEqual(ALL_STORAGE_AVAILABLE);
  });
});
