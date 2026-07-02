// @vitest-environment jsdom
//
// DOM-level coverage for attachMermaidInteraction: it wraps the SVG in a pan
// layer, builds the +/1:1/- cluster, applies a pan transform on drag, and zooms
// on wheel toward the cursor. The pure anchor/clamp/ease math is covered in
// zoom.test.ts; this verifies the wiring applies it to the DOM.

import { describe, it, expect, beforeEach } from "vitest";
import { attachMermaidInteraction } from "./mermaidInteraction";

const LABELS = { zoomIn: "Zoom in", reset: "Reset view", zoomOut: "Zoom out" };

function build(): { root: HTMLElement; holder: HTMLElement; layer: HTMLElement } {
  const root = document.createElement("div");
  root.className = "cm-live-mermaid";
  const holder = document.createElement("div");
  holder.className = "mermaid-block";
  holder.dataset.rendered = "svg";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  holder.appendChild(svg);
  root.appendChild(holder);
  // jsdom has no layout; stub the holder rect so pointer math has dimensions.
  holder.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0 }) as DOMRect;
  attachMermaidInteraction(root, holder, LABELS);
  const layer = holder.querySelector<HTMLElement>(".mermaid-pan-layer")!;
  return { root, holder, layer };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("attachMermaidInteraction", () => {
  it("moves the svg into a pan layer and builds the control cluster", () => {
    const { root, layer } = build();
    expect(layer).not.toBeNull();
    expect(layer.querySelector("svg")).not.toBeNull();
    const controls = root.querySelector(".mermaid-controls");
    expect(controls).not.toBeNull();
    const btns = controls!.querySelectorAll("button");
    expect(btns).toHaveLength(3);
    expect(btns[0].getAttribute("aria-label")).toBe("Zoom in");
    expect(btns[1].textContent).toBe("1:1");
    expect(btns[2].getAttribute("aria-label")).toBe("Zoom out");
  });

  it("applies a translate transform when the diagram is dragged", () => {
    const { holder, layer } = build();
    holder.setPointerCapture = () => {};
    holder.releasePointerCapture = () => {};
    holder.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, bubbles: true }),
    );
    holder.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 40, clientY: 25, bubbles: true }),
    );
    expect(layer.style.transform).toContain("translate(30px, 15px)");
    holder.dispatchEvent(
      new PointerEvent("pointerup", { clientX: 40, clientY: 25, bubbles: true }),
    );
  });

  it("zooms on wheel, scaling the layer", () => {
    const { holder, layer } = build();
    holder.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -100,
        clientX: 100,
        clientY: 50,
        bubbles: true,
        cancelable: true,
      }),
    );
    const m = /scale\(([\d.]+)\)/.exec(layer.style.transform);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(1);
  });

  it("does not exceed the max zoom clamp on repeated wheel-in", () => {
    const { holder, layer } = build();
    for (let i = 0; i < 60; i++) {
      holder.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -200,
          clientX: 100,
          clientY: 50,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    const scale = Number(/scale\(([\d.]+)\)/.exec(layer.style.transform)![1]);
    expect(scale).toBeLessThanOrEqual(4);
    expect(scale).toBeGreaterThan(3.9);
  });
});
