// @mention autocomplete for comment composers. Port of
// src/lib/collab/mentionAction.svelte.ts (a Svelte action) as a plain
// imperative function + a thin React hook wrapper. The DOM logic is byte-for-
// byte the Svelte action's: on `@` it shows a floating member picker filtered
// by the typed query; Enter/click inserts the chip token at the caret;
// Backspace immediately after a chip deletes the WHOLE chip. All text math
// lives in services/collab/mentions.ts — this file is just the DOM glue and
// the dropdown. Values are written through the native value setter and an
// `input` event is dispatched so controlled React inputs stay in sync.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  detectTrigger,
  filterMembers,
  insertMention,
  chipDeletion,
  type Member,
} from "@/services/collab/mentions";

export type MentionAutocompleteParams = {
  /** Current candidate list (the doc's members); may update over the hook's life. */
  members: Member[];
};

type Field = HTMLInputElement | HTMLTextAreaElement;

function setValue(el: Field, text: string, cursor: number) {
  // Use the native setter so frameworks observing the property still react.
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  el.setSelectionRange(cursor, cursor);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export interface MentionAutocompleteHandle {
  update(next: MentionAutocompleteParams): void;
  destroy(): void;
}

export function mentionAutocomplete(
  el: Field,
  params: MentionAutocompleteParams,
): MentionAutocompleteHandle {
  let members = params.members;
  let menu: HTMLUListElement | null = null;
  let matches: Member[] = [];
  let active = 0;
  let trigger: { query: string; start: number } | null = null;

  function close() {
    menu?.remove();
    menu = null;
    matches = [];
    trigger = null;
  }

  function render() {
    if (!trigger || matches.length === 0) return close();
    if (!menu) {
      menu = document.createElement("ul");
      // All styling lives in styles/app.css keyed on this class (body-appended,
      // so Tailwind utilities are deliberately avoided here).
      menu.className = "mention-menu";
      menu.setAttribute("role", "listbox");
      document.body.appendChild(menu);
    }
    menu.innerHTML = "";
    matches.forEach((m, i) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = m.display_name ?? "(unnamed)";
      a.className = i === active ? "active" : "";
      a.setAttribute("role", "option");
      // mousedown (not click) so it fires before the field blurs.
      a.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        choose(m);
      });
      li.appendChild(a);
      menu!.appendChild(li);
    });
    position();
  }

  function position() {
    if (!menu) return;
    const r = el.getBoundingClientRect();
    menu.style.left = `${r.left + window.scrollX}px`;
    menu.style.top = `${r.bottom + window.scrollY + 2}px`;
  }

  function choose(m: Member) {
    if (!trigger) return;
    const out = insertMention(el.value, el.selectionStart ?? el.value.length, trigger, m);
    setValue(el, out.text, out.cursor);
    close();
  }

  function recompute() {
    const cursor = el.selectionStart ?? el.value.length;
    trigger = detectTrigger(el.value, cursor);
    if (!trigger) return close();
    matches = filterMembers(members, trigger.query).slice(0, 8);
    active = 0;
    render();
  }

  function onInput() {
    recompute();
  }

  function onKeydown(e: KeyboardEvent) {
    // Atomic chip delete: Backspace with no selection, caret right after a chip.
    if (e.key === "Backspace" && el.selectionStart === el.selectionEnd) {
      const del = chipDeletion(el.value, el.selectionStart ?? 0);
      if (del) {
        e.preventDefault();
        setValue(el, del.text, del.cursor);
        close();
        return;
      }
    }
    if (!menu || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % matches.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + matches.length) % matches.length;
      render();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation(); // don't let the composer also submit on this Enter
      choose(matches[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  el.addEventListener("input", onInput);
  // capture so chip-delete and picker-nav run before the composer's own keydown.
  el.addEventListener("keydown", onKeydown as EventListener, true);
  el.addEventListener("blur", close);

  return {
    update(next: MentionAutocompleteParams) {
      members = next.members;
      if (trigger) recompute();
    },
    destroy() {
      el.removeEventListener("input", onInput);
      el.removeEventListener("keydown", onKeydown as EventListener, true);
      el.removeEventListener("blur", close);
      close();
    },
  };
}

/**
 * React wrapper: returns a CALLBACK REF to put on the input/textarea. A plain
 * `useEffect(..., [ref.current])` misses the render where the element first
 * mounts (ref.current is still null at render time), so the first "@" typed
 * after the composer opens would show no dropdown. Capturing the element via
 * useState instead re-runs the attach effect exactly when the node appears/
 * disappears (same pattern as AppShell's treeScrollEl). `opts.members` updates
 * flow through handle.update() without re-attaching (mirrors the Svelte
 * action's update()).
 */
export function useMentionAutocomplete(
  opts: MentionAutocompleteParams,
): (el: Field | null) => void {
  const [el, setEl] = useState<Field | null>(null);
  const handleRef = useRef<MentionAutocompleteHandle | null>(null);

  useEffect(() => {
    if (!el) return;
    handleRef.current = mentionAutocomplete(el, opts);
    return () => {
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // Re-attach only when the element changes; member updates go through update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el]);

  useEffect(() => {
    handleRef.current?.update(opts);
  }, [opts.members]);

  // Stable identity so passing it as `ref` never causes detach/re-attach churn.
  return useCallback((node: Field | null) => setEl(node), []);
}
