// Drive-style account area, shared by the Home, editor, and settings headers.
// Signed in: avatar button → identity header · Profile · Settings · theme
// control · Workspace settings · Sign out. Signed out: Sign in + organization
// SSO. Open mode (no auth at all): just Settings + theme. Profile/Settings
// navigate to the full settings page (#~settings/…, settings.md §1). Yjs-free
// (identity.ts only). Ported from AccountMenu.svelte onto the shadcn
// DropdownMenu/Popover primitives.

import { useState, type FormEvent } from "react";
import { CircleUser, LogOut, Settings, User, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import ThemeModeControl from "@/components/settings/ThemeModeControl";
import { useT } from "@/state/i18n";
import { gotoSettings } from "@/state/route";
import { loginUrl, orgLoginUrl, type AuthInfo } from "@/services/identity";

interface Props {
  auth: AuthInfo;
  toast: (msg: string, kind?: "info" | "warning") => void;
  onSignOut: () => void | Promise<void>;
  /** Opens the host's WorkspacePanel modal (Home/editor headers own its state).
   *  Omitted in the settings header, where it routes to the workspace settings
   *  pages instead of opening the legacy modal. */
  onWorkspace?: () => void;
}

export function AccountMenu({ auth, toast, onSignOut, onWorkspace }: Props) {
  const t = useT();
  const [ssoEmail, setSsoEmail] = useState("");

  /** Workspace settings: open the host modal when given, else go to the page. */
  const openWorkspace = () => (onWorkspace ? onWorkspace() : gotoSettings("workspace"));

  const initial = (auth.user?.display_name ?? auth.user?.email ?? "?")
    .trim()
    .charAt(0)
    .toUpperCase();

  const avatar = (cls: string) =>
    auth.user?.avatar_url ? (
      <img src={auth.user.avatar_url} alt="" className={`${cls} rounded-full object-cover`} />
    ) : (
      <span
        className={`${cls} flex items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground`}
      >
        {initial}
      </span>
    );

  /** Probe-first SSO flow: unknown email domain → toast, not a dead-end page. */
  async function orgSignIn(e: FormEvent) {
    e.preventDefault();
    const url = orgLoginUrl(ssoEmail.trim());
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status === 404) {
        toast(t("account.noSsoForDomain"), "warning");
        return;
      }
    } catch {
      // opaque redirect / network hiccup — let the real navigation decide
    }
    window.location.href = url;
  }

  if (auth.mode === "oidc") {
    if (auth.user) {
      return (
        <DropdownMenu>
          {/* The visible circle matches the + New button's 40px height exactly
              (control-dimension consistency); hover feedback is a ring, not
              padding. */}
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="arc-tap h-10 w-10 shrink-0 rounded-full p-0 hover:ring-4 hover:ring-[var(--color-base-300)]/70"
                title={auth.user.email ?? auth.user.display_name ?? t("account.title")}
              />
            }
          >
            {avatar("h-10 w-10 text-sm")}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <div className="flex items-center gap-3 px-3 py-2">
              {avatar("h-9 w-9 shrink-0 text-base")}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{auth.user.display_name ?? "—"}</p>
                {auth.user.email && (
                  <p className="truncate text-xs opacity-60">{auth.user.email}</p>
                )}
              </div>
            </div>
            <DropdownMenuItem onClick={() => gotoSettings("profile")}>
              <User className="h-4 w-4 opacity-70" aria-hidden="true" />
              {t("account.profile")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => gotoSettings()}>
              <Settings className="h-4 w-4 opacity-70" aria-hidden="true" />
              {t("common.settings")}
            </DropdownMenuItem>
            <div className="px-3 py-2">
              <ThemeModeControl />
            </div>
            <DropdownMenuItem onClick={openWorkspace}>
              <Users className="h-4 w-4 opacity-70" aria-hidden="true" />
              {t("ws.title")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void onSignOut()}>
              <LogOut className="h-4 w-4 opacity-70" aria-hidden="true" />
              {t("account.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }
    return (
      <>
        <Button size="sm" render={<a href={loginUrl()} />}>
          {t("common.signIn")}
        </Button>
        <Popover>
          <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
            {t("account.useOrgSso")}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-3">
            <form className="flex flex-col gap-2" onSubmit={(e) => void orgSignIn(e)}>
              <Input
                type="email"
                placeholder={t("account.ssoEmailPlaceholder")}
                value={ssoEmail}
                onChange={(e) => setSsoEmail(e.target.value)}
                required
              />
              <Button size="sm" type="submit">
                {t("account.signInWithOrg")}
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      </>
    );
  }

  // open mode: no identity, but Settings (theme, default view, language) still apply
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            title={t("common.settings")}
          />
        }
      >
        <CircleUser className="h-6 w-6 opacity-70" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onClick={() => gotoSettings("preferences")}>
          <Settings className="h-4 w-4 opacity-70" aria-hidden="true" />
          {t("common.settings")}
        </DropdownMenuItem>
        <div className="px-3 py-2">
          <ThemeModeControl />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default AccountMenu;
