# 03 — Configuration and Environment

This document lists every environment variable actually read by the code.
It is based on `apps/api/src/**` and `.env.example`. Values marked with a
comment in `.env.example` are described there; behavior below is confirmed by
the reading code.

## Runtime

| Variable           | Default in code         | Used by                                                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`         | —                       | Disables simulator (`payments.service.ts:23`), requires Clerk webhook secret in production (`webhooks.controller.ts:22`), refuses Transatel webhook without signature (`webhooks.controller.ts:55`), requires encryption key (`crypto.service.ts:8`), skips dev inventory seeding (`inventory.service.ts:14`) |
| `PORT`             | `4000`                  | `main.ts:25`                                                                                                                                                                                                                                                                                                  |
| `API_PUBLIC_URL`   | `http://localhost:4000` | Public API base used for callback/return URLs                                                                                                                                                                                                                                                                 |
| `CUSTOMER_WEB_URL` | `http://localhost:3000` | CORS (`main.ts:17`), payment return URL (`payments.service.ts:11`), Clerk authorized party (`auth.guard.ts:71`), landing portal (`auth.controller.ts:27`)                                                                                                                                                     |
| `OPS_WEB_URL`      | `http://localhost:3001` | CORS (`main.ts:17`), Clerk authorized party (`auth.guard.ts:71`), invitation redirect (`admin.service.ts:400`), landing portal (`auth.controller.ts:28`)                                                                                                                                                      |

## Persistence & crypto

| Variable                    | Default                             | Used by                                                                                   |
| --------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | —                                   | Prisma datasource (`schema.prisma`); enables persistence when set (`prisma.service.ts:7`) |
| `PERSISTENCE_MODE`          | —                                   | Must equal `prisma` for persistence (`prisma.service.ts:7`)                               |
| `APP_ENCRYPTION_KEY_BASE64` | 32 bytes of `0x07` (non-production) | AES-256-GCM key (`crypto.service.ts:6-10`)                                                |
| `PII_HASH_KEY`              | `development-only`                  | Passport blind index HMAC (`crypto.service.ts:23-25`)                                     |

## Clerk

| Variable                      | Used by                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERK_SECRET_KEY`            | Token verification (`auth.guard.ts:63,75`), invitations (`admin.service.ts:392-396`), JIT user sync (`clerk-sync.service.ts:145-150`) |
| `CLERK_WEBHOOK_SECRET`        | Svix verification of `/webhooks/clerk` (`webhooks.controller.ts:21-29`)                                                               |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | Promotes a matching existing customer to Super Admin when none exists (`clerk-sync.service.ts:71-85, 173-242`)                        |
| `ENFORCE_SUPER_ADMIN_MFA`     | `false` disables Super Admin MFA gate (default enabled) (`auth.guard.ts:33-34`)                                                       |

## Queues

| Variable                          | Default | Used by                                                                                         |
| --------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `REDIS_URL`                       | —       | Enables BullMQ (`queue.service.ts:14`)                                                          |
| `QUEUE_CONCURRENCY`               | `3`     | Worker concurrency (`queue.service.ts:29`)                                                      |
| `RECONCILIATION_INTERVAL_MINUTES` | `15`    | Reconciliation sweep interval and staleness threshold (`reconciliation.service.ts:32-33,55-56`) |

## Guest checkout

| Variable             | Default                       | Used by                                                      |
| -------------------- | ----------------------------- | ------------------------------------------------------------ |
| `GUEST_ORDER_SECRET` | `local-guest-checkout-secret` | HMAC token for guest orders (`guest-orders.controller.ts:7`) |

## API hardening

| Variable                     | Default | Used by                                               |
| ---------------------------- | ------- | ----------------------------------------------------- |
| `RATE_LIMIT_PER_MINUTE`      | `300`   | General per-IP+route limit (`rate-limit.guard.ts:18`) |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `60`    | Auth/public route limit (`rate-limit.guard.ts:19,33`) |

## Payments

| Variable                    | Default                                               | Used by                                                                                                                     |
| --------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_MODE`              | —                                                     | `sandbox` or `production` selects real gateways (`payments.service.ts:25`)                                                  |
| `PAYMENT_SIMULATOR_SECRET`  | `local-development-only-change-me`                    | Simulator HMAC signing/verification (`simulator.gateway.ts:13`, `webhooks.controller.ts:72`)                                |
| `KHALTI_BASE_URL`           | `https://dev.khalti.com/api/v2` (from `.env.example`) | Khalti API root (`khalti.gateway.ts:22-25`)                                                                                 |
| `KHALTI_SECRET_KEY`         | —                                                     | Khalti auth; its presence reports gateway UP (`khalti.gateway.ts:27-30`, `orders.controller.ts:30`, `admin.service.ts:209`) |
| `KHALTI_REQUEST_TIMEOUT_MS` | `15000`                                               | Khalti request timeout (`khalti.gateway.ts:31-34`)                                                                          |

## Connectivity (Transatel)

| Variable                            | Default                                                                                | Used by                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `TRANSATEL_BASE_URL`                | —                                                                                      | API root; per-domain URLs derived (`transatel.provider.ts:145-149`)                       |
| `TRANSATEL_CLIENT_ID`               | —                                                                                      | OAuth client credentials (`transatel.provider.ts:157-171`)                                |
| `TRANSATEL_CLIENT_SECRET`           | —                                                                                      | OAuth client credentials (`transatel.provider.ts:157-171`)                                |
| `TRANSATEL_MVNO_REF`                | —                                                                                      | OCS order MVNO reference (`transatel.provider.ts:288-289,306`)                            |
| `TRANSATEL_COS`                     | `WW_COS_UBG_MKP_EUR`                                                                   | Catalog COS (`transatel.provider.ts:379,462`)                                             |
| `TRANSATEL_PAYMENT_PROVIDER`        | —                                                                                      | OCS order payment (omitted when empty) (`transatel.provider.ts:308`)                      |
| `TRANSATEL_SUBSCRIBER_IDENTIFIER`   | `iccid`                                                                                | `iccid` or `msisdn` for bind/usage lookups (`transatel.provider.ts:250-252`)              |
| `TRANSATEL_FX_TO_NPR`               | —                                                                                      | Catalog currency→NPR conversion (`transatel.provider.ts:630`)                             |
| `TRANSATEL_CATALOG_SYNC_ON_STARTUP` | —                                                                                      | `true` syncs catalog at startup (`connectivity.service.ts:23`)                            |
| `TRANSATEL_WEBHOOK_TARGET_URL`      | —                                                                                      | Registers webhook at startup (`connectivity.service.ts:11-16`)                            |
| `TRANSATEL_WEBHOOK_CONTACT_EMAIL`   | `it-operations@visacompass.local`                                                      | Webhook registration (`transatel.provider.ts:481`)                                        |
| `TRANSATEL_WEBHOOK_SECRET`          | —                                                                                      | Webhook signature verification (`webhooks.controller.ts:76`, `transatel.provider.ts:482`) |
| `TRANSATEL_WEBHOOK_EVENTS`          | OCS lifecycle plus `CONNECTIVITY-MANAGEMENT/SUBSCRIBER/SUSPENDED` and `.../TERMINATED` | Registered product and subscriber lifecycle events                                        |
| `TRANSATEL_REQUEST_TIMEOUT_MS`      | `15000`                                                                                | Outbound request timeout (`transatel.provider.ts:151-154`)                                |

## Private document storage

| Variable                | Used by                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `CLOUDINARY_CLOUD_NAME` | Signed upload + read (`cloudinary-storage.service.ts:17,26-27,49`) |
| `CLOUDINARY_API_KEY`    | Signed upload (`cloudinary-storage.service.ts:17,26-27`)           |
| `CLOUDINARY_API_SECRET` | Signed upload signature (`cloudinary-storage.service.ts:17,26-27`) |

When any of these three is missing, document upload returns
`mode: 'local-simulator'` (`cloudinary-storage.service.ts:17-19`).

### Passport OCR verification (Tesseract)

Server-side passport check before payment (`passport-verification.service.ts`).
Uses Tesseract.js; the `eng` traineddata (~15 MB) is fetched from jsDelivr on
first use and cached unless `TESSERACT_LANG_PATH` points at pre-bundled data.

| Variable               | Used by                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `TESSERACT_LANG`       | Language code (default `eng`) (`passport-verification.service.ts:84`)                    |
| `TESSERACT_LANG_PATH`  | Folder containing pre-downloaded `.traineddata` (`passport-verification.service.ts:135`) |
| `TESSERACT_CACHE_PATH` | Cache dir for downloaded language data (`passport-verification.service.ts:135`)          |

When Cloudinary is not configured the check is skipped (`SKIPPED`) rather than
blocking payment, matching the local-simulator flow.

## Notifications

| Variable                                                                | Used by                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOTIFICATION_MODE`                                                     | `live` enables real delivery; `simulator` never calls Resend or WhatsApp                                                                         |
| `EMAIL_PROVIDER`                                                        | Must be `resend`; the provider-neutral channel is ready for a future SES adapter                                                                 |
| `RESEND_API_KEY`                                                        | Sending-only Resend API key                                                                                                                       |
| `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`               | Verified-domain sender, display name, and optional reply-to address                                                                               |
| `WHATSAPP_API_URL`                                                      | WhatsApp Graph URL, default `https://graph.facebook.com/v21.0` (`whatsapp.channel.ts:7`)                                                         |
| `WHATSAPP_ACCESS_TOKEN`                                                 | WhatsApp auth (`whatsapp.channel.ts:7`)                                                                                                          |
| `WHATSAPP_PHONE_NUMBER_ID`                                              | WhatsApp sender (`whatsapp.channel.ts:7`)                                                                                                        |
| `WHATSAPP_API_URL`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Reports WhatsApp integration HEALTHY when `NOTIFICATION_MODE === 'live'` and all three present (`admin.service.ts:257-269`)                      |

## Partner API

| Variable                | Used by                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `PARTNER_API_KEYS_JSON` | JSON array of `{ id, keyHash }`; keyHash is hex SHA-256 of the API key (`partner-auth.guard.ts:20-26`) |

## Frontend

| Variable                            | Default                        | Used by                                                                                      |
| ----------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`               | `http://localhost:4000/api/v1` | All customer-web and ops-web API calls (e.g. `checkout-client.tsx:24`, `topup-lookup.tsx:5`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | —                              | Clerk frontend (`.env.example`)                                                              |
| `NEXT_PUBLIC_PAYMENT_MODE`          | —                              | `simulator` selects the simulate button in checkout (`checkout-client.tsx:25,372`)           |

## Note on secrets

`.env` and `apps/*/.env.local` are gitignored; never commit real secrets
(`README.md:60`). No secret values appear in any tracked file.
