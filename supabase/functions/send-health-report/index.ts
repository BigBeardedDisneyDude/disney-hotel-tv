// Supabase Edge Function: send-health-report
// Deploy with: supabase functions deploy send-health-report --project-ref qumvjdwimpvnaijjwght
//
// Tiny notification endpoint for the daily cloud-agent health check (a
// scheduled Claude Code routine, not a Supabase cron job). The routine does
// its own read-only diagnosis using the public anon key and plain HTTP
// checks, then POSTs here ONLY if it found something worth flagging --
// this function's only job is turning that into an email, reusing the
// existing Resend setup in _shared/alerts.ts so no new secret is needed
// anywhere. Auth is just the standard Supabase anon key (already public in
// this repo, e.g. predict-core.js) -- the real protection against abuse is
// alertOnFailure()'s existing 3-hour per-function throttle, which caps this
// at a handful of emails/day even if someone spammed the endpoint directly.
//
// POST body: { "subject": string, "body": string }

import { alertOnFailure } from '../_shared/alerts.ts';

Deno.serve(async (req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 });
  }

  let subject = '';
  let body = '';
  try {
    const payload = await req.json();
    subject = String(payload.subject ?? '').slice(0, 200);
    body = String(payload.body ?? '').slice(0, 5000);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400 });
  }

  if (!subject || !body) {
    return new Response(JSON.stringify({ error: 'subject and body are required' }), { status: 400 });
  }

  await alertOnFailure(
    'cloud-health-report',
    `disney-hotel-tv: ${subject}`,
    body,
    SUPABASE_URL,
    SUPABASE_KEY
  );

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
