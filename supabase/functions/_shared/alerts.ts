// Shared email alerting for the wait-times pipeline's Edge Functions
// (collect-waits, prune-waits). Sends via Resend (https://resend.com) — a
// plain HTTP API, so no SMTP setup needed from Deno.
//
// Requires the RESEND_API_KEY secret (Supabase dashboard → Edge Functions →
// Secrets, or `supabase secrets set RESEND_API_KEY=... --project-ref ...`).
// If it's missing, alertOnFailure() just logs and does nothing — a missing
// key should never make the pipeline itself fail.

const ALERT_TO = 'andpcooke@gmail.com';
// Resend's shared test sender — works with no domain setup, sending to any
// address, at Resend's free-tier volume. Fine for occasional alert emails.
const ALERT_FROM = 'Disney Hotel TV Alerts <onboarding@resend.dev>';

// Re-alert at most this often per function, so a sustained outage sends a
// handful of emails rather than one every 15 minutes.
const ALERT_THROTTLE_MS = 3 * 60 * 60 * 1000; // 3 hours

async function sendEmail(subject: string, body: string) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    console.error('RESEND_API_KEY not set — skipping alert email:', subject);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: ALERT_FROM,
        to: [ALERT_TO],
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      console.error('Alert email send failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('Alert email send threw:', (err as Error).message);
  }
}

// Reads/writes the function_alerts table (via PostgREST, service role) to
// throttle re-alerts. Returns true if enough time has passed since the last
// alert for this function that a new one should go out now.
async function shouldAlert(functionName: string, supabaseUrl: string, serviceKey: string): Promise<boolean> {
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  try {
    const getRes = await fetch(
      `${supabaseUrl}/rest/v1/function_alerts?function_name=eq.${functionName}&select=last_alert_at`,
      { headers }
    );
    if (getRes.ok) {
      const rows: { last_alert_at: string }[] = await getRes.json();
      if (rows.length > 0) {
        const lastAlertMs = new Date(rows[0].last_alert_at).getTime();
        if (Date.now() - lastAlertMs < ALERT_THROTTLE_MS) return false;
      }
    }
  } catch (err) {
    // If the throttle check itself fails, err on the side of still alerting —
    // missing an alert is worse than an occasional extra one.
    console.error('Alert throttle check failed:', (err as Error).message);
  }

  try {
    await fetch(`${supabaseUrl}/rest/v1/function_alerts`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ function_name: functionName, last_alert_at: new Date().toISOString() }),
    });
  } catch (err) {
    console.error('Alert throttle write failed:', (err as Error).message);
  }

  return true;
}

// Call from a function's failure path. Throttled per functionName so a
// sustained problem doesn't flood the inbox.
export async function alertOnFailure(
  functionName: string,
  subject: string,
  body: string,
  supabaseUrl: string,
  serviceKey: string
) {
  if (await shouldAlert(functionName, supabaseUrl, serviceKey)) {
    await sendEmail(subject, body);
  } else {
    console.log(`Alert for ${functionName} suppressed — already alerted within the last ${ALERT_THROTTLE_MS / 60000} min`);
  }
}
