// Shared types for the React wizard components. The framework-agnostic logic
// (machine, capabilities, host, copy, sharepoint, onboarding) lives one level
// up; only the rendering layer lives in react/.

import type { WizardKey } from "../copy";
import type { WizardHost } from "../host";

/** The interpolating translator makeT() returns (built-in English fallback). */
export type Translate = (key: WizardKey, params?: Record<string, string | number>) => string;

/** Props every StepConnect* screen receives from WorkspaceWizard. */
export type ConnectStepProps = {
  host: WizardHost;
  t: Translate;
  workspaceId: string | null;
  ensureWorkspace: () => Promise<string>;
  onConnected: (workspaceId: string) => void;
  onBack: () => void;
  stepIndex: number;
  totalSteps: number;
};

/** Multica's wizard headline stack: system serif with italic emphasis. */
export const WIZARD_SERIF =
  'ui-serif, "Iowan Old Style", "Apple Garamond", Baskerville, "Times New Roman", serif';

/** Per-step remount fade (subtle, reduced-motion aware) — put on the wrapper
 *  that gets `key={step}` so each step eases in. */
export const STEP_FADE_CLASS =
  "animate-in fade-in duration-300 fill-mode-both motion-reduce:animate-none";
