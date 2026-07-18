// Mint-an-API-key modal (settings.md §2.2). Two phases: the form (label,
// scope preset, expiry) and the show-once success state — the `mua_` secret
// with a copy button, an amber "you won't see this again" callout, and a
// ready-to-paste MCP config snippet pointing at {httpBase}/mcp. React port of
// the web settings/TokenMintModal.svelte, on the shadcn Dialog.
import { useState, type FormEvent } from "react";
import { Copy, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  type AccountApi,
  type MintedToken,
  type TokenScopes,
} from "@/services/accountApi";
import { errMsg } from "@/services/apiError";
import { httpBase } from "@/services/identity";
import { useT } from "@/state/i18n";
import { NativeSelect } from "./NativeSelect";

interface Props {
  api: AccountApi;
  /** minted=true → the parent reloads its key list. */
  onClose: (minted: boolean) => void;
}

function snippetFor(m: MintedToken | null): string {
  if (!m) return "";
  return JSON.stringify(
    {
      mcpServers: {
        muesli: {
          type: "http",
          url: `${httpBase}/mcp`,
          headers: { Authorization: `Bearer ${m.token}` },
        },
      },
    },
    null,
    2,
  );
}

export function TokenMintModal({ api, onClose }: Props) {
  const t = useT();

  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<"read" | "readwrite">("read");
  const [expiry, setExpiry] = useState<"30" | "90" | "365" | "never">("90");
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [copied, setCopied] = useState(false);

  const mcpSnippet = snippetFor(minted);

  async function mint(e: FormEvent) {
    e.preventDefault();
    if (minting) return;
    setMinting(true);
    setError(null);
    try {
      const scopeList: TokenScopes = scopes === "readwrite" ? ["read", "write"] : ["read"];
      setMinted(
        await api.mintToken({
          label,
          scopes: scopeList,
          expires_in_days: expiry === "never" ? null : Number(expiry),
        }),
      );
    } catch (e2) {
      // 400 = validation the server words for the user; errMsg passes 4xx through as-is.
      setError(errMsg(e2));
    } finally {
      setMinting(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // selection fallback: the inputs select-on-focus below
    }
  }

  function close() {
    onClose(minted !== null);
  }

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && close()}>
      <DialogContent className="w-[30rem] max-w-[92vw]">
        {!minted ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("settings.keys.create")}</DialogTitle>
            </DialogHeader>
            <form className="flex flex-col gap-4" onSubmit={(e) => void mint(e)}>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">{t("settings.keys.labelLabel")}</span>
                <Input
                  className="h-8 w-full"
                  value={label}
                  placeholder={t("settings.keys.labelPlaceholder")}
                  maxLength={120}
                  required
                  onChange={(e) => setLabel(e.currentTarget.value)}
                />
              </label>

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">
                  {t("settings.keys.accessLabel")}
                </legend>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="radio"
                    className="mt-0.5 accent-[var(--primary)]"
                    name="scopes"
                    value="read"
                    checked={scopes === "read"}
                    onChange={() => setScopes("read")}
                  />
                  <span className="text-sm">
                    {t("settings.keys.scopeRead")}
                    <span className="block text-xs opacity-60">
                      {t("settings.keys.scopeReadHint")}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="radio"
                    className="mt-0.5 accent-[var(--primary)]"
                    name="scopes"
                    value="readwrite"
                    checked={scopes === "readwrite"}
                    onChange={() => setScopes("readwrite")}
                  />
                  <span className="text-sm">
                    {t("settings.keys.scopeReadWrite")}
                    <span className="block text-xs opacity-60">
                      {t("settings.keys.scopeReadWriteHint")}
                    </span>
                  </span>
                </label>
              </fieldset>

              <label className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{t("settings.keys.expiryLabel")}</span>
                <NativeSelect
                  className="w-40"
                  value={expiry}
                  onChange={(e) =>
                    setExpiry(e.currentTarget.value as "30" | "90" | "365" | "never")
                  }
                >
                  <option value="30">{t("settings.keys.expiry30")}</option>
                  <option value="90">{t("settings.keys.expiry90")}</option>
                  <option value="365">{t("settings.keys.expiry1y")}</option>
                  <option value="never">{t("settings.keys.expiryNever")}</option>
                </NativeSelect>
              </label>

              {error ? <p className="text-sm text-destructive">{error}</p> : null}

              <DialogFooter className="mt-2">
                <Button variant="ghost" type="button" onClick={close}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={minting}>
                  {minting ? <Spinner className="size-3.5" /> : null}
                  {t("common.create")}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("settings.keys.minted")}</DialogTitle>
            </DialogHeader>
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{t("settings.keys.showOnce")}</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Input
                className="h-8 w-full font-mono text-xs"
                readOnly
                value={minted.token}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1"
                onClick={() => void copy(minted.token)}
              >
                <Copy className="size-3.5" aria-hidden="true" />
                {copied ? t("common.copiedToClipboard") : t("settings.keys.copyKey")}
              </Button>
            </div>

            <p className="mt-4 text-sm font-medium">{t("settings.keys.mcpSnippet")}</p>
            <p className="text-xs opacity-60">{t("settings.keys.mcpSnippetHint")}</p>
            <div className="relative mt-2">
              <pre className="max-h-48 overflow-auto rounded-xl border border-surface-border bg-muted p-3 font-mono text-xs">
                {mcpSnippet}
              </pre>
              <Button
                variant="ghost"
                size="icon-xs"
                className="absolute right-2 top-2"
                title={t("settings.keys.copySnippet")}
                aria-label={t("settings.keys.copySnippet")}
                onClick={() => void copy(mcpSnippet)}
              >
                <Copy className="size-3.5 opacity-70" aria-hidden="true" />
              </Button>
            </div>

            <DialogFooter>
              <Button onClick={close}>{t("common.done")}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default TokenMintModal;
