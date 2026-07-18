// Settings → Language: the interface-language selector. Lives on its own
// page because the Appearance page is exactly that — appearance — and the
// UI language is not. localStorage-backed (per browser), never synced.
// React port of the web settings/LanguageSection.svelte.
import { availableLocales, currentLocale, setLocale, useT, type LocaleCode } from "@/state/i18n";
import { NativeSelect } from "./NativeSelect";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";

export function LanguageSection() {
  const t = useT();

  return (
    <>
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">{t("settings.language")}</h2>
        <p className="mt-1 text-sm text-muted-foreground [text-wrap:pretty]">
          {t("settings.language.hint")}
        </p>
      </header>

      <SettingsCard>
        <SettingsRow
          title={t("settings.language")}
          control={
            <NativeSelect
              className="w-52 max-w-full"
              value={currentLocale()}
              onChange={(e) => setLocale(e.currentTarget.value as LocaleCode)}
            >
              {availableLocales.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </NativeSelect>
          }
        />
      </SettingsCard>
    </>
  );
}

export default LanguageSection;
