// Reusable, on-brand error shell. A blank centered page — Muesli mark, a
// title, a short message, and one action — used for not-found, no-access, and
// generic-crash surfaces instead of dumping raw errors or a white screen.
// Clear props so callers stay declarative. React port of the web
// ErrorPage.svelte.
import { Button } from "@/components/ui/button";
import { useT } from "@/state/i18n";
import { gotoHome } from "@/state/route";

interface Props {
  title: string;
  message: string;
  /** Which action button to show. "home" routes to the dashboard; "reload"
   *  does a hard reload (for the generic crash boundary); "none" shows none. */
  action?: "home" | "reload" | "none";
  /** Optional custom handler; overrides the built-in "home"/"reload" behavior. */
  onAction?: () => void;
}

export function ErrorPage({ title, message, action = "home", onAction }: Props) {
  const t = useT();

  function runAction() {
    if (onAction) return onAction();
    if (action === "reload") location.reload();
    else gotoHome();
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[var(--floor)] px-6 text-foreground antialiased">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <span className="wordmark text-5xl leading-none" aria-hidden="true">
          muesli
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight [text-wrap:balance]">{title}</h1>
          <p className="text-sm opacity-60 [text-wrap:pretty]">{message}</p>
        </div>
        {action !== "none" ? (
          <Button onClick={runAction}>
            {action === "reload" ? t("error.reload") : t("error.backHome")}
          </Button>
        ) : null}
      </div>
    </main>
  );
}

export default ErrorPage;
