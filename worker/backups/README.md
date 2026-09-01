# Worker rollback snapshots

Frozen copies of previously deployed versions of the `restless-glade-a1e4`
Worker, kept so a bad deploy can be undone from source. **Do not edit these
files** — they are historical records.

| File | Deployed | Cloudflare version ID | Notes |
| --- | --- | --- | --- |
| `worker.2026-05-13-pre-proxy-route.js` | 2026-05-13 → 2026-09-01 | `8f107003-fc78-498a-acde-6429f8fad32b` | Anthropic `/v1/messages` proxy only. Last version before the `/proxy` route was added. |

## Reverting

Fastest — roll back on Cloudflare without touching code:

```bash
npx wrangler rollback 8f107003-fc78-498a-acde-6429f8fad32b
```

From source instead:

```bash
cp backups/worker.2026-05-13-pre-proxy-route.js worker.js   # then strip the snapshot header comment
npx wrangler deploy
```

Secrets (`ANTHROPIC_API_KEY`) are unaffected by either path.

## Full history

`npx wrangler deployments list` shows every deployment with its version ID.
