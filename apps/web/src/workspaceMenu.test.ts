import { describe, expect, it } from "vitest";
import {
  activeWorkspaceLabel,
  avatarLetter,
  menuIdentity,
  workspaceMenuRows,
} from "./workspaceMenu";
import type { WorkspaceSummary } from "./workspaceApi";
import type { Me } from "./identity";

const ws = (over: Partial<WorkspaceSummary>): WorkspaceSummary => ({
  id: "id",
  name: "Name",
  role: "admin",
  is_personal: false,
  ...over,
});

const PERSONAL = ws({ id: "ws-personal", name: "Personal", is_personal: true });
const TEAM = ws({ id: "ws-team", name: "Team Alpha" });

describe("avatarLetter", () => {
  it("uppercases the first alphanumeric character", () => {
    expect(avatarLetter("team alpha")).toBe("T");
    expect(avatarLetter("  oat 86")).toBe("O");
    expect(avatarLetter("99 luftballons")).toBe("9");
  });
  it("falls back to ? when there is nothing alphanumeric", () => {
    expect(avatarLetter("   ")).toBe("?");
    expect(avatarLetter("")).toBe("?");
    expect(avatarLetter("✦")).toBe("?");
  });
});

describe("workspaceMenuRows", () => {
  it("labels the personal workspace with the localized label, others by name", () => {
    const rows = workspaceMenuRows([PERSONAL, TEAM], "ws-personal", "My workspace");
    expect(rows.map((r) => r.label)).toEqual(["My workspace", "Team Alpha"]);
    expect(rows.map((r) => r.letter)).toEqual(["M", "T"]);
  });

  it("marks exactly the selected workspace active (the checkmark target)", () => {
    const rows = workspaceMenuRows([PERSONAL, TEAM], "ws-team", "My workspace");
    expect(rows.find((r) => r.id === "ws-team")?.active).toBe(true);
    expect(rows.find((r) => r.id === "ws-personal")?.active).toBe(false);
  });

  it("marks none active when the selection is unresolved (null)", () => {
    const rows = workspaceMenuRows([PERSONAL, TEAM], null, "My workspace");
    expect(rows.every((r) => !r.active)).toBe(true);
  });
});

describe("activeWorkspaceLabel", () => {
  it("returns the active workspace label (personal localized)", () => {
    expect(activeWorkspaceLabel([PERSONAL, TEAM], "ws-personal", "My workspace", "fallback")).toBe(
      "My workspace",
    );
    expect(activeWorkspaceLabel([PERSONAL, TEAM], "ws-team", "My workspace", "fallback")).toBe(
      "Team Alpha",
    );
  });

  it("returns the fallback when nothing is selected or the id is unknown", () => {
    expect(activeWorkspaceLabel([PERSONAL, TEAM], null, "My workspace", "fallback")).toBe(
      "fallback",
    );
    expect(activeWorkspaceLabel([PERSONAL, TEAM], "ghost", "My workspace", "fallback")).toBe(
      "fallback",
    );
  });
});

describe("menuIdentity", () => {
  const base: Me = {
    id: "user-1",
    email: "ada@example.com",
    display_name: "Ada Lovelace",
    avatar_url: null,
    onboarded_at: null,
  };

  it("prefers the display name, exposes initials and a stable id-derived color", () => {
    const id = menuIdentity(base);
    expect(id.name).toBe("Ada Lovelace");
    expect(id.email).toBe("ada@example.com");
    expect(id.initials).toBe("A");
    expect(id.avatarUrl).toBeNull();
    // Same id → same color across calls (stable, reuses colorFromId).
    expect(id.color).toBe(menuIdentity({ ...base, display_name: "Other" }).color);
  });

  it("falls back to the email when there is no display name", () => {
    expect(menuIdentity({ ...base, display_name: null }).name).toBe("ada@example.com");
  });

  it("passes through an avatar URL when present", () => {
    expect(menuIdentity({ ...base, avatar_url: "https://x/y.png" }).avatarUrl).toBe(
      "https://x/y.png",
    );
  });
});
