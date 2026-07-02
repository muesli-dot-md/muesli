import { describe, it, expect } from "vitest";
import { createWizardMachine } from "./machine";

describe("wizard machine", () => {
  it("walks name → storage → connect → done and back", () => {
    const m = createWizardMachine();
    expect(m.state.step).toBe("name");
    expect(m.state.stepIndex).toBe(0);
    expect(m.state.totalSteps).toBe(4);

    expect(m.next({ name: "  Team Docs  " })).toBe(true);
    expect(m.state.step).toBe("storage");
    expect(m.state.name).toBe("Team Docs"); // trimmed

    expect(m.next({ backend: "s3" })).toBe(true);
    expect(m.state.step).toBe("connect");
    expect(m.state.backend).toBe("s3");

    m.back();
    expect(m.state.step).toBe("storage");
    m.back();
    expect(m.state.step).toBe("name");
    m.back(); // no-op at the first step
    expect(m.state.step).toBe("name");
  });

  it("refuses to advance without required data", () => {
    const m = createWizardMachine();
    expect(m.next({ name: "   " })).toBe(false);
    expect(m.state.step).toBe("name");
    m.next({ name: "x" });
    expect(m.next({})).toBe(false); // no backend chosen
    expect(m.state.step).toBe("storage");
  });

  it("connect step completes with a workspace id", () => {
    const m = createWizardMachine();
    m.next({ name: "x" });
    m.next({ backend: "gdrive" });
    expect(m.next({ workspaceId: "ws-123" })).toBe(true);
    expect(m.state.step).toBe("done");
    expect(m.state.workspaceId).toBe("ws-123");
  });

  it("resume() jumps straight to a step (OAuth return)", () => {
    const m = createWizardMachine();
    m.resume({ step: "done", workspaceId: "ws-9", backend: "gdrive", name: "" });
    expect(m.state.step).toBe("done");
    expect(m.state.workspaceId).toBe("ws-9");
  });

  it("sharepoint is a connect-step backend like s3 (no new states)", () => {
    const m = createWizardMachine();
    m.next({ name: "x" });
    expect(m.next({ backend: "sharepoint" })).toBe(true);
    expect(m.state.step).toBe("connect");
    expect(m.state.backend).toBe("sharepoint");
    expect(m.next({ workspaceId: "ws-sp" })).toBe(true);
    expect(m.state.step).toBe("done");
  });
});
