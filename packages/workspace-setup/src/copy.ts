// Built-in English copy, Multica tone: short, plain, second person, explains why.
// The web app overrides via WizardHost.t with the same keys in its i18n catalog.

export const EN = {
  "wizard.stepOf": "Step {n} of {total}",
  "wizard.back": "Back",
  "wizard.cancel": "Cancel",
  "wizard.next": "Continue",
  "wizard.nameTitle": "Name your workspace",
  "wizard.nameBody": "A workspace is a shared home for documents. You can rename it later.",
  "wizard.namePlaceholder": "Workspace name",
  "wizard.storageTitle": "Where should your files live?",
  "wizard.storageBody":
    "Muesli doesn't store your documents on its server — you bring the storage, so your files stay yours. Pick where this workspace's Markdown files should live.",
  "wizard.s3Card": "S3-compatible bucket",
  "wizard.s3CardBody":
    "AWS S3, MinIO, or Cloudflare R2. You create an access key scoped to one bucket.",
  "wizard.gdriveCard": "Google Drive",
  "wizard.gdriveCardBody":
    "A Muesli folder in your Drive. You approve access in your Google account.",
  "wizard.gdriveUnavailable": "This server has no Google OAuth client configured.",
  "wizard.githubCard": "Git repository",
  "wizard.githubCardBody": "GitHub, Gitea, or Forgejo. Every change becomes a commit.",
  "wizard.sharepointCard": "SharePoint",
  "wizard.sharepointCardBody":
    "A SharePoint document library. Your tenant admin grants the app access to one site — nothing else.",
  "wizard.comingSoon": "COMING SOON",
  "wizard.s3ConnectTitle": "Connect your bucket",
  "wizard.s3PolicyLead":
    "First, create an access key that can only touch this bucket and prefix. Here's the exact policy:",
  "wizard.copyPolicy": "Copy policy",
  "wizard.copied": "Copied",
  "wizard.endpoint": "Endpoint",
  "wizard.bucket": "Bucket",
  "wizard.region": "Region",
  "wizard.prefix": "Prefix (optional)",
  "wizard.accessKeyId": "Access key ID",
  "wizard.secretKey": "Secret access key",
  "wizard.testConnect": "Test & connect",
  "wizard.probing": "Checking we can write, read, and delete…",
  "wizard.githubConnectTitle": "Connect your repository",
  "wizard.apiBase": "API base",
  "wizard.owner": "Owner",
  "wizard.repo": "Repository",
  "wizard.branch": "Branch",
  "wizard.tokenLabel": "Access token",
  "wizard.driveConnectTitle": "Connect Google Drive",
  "wizard.driveLead":
    "We'll send you to Google to approve access. Muesli only sees the folder it creates — nothing else in your Drive.",
  "wizard.driveGo": "Continue with Google",
  "wizard.driveWaiting": "Waiting for Google…",
  "wizard.driveHint15": "Finish approving access in the browser window we opened.",
  "wizard.driveHint45":
    "Still waiting. If no window opened, check your popup blocker or sign in to the web app first.",
  "wizard.driveHint90":
    "This is taking a while. You can go back and pick a different storage option.",
  "wizard.doneTitle": "Your workspace is ready",
  "wizard.doneBody":
    "Files sync to your storage as you type. Invite people from workspace settings.",
  "wizard.open": "Open workspace",
  "wizard.error": "That didn't work: {detail}",
  "wizard.spConnectTitle": "Connect SharePoint",
  "wizard.spLead":
    "Pick the app identity, have a tenant admin grant it access, then point at your site and library.",
  "wizard.spStageIdentity": "App",
  "wizard.spStageGrant": "Grant",
  "wizard.spStageSite": "Site",
  "wizard.spStageConnect": "Library",
  "wizard.spServerApp": "Use this server's Microsoft app",
  "wizard.spServerAppId": "Application ID: {clientId}",
  "wizard.spOwnApp": "Use your own Entra app",
  "wizard.spOwnAppHint":
    "Register an app in your own tenant so you never consent to this server's app. Credentials are stored encrypted, for this workspace only.",
  "wizard.spNoServerApp": "This server has no Microsoft app configured — bring your own Entra app.",
  "wizard.spClientId": "Application (client) ID",
  "wizard.spAuthSecret": "Client secret",
  "wizard.spAuthCert": "Certificate",
  "wizard.spClientSecret": "Client secret value",
  "wizard.spCertPem": "Certificate (PEM)",
  "wizard.spKeyPem": "Private key (PEM)",
  "wizard.spKeyPemLoaded": "{name} — {bytes} bytes",
  "wizard.spKeyPemRemove": "Remove",
  "wizard.spKeyPemEmpty": "The file is empty.",
  "wizard.spGrantLead":
    "A tenant admin runs these once: admin consent admits the app, the site grant scopes it to exactly one site.",
  "wizard.spConsentUrl": "Admin-consent URL",
  "wizard.spGrantGraph": "Site grant — Microsoft Graph",
  "wizard.spGrantPowershell": "Site grant — PnP PowerShell",
  "wizard.spPlaceholderHint":
    "{tenant} and {site_url} fill in once you enter them in the next step.",
  "wizard.spTenant": "Tenant (GUID or domain)",
  "wizard.spSiteUrl": "Site URL",
  "wizard.spFindLibraries": "Find libraries",
  "wizard.spFinding": "Resolving the site and listing its document libraries…",
  "wizard.spLibrary": "Document library",
  "wizard.spDefault": "default",
  "wizard.spSite": "Site: {name}",
  "wizard.copy": "Copy",
  "onboarding.skip": "Skip",
  "onboarding.welcomeTitle": "Welcome to Muesli",
  "onboarding.welcomeBody":
    "Muesli is a collaborative Markdown editor. Your documents live in storage you control, and the people you invite see your edits as you type.",
  "onboarding.conceptsTitle": "Four things to know",
  "onboarding.conceptWorkspace": "Workspace",
  "onboarding.conceptWorkspaceBody": "A shared home for documents and people.",
  "onboarding.conceptDocument": "Document",
  "onboarding.conceptDocumentBody": "Markdown, edited live together.",
  "onboarding.conceptStorage": "Storage",
  "onboarding.conceptStorageBody":
    "Files materialize to your S3, Google Drive, or SharePoint — the operator never holds your content.",
  "onboarding.conceptSharing": "Sharing",
  "onboarding.conceptSharingBody": "Invite people by email, or share a link.",
  "onboarding.createTitle": "Ready to start?",
  "onboarding.createBody":
    "A workspace needs a home for its files. The setup wizard walks you through connecting one in a minute.",
  "onboarding.createButton": "Create your first workspace",
  "onboarding.invitedTitle": "You're already in {workspace}",
  "onboarding.invitedBody":
    "Someone added you to this workspace — its documents are waiting for you.",
  "onboarding.invitedButton": "Take me there",
  "onboarding.desktopTitle": "How do you want to work?",
  "onboarding.desktopBody": "You can add the other way of working any time.",
  "onboarding.localCard": "Work locally",
  "onboarding.localCardBody":
    "Open a folder of Markdown files on this computer. No account, no server.",
  "onboarding.serverCard": "Connect to a server",
  "onboarding.serverCardBody":
    "Sign in to collaborate, then create a workspace backed by your storage.",
} as const;

export type WizardKey = keyof typeof EN;

/** Interpolating lookup with built-in-English fallback. */
export function makeT(
  override?: (key: string, params?: Record<string, string | number>) => string,
) {
  return (key: WizardKey, params?: Record<string, string | number>): string => {
    if (override) {
      const s = override(key, params);
      // A host t() that misses the key should fall back to built-in English:
      // the web app's t() already falls back itself and never returns the raw
      // key, so any non-key answer wins.
      if (s && s !== key) return s;
    }
    const template = EN[key];
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    );
  };
}
