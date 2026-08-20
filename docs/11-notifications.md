# 11 — Notifications

Primary sources: `apps/api/src/modules/notification/notification.service.ts`,
`notification.controller.ts`, `notification.templates.ts`, `email.channel.ts`,
`resend-email.channel.ts`,
`whatsapp.channel.ts`, `qr-pdf.service.ts`, and the delivery worker in
`apps/api/src/jobs/integration.processor.ts`.

## Templates

`notification.templates.ts`:

```ts
type NotificationTemplate =
  | "ORDER_STATUS"
  | "QR_READY"
  | "DOCUMENT_REUPLOAD"
  | "PLAN_EXHAUSTED"
  | "PLAN_EXPIRED";
```

`renderNotification(template, { orderNumber, reason? })` returns
`{ subject, text }` (`notification.templates.ts:2-7`):

- `QR_READY` — subject "Your Visa Compass eSIM is ready - {order}"; text tells
  the customer that the unencrypted QR image is attached and must be kept
  private.
- `DOCUMENT_REUPLOAD` — subject "Action required for {order}"; reason appended.
- `PLAN_EXHAUSTED` — "Your data plan is used up - {order}".
- `PLAN_EXPIRED` — "Your data plan has expired - {order}"; reason appended.
- Default (incl. `ORDER_STATUS`) — "Visa Compass order update - {order}".

## Delivery channels

### Email (Resend)

`email.channel.ts` defines the provider-neutral contract and
`resend-email.channel.ts` implements it:

- `NOTIFICATION_MODE !== 'live'` → simulated `{ providerMessageId:
resend-sim-{ts}, simulated: true }` without contacting Resend.
- Live delivery requires `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and a
  verified-domain `EMAIL_FROM_ADDRESS`; `EMAIL_FROM_NAME` and `EMAIL_REPLY_TO`
  control presentation and replies.
- The official Resend SDK sends plain text and optional base64 QR PNG
  attachments. Notification IDs are Resend idempotency keys for safe retries.
- Provider errors are sanitized; BullMQ retry exhaustion continues to create
  an Operations attention case. AWS SES can later implement the same contract.

### WhatsApp

`whatsapp.channel.ts`:

- `NOTIFICATION_MODE !== 'live'` → simulated.
- Requires `WHATSAPP_API_URL`, `WHATSAPP_ACCESS_TOKEN`,
  `WHATSAPP_PHONE_NUMBER_ID`; `POST {url}/{phoneId}/messages` with
  `messaging_product: 'whatsapp', to, type: 'text', text: { body }`.

## Service

`notification.service.ts`:

- Channels: `EMAIL | WHATSAPP`.
- `enqueue(input)` (`notification.service.ts:14`):
  - Persists a `Notification` row (status QUEUED) when Prisma is enabled,
    otherwise keeps an in-memory record.
  - Adds `notifications:deliver-notification` job.
  - If queues are disabled, marks SENT immediately.
  - Returns `{ id, status: 'QUEUED'|'SENT' }`.
- `mark(id, status)` — updates DB or memory (`notification.service.ts:15`).
- `list(orderIds?)` — last 200, filtered by order ids when provided
  (`notification.service.ts:16`).
- `get(id)` — single notification or 404 (`notification.service.ts:17`).
- `retry(id, recipient, orderNumber)` — re-queues a delivery
  (`notification.service.ts:18`).

## Delivery worker

`IntegrationProcessor.notification` (`integration.processor.ts:23-24`):

1. Marks notification `SENDING`.
2. Renders the template.
3. EMAIL → `qrAttachment(job)` builds an unencrypted PNG when template is
   `QR_READY` (requires `order.qrPayload`), then calls the injectable
   `EmailChannel` with the notification ID as its idempotency key.
4. WHATSAPP → `whatsapp.send({ to, text })`.
5. Marks `SENT` or `SIMULATED` based on the channel result; on error marks
   `FAILED` and rethrows.

## QR attachment and account download

`qr-pdf.service.ts` (`build`):

- Generates a QR PNG from `qrPayload` (`QRCode.toBuffer`, 512px).
- Builds an A4 PDF via `pdfkit` with:
  - Title "Visa Compass eSIM", order number.
  - Instructions to scan the QR from another screen.
  - The QR image.
  - Warning: "This QR is sensitive — do not share it."
- The authenticated account download is intentionally unencrypted and does not
  require the MSISDN or any other password.

## Emitters

Where notifications are triggered:

- `QR_READY` after provisioning success (`orders.service.ts:215`) and after an
  ACTIVATED provider event (`orders.service.ts:246`).
- `DOCUMENT_REUPLOAD` — `safeNotify(order, 'DOCUMENT_REUPLOAD', reason)` is
  defined but its invocation is in `requestReupload`/`reviewDocument`
  (`orders.service.ts:212-213` use the transition path; `safeNotify` is called
  at `orders.service.ts:261` with the re-upload reason — see gaps doc for the
  exact trigger points confirmed).
- `PLAN_EXPIRED` / `PLAN_EXHAUSTED` from
  `ReconciliationService.notifyLifecycle` (`reconciliation.service.ts:97-104`).

## Controller

`notification.controller.ts:8-17`, guarded by `AuthGuard`:

- `GET /customer/orders/:id/notifications` — owner only.
- `GET /customer/notifications` — owner's orders' notifications.
- `GET /operations/notifications` — OPERATIONS/SUPER_ADMIN.
- `POST /operations/notifications/test` — SUPER_ADMIN; requires orderId.
- `POST /operations/notifications/:id/retry` — OPERATIONS/SUPER_ADMIN.

## Admin integration status

`AdminService.integrations` reports:

- Email Resend: HEALTHY only when `NOTIFICATION_MODE === 'live'`,
  `EMAIL_PROVIDER=resend`, and the API key and sender are present.
- WhatsApp: HEALTHY only when `NOTIFICATION_MODE === 'live'` and
  `WHATSAPP_API_URL`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
  all present (`admin.service.ts:257-269`).
