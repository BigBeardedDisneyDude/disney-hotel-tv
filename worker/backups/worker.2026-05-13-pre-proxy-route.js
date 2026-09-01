/**
 * SNAPSHOT — the Worker exactly as it ran before the 2026-09-01 deploy that added
 * the /proxy route. Kept as a rollback reference only. Do not edit.
 *
 * Cloudflare version ID of this code: 8f107003-fc78-498a-acde-6429f8fad32b
 * Instant revert:  npx wrangler rollback 8f107003-fc78-498a-acde-6429f8fad32b
 *
 * ---------------------------------------------------------------------------
 *
 * Cloudflare Worker — Anthropic API Proxy
 *
 * Setup:
 * 1. In Cloudflare Dashboard → Workers & Pages → Create Worker
 * 2. Paste this code
 * 3. Go to Settings → Variables → Add environment variable:
 *    Name: ANTHROPIC_API_KEY   Value: your key (mark as Secret)
 * 4. Deploy — note your worker URL e.g. https://anthropic-proxy.YOUR-NAME.workers.dev
 */

const ALLOWED_ORIGIN = "https://bigbeardeddisneydude.github.io";

export default {
  async fetch(request, env) {

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        }
      });
    }

    // Only allow POST
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
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
console.log("Anthropic response:", JSON.stringify(data));

return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        }
      });
    }
  }
};
