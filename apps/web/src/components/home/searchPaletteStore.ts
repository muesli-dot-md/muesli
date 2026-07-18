// Compatibility shim: the canonical search-palette store (module-level open
// flag + shortcut hint, ported from the old SearchPalette.svelte module block)
// lives WITH the palette in @/components/search/SearchPalette. This re-export
// keeps the wave-era import path working for headers that summon the palette
// (e.g. DocApp) without prop drilling.

export {
  searchPaletteStore,
  openSearchPalette,
  closeSearchPalette,
  searchPaletteOpen,
  useSearchPaletteOpen,
  searchShortcutHint,
} from "@/components/search/SearchPalette";
