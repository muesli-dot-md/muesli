// Svelte action that wires the shared `mentions.ts` autocomplete into any <input> or
// <textarea> comment composer (sub-project ④b). Keep in sync with
// apps/web/src/mentionAction.svelte.ts (identical; no i18n strings here).
//
// On `@`, it shows a floating member picker filtered by the typed query; Enter/click
// inserts the chip token at the caret; Backspace immediately after a chip deletes the
// WHOLE chip. All text math lives in mentions.ts — this file is just the DOM glue and the
// dropdown. The element keeps using `bind:value`; the action writes through the native
// value setter and dispatches `input` so Svelte's binding stays in sync.
import {
  detectTrigger,
  filterMembers,
  insertMention,
  chipDeletion,
  type Member,
} from "./mentions";

export type MentionActionParams = {
  /** Current candidate list (the doc's members); may update over the action's life. */
  members: Member[];
};

type Field = HTMLInputElement | HTMLTextAreaElement;

function setValue(el: Field, text: string, cursor: number) {
  // Use the native setter so frameworks observing the property still react.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter ? setter.call(el, text) : (el.value = text);
  el.setSelectionRange(cursor, cursor);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function mentionAutocomplete(el: Field, params: MentionActionParams) {
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
      menu.className =
        "menu menu-sm absolute z-50 max-h-56 w-56 flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow-lg";
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
    update(next: MentionActionParams) {
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
