// CLI login e2e (local-agent-cli.md): spawns `muesli login`, drives the OIDC device-code
// flow headlessly (walking Dex's HTML forms), and asserts a delegated agent token lands in
// the (file-backed) token store. Uses an isolated HOME so the user's real state is untouched.
// Usage: node cli-login-e2e.mjs <path-to-muesli-binary> <tmp-home>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [bin, tmpHome] = process.argv.slice(2);
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
setTimeout(() => fail("global timeout"), 60_000).unref();

// --- tiny cookie jar + form walker (Dex pages are plain HTML forms) ----------
const jar = new Map();
function cookies(url) {
  const m = jar.get(new URL(url).host);
  return m ? [...m].map(([k, v]) => `${k}=${v}`).join("; ") : "";
}
async function request(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    redirect: "manual",
    headers: { ...(opts.headers ?? {}), cookie: cookies(url) },
  });
  const host = new URL(url).host;
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (!jar.has(host)) jar.set(host, new Map());
    jar.get(host).set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return res;
}
async function follow(url, opts = {}) {
  let res = await request(url, opts);
  while ([301, 302, 303, 307].includes(res.status)) {
    url = new URL(res.headers.get("location"), url).toString();
    res = await request(url);
  }
  return { res, url };
}

/// Walk HTML forms: fill the device code and credentials where asked, prefer
/// "approve"-style submits.
async function driveForms(startUrl) {
  const userCode = new URL(startUrl).searchParams.get("user_code");
  let { res, url } = await follow(startUrl);
  for (let step = 0; step < 8; step++) {
    const html = await res.text();
    if (/login successful|you can close|return to your device|success/i.test(html)) return;
    const formMatch = html.match(/<form[^>]*>([\s\S]*?)<\/form>/i);
    if (!formMatch) return; // no more forms — assume done
    const actionMatch = formMatch[0].match(/action="([^"]*)"/i);
    // Form actions are HTML-escaped (&amp;) — decode before using as a URL.
    const rawAction = (actionMatch?.[1] || url)
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'");
    const action = new URL(rawAction, url).toString();
    const fields = new URLSearchParams();
    for (const input of formMatch[1].matchAll(/<input[^>]*>/gi)) {
      const name = input[0].match(/name="([^"]*)"/i)?.[1];
      if (!name) continue;
      const value = input[0].match(/value="([^"]*)"/i)?.[1] ?? "";
      if (name === "user_code") {
        fields.set(name, value || userCode);
      } else if (/login|email|user/i.test(name) && input[0].match(/type="(text|email)"/i)) {
        fields.set(name, "dev@muesli.md");
      } else if (/password/i.test(name)) {
        fields.set(name, "password");
      } else if (name === "approval") {
        fields.set(name, "approve");
      } else {
        fields.set(name, value);
      }
    }
    ({ res, url } = await follow(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields,
    }));
  }
  fail("form walker did not converge");
}

// --- spawn the CLI and watch for the verification URL ------------------------
const cli = spawn(bin, ["login", "--server", "ws://localhost:8787/ws"], {
  env: {
    ...process.env,
    HOME: tmpHome,
    MUESLI_TOKEN_STORE: "file",
    MUESLI_NO_BROWSER: "1",
  },
});
let out = "";
let driven = false;
cli.stdout.on("data", async (chunk) => {
  out += chunk.toString();
  process.stdout.write(chunk);
  const m = out.match(/(http:\/\/\S+dex\/device\S*)/);
  if (m && !driven) {
    driven = true;
    console.log("→ driving the device-flow pages…");
    await driveForms(m[1]).catch((e) => fail(`form walk: ${e}`));
  }
});
cli.stderr.on("data", (c) => process.stderr.write(c));

const code = await new Promise((resolve) => cli.on("exit", resolve));
if (code !== 0) fail(`muesli login exited ${code}`);
if (!/signed in as dev@muesli\.md/.test(out)) fail("missing success line");

// macOS dirs::config_dir() = $HOME/Library/Application Support
const credPath = join(tmpHome, "Library", "Application Support", "muesli", "credentials.json");
const creds = JSON.parse(readFileSync(credPath, "utf8"));
const token = creds["http://localhost:8787"];
if (!token?.startsWith("mua_")) fail(`no mua_ token in ${credPath}`);

// The token authenticates as the agent identity.
const me = await (
  await fetch("http://localhost:8787/api/me", { headers: { authorization: `Bearer ${token}` } })
).json();
if (!me.user?.display_name?.startsWith("muesli-cli@")) {
  fail(`unexpected bearer identity: ${JSON.stringify(me)}`);
}
console.log(`OK: delegated agent token works (identity: ${me.user.display_name})`);
console.log("CLI LOGIN E2E PASSED");
process.exit(0);
