// Settings → Profile (settings.md §2.1): avatar + display-name OVERRIDES
// (PATCH /api/me writes the custom_* columns, never the OIDC claim columns),
// the read-only email row, and the danger-zone stubs. The avatar never touches
// blob storage: it is cover-cropped and resized to 128px on a canvas and sent
// as a ≤64 KB data URL. Picking an avatar PATCHes immediately — there is no
// local preview state that a closed settings page could silently discard.
// React port of the web settings/ProfileSection.svelte.
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createAccountApi, type AccountUser } from "@/services/accountApi";
import { errMsg } from "@/services/apiError";
import { httpBase, loginUrl, type AuthInfo } from "@/services/identity";
import { useT } from "@/state/i18n";
import { resizeToDataUrl } from "./avatarResize";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";

interface Props {
  auth: AuthInfo;
  toast: (msg: string, kind?: "info" | "warning") => void;
  /** Profile edits update the shell's auth so the header avatar follows. */
  onUpdated: (user: AccountUser) => void;
}

const api = createAccountApi({ httpBase });

export function ProfileSection({ auth, toast, onUpdated }: Props) {
  const t = useT();

  const [nameDraft, setNameDraft] = useState("");
  const nameInitialized = useRef(false);
  useEffect(() => {
    // Seed the input once auth arrives; don't clobber while the user types.
    if (!nameInitialized.current && auth.user) {
      setNameDraft(auth.user.display_name ?? "");
      nameInitialized.current = true;
    }
  }, [auth.user]);

  const [savingName, setSavingName] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // PATCH /api/me answers a FULL user snapshot, and a name save can interleave
  // with an avatar pick — if the earlier-issued response lands last, applying
  // it would revert the newer change on screen (and in the host via onUpdated).
  // Invariant: only the response of the LATEST-issued PATCH is applied and
  // forwarded; stale resolutions return null and callers skip local state.
  const patchSeq = useRef(0);
  async function patch(body: {
    display_name?: string | null;
    avatar_url?: string | null;
  }): Promise<AccountUser | null> {
    const seq = ++patchSeq.current;
    const user = await api.patchMe(body);
    if (seq !== patchSeq.current) return null;
    onUpdated(user);
    return user;
  }

  async function saveName() {
    setSavingName(true);
    try {
      const trimmed = nameDraft.trim();
      const user = await patch({ display_name: trimmed === "" ? null : trimmed });
      if (user) setNameDraft(user.display_name ?? "");
      toast(t("settings.profile.saved"));
    } catch (e) {
      toast(errMsg(e), "warning");
    } finally {
      setSavingName(false);
    }
  }

  async function resetName() {
    setSavingName(true);
    try {
      const user = await patch({ display_name: null });
      if (user) setNameDraft(user.display_name ?? "");
      toast(t("settings.profile.saved"));
    } catch (e) {
      toast(errMsg(e), "warning");
    } finally {
      setSavingName(false);
    }
  }

  /** Picking a file saves it right away: a picked avatar that only lived in
   *  component state until a separate Save click was silently discarded when
   *  settings closed — the PATCH must be the moment the pick takes effect. */
  async function pickAvatar(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = ""; // re-picking the same file must fire change again
    if (!file) return;
    setSavingAvatar(true);
    try {
      await patch({ avatar_url: await resizeToDataUrl(file) });
      toast(t("settings.profile.saved"));
    } catch (err) {
      toast(errMsg(err), "warning");
    } finally {
      setSavingAvatar(false);
    }
  }

  async function removeAvatar() {
    setSavingAvatar(true);
    try {
      await patch({ avatar_url: null });
      toast(t("settings.profile.saved"));
    } catch (e) {
      toast(errMsg(e), "warning");
    } finally {
      setSavingAvatar(false);
    }
  }

  function onNameSubmit(e: FormEvent) {
    e.preventDefault();
    void saveName();
  }

  const shownAvatar = auth.user?.avatar_url ?? null;
  const initial = (auth.user?.display_name ?? auth.user?.email ?? "?")
    .trim()
    .charAt(0)
    .toUpperCase();

  return (
    <>
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">{t("settings.nav.profile")}</h2>
      </header>

      {auth.mode === "open" ? (
        <p className="text-sm text-muted-foreground [text-wrap:pretty]">{t("settings.openMode")}</p>
      ) : !auth.user ? (
        <p className="text-sm text-muted-foreground [text-wrap:pretty]">
          {t("settings.signInToManage")}{" "}
          <a className="text-primary underline-offset-4 hover:underline" href={loginUrl()}>
            {t("common.signIn")}
          </a>
        </p>
      ) : (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void pickAvatar(e)}
          />

          <SettingsCard>
            {/* avatar */}
            <SettingsRow
              title={t("settings.profile.changeAvatar")}
              leading={
                shownAvatar ? (
                  <img src={shownAvatar} alt="" className="h-16 w-16 rounded-full object-cover" />
                ) : (
                  <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl font-semibold text-primary-foreground">
                    {initial}
                  </span>
                )
              }
              control={
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={savingAvatar}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {t("settings.profile.changeAvatar")}
                  </Button>
                  {auth.user?.avatar_url ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={savingAvatar}
                      onClick={() => void removeAvatar()}
                    >
                      {t("settings.profile.removeAvatar")}
                    </Button>
                  ) : null}
                </>
              }
            />

            {/* display name */}
            <SettingsRow
              title={t("settings.profile.displayName")}
              control={
                <form
                  className="flex flex-wrap items-center justify-end gap-2"
                  onSubmit={onNameSubmit}
                >
                  <label className="sr-only" htmlFor="settings-display-name">
                    {t("settings.profile.displayName")}
                  </label>
                  <Input
                    id="settings-display-name"
                    className="h-8 w-56 max-w-full"
                    value={nameDraft}
                    maxLength={120}
                    onChange={(e) => setNameDraft(e.currentTarget.value)}
                  />
                  <Button size="sm" type="submit" disabled={savingName}>
                    {t("common.save")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={savingName}
                    onClick={() => void resetName()}
                  >
                    {t("settings.profile.useIdpName")}
                  </Button>
                </form>
              }
            />
          </SettingsCard>

          {/* read-only identity row */}
          <SettingsCard>
            <SettingsRow
              title={t("settings.profile.email")}
              description={t("settings.profile.emailManaged")}
              control={<span className="text-sm">{auth.user?.email ?? "—"}</span>}
            />
          </SettingsCard>

          {/* danger zone (honest stubs, settings.md §2.7) */}
          <SettingsCard heading={t("settings.profile.dangerZone")} tone="danger">
            <SettingsRow
              title={t("settings.profile.signOutOthers")}
              control={
                <Button variant="outline" size="sm" disabled>
                  {t("settings.comingSoon")}
                </Button>
              }
            />
            <SettingsRow
              title={t("settings.profile.deleteAccount")}
              description={t("settings.profile.deleteAccountNote")}
            />
          </SettingsCard>
        </>
      )}
    </>
  );
}

export default ProfileSection;
