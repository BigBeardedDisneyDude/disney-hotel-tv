/**
 * Cloudflare Worker — disney-hotel-tv backend
 *
 * Two routes on one Worker:
 *
 *   POST  /(anything except /proxy)   Anthropic Messages API proxy for MainStreet
 *                                     chat. Body is forwarded verbatim to
 *                                     https://api.anthropic.com/v1/messages with
 *                                     the server-held ANTHROPIC_API_KEY.
 *
 *   GET   /proxy?url=<encoded>         Allow-listed CORS passthrough for the public
 *                                     park-data APIs (Queue-Times, ThemeParks.wiki).
 *                                     Replaces the old rotating public CORS proxies
 *                                     (allorigins / corsproxy / codetabs) that every
 *                                     wait-times page used to depend on.
 *
 * Env / secrets:
 *   ANTHROPIC_API_KEY  (secret)  — required by the Anthropic proxy route. Set in the
 *                                  Cloudflare dashboard (Settings → Variables) or via
 *                                  `npx wrangler secret put ANTHROPIC_API_KEY`.
 *                                  `wrangler deploy` never touches existing secrets.
 */

// Origins allowed to read responses from this Worker.
const ALLOWED_ORIGINS = [
  "https://bigbeardeddisneydude.github.io",
];

// Hosts the /proxy route is permitted to fetch from. Anything else → 403.
const PROXY_ALLOWED_HOSTS = [
  "queue-times.com",
  "www.queue-times.com",
  "api.themeparks.wiki",
];

// How long /proxy responses are considered fresh (client cache + in-isolate memo).
const PROXY_CACHE_SECONDS = 60;

// Best-effort in-memory cache. Cloudflare's Cache API is a no-op on *.workers.dev,
// so this per-isolate Map is what actually spares the upstream APIs. Isolates are
// reused across requests, so hit rates are decent in practice; it is not a
// guarantee. Move the Worker to a custom domain later for true edge caching.
const memCache = new Map(); // key: target URL string -> { body, contentType, expires }
const MEM_CACHE_MAX = 50;

function corsOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Allow local development (file server) to hit the live Worker.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return ALLOWED_ORIGINS[0];
}

function corsHeaders(request, extra = {}) {
  return {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Vary": "Origin",
    ...extra,
  };
}

function jsonError(request, message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: corsHeaders(request, { "Content-Type": "application/json" }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight — covers both routes.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(request, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        }),
      });
    }

    // ── GET /proxy?url=… ────────────────────────────────────────────────
    if (url.pathname === "/proxy" || url.pathname === "/proxy/") {
      return handleProxy(request);
    }

    // ── Anthropic Messages API proxy (unchanged behaviour) ──────────────
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders(request),
      });
    }

    try {
      const body = await request.json();

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      return new Response(JSON.stringify(data), {
        headers: corsHeaders(request, { "Content-Type": "application/json" }),
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders(request, { "Content-Type": "application/json" }),
      });
    }
  },
};

async function handleProxy(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");

  if (!target) return jsonError(request, "missing ?url= parameter", 400);

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonError(request, "invalid url", 400);
  }

  if (targetUrl.protocol !== "https:" || !PROXY_ALLOWED_HOSTS.includes(targetUrl.hostname)) {
    return jsonError(request, "host not allowed: " + targetUrl.hostname, 403);
  }

  const key = targetUrl.toString();
  const now = Date.now();
  let entry = memCache.get(key);
  let cache = "HIT";

  if (!entry || entry.expires < now) {
    cache = "MISS";
    let upstream;
    try {
      upstream = await fetch(key, {
        headers: { "Accept": "application/json", "User-Agent": "disney-hotel-tv-proxy" },
      });
    } catch (err) {
      return jsonError(request, "upstream fetch failed: " + err.message, 502);
    }
    if (!upstream.ok) {
      return jsonError(request, "upstream responded " + upstream.status, upstream.status === 429 ? 429 : 502);
    }
    entry = {
      body: await upstream.text(),
      contentType: upstream.headers.get("Content-Type") || "application/json",
      expires: now + PROXY_CACHE_SECONDS * 1000,
    };
    memCache.set(key, entry);
    if (memCache.size > MEM_CACHE_MAX) {
      memCache.delete(memCache.keys().next().value);
    }
  }

  return new Response(entry.body, {
    headers: corsHeaders(request, {
      "Content-Type": entry.contentType,
      "Cache-Control": `public, max-age=${PROXY_CACHE_SECONDS}`,
      "X-Proxy-Cache": cache,
    }),
  });
}
