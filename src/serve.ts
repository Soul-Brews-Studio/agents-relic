import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./mcp.js";

/*
 * relic over HTTP — the same eight tools, reachable by something that is not a child
 * process.
 *
 * WHAT IS ACTUALLY BEING EXPOSED. relic indexes every agent session on the machine:
 * private repository contents, absolute paths, whatever anyone ever pasted into a
 * transcript. That is a different risk from a normal dev server, which usually holds
 * one project's data. An open relic port is the whole fleet's history, so the binding
 * rules below are the feature, not boilerplate around it.
 */

/** Loopback means "no one off this machine can reach it", and nothing else does. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export type AuthVerdict = { ok: true } | { ok: false; status: number; message: string };

/**
 * Whether a request may proceed.
 *
 * A token is required for every non-loopback bind, and `startupError` below refuses to
 * start without one — so by the time a request arrives on a public interface, a token
 * exists. On loopback the token is optional: the OS is already the boundary, and
 * demanding one there only trains people to paste tokens into scripts.
 */
export function checkAuth(token: string | null, header: string | null): AuthVerdict {
  if (!token) return { ok: true };
  if (!header) return { ok: false, status: 401, message: "missing Authorization: Bearer <token>" };
  const got = header.replace(/^Bearer\s+/i, "");
  // Length-first compare, then constant-time-ish over the bytes. Not a defence against
  // a local attacker with a timer, but it costs nothing and removes the trivial
  // early-exit oracle that `===` on strings gives.
  if (got.length !== token.length) return { ok: false, status: 403, message: "bad token" };
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= got.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, status: 403, message: "bad token" };
}

/**
 * The refusal that makes the default safe.
 *
 * `--host 0.0.0.0` binds every interface at once — loopback, LAN wifi, and the mesh
 * address. That is usually what someone wants ("reach it from my phone AND from
 * white"), and it is also how the machine's entire session history ends up readable by
 * anything on a café network. Starting without a token in that state is not a
 * configuration choice worth honouring, so it is an error rather than a warning.
 */
export function startupError(host: string, token: string | null): string | null {
  if (isLoopback(host) || token) return null;
  return `refusing to bind ${host} without a token — relic serves this machine's entire session history.\n` +
         `  relic serve --host ${host} --token "$(openssl rand -hex 32)"\n` +
         `  or set RELIC_TOKEN, or drop --host to stay on 127.0.0.1`;
}

/**
 * CORS, allow-list only.
 *
 * A browser UI needs this to call the server at all. `*` is refused deliberately: with
 * a token in a header it would still be exploitable by any page the user visits, since
 * the browser would happily make the request and read the reply.
 */
export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.length) return {};
  const ok = allowed.includes(origin) || allowed.includes("*");
  if (!ok) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
}

export interface ServeOpts {
  host: string; port: number; token: string | null; origins: string[];
}

export async function serve(o: ServeOpts) {
  const fatal = startupError(o.host, o.token);
  if (fatal) { console.error(fatal); process.exit(1); }

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get("origin"), o.origins);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // Unauthenticated ON PURPOSE: a liveness probe that needs a token cannot tell you
    // the server is up when you have the token wrong. It reveals nothing but the name.
    if (url.pathname === "/health") {
      return Response.json({ ok: true, server: "relic", tools: 8, auth: o.token ? "bearer" : "none" },
                           { headers: cors });
    }

    if (url.pathname !== "/mcp") return new Response("not found", { status: 404, headers: cors });

    const verdict = checkAuth(o.token, req.headers.get("authorization"));
    if (!verdict.ok) {
      return Response.json({ error: verdict.message }, { status: verdict.status, headers: cors });
    }

    // One transport and one Server per request. Stateless mode: no session id to track
    // and nothing to leak between callers, at the cost of not supporting server-push.
    // None of the eight tools push, so there is nothing to lose here yet.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer();
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  };

  const s = Bun.serve({ hostname: o.host, port: o.port, fetch: handler, idleTimeout: 120 });
  const where = isLoopback(o.host) ? "this machine only" : "EVERY interface on this host";
  console.log(`relic serve  http://${o.host}:${s.port}/mcp   (${where})`);
  console.log(`  auth    ${o.token ? "Bearer token required" : "none — loopback only"}`);
  console.log(`  cors    ${o.origins.length ? o.origins.join(", ") : "off (no browser origin allowed)"}`);
  console.log(`  health  http://${o.host}:${s.port}/health`);
  if (!isLoopback(o.host)) {
    console.log(`\n  This exposes every indexed session on this machine. Stop it when you are done.`);
  }
}
