import { describe, expect, it } from "vitest";
import { compareBy, homeMainPanel, inWorkspace } from "./homeWorkspace";
import type { Route } from "./route.svelte";

const PERSONAL = "ws-personal";
const TEAM = "ws-team";

describe("inWorkspace", () => {
  it("shows everything while the selection is unresolved (null)", () => {
    expect(inWorkspace(TEAM, null, PERSONAL)).toBe(true);
    expect(inWorkspace(null, null, PERSONAL)).toBe(true);
  });

  it("matches a non-personal workspace strictly on id", () => {
    expect(inWorkspace(TEAM, TEAM, PERSONAL)).toBe(true);
    expect(inWorkspace(PERSONAL, TEAM, PERSONAL)).toBe(false);
    expect(inWorkspace(null, TEAM, PERSONAL)).toBe(false);
    expect(inWorkspace(undefined, TEAM, PERSONAL)).toBe(false);
  });

  it("treats ownerless / open-mode (null) rows as belonging to the personal workspace", () => {
    expect(inWorkspace(null, PERSONAL, PERSONAL)).toBe(true);
    expect(inWorkspace(undefined, PERSONAL, PERSONAL)).toBe(true);
    expect(inWorkspace(PERSONAL, PERSONAL, PERSONAL)).toBe(true);
    expect(inWorkspace(TEAM, PERSONAL, PERSONAL)).toBe(false);
  });

  it("handles a null personal id (open mode with no personal workspace)", () => {
    // selected === personal === null is the unresolved case → show all
    expect(inWorkspace(TEAM, null, null)).toBe(true);
    // a real selection still filters strictly
    expect(inWorkspace(null, TEAM, null)).toBe(false);
  });
});

describe("homeMainPanel", () => {
  const home: Route = { kind: "home", view: "root", folderId: null };
  const folder: Route = { kind: "home", view: "folder", folderId: "f1" };
  const settings: Route = { kind: "settings", section: "profile" };

  it("renders the document browser on a home route with the graph closed", () => {
    expect(homeMainPanel(home, false)).toBe("documents");
    expect(homeMainPanel(folder, false)).toBe("documents");
  });

  it("renders the graph when the local toggle is open on a home route", () => {
    expect(homeMainPanel(home, true)).toBe("graph");
  });

  it("renders settings inside the panel for a settings route", () => {
    expect(homeMainPanel(settings, false)).toBe("settings");
  });

  it("lets a settings deep-link win over a stale graph-open toggle", () => {
    expect(homeMainPanel(settings, true)).toBe("settings");
  });
});

describe("compareBy", () => {
  type Row = { name: string; updated_at: string };
  const rows: Row[] = [
    { name: "Bravo", updated_at: "2026-01-03T00:00:00Z" },
    { name: "alpha", updated_at: "2026-01-01T00:00:00Z" },
    { name: "Charlie", updated_at: "2026-01-02T00:00:00Z" },
  ];
  const byName = (r: Row) => r.name;
  const byDate = (r: Row) => r.updated_at;

  it("sorts by name ascending, case-insensitively", () => {
    const out = [...rows].sort(compareBy("name", true, byName, byDate)).map(byName);
    expect(out).toEqual(["alpha", "Bravo", "Charlie"]);
  });

  it("sorts by name descending", () => {
    const out = [...rows].sort(compareBy("name", false, byName, byDate)).map(byName);
    expect(out).toEqual(["Charlie", "Bravo", "alpha"]);
  });

  it("sorts by modified date, newest-first when descending", () => {
    const out = [...rows].sort(compareBy("modified", false, byName, byDate)).map(byName);
    expect(out).toEqual(["Bravo", "Charlie", "alpha"]);
  });

  it("sorts by modified date, oldest-first when ascending", () => {
    const out = [...rows].sort(compareBy("modified", true, byName, byDate)).map(byName);
    expect(out).toEqual(["alpha", "Charlie", "Bravo"]);
  });
});
