import { describe, expect, it } from "vitest";
import { classifyDocError } from "./errorKind";

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
