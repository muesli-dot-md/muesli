<script lang="ts">
  // A zero-width flex item with an absolutely-positioned hit area centered on the
  // boundary it sits at. Arc-style: col-resize cursor + a colored line on
  // hover/drag. `onResize` receives the pointer's clientX; the parent maps that
  // to a sidebar width. `shift` nudges the hit area + line off the flex boundary
  // (CSS length) so the indicator can hug a floating pane edge that is inset
  // from the boundary — e.g. the editor card's `--inset-card` left margin.
  let { onResize, shift = "0px" }: { onResize: (clientX: number) => void; shift?: string } =
    $props();

  let dragging = $state(false);

  function start(e: PointerEvent) {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const move = (ev: PointerEvent) => onResize(ev.clientX);
    const up = () => {
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<div class="relative w-0 shrink-0 self-stretch z-20" role="separator" aria-orientation="vertical">
  <button
    type="button"
    class="absolute inset-y-0 -translate-x-1/2 w-2 flex justify-center cursor-col-resize group bg-transparent border-0 p-0"
    style="left: {shift};"
    onpointerdown={start}
    aria-label="Resize sidebar"
    tabindex="-1"
  >
    <span
      class="w-0.5 h-full rounded-full transition-colors duration-100"
      class:bg-primary={dragging}
      class:bg-transparent={!dragging}
      class:group-hover:bg-primary={!dragging}
    ></span>
  </button>
</div>
