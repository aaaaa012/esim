# 11 — Notifications

Primary sources: `apps/api/src/modules/notification/notification.service.ts`,
`notification.controller.ts`, `notification.templates.ts`, `gmail.channel.ts`,
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
  the customer to open the attached PDF and enter their mobile number to
  reveal the QR.
- `DOCUMENT_REUPLOAD` — subject "Action required for {order}"; reason appended.
- `PLAN_EXHAUSTED` — "Your data plan is used up - {order}".
- `PLAN_EXPIRED` — "Your data plan has expired - {order}"; reason appended.
- Default (incl. `ORDER_STATUS`) — "Visa Compass order update - {order}".

## Delivery channels

### Gmail

`gmail.channel.ts`:

- `NOTIFICATION_MODE !== 'live'` → simulated `{ providerMessageId:
gmail-sim-{ts}, simulated: true }`.
- Otherwise requires GMAIL client id/secret/refresh token; OAuth refresh via
  Google token endpoint, then `POST gmail/v1/users/me/messages/send` with a
  base64url MIME message (`gmail.channel.ts:14-22`).
- MIME builder supports plain text or multipart with a base64 attachment
  (`gmail.channel.ts:25-48`).
- `GMAIL_FROM_ADDRESS` default `me`.

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
3. EMAIL → `qrAttachment(job)` builds a password-protected PDF when template is
   `QR_READY` (requires `order.qrPayload` and `order.traveler.mobile`), then
   `gmail.send({ to, subject, text, attachment? })`.
4. WHATSAPP → `whatsapp.send({ to, text })`.
5. Marks `SENT` or `SIMULATED` based on the channel result; on error marks
   `FAILED` and rethrows.

## QR PDF

`qr-pdf.service.ts` (`build`):

- Generates a QR PNG from `qrPayload` (`QRCode.toBuffer`, 512px).
- Builds an A4 PDF via `pdfkit` with:
  - Title "Visa Compass eSIM", order number.
  - A prompt to open the PDF on a phone and enter the mobile number.
  - The QR image.
  - Warning: "This QR is sensitive — do not share it."
- **Password-protected**: both user and owner password = the traveler's
  mobile; permissions deny copying/modifying/annotating etc.
  (`qr-pdf.service.ts:10-24`).

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

- Email Gmail: HEALTHY only when `NOTIFICATION_MODE === 'live'` and Gmail creds
  present (`admin.service.ts:183-203`).
- WhatsApp: HEALTHY only when `NOTIFICATION_MODE === 'live'` and
  `WHATSAPP_API_URL`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
  all present (`admin.service.ts:257-269`).
