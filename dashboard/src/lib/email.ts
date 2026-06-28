import { getCloudflareContext } from '@opennextjs/cloudflare';

/** Send a magic sign-in link email via Resend. All credentials are CF secrets — never on the client. */
export async function sendMagicLinkEmail(toEmail: string, verifyUrl: string, userName: string): Promise<void> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };
	const apiKey: string = env.RESEND_API_KEY ?? '';
	const fromEmail: string = env.RESEND_FROM_EMAIL ?? '';

	if (!apiKey || !fromEmail) {
		console.error('[EMAIL] RESEND_API_KEY or RESEND_FROM_EMAIL not configured');
		return;
	}

	const html = magicLinkTemplate(userName, verifyUrl);

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: fromEmail,
			to: toEmail,
			subject: 'Sign in to Chinese Intel Monitor',
			html,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		console.error(`[EMAIL] Resend error ${res.status}:`, body);
	}
}

function magicLinkTemplate(name: string, verifyUrl: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in to Chinese Intel Monitor</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;overflow:hidden;max-width:560px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:#0f172a;padding:24px 32px;">
              <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#ef4444;">Intelligence Monitor</p>
              <p style="margin:4px 0 0;font-size:18px;font-weight:600;color:#f1f5f9;">Chinese Provincial Press</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 8px;font-size:15px;color:#475569;">Hello ${escapeHtml(name)},</p>
              <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.6;">
                Click the button below to sign in to your account. This link expires in <strong>15 minutes</strong> and can only be used once.
              </p>

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background:#dc2626;border-radius:6px;">
                    <a href="${escapeHtml(verifyUrl)}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">
                      Sign in to Intel Monitor
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 4px;font-size:13px;color:#94a3b8;">Or copy this link into your browser:</p>
              <p style="margin:0 0 28px;font-size:12px;color:#64748b;word-break:break-all;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:10px 12px;">
                ${escapeHtml(verifyUrl)}
              </p>

              <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
                If you did not request this link, you can safely ignore this email. Someone may have entered your address by mistake.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #e2e8f0;background:#f8fafc;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Chinese Intel Monitor · Automated briefings from seven Chinese provincial newspapers
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
