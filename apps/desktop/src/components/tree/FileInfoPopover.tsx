// "File information" — a small centered panel showing path, type, size, and
// modified/created times via the `stat_path` Tauri command. Works for both
// files and folders (folder size = recursive total of its `.md` files).
// Ported from FileInfoPopover.svelte.

import { useEffect, useState } from "react";
import { Info, FileText, Folder } from "lucide-react";
import { statPath, type PathInfo } from "@/services/tauri";
import { formatBytes, formatTimestamp } from "@/services/fileInfo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  path: string;
  name: string;
  onClose: () => void;
}

export function FileInfoPopover({ path, name, onClose }: Props) {
  const [info, setInfo] = useState<PathInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    statPath(path)
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // The panel owns its Escape (capture + preventDefault per the modal
  // contract) so the global fallback in services/keymap.ts never sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/10 pt-[16vh] backdrop-blur-xs"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        className="mx-4 w-full max-w-md overflow-hidden rounded-xl bg-surface-raised shadow-[var(--floating-shadow)] ring-1 ring-surface-border animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-100 motion-reduce:animate-none"
        role="dialog"
        aria-modal="true"
        aria-label={`Information for ${name}`}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Info size={16} className="shrink-0 opacity-60" />
          <span className="truncate text-sm font-medium">File information</span>
        </div>

        <div className="px-4 py-3">
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : !info ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2">
                {info.isDir ? (
                  <Folder size={18} className="shrink-0 text-muted-foreground" />
                ) : (
                  <FileText size={18} className="shrink-0 text-primary" />
                )}
                <span className="truncate text-sm font-medium">{info.name}</span>
              </div>
              <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                <dt className="text-muted-foreground">Type</dt>
                <dd className="text-foreground">{info.isDir ? "Folder" : "Markdown file"}</dd>

                {info.isDir && info.childCount != null ? (
                  <>
                    <dt className="text-muted-foreground">Notes</dt>
                    <dd className="text-foreground">{info.childCount}</dd>
                  </>
                ) : null}

                <dt className="text-muted-foreground">Size</dt>
                <dd className="text-foreground">{formatBytes(info.size)}</dd>

                <dt className="text-muted-foreground">Modified</dt>
                <dd className="text-foreground">{formatTimestamp(info.modifiedMs)}</dd>

                <dt className="text-muted-foreground">Created</dt>
                <dd className="text-foreground">{formatTimestamp(info.createdMs)}</dd>

                <dt className="text-muted-foreground">Path</dt>
                <dd className="break-all text-foreground/70">{info.path}</dd>
              </dl>
            </>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-4 py-2.5">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
