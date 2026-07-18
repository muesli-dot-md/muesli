// Outline rail (editor redesign §Layout): document headings parsed from the
// live ytext (debounced), indented by level. Click scrolls the editor to the
// heading (centered); the current section highlights from the editor's scroll
// position. Collapsible to a thin strip; renders nothing while the document
// has no headings (Docs behavior). Port of src/OutlineRail.svelte — the WEB
// behavior (live ytext observer + scroll tracking + collapse), richer than the
// desktop OutlineRail's parse-of-current-text.
import { useCallback, useEffect, useState } from "react";
import { ChevronsLeft, ListTree } from "lucide-react";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { useT } from "@/state/i18n";
import { useDocSession, useEditorView } from "@/state/session";
import { parseOutline, type OutlineItem } from "@muesli/editor-core/mdCommands";
import { Button } from "@/components/ui/button";

export default function OutlineRail() {
  const t = useT();
  const session = useDocSession();
  // The mounted editor view (reactive seam) — scroll tracking + jump target.
  const view = useEditorView(session);
  const [items, setItems] = useState<OutlineItem[]>(() =>
    parseOutline(session.ytext.toString()),
  );
  const [collapsed, setCollapsed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Debounced re-parse on every ytext change. The session (and its ytext) is
  // immutable per keyed DocApp mount, so this attaches exactly once.
  useEffect(() => {
    const ytext = session.ytext;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const observer = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        setItems(parseOutline(ytext.toString()));
      }, 300);
    };
    ytext.observe(observer);
    return () => {
      ytext.unobserve(observer);
      clearTimeout(debounce);
    };
  }, [session]);

  const updateActive = useCallback(() => {
    if (!view || items.length === 0) {
      setActiveIndex(items.length > 0 ? 0 : -1);
      return;
    }
    // the heading at/above the first visible line is the current section
    // (heights are relative to the document top, so strip the scroller padding)
    const topPos = view.lineBlockAtHeight(
      view.scrollDOM.scrollTop - view.documentPadding.top,
    ).from;
    let idx = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].from <= topPos + 1) idx = i;
      else break;
    }
    setActiveIndex(idx);
  }, [view, items]);

  // (Re)attach the scroll listener whenever the editor view mounts (or the
  // outline items change — updateActive closes over both).
  useEffect(() => {
    if (!view) return;
    updateActive();
    const onScroll = () => updateActive();
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => view.scrollDOM.removeEventListener("scroll", onScroll);
  }, [view, updateActive]);

  function jumpTo(item: OutlineItem) {
    if (!view) return;
    const pos = Math.min(item.from, view.state.doc.length);
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }

  if (items.length === 0) return null;

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center pt-3">
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("outline.expand")}
          onClick={() => setCollapsed(false)}
        >
          <ListTree aria-hidden="true" />
        </Button>
      </aside>
    );
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-hidden pl-2 pt-3">
      <div className="flex items-center justify-between pl-3 pr-1">
        <span className="text-xs font-semibold uppercase tracking-wide opacity-50">
          {t("outline.title")}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          title={t("outline.collapse")}
          onClick={() => setCollapsed(true)}
        >
          <ChevronsLeft aria-hidden="true" />
        </Button>
      </div>
      <nav className="mt-1 min-h-0 flex-1 overflow-y-auto pb-4" aria-label={t("outline.title")}>
        <ul className="flex flex-col">
          {items.map((item, i) => (
            <li key={`${item.from}-${item.text}`}>
              <button
                type="button"
                className={`block w-full truncate rounded-r-md border-l-2 px-3 py-1 text-left text-sm transition-colors ${
                  i === activeIndex
                    ? "border-primary font-medium text-primary"
                    : "border-transparent opacity-70 hover:bg-muted/60 hover:opacity-100"
                }`}
                style={{ paddingLeft: `${0.75 + (item.level - 1) * 0.65}rem` }}
                title={item.text}
                onClick={() => jumpTo(item)}
              >
                {item.text}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
