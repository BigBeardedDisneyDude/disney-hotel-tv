# disney-hotel-tv Worker

The Cloudflare Worker behind `restless-glade-a1e4.andpcooke.workers.dev`. It does
two jobs:

| Route | Method | Purpose |
| --- | --- | --- |
| `/` (any path except `/proxy`) | `POST` | Anthropic Messages API proxy for the MainStreet chat. Holds `ANTHROPIC_API_KEY`. |
| `/proxy?url=<encoded>` | `GET` | Allow-listed CORS passthrough for `queue-times.com` and `api.themeparks.wiki`. Replaces the old public CORS proxies. |

## Why `/proxy` exists

Every wait-times page (`waittimes.html`, `wdwwait.html`, `predict.html`,
`sim.html`, `mainstreet.html`) used to fetch Queue-Times through a rotating chain
of public CORS proxies (`allorigins.win`, `corsproxy.io`, `codetabs.com`). Those
go down often and independently, so a page would just fail to load waits. Now
they all hit this one route on infrastructure we control.

Client usage:

```js
const WORKER_PROXY = 'https://restless-glade-a1e4.andpcooke.workers.dev/proxy?url=';
const data = await fetch(WORKER_PROXY + encodeURIComponent(
  'https://queue-times.com/parks/16/queue_times.json'
)).then(r => r.json());
```

## Deploy

From this folder:

```bash
npx wrangler deploy
```

That updates the existing Worker in place. Secrets set in the dashboard
(`ANTHROPIC_API_KEY`) are **not** affected by a deploy.

First time on a new machine: `npx wrangler login` first.

## Config notes

- `name` in `wrangler.jsonc` must stay `restless-glade-a1e4` — that is what ties
  a deploy to the existing Worker and its `workers.dev` URL.
- Edge caching via Cloudflare's Cache API is a no-op on `*.workers.dev`, so
  `/proxy` uses a best-effort in-isolate memory cache (60 s). Putting the Worker
  on a custom domain would enable real edge caching with no code change.
- Allowed hosts and cache TTL are constants at the top of `worker.js`.
