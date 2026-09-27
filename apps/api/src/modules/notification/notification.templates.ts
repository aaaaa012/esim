export type NotificationTemplate =
  | "ORDER_STATUS"
  | "QR_READY"
  | "DOCUMENT_REUPLOAD"
  | "DOCUMENT_APPROVED"
  | "RECHARGE_RECOVERY"
  | "GUEST_ORDER_RECOVERY"
  | "TOPUP_LOOKUP"
  | "PLAN_EXHAUSTED"
  | "PLAN_EXPIRED"
  | "OPS_ALERT";

type TemplateData = {
  orderNumber: string;
  reason?: string;
  msisdn?: string;
  recoveryUrl?: string;
};

type NotificationContent = {
  subject: string;
  text: string;
  html: string;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function webUrl(kind: "customer" | "ops", path: string) {
  const base =
    kind === "customer"
      ? (process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000")
      : (process.env.OPS_WEB_URL ?? "http://localhost:3001");
  return `${base.replace(/\/$/, "")}${path}`;
}

function branded(input: {
  subject: string;
  paragraphs: string[];
  cta?: { label: string; href: string };
  steps?: string[];
  internal?: boolean;
}): NotificationContent {
  const support = process.env.SUPPORT_EMAIL ?? process.env.EMAIL_REPLY_TO;
  const text = [
    ...(input.internal ? [] : ["Dear Customer,"]),
    ...input.paragraphs,
    ...(input.steps?.length
      ? [input.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")]
      : []),
    ...(input.cta ? [`${input.cta.label}: ${input.cta.href}`] : []),
    ...(input.internal
      ? []
      : [
          "Warm regards,\nThe Visa Compass Team",
          ...(support ? [`Support: ${support}`] : []),
        ]),
  ].join("\n\n");
  const paragraphs = input.paragraphs
    .map((value) => `<p style="margin:0 0 14px">${escapeHtml(value)}</p>`)
    .join("");
  const steps = input.steps?.length
    ? `<ol style="margin:0 0 18px;padding-left:22px">${input.steps.map((step) => `<li style="margin:0 0 7px">${escapeHtml(step)}</li>`).join("")}</ol>`
    : "";
  const cta = input.cta
    ? `<p style="margin:22px 0"><a href="${escapeHtml(input.cta.href)}" style="display:inline-block;background:#132a4a;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:7px">${escapeHtml(input.cta.label)}</a></p>`
    : "";
  const greeting = input.internal
    ? ""
    : '<p style="margin:0 0 14px">Dear Customer,</p>';
  const signature = input.internal
    ? ""
    : '<p style="margin:22px 0 0">Warm regards,<br><strong>The Visa Compass Team</strong></p>';
  const supportHtml = support
    ? `<p style="margin:6px 0 0">Support: ${escapeHtml(support)}</p>`
    : "";
  return {
    subject: input.subject,
    text,
    html: `<div style="margin:0;padding:24px 12px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2937"><div style="max-width:580px;margin:0 auto;background:#fff;border:1px solid #e3e7ec;border-radius:9px;overflow:hidden"><div style="background:#132a4a;padding:19px 28px;color:#fff;font-size:19px;font-weight:700">Visa Compass</div><div style="padding:28px;font-size:15px;line-height:1.65">${greeting}${paragraphs}${steps}${cta}${signature}</div><div style="padding:15px 28px;background:#f8fafc;border-top:1px solid #e3e7ec;color:#6b7280;font-size:12px">This is an automated Visa Compass notification.${supportHtml}</div></div></div>`,
  };
}

export function renderNotification(
  template: NotificationTemplate,
  data: TemplateData,
) {
  if (template === "TOPUP_LOOKUP")
    return branded({
      subject: "Confirm your eSIM recharge",
      paragraphs: [
        "A request was made to view recharge plans for your Visa Compass eSIM.",
        "Use the secure link below to continue. The link expires in 15 minutes and should not be shared.",
        "If you did not make this request, you can ignore this email.",
      ],
      ...(data.recoveryUrl
        ? {
            cta: {
              label: "View recharge plans",
              href: data.recoveryUrl,
            },
          }
        : {}),
    });
  if (template === "RECHARGE_RECOVERY")
    return branded({
      subject: `Track your recharge - ${data.orderNumber}`,
      paragraphs: [
        `Your recharge order ${data.orderNumber} has been created. Use this private link to resume payment or track payment and recharge progress.`,
        "This is not a payment confirmation. The link works for 30 days and gives access only to this recharge transaction.",
        "Keep this link private. Your existing eSIM does not need to be installed again.",
      ],
      ...(data.recoveryUrl
        ? { cta: { label: "Track recharge", href: data.recoveryUrl } }
        : {}),
    });
  if (template === "GUEST_ORDER_RECOVERY")
    return branded({
      subject: `Keep access to ${data.orderNumber}`,
      paragraphs: [
        `Use this private link to resume checkout or check verification progress for ${data.orderNumber}.`,
        "The link expires in 30 days. Anyone with the link can access this guest order, so keep it private.",
      ],
      ...(data.recoveryUrl
        ? {
            cta: {
              label: "Resume or check order",
              href: data.recoveryUrl,
            },
          }
        : {}),
    });
  if (template === "OPS_ALERT")
    return branded({
      subject: `[Ops Alert] ${data.reason ?? "Action required"}`,
      paragraphs: [
        `Operational alert for order ${data.orderNumber}.`,
        data.reason ?? "Review required.",
      ],
      cta: {
        label: "Open operations console",
        href: webUrl("ops", "/attention"),
      },
      internal: true,
    });
  if (template === "QR_READY")
    return branded({
      subject: `Your Visa Compass eSIM is ready - ${data.orderNumber}`,
      paragraphs: [
        `Your eSIM for order ${data.orderNumber} is ready to install. The activation QR is attached as an image.`,
        ...(data.msisdn ? [`Your eSIM mobile number is ${data.msisdn}.`] : []),
        "Keep the QR private. Anyone with access to it may be able to install your eSIM.",
      ],
      steps: [
        "Open your device's Mobile Data or Cellular settings.",
        "Choose Add eSIM or Add Cellular Plan.",
        "Scan the attached QR image and follow the device instructions.",
        "Enable data roaming after arriving at your destination.",
      ],
    });
  if (template === "DOCUMENT_REUPLOAD")
    return branded({
      subject: `Action required for ${data.orderNumber}`,
      paragraphs: [
        `A replacement travel document is required for ${data.orderNumber}.${data.reason ? ` Reason: ${data.reason}` : ""}`,
        "Please sign in and upload a clearer, complete document. Document review does not reverse an eSIM that is already being provisioned.",
      ],
      cta: {
        label: "Upload document",
        href: webUrl("customer", "/account/orders"),
      },
    });
  if (template === "DOCUMENT_APPROVED")
    return branded({
      subject: `Documents approved for ${data.orderNumber}`,
      paragraphs: [
        `Your travel documents for ${data.orderNumber} have been approved.`,
        "Return to the checkout you previously opened to continue securely to payment. Do not start a duplicate order.",
      ],
    });
  if (template === "PLAN_EXHAUSTED")
    return branded({
      subject: `Your data plan is used up - ${data.orderNumber}`,
      paragraphs: [
        `The data allowance for order ${data.orderNumber} has been fully consumed.`,
        "Your eSIM can be reused. Add a top-up to stay connected.",
      ],
      cta: {
        label: "Add more data",
        href: webUrl("customer", "/account/esims"),
      },
    });
  if (template === "PLAN_EXPIRED")
    return branded({
      subject: `Your data plan has expired - ${data.orderNumber}`,
      paragraphs: [
        `The plan for order ${data.orderNumber} has expired.${data.reason ? ` Reason: ${data.reason}` : ""}`,
        "Your eSIM remains reusable. Add a new plan whenever you need it.",
      ],
      cta: {
        label: "Browse plans",
        href: webUrl("customer", "/account/esims"),
      },
    });
  return branded({
    subject: `Visa Compass order update - ${data.orderNumber}`,
    paragraphs: [`There is an update for order ${data.orderNumber}.`],
    cta: {
      label: "View your order",
      href: webUrl("customer", "/account/orders"),
    },
  });
}
