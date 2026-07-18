// React rendering layer for @muesli/workspace-setup — imported by BOTH apps as
// "@muesli/workspace-setup/react" (raw .tsx source, compiled by each app; each
// app's Tailwind @source-scans packages/workspace-setup/src/**). Desktop-only
// hosts (Tauri overlay shell, CreateWorkspaceModal) stay in apps/desktop.

export { WorkspaceWizard } from "./WorkspaceWizard";
export { OnboardingFlow, type OnboardingFlowHost } from "./OnboardingFlow";
export { StepConnectS3 } from "./StepConnectS3";
export { StepConnectGithub } from "./StepConnectGithub";
export { StepConnectDrive } from "./StepConnectDrive";
export { StepConnectSharePoint } from "./StepConnectSharePoint";
export { ChoiceCard } from "./ChoiceCard";
export { StepDots, StepHeader } from "./StepHeader";
export {
  WIZARD_SERIF,
  STEP_FADE_CLASS,
  type ConnectStepProps,
  type Translate,
} from "./wizard-common";
