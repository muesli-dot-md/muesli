// Multica-style progress header: a row of dots (filled done / filled+ring
// current / hollow pending) + "Step N of M", then the serif headline and a
// plain lede. React sibling of StepHeader.svelte, promoted from apps/desktop.

import { cx } from "./ui";
import { WIZARD_SERIF, type Translate } from "./wizard-common";

export function StepDots({
  stepIndex,
  totalSteps,
  t,
}: {
  stepIndex: number;
  totalSteps: number;
  t: Translate;
}) {
  return (
    <div
      className="flex items-center gap-2"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={totalSteps}
      aria-valuenow={stepIndex + 1}
      aria-label={t("wizard.stepOf", { n: stepIndex + 1, total: totalSteps })}
    >
      {Array.from({ length: totalSteps }, (_, i) => (
        <span
          key={i}
          className={cx(
            "size-2 rounded-full",
            i < stepIndex
              ? "bg-foreground"
              : i === stepIndex
                ? "bg-foreground ring-2 ring-foreground/25 ring-offset-1 ring-offset-background"
                : "border border-foreground/30",
          )}
        />
      ))}
      <span className="ml-1 text-xs text-muted-foreground">
        {t("wizard.stepOf", { n: stepIndex + 1, total: totalSteps })}
      </span>
    </div>
  );
}

export function StepHeader({
  stepIndex,
  totalSteps,
  title,
  body,
  t,
}: {
  stepIndex: number;
  totalSteps: number;
  title: string;
  body?: string;
  t: Translate;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3">
      <StepDots stepIndex={stepIndex} totalSteps={totalSteps} t={t} />
      <h3
        className="text-2xl leading-tight font-semibold text-balance"
        style={{ fontFamily: WIZARD_SERIF }}
      >
        {title}
      </h3>
      {body ? (
        <p className="text-sm text-muted-foreground" style={{ textWrap: "pretty" }}>
          {body}
        </p>
      ) : null}
    </div>
  );
}
