// Settings → API keys (settings.md §2.2): GitHub-PAT-style list / mint /
// revoke over /api/me/tokens. Keys are delegated agent identities; the raw
// `mua_` secret appears exactly once, inside TokenMintModal's success state.
// React port of the web settings/ApiKeysSection.svelte.
import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  AccountApiError,
  createAccountApi,
  type ApiTokenSummary,
} from "@/services/accountApi";
import { errMsg } from "@/services/apiError";
import { httpBase, loginUrl, type AuthInfo } from "@/services/identity";
import { driveDate, fullDateTime } from "@/services/time";
import { useT } from "@/state/i18n";
import { SettingsCard } from "./SettingsCard";
import { TokenMintModal } from "./TokenMintModal";

interface Props {
  auth: AuthInfo;
  toast: (msg: string, kind?: "info" | "warning") => void;
}

const api = createAccountApi({ httpBase });

export function ApiKeysSection({ auth, toast }: Props) {
  const t = useT();

  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  /** 401 → sign in; 503 → open mode; anything else → generic error line. */
  const [degraded, setDegraded] = useState<"signin" | "open" | "error" | null>(null);
  const [mintOpen, setMintOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setTokens((await api.listTokens()).tokens);
      setDegraded(null);
    } catch (e) {
      if (e instanceof AccountApiError && e.status === 401) setDegraded("signin");
      else if (e instanceof AccountApiError && e.status === 503) setDegraded("open");
      else setDegraded("error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(token: ApiTokenSummary) {
    const label = token.label ?? token.id.slice(0, 8);
    if (!confirm(t("settings.keys.revokeConfirm", { label }))) return;
    setRevoking(token.id);
    try {
      await api.revokeToken(token.id);
      setTokens((cur) => cur.filter((k) => k.id !== token.id));
      toast(t("settings.keys.revoked"));
    } catch (e) {
      toast(errMsg(e), "warning");
    } finally {
      setRevoking(null);
    }
  }

  function scopesLabel(scopes: string[]): string {
    return scopes.includes("write")
      ? t("settings.keys.scopeReadWrite")
      : t("settings.keys.scopeRead");
  }

  return (
    <>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">
            {t("settings.nav.apiKeys")}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground [text-wrap:pretty]">
            {t("settings.keys.purpose")}
          </p>
        </div>
        {!(auth.mode === "open" || degraded === "open" || degraded === "signin") ? (
          <Button size="sm" className="shrink-0 gap-2" onClick={() => setMintOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            {t("settings.keys.create")}
          </Button>
        ) : null}
      </header>

      {auth.mode === "open" || degraded === "open" ? (
        <p className="text-sm text-muted-foreground [text-wrap:pretty]">
          {t("settings.openMode")}
        </p>
      ) : degraded === "signin" ? (
        <p className="text-sm text-muted-foreground [text-wrap:pretty]">
          {t("settings.signInToManage")}{" "}
          <a className="text-primary underline-offset-4 hover:underline" href={loginUrl()}>
            {t("common.signIn")}
          </a>
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : degraded === "error" ? (
        <p className="text-sm text-destructive">{t("settings.keys.loadFailed")}</p>
      ) : tokens.length === 0 ? (
        <SettingsCard>
          <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
            <KeyRound className="size-6 opacity-40" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{t("settings.keys.empty")}</p>
          </div>
        </SettingsCard>
      ) : (
        // Multica-style token list: name + scope badge over created/expiry
        // meta, a trailing trash icon to revoke.
        <SettingsCard>
          {tokens.map((token) => {
            const expired =
              token.expires_at != null &&
              new Date(token.expires_at).getTime() < Date.now();
            return (
              <div key={token.id} className="flex items-center gap-3 px-4 py-3.5">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted"
                  aria-hidden="true"
                >
                  <KeyRound className="size-4 opacity-70" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {token.label ?? "—"}
                    </span>
                    <Badge variant="secondary">{scopesLabel(token.scopes)}</Badge>
                    {expired ? (
                      <Badge variant="destructive">
                        {t("settings.keys.expiredBadge")}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                    <span title={fullDateTime(token.created_at)}>
                      {t("settings.keys.createdOn", { date: driveDate(token.created_at) })}
                    </span>
                    {" · "}
                    {token.expires_at ? (
                      <span title={fullDateTime(token.expires_at)}>
                        {t("settings.keys.expiresOn", {
                          date: driveDate(token.expires_at),
                        })}
                      </span>
                    ) : (
                      t("settings.keys.noExpiry")
                    )}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-destructive hover:text-destructive"
                  disabled={revoking === token.id}
                  title={t("settings.keys.revoke")}
                  aria-label={t("settings.keys.revoke")}
                  onClick={() => void revoke(token)}
                >
                  {revoking === token.id ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Trash2 className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
            );
          })}
        </SettingsCard>
      )}

      {mintOpen ? (
        <TokenMintModal
          api={api}
          onClose={(minted) => {
            setMintOpen(false);
            if (minted) void load();
          }}
        />
      ) : null}
    </>
  );
}

export default ApiKeysSection;
