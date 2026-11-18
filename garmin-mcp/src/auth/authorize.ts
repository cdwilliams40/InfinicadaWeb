/**
 * The OAuth authorization page. This server has exactly one user, the owner.
 * Cloudflare Access protects /authorize and signs them in before the page is
 * served; the Worker fails closed unless the request carries an Access
 * identity for this application. The consent helpers keep the form
 * unforgeable and unframeable; see
 * node_modules/@cloudflare/workers-oauth-provider/docs/consent-page.md.
 */
import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const SCOPE = "garmin:read";
export const OWNER_ID = "owner";

export async function handleAuthorize(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Only requests that passed this Access application reach the consent page.
  // Without ACCESS_AUD nothing matches, so a misconfigured deploy stays closed.
  if (!env.ACCESS_AUD || ctx.access?.aud !== env.ACCESS_AUD) {
    return page("Access required", "Sign in through Cloudflare Access to authorize clients.", 403);
  }
  try {
    return request.method === "POST" ? await submit(request, env) : await show(request, env, ctx.access);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return page("Cannot authorize", escape(error.description), 400);
    if (error instanceof CimdFetchError) return page("Cannot authorize", "The application could not be verified.", 400);
    throw error;
  }
}

async function show(request: Request, env: Env, access: CloudflareAccessContext): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  const identity = await access.getIdentity();
  const email = typeof identity?.email === "string" ? identity.email : undefined;
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle, email), { headers: consent.headers });
}

async function submit(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: OWNER_ID,
    metadata: {},
    scope: [SCOPE],
    props: {},
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

function consentPage(details: ConsentDescription, handle: string, email: string | undefined): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This application registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? "<p class=warn>Access will be sent to an application on this computer. Continue only if you just started connecting from it.</p>"
    : "";
  const signedIn = email ? `<p class=muted>Signed in as ${escape(email)}.</p>` : "";
  return html(
    `Authorize ${name}`,
    `<h1>Give ${name} access?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<p>It will be able to <strong>read</strong> your Garmin Connect data (activities, sleep, health). It cannot change anything.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <div class=actions>
    <button name="decision" value="approve">Allow</button>
    <button name="decision" value="deny" class=secondary>Deny</button>
  </div>
</form>
${signedIn}`,
  );
}

function page(title: string, body: string, status: number): Response {
  return new Response(html(escape(title), `<h1>${escape(title)}</h1><p>${body}</p>`), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

function html(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 28rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { padding: .6rem 1.2rem; font: inherit; border-radius: .4rem; border: 1px solid; cursor: pointer; }
  .secondary { background: transparent; }
  .warn { padding: .75rem; border-left: 4px solid orange; }
  .muted { opacity: .7; font-size: .9rem; margin-top: 2rem; }
</style>
${body}
</html>`;
}

export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
