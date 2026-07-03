// Block-level live-preview decorations (editor redesign §Core): tables,
// ```mermaid fences, $$ math blocks and horizontal rules render as widgets
// REPLACING their source lines while the selection is outside the block; any
// selection touching the block swaps it back to raw text. Images add a widget
// BELOW their line (never replacing — the inline syntax hiding lives in
// inline.ts).
//
// This is a StateField, not a ViewPlugin, because CM6 only allows block
// widgets / line-break-replacing decorations from state-level sources. To
// avoid pointless work:
//   - doc changes rebuild (a bounded-time ensureSyntaxTree + a node-kind
//     filtered tree walk — no per-keystroke full re-render: widget DOM is
//     cached by source text in widgets.ts),
//   - selection-only transactions rebuild ONLY when the set of
//     selection-touched blocks actually changed,
//   - anything else just maps the existing set through the changes.

import { EditorState, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  collectBlocks,
  collectImages,
  parseTableMarkdown,
  selectionTouches,
  type LiveBlock,
  type Range16,
} from "./transform";
import { HrWidget, ImageWidget, MathWidget, MermaidWidget, TableWidget } from "./widgets";

type BlocksValue = { deco: DecorationSet; blocks: LiveBlock[] };

function widgetFor(block: LiveBlock): Decoration | null {
  switch (block.kind) {
    case "hr":
      return Decoration.replace({ widget: new HrWidget(), block: true });
    case "math":
      return Decoration.replace({ widget: new MathWidget(block.source), block: true });
    case "mermaid":
      return Decoration.replace({ widget: new MermaidWidget(block.source), block: true });
    case "table": {
      const parsed = parseTableMarkdown(block.source);
      if (!parsed) return null; // malformed — leave the raw text alone
      return Decoration.replace({ widget: new TableWidget(block.source, parsed), block: true });
    }
  }
}

function selRanges(state: EditorState): Range16[] {
  return state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
}

/** Which blocks the selection touches — the rebuild trigger for selection-only
 * transactions. */
function revealSignature(blocks: readonly LiveBlock[], sel: readonly Range16[]): string {
  let sig = "";
  for (let i = 0; i < blocks.length; i++) {
    if (selectionTouches(sel, blocks[i])) sig += `${i},`;
  }
  return sig;
}

function build(state: EditorState): BlocksValue {
  // Bounded parse: 20ms is plenty for typical docs; for very large ones the
  // unparsed tail just stays raw until the parser catches up on a later update.
  const tree = ensureSyntaxTree(state, state.doc.length, 20) ?? syntaxTree(state);
  const blocks = collectBlocks(state, tree);
  const sel = selRanges(state);
  const ranges: Range<Decoration>[] = [];
  for (const b of blocks) {
    if (selectionTouches(sel, b)) continue; // inside -> raw text
    const deco = widgetFor(b);
    if (deco) ranges.push(deco.range(b.from, b.to));
  }
  for (const img of collectImages(state, tree)) {
    ranges.push(
      Decoration.widget({ widget: new ImageWidget(img.url, img.alt), block: true, side: 1 })
        .range(img.linePos),
    );
  }
  return { deco: Decoration.set(ranges, true), blocks };
}

export const blockPreview = StateField.define<BlocksValue>({
  create: build,
  update(value, tr) {
    if (tr.docChanged) return build(tr.state);
    if (tr.selection) {
      const before = revealSignature(value.blocks, selRanges(tr.startState));
      const after = revealSignature(value.blocks, selRanges(tr.state));
      if (before !== after) return build(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
