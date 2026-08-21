export type NotificationTemplate = 'ORDER_STATUS' | 'QR_READY' | 'DOCUMENT_REUPLOAD' | 'PLAN_EXHAUSTED' | 'PLAN_EXPIRED' | 'OPS_ALERT';

export type RenderedNotification = { subject: string; text: string; html: string };

type TemplateData = { orderNumber: string; reason?: string; msisdn?: string; customerName?: string };

const BRAND = 'Visa Compass';

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function supportContact(): string {
  const email = process.env.SUPPORT_EMAIL ?? process.env.EMAIL_REPLY_TO ?? '';
  const phone = process.env.SUPPORT_PHONE ?? '';
  const parts = [email ? `email us at ${email}` : '', phone ? `call us on ${phone}` : ''].filter(Boolean);
  return parts.length ? `If you need help, please ${parts.join(' or ')}.` : '';
}

function supportContactHtml(): string {
  const email = process.env.SUPPORT_EMAIL ?? process.env.EMAIL_REPLY_TO ?? '';
  const phone = process.env.SUPPORT_PHONE ?? '';
  const parts = [
    email ? `email us at <a href="mailto:${escapeHtml(email)}" style="color:#132a4a;text-decoration:underline;">${escapeHtml(email)}</a>` : '',
    phone ? `call us on ${escapeHtml(phone)}` : '',
  ].filter(Boolean);
  return parts.length ? `<p style="margin:0 0 6px;">If you need help, please ${parts.join(' or ')}.</p>` : '';
}

function customerUrl(path: string): string {
  const base = (process.env.CUSTOMER_WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return `${base}${path}`;
}

type Spec = { subject: string; paragraphs: string[]; steps?: string[]; cta?: { label: string; href: string }; internal?: boolean };

function render(spec: Spec, data: TemplateData): RenderedNotification {
  const greet = greeting(data.customerName);
  const textBlocks = [...(spec.internal ? [] : [greet]), ...spec.paragraphs];
  if (spec.steps?.length) textBlocks.push(spec.steps.map((step, index) => `${index + 1}. ${step}`).join('\n'));
  if (spec.cta) textBlocks.push(`${spec.cta.label}: ${spec.cta.href}`);
  if (!spec.internal) textBlocks.push('Warm regards,', `The ${BRAND} Team`, supportContact(), `This is an automated message from ${BRAND} for order ${data.orderNumber}.`);
  const text = textBlocks.filter(Boolean).join('\n\n');

  const paragraphHtml = spec.paragraphs.map((paragraph) => `<p style="margin:0 0 14px;">${escapeHtml(paragraph)}</p>`).join('');
  const stepsHtml = spec.steps?.length ? `<ol style="margin:0 0 14px;padding-left:20px;color:#1f2937;font-size:15px;line-height:1.7;">${spec.steps.map((step) => `<li style="margin-bottom:6px;">${escapeHtml(step)}</li>`).join('')}</ol>` : '';
  const ctaHtml = spec.cta ? `<p style="margin:20px 0;"><a href="${escapeHtml(spec.cta.href)}" style="display:inline-block;background:#132a4a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;padding:12px 26px;border-radius:6px;">${escapeHtml(spec.cta.label)}</a></p><p style="margin:0 0 14px;font-size:13px;color:#6b7280;word-break:break-all;">${escapeHtml(spec.cta.href)}</p>` : '';
  const bodyHtml = spec.internal ? '' : `<p style="margin:0 0 14px;">${escapeHtml(greet)}</p>`;
  const signatureHtml = spec.internal ? '' : `<p style="margin:22px 0 0;">Warm regards,<br/><b>The ${BRAND} Team</b></p>`;
  const footerParts = [`This is an automated message from ${BRAND} regarding order <b>${escapeHtml(data.orderNumber)}</b>.`, supportContactHtml()].filter(Boolean);
  const html = `<div style="margin:0;padding:24px 12px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;"><div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e3e7ec;"><div style="background:#132a4a;padding:18px 28px;"><span style="color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:.5px;">${BRAND}</span></div><div style="padding:28px;color:#1f2937;font-size:15px;line-height:1.6;">${bodyHtml}${paragraphHtml}${stepsHtml}${ctaHtml}${signatureHtml}</div><div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e3e7ec;color:#6b7280;font-size:12px;line-height:1.6;">${footerParts.map((part) => `<p style="margin:0 0 6px;">${part}</p>`).join('')}</div></div></div>`;
  return { subject: spec.subject, text, html };
}

function greeting(name?: string): string {
  return name ? `Dear ${name},` : 'Dear Customer,';
}

export function renderNotification(template: NotificationTemplate, data: TemplateData): RenderedNotification {
  if (template === 'OPS_ALERT') {
    return render({
      subject: `[Visa Compass Ops] ${data.reason ?? 'Action required'} (${data.orderNumber})`,
      paragraphs: [
        `An operational alert was raised for order ${data.orderNumber}.`,
        `Issue: ${data.reason ?? 'Review required.'}`,
        'Please review this order in the operations console and take the necessary action.',
      ],
      cta: { label: 'Open operations console', href: `${(process.env.OPS_WEB_URL ?? 'http://localhost:3001').replace(/\/$/, '')}/provisioning-operations` },
      internal: true,
    }, data);
  }
  if (template === 'QR_READY') {
    const paragraphs = [
      `Good news — your eSIM for order ${data.orderNumber} has been provisioned and is ready to install.`,
      'The activation QR code is attached as an image to this email. Simply save it to your phone or another device.',
    ];
    if (data.msisdn) paragraphs.push(`Your eSIM mobile number is ${data.msisdn}. You will need this number to open the protected QR document should you download it later from your account.`);
    paragraphs.push('Please keep this email private: anyone who obtains the QR code could access your data plan.');
    return render({
        subject: `Your Visa Compass eSIM is ready to install (order ${data.orderNumber})`,
        paragraphs,
        steps: [
          'On your phone, open Settings and tap Mobile Data or Cellular Data.',
          'Choose Add eSIM or Add Cellular Plan.',
          'Scan the attached QR code and follow the on-screen prompts.',
          'Install the eSIM before you travel, then turn on data roaming when you arrive at your destination.',
        ],
        cta: { label: 'View your eSIM', href: customerUrl('/account/esims') },
      }, data);
  }
  if (template === 'DOCUMENT_REUPLOAD') {
    return render({
      subject: `Action required: travel document for your Visa Compass order ${data.orderNumber}`,
      paragraphs: [
        `We were unable to verify one of the travel documents submitted with order ${data.orderNumber}.${data.reason ? ` Reason: ${data.reason}` : ''}`,
        'Please sign in to your Visa Compass account and upload a replacement document at your earliest convenience. Your order will continue as soon as the new document has been verified.',
      ],
      cta: { label: 'Upload your document', href: customerUrl(`/account/orders`) },
    }, data);
  }
  if (template === 'PLAN_EXHAUSTED') {
    return render({
      subject: `Your Visa Compass data plan has been fully used (order ${data.orderNumber})`,
      paragraphs: [
        `The data allowance included with order ${data.orderNumber} has now been fully used.`,
        'To stay connected during your trip, simply add a top-up plan to your eSIM. Your eSIM remains active and can be reused straight away.',
      ],
      cta: { label: 'Add more data', href: customerUrl('/account/esims') },
    }, data);
  }
  if (template === 'PLAN_EXPIRED') {
    return render({
      subject: `Your Visa Compass data plan has expired (order ${data.orderNumber})`,
      paragraphs: [
        `The plan associated with order ${data.orderNumber} has expired.${data.reason ? ` ${data.reason}` : ''}`,
        'Your eSIM itself remains valid and reusable. Add a new plan whenever you are ready to get connected again.',
      ],
      cta: { label: 'Browse plans', href: customerUrl('/account/esims') },
    }, data);
  }
  return render({
    subject: `Update on your Visa Compass order ${data.orderNumber}`,
    paragraphs: [
      `There is an update to your eSIM order ${data.orderNumber}.`,
      'You can review the current status and the complete timeline by signing in to your Visa Compass account.',
    ],
    cta: { label: 'View your order', href: customerUrl('/account/orders') },
  }, data);
}
