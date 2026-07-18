/**
 * Temporary placeholder shell — the integration agent replaces this with the
 * real AppShell composition (title strip, sidebars, tabs, editor).
 *
 * It demonstrates the design system's core move: a quiet app-shell frame with
 * the content floating on a rounded canvas card (ring + surface shadow).
 */
export default function App() {
  return (
    <div className="flex h-screen w-screen flex-col bg-app-shell" data-tauri-drag-region>
      <div className="h-12 shrink-0" data-tauri-drag-region />
      <main className="mx-2 mb-2 flex min-h-0 flex-1 flex-col items-center justify-center rounded-xl bg-page-canvas ring-1 ring-surface-border shadow-[var(--surface-shadow)]">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Muesli</h1>
        <p className="mt-1 text-sm text-muted-foreground">React shell scaffold</p>
      </main>
    </div>
  );
}
