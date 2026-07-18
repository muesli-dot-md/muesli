import { describe, expect, it } from "vitest";
import { classifyDocError, presentApiError } from "./errorKind";

describe("classifyDocError", () => {
  it("maps 404 to a doc-not-found page", () => {
    expect(classifyDocError(404)).toBe("doc-not-found");
  });

  it("maps 401/403 to a no-access page (signed in but not allowed)", () => {
    expect(classifyDocError(401)).toBe("no-access");
    expect(classifyDocError(403)).toBe("no-access");
  });

  it("maps everything else to a generic error page", () => {
    expect(classifyDocError(500)).toBe("generic");
    expect(classifyDocError(502)).toBe("generic");
    expect(classifyDocError(0)).toBe("generic");
  });
});

/** All API error classes share this shape: an Error with a numeric status. */
class FakeApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

describe("presentApiError", () => {
  it("passes user-actionable 4xx validation messages through as-is", () => {
    expect(presentApiError(new FakeApiError(409, "name already taken"))).toEqual({
      kind: "actionable",
      message: "name already taken",
    });
    expect(presentApiError(new FakeApiError(400, "endpoint and bucket are required"))).toEqual({
      kind: "actionable",
      message: "endpoint and bucket are required",
    });
  });

  it("hides 5xx config/internal errors behind the friendly catch-all", () => {
    // The prod bug: a raw server config string must never be user-facing.
    const raw =
      "google drive is not configured on the server " +
      "(set MUESLI_GOOGLE_CLIENT_ID + MUESLI_GOOGLE_CLIENT_SECRET or MUESLI_GOOGLE_CLIENT_FILE)";
    expect(presentApiError(new FakeApiError(503, raw))).toEqual({
      kind: "unexpected",
      detail: raw,
    });
    expect(presentApiError(new FakeApiError(500, "internal error")).kind).toBe("unexpected");
  });

  it("treats network failures and non-Error throwables as unexpected", () => {
    expect(presentApiError(new TypeError("Failed to fetch")).kind).toBe("unexpected");
    expect(presentApiError("boom")).toEqual({ kind: "unexpected", detail: "boom" });
    expect(presentApiError(null).kind).toBe("unexpected");
  });

  it("a 4xx with an empty body still gets the friendly treatment", () => {
    expect(presentApiError(new FakeApiError(404, "  ")).kind).toBe("unexpected");
  });
});
