// Settings → About (settings.md §2.6): server version/commit/mode from the
// unauthenticated GET /api/meta, plus source/docs links and the self-host
// note. NOTE: the repo declares no canonical public URLs anywhere (no
// repository field, no homepage) — swap SOURCE_URL/DOCS_URL when one exists.
// React port of the web settings/AboutSection.svelte.
import { useEffect, useState } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createAccountApi, type ServerMeta } from "@/services/accountApi";
import { httpBase } from "@/services/identity";
import { useT } from "@/state/i18n";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";

const SOURCE_URL = "https://github.com/muesli-md/muesli";
const DOCS_URL = "https://github.com/muesli-md/muesli/tree/main/docs";

const api = createAccountApi({ httpBase });

export function AboutSection() {
  const t = useT();
  const [meta, setMeta] = useState<ServerMeta | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getMeta()
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const linkButton = cn(buttonVariants({ variant: "outline", size: "sm" }));

  return (
    <>
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">{t("settings.nav.about")}</h2>
      </header>

      <SettingsCard>
        {/* identity header */}
        <SettingsRow>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold">Muesli{meta ? ` v${meta.version}` : ""}</p>
            <p className="text-sm text-muted-foreground [text-wrap:pretty]">
              {t("settings.about.tagline")}
            </p>
          </div>
        </SettingsRow>

        {failed ? (
          <SettingsRow title={t("settings.about.metaFailed")} />
        ) : !meta ? (
          <SettingsRow title={t("common.loading")} />
        ) : (
          <>
            <SettingsRow
              title={t("settings.about.version")}
              control={<span className="font-mono text-xs">{meta.version}</span>}
            />
            {meta.commit ? (
              <SettingsRow
                title={t("settings.about.commit")}
                control={<span className="font-mono text-xs">{meta.commit.slice(0, 12)}</span>}
              />
            ) : null}
            <SettingsRow
              title={t("settings.about.mode")}
              control={
                <span className="text-sm">
                  {meta.mode === "oidc"
                    ? t("settings.about.modeOidc")
                    : t("settings.about.modeOpen")}
                </span>
              }
            />
          </>
        )}
      </SettingsCard>

      {/* source / docs links */}
      <SettingsCard>
        <SettingsRow
          title={t("settings.about.source")}
          leading={<ExternalLink className="size-4 opacity-70" aria-hidden="true" />}
          control={
            <>
              <Badge variant="secondary">{t("settings.about.license")}</Badge>
              <a className={linkButton} href={SOURCE_URL} target="_blank" rel="noreferrer">
                {t("settings.about.source")}
              </a>
            </>
          }
        />
        <SettingsRow
          title={t("settings.about.docs")}
          leading={<BookOpen className="size-4 opacity-70" aria-hidden="true" />}
          control={
            <a className={linkButton} href={DOCS_URL} target="_blank" rel="noreferrer">
              {t("settings.about.docs")}
            </a>
          }
        />
      </SettingsCard>

      <p className="mt-3 px-1 text-xs text-muted-foreground [text-wrap:pretty]">
        {t("settings.about.selfHost")}
      </p>
    </>
  );
}

export default AboutSection;
