// The wizard's step logic, kept rune-free so it unit-tests in node. The Svelte
// components wrap it in $state (see WorkspaceWizard.svelte).

export type StepId = "name" | "storage" | "connect" | "done";
export type BackendKind = "s3" | "gdrive" | "github" | "sharepoint";

export type WizardState = {
  step: StepId;
  stepIndex: number;
  totalSteps: number;
  name: string;
  backend: BackendKind | null;
  workspaceId: string | null;
};

const ORDER: StepId[] = ["name", "storage", "connect", "done"];

export type NextInput = {
  name?: string;
  backend?: BackendKind;
  workspaceId?: string;
};

export function createWizardMachine() {
  const state: WizardState = {
    step: "name",
    stepIndex: 0,
    totalSteps: ORDER.length,
    name: "",
    backend: null,
    workspaceId: null,
  };

  function goto(step: StepId) {
    state.step = step;
    state.stepIndex = ORDER.indexOf(step);
  }

  /** Advance if the input satisfies the current step; false = stay put. */
  function next(input: NextInput): boolean {
    switch (state.step) {
      case "name": {
        const name = (input.name ?? "").trim();
        if (!name) return false;
        state.name = name;
        goto("storage");
        return true;
      }
      case "storage": {
        if (!input.backend) return false;
        state.backend = input.backend;
        goto("connect");
        return true;
      }
      case "connect": {
        if (!input.workspaceId) return false;
        state.workspaceId = input.workspaceId;
        goto("done");
        return true;
      }
      case "done":
        return false;
    }
  }

  /** Step back one step; no-op at the first step and once done. */
  function back() {
    if (state.step === "storage") goto("name");
    else if (state.step === "connect") goto("storage");
  }

  /** Jump to a known state (the OAuth-return resume path). */
  function resume(to: {
    step: StepId;
    name: string;
    backend: BackendKind | null;
    workspaceId: string | null;
  }) {
    state.name = to.name;
    state.backend = to.backend;
    state.workspaceId = to.workspaceId;
    goto(to.step);
  }

  return { state, next, back, resume };
}
