// Two-pane settings view rendered INSIDE the main content card (where the
// editor normally lives) — NOT a modal. The left file-tree sidebar stays put;
// only the main card swaps to this view. Multica settings pattern: a left
// vertical nav column (group heading + line-style items) and a right
// scrollable content column (max-w-3xl mx-auto). Escape-to-close is handled
// by the shell's keymap; the close button in the header returns to the
// editor. Literal strings (desktop has no i18n).
//
// `@container`: the narrow-layout switch keys off the PANEL's own width, not
// the viewport — the file-tree sidebar shares the window, so a viewport
// breakpoint would keep the category rail open while the content column is
// already crushed. `@3xl` (48rem) matches the webapp's `md:` threshold
// applied to the settings surface itself.
import { useEffect, useState } from "react";
import { Bell, Info, SlidersHorizontal, User, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { workspacesStore } from "@/state/workspaces";
import { AboutSection } from "@/components/settings/AboutSection";
import { NotificationsSection } from "@/components/settings/NotificationsSection";
import { PreferencesSection } from "@/components/settings/PreferencesSection";
import { ProfileSection } from "@/components/settings/ProfileSection";

type Section = "profile" | "preferences" | "notifications" | "about";

// App version. Mirrors package.json's "version"; bump together.
const APP_VERSION = "0.1.0";

interface NavItem {
  id: Section;
  label: string;
  Icon: LucideIcon;
}

// Mirrors the webapp's Multica layout: a "My Account" group, mapped to what
// the desktop actually has — no API keys / Members / workspace-General (the
// desktop lacks that backend). There is no Sync page: sync is active iff
// signed in AND the open workspace is server-linked (never a toggle), and the
// server URL lives in About.
const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "My Account",
    items: [
      { id: "profile", label: "Profile", Icon: User },
      { id: "preferences", label: "Appearance", Icon: SlidersHorizontal },
      { id: "notifications", label: "Notifications", Icon: Bell },
      { id: "about", label: "About", Icon: Info },
    ],
  },
];

function isSection(v: string | undefined): v is Section {
  return (
    v === "profile" ||
    v === "preferences" ||
    v === "notifications" ||
    v === "about"
  );
}

interface Props {
  /** Section to land on when the panel mounts (defaults to Profile). Lets
   *  callers deep-link, e.g. a failed sign-in opens straight at Profile,
   *  the one Settings surface with the sign-in control and error text. */
  initialSection?: string;
  /** Close the settings view and return to the editor/last document. */
  onClose: () => void;
}

function NavButton({
  item,
  selected,
  onSelect,
  className,
}: {
  item: NavItem;
  selected: boolean;
  onSelect: (id: Section) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors active:translate-y-px",
        selected
          ? "bg-surface-selected font-medium text-surface-selected-foreground"
          : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
        className,
      )}
      aria-current={selected ? "page" : undefined}
      onClick={() => onSelect(item.id)}
    >
      <item.Icon
        className={cn("size-4", !selected && "opacity-70")}
        aria-hidden="true"
      />
      {item.label}
    </button>
  );
}

export function SettingsPanel({ initialSection, onClose }: Props) {
  const [section, setSection] = useState<Section>(
    isSection(initialSection) ? initialSection : "profile",
  );

  // Refresh the workspace list once when the panel mounts (the webapp
  // refreshes on open; here the panel only mounts when settings is shown).
  useEffect(() => {
    void workspacesStore.getState().refresh();
  }, []);

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      {/* Header inside the card: title + close (back to the editor). */}
      <header className="flex h-14 shrink-0 items-center gap-3 px-5">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto rounded-full"
          title="Close"
          aria-label="Close"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* left category sub-sidebar: group headings + vertical nav items */}
        <aside className="hidden w-56 shrink-0 overflow-y-auto overscroll-contain px-3 pb-6 pt-1 @3xl:block">
          <nav className="flex flex-col gap-5" aria-label="Settings">
            {GROUPS.map((group) => (
              <div key={group.title} className="flex flex-col gap-0.5">
                <span className="mb-1 px-2.5 text-xs font-medium text-muted-foreground">
                  {group.title}
                </span>
                {group.items.map((item) => (
                  <NavButton
                    key={item.id}
                    item={item}
                    selected={section === item.id}
                    onSelect={setSection}
                    className="w-full"
                  />
                ))}
              </div>
            ))}
          </nav>
        </aside>

        {/* narrow panel: groups collapse to a single top tab strip */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <nav
            className="flex gap-1 overflow-x-auto px-4 pb-2 @3xl:hidden"
            aria-label="Settings"
          >
            {GROUPS.flatMap((g) => g.items).map((item) => (
              <NavButton
                key={item.id}
                item={item}
                selected={section === item.id}
                onSelect={setSection}
                className="shrink-0 whitespace-nowrap"
              />
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-3xl p-6 pb-12">
              {section === "profile" ? (
                <ProfileSection />
              ) : section === "preferences" ? (
                <PreferencesSection />
              ) : section === "notifications" ? (
                <NotificationsSection />
              ) : (
                <AboutSection appVersion={APP_VERSION} />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default SettingsPanel;
