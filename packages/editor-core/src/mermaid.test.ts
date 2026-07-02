import { describe, it, expect } from "vitest";
import { MERMAID_SECURITY_LEVEL } from "./mermaid";

// Regression guard for security review finding 32: mermaid must keep running
// with securityLevel "strict" (labels sanitized, no click handlers/scripts).
// renderMermaidDiagrams additionally DOMPurify-sanitizes the SVG before
// injection, but this setting is the first line of defense.
describe("mermaid security settings", () => {
  it('MERMAID_SECURITY_LEVEL stays "strict"', () => {
    expect(MERMAID_SECURITY_LEVEL).toBe("strict");
  });
});
