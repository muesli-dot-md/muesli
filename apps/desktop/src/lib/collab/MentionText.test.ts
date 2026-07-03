// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount } from "svelte";
import MentionText from "./MentionText.svelte";
import { colorFromId } from "../presence";

const ID = "00000000-0000-0000-0000-0000000000a1";
const token = `@[Ada Lovelace](muesli:user/${ID})`;

let host: HTMLElement | undefined;
let comp: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (comp) unmount(comp);
  host?.remove();
  comp = undefined;
  host = undefined;
});

function render(props: { body: string; knownIds?: Set<string> }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  comp = mount(MentionText, { target: host, props });
  return host;
}

describe("MentionText", () => {
  it("renders a chip with the @name and presence color", () => {
    const el = render({ body: `hi ${token}` });
    expect(el.textContent).toContain("@Ada Lovelace");
    const chip = el.querySelector("[data-tip='Ada Lovelace']") as HTMLElement;
    expect(chip).toBeTruthy();
    // colorFromId is the single source of color (sub-project ⑤). jsdom normalizes the
    // inline HSL to rgb(), so compare against a probe set to the same colorFromId value
    // rather than the raw string.
    const probe = document.createElement("span");
    probe.style.backgroundColor = colorFromId(ID).color;
    expect(chip.style.backgroundColor).toBe(probe.style.backgroundColor);
    expect(chip.style.backgroundColor).not.toBe("");
  });

  it("renders surrounding text verbatim", () => {
    const el = render({ body: `before ${token} after` });
    expect(el.textContent).toBe(`before @Ada Lovelace after`);
  });

  it("renders an unknown/removed user as a muted chip (no presence color)", () => {
    const el = render({ body: token, knownIds: new Set<string>() });
    const chip = el.querySelector("[title='Ada Lovelace']") as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.style.backgroundColor).toBe("");
    expect(chip.className).toContain("opacity-60");
  });
});
