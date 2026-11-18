/**
 * Garmin Connect MCP server on Cloudflare Workers.
 *
 * - /mcp        Streamable HTTP MCP endpoint, protected by OAuth 2.1.
 * - /authorize  Consent page where the owner approves an MCP client, behind
 *               Cloudflare Access.
 * - OAuth metadata, token, registration and revocation endpoints are served by
 *   OAuthProvider.
 */
import { OAuthProvider, insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { SCOPE, handleAuthorize } from "./auth/authorize";
import { SERVER_INFO, createServer } from "./mcp/server";

const MCP_ROUTE = "/mcp";
const DAY_S = 86_400;

const mcpHandler = createMcpHandler(() => createServer(env), { route: MCP_ROUTE });

const apiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { auth } = ctx as OAuthResourceContext<unknown>;
    if (!auth.scope.includes(SCOPE)) return insufficientScope(auth, [SCOPE]);
    return mcpHandler(request, env, ctx);
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env, ctx);
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        name: SERVER_INFO.title,
        version: SERVER_INFO.version,
        mcp: `${url.origin}${MCP_ROUTE}`,
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

/**
 * The OAuth resource must be this server's exact public URL. Deriving it from
 * the request origin lets the same Worker serve workers.dev, a custom domain and
 * `wrangler dev` without configuration; tokens stay bound to the origin that
 * issued them.
 */
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: MCP_ROUTE,
      apiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE, "offline_access"],
      requiredScopes: [SCOPE],
      resourceMetadata: { resource: `${origin}${MCP_ROUTE}`, resource_name: SERVER_INFO.title },
      accessTokenTTL: 3600,
      // Clients stay connected while used at least once a month, for up to a year.
      refreshTokenTTL: 365 * DAY_S,
      refreshTokenIdleTTL: 30 * DAY_S,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
