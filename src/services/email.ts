/**
 * Shared email delivery via Resend (same provider as employee welcome emails).
 * Never pretends delivery succeeded when the provider is unconfigured or fails.
 */

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
};

export type SendEmailResult =
  | { ok: true; providerId?: string }
  | { ok: false; configured: boolean; error: string };

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export function escapeHtml(value: string) {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return String(value || '').replace(/[&<>"']/g, (c) => entities[c]);
}

export function appBaseUrl(): string {
  return (
    process.env.APP_BASE_URL ||
    process.env.APP_LOGIN_URL?.replace(/\/login\/?$/, '') ||
    process.env.WEB_ORIGIN?.split(',')[0]?.trim() ||
    'http://localhost:5173'
  );
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    return {
      ok: false,
      configured: false,
      error: 'Email service is not configured. Set RESEND_API_KEY and EMAIL_FROM.'
    };
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html
      })
    });
    if (!response.ok) {
      const detail = await response.text();
      return {
        ok: false,
        configured: true,
        error: `Email provider rejected send (${response.status}): ${detail.slice(0, 300)}`
      };
    }
    const body = (await response.json().catch(() => ({}))) as { id?: string };
    return { ok: true, providerId: body.id };
  } catch (e: any) {
    return {
      ok: false,
      configured: true,
      error: e?.message || 'Email delivery failed'
    };
  }
}
