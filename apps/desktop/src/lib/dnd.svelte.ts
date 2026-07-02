// Shared drag state for moving files/folders within the tree by drag-and-drop.
// `draggingPath` is the absolute path of the node currently being dragged, so
// any folder row can validate whether it's a legal drop target during dragover
// (the DataTransfer payload isn't readable until drop).
export const dnd = $state<{ draggingPath: string | null }>({ draggingPath: null });
