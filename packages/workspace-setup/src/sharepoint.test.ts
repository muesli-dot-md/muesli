import { describe, it, expect } from "vitest";
import {
  applyLibraries,
  connectBody,
  identityComplete,
  initialSpState,
  librariesBody,
  nextStage,
  backStage,
  siteComplete,
  substitute,
  TENANT_RE,
} from "./sharepoint";
import type { SharePointSetup } from "./host";

const setup = (configured: boolean): SharePointSetup => ({
  configured,
  client_id: configured ? "srv-cid" : null,
  consent_url_template:
    "https://login.microsoftonline.com/{tenant}/adminconsent?client_id={client_id}",
  grant_snippet_graph: "POST …/sites/{site_id}/permissions … {client_id}",
  grant_snippet_powershell:
    "Grant-PnPAzureADAppSitePermission -AppId {client_id} -Site {site_url} -Permissions Write",
});

const libs = {
  site_id: "contoso,g1,g2",
  site_name: "Engineering",
  libraries: [
    { drive_id: "drv-arch", name: "Archive", is_default: false },
    { drive_id: "drv-docs", name: "Documents", is_default: true },
  ],
};

describe("sharepoint connect stages", () => {
  it("walks identity → grant → site, and back", () => {
    const s = initialSpState(true);
    expect(s.stage).toBe("identity");
    expect(s.ownApp).toBe(false); // server app is the default when configured
    expect(identityComplete(s, setup(true))).toBe(true);
    expect(nextStage(s, setup(true))).toBe(true);
    expect(s.stage).toBe("grant");
    expect(nextStage(s, setup(true))).toBe(true);
    expect(s.stage).toBe("site");
    // site → connect only through applyLibraries (the server resolves the site)
    expect(nextStage(s, setup(true))).toBe(false);
    expect(backStage(s)).toBe(true);
    expect(s.stage).toBe("grant");
    backStage(s);
    expect(s.stage).toBe("identity");
    expect(backStage(s)).toBe(false);
  });

  it("requires the own-app credentials when the server has no app", () => {
    const s = initialSpState(false);
    expect(s.ownApp).toBe(true); // forced: there is nothing else to use
    expect(identityComplete(s, setup(false))).toBe(false);
    s.clientId = "my-cid";
    expect(identityComplete(s, setup(false))).toBe(false); // still no secret material
    s.clientSecret = "shhh";
    expect(identityComplete(s, setup(false))).toBe(true);
    // certificate mode needs BOTH pems
    s.authMethod = "certificate";
    expect(identityComplete(s, setup(false))).toBe(false);
    s.certificatePem = "CERT";
    expect(identityComplete(s, setup(false))).toBe(false);
    s.privateKeyPem = "KEY";
    expect(identityComplete(s, setup(false))).toBe(true);
  });

  it("validates tenant + site url before Find libraries", () => {
    const s = initialSpState(true);
    expect(siteComplete(s)).toBe(false);
    s.tenant = "contoso.onmicrosoft.com";
    s.siteUrl = "https://contoso.sharepoint.com/sites/eng";
    expect(siteComplete(s)).toBe(true);
    s.tenant = "bad tenant";
    expect(siteComplete(s)).toBe(false);
    expect(TENANT_RE.test("11111111-2222-3333-4444-555555555555")).toBe(true);
    s.tenant = "contoso.onmicrosoft.com";
    s.siteUrl = "notaurl";
    expect(siteComplete(s)).toBe(false);
  });

  it("preselects the default library and builds the connect body", () => {
    const s = initialSpState(true);
    s.tenant = "contoso.onmicrosoft.com";
    s.siteUrl = "https://contoso.sharepoint.com/sites/eng";
    applyLibraries(s, libs);
    expect(s.stage).toBe("connect");
    expect(s.driveId).toBe("drv-docs"); // is_default wins over list order
    s.prefix = " notes ";
    const body = connectBody(s);
    expect(body).toEqual({
      kind: "sharepoint",
      tenant: "contoso.onmicrosoft.com",
      site_url: "https://contoso.sharepoint.com/sites/eng",
      site_id: "contoso,g1,g2",
      drive_id: "drv-docs",
      drive_name: "Documents",
      prefix: "notes",
    });
  });

  it("carries own-app credentials into the libraries and connect bodies", () => {
    const s = initialSpState(false);
    s.clientId = "my-cid";
    s.clientSecret = "shhh";
    s.tenant = "t.example";
    s.siteUrl = "https://t.sharepoint.com/sites/x";
    expect(librariesBody(s)).toEqual({
      tenant: "t.example",
      site_url: "https://t.sharepoint.com/sites/x",
      client_id: "my-cid",
      client_secret: "shhh",
    });
    s.authMethod = "certificate";
    s.certificatePem = "CERT";
    s.privateKeyPem = "KEY";
    applyLibraries(s, libs);
    const body = connectBody(s)!;
    expect(body.client_certificate_pem).toBe("CERT");
    expect(body.client_private_key_pem).toBe("KEY");
    expect(body.client_secret).toBeUndefined(); // cert wins over secret
  });

  it("substitutes known placeholders and leaves unknown/empty ones literal", () => {
    const s = initialSpState(true);
    s.tenant = "contoso.onmicrosoft.com";
    expect(substitute(setup(true).consent_url_template, s, setup(true))).toBe(
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/adminconsent?client_id=srv-cid",
    );
    // site_url not entered yet → the placeholder survives for the admin to fill
    expect(substitute("… -Site {site_url} … {site_id} …", s, setup(true))).toBe(
      "… -Site {site_url} … {site_id} …",
    );
    // own app substitutes ITS client id, not the server's
    const own = initialSpState(true);
    own.ownApp = true;
    own.clientId = "my-cid";
    expect(substitute("{client_id}", own, setup(true))).toBe("my-cid");
  });
});
