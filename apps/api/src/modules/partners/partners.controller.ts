import {
  applyDecorators,
  Body,
  Controller,
  Get,
  GoneException,
  Header,
  Headers,
  Ip,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiQuery,
} from "@nestjs/swagger";
import {
  DocumentType,
  OrderStatus,
  PaymentProvider,
  PartnerSettlementMethod,
} from "@prisma/client";
import { documentRequestSchema, travelerSchema } from "@visa-compass/shared";
import { z } from "zod";
import {
  PartnerAuthGuard,
  type PartnerRequest,
  PartnerScopes,
} from "./partner-auth.guard.js";
import { PartnerService } from "./partner.service.js";
import { PartnerApiLoggingInterceptor } from "./partner-api-logging.interceptor.js";

const legacyCreateSchema = z.object({
  quoteId: z.string().uuid(),
  externalOrderId: z.string().trim().min(1).max(120),
  externalCustomerId: z.string().trim().min(1).max(120),
  compatibilityAccepted: z.literal(true),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
});
const uploadDocumentsSchema = z
  .array(
    z.object({
      type: z.enum(DocumentType),
      fileName: z.string().trim().min(1).max(180),
      contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
      sizeBytes: z
        .number()
        .int()
        .min(1)
        .max(10 * 1024 * 1024),
    }),
  )
  .min(2)
  .max(3)
  .refine(
    (documents) =>
      new Set(documents.map((item) => item.type)).size === documents.length,
    "Document types must be unique",
  )
  .refine(
    (documents) =>
      [DocumentType.PASSPORT, DocumentType.TICKET].every((type) =>
        documents.some((document) => document.type === type),
      ),
    "Passport and ticket are required",
  );

export const uploadSessionSchema = z
  .object({
    mode: z.literal("EXTRACT_FIRST"),
    externalOrderId: z.string().trim().min(1).max(120),
    documents: uploadDocumentsSchema,
  })
  .strict();

export const confirmExtractedTravelerSchema = travelerSchema;
export const correctExtractedTravelerSchema = z
  .object({
    traveler: travelerSchema,
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
export const completeCreateSchema = z
  .object({
    externalOrderId: z.string().trim().min(1).max(120),
    externalCustomerId: z.string().trim().min(1).max(120),
    planId: z.string().uuid(),
    purchaseType: z.enum(["INITIAL_PURCHASE", "TOPUP"]).optional(),
    settlement: z
      .discriminatedUnion("method", [
        z.object({ method: z.literal("PARTNER_ACCOUNT") }),
        z.object({
          method: z.literal("HOSTED_PAYMENT"),
          provider: z.enum(PaymentProvider),
          redirectUrl: z.url(),
        }),
      ])
      .optional(),
    documentVerificationId: z.string().uuid().optional(),
    topUpMobile: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .optional()
      .describe("MSISDN assigned to the existing eSIM to top up"),
    consent: z.object({
      compatibilityAccepted: z.literal(true),
      termsAccepted: z.literal(true),
      privacyAccepted: z.literal(true),
      acceptedAt: z.iso.datetime(),
    }),
    metadata: z.record(z.string(), z.string().max(500)).optional(),
  })
  .superRefine((value, context) => {
    const purchaseType =
      value.purchaseType ?? (value.topUpMobile ? "TOPUP" : "INITIAL_PURCHASE");
    if (purchaseType === "TOPUP" && !value.topUpMobile)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topUpMobile"],
        message: "topUpMobile is required for a top-up",
      });
    if (purchaseType === "INITIAL_PURCHASE" && !value.documentVerificationId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentVerificationId"],
        message: "Document verification is required for an initial purchase",
      });
    if (purchaseType === "TOPUP" && value.documentVerificationId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentVerificationId"],
        message: "Document verification must not be supplied for a top-up",
      });
    if (purchaseType === "INITIAL_PURCHASE" && value.topUpMobile)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topUpMobile"],
        message: "topUpMobile must not be supplied for an initial purchase",
      });
  });
const createSchema = z.union([completeCreateSchema, legacyCreateSchema]);
export const hostedCheckoutSessionSchema = z.object({
  planId: z.string().uuid(),
  externalOrderId: z.string().trim().min(1).max(120),
  externalCustomerId: z.string().trim().min(1).max(120),
  topUpMobile: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .optional()
    .describe("MSISDN assigned to the existing eSIM receiving the top-up"),
  allowInitialPurchaseFallback: z
    .literal(true)
    .optional()
    .describe(
      "Explicit customer-approved fallback when the supplied eSIM MSISDN cannot be used for a top-up",
    ),
});
export const listSchema = z.object({
  cursor: z.string().trim().min(1).max(256).optional(),
  status: z.enum(OrderStatus).optional(),
  externalOrderId: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(1000) });
const replacementDocumentSchema = z.object({
  type: z.enum([DocumentType.PASSPORT, DocumentType.TICKET]),
  fileName: z.string().trim().min(1).max(180),
  contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
});
const notificationSchema = z.object({
  channel: z.enum(["EMAIL", "WHATSAPP"]),
  template: z.enum(["ORDER_STATUS", "QR_READY", "DOCUMENT_REUPLOAD"]),
});
export const ledgerSchema = z.object({
  cursor: z.string().trim().min(1).max(256).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  externalOrderId: z.string().max(120).optional(),
  orderNumber: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
  type: z
    .enum([
      "CREDIT",
      "DEBIT",
      "RESERVATION",
      "CAPTURE",
      "RELEASE",
      "REFUND",
      "ADJUSTMENT",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const PartnerMutation = () =>
  applyDecorators(
    ApiHeader({
      name: "Idempotency-Key",
      required: true,
      description: "Unique key for this mutation (8-200 characters)",
      example: "request-8f6d2462",
    }),
  );

const LegacyPartnerRoute = () =>
  applyDecorators(
    ApiOperation({ deprecated: true }),
    Header("Deprecation", "true"),
    Header("Link", '</api/partner-docs>; rel="successor-version"'),
  );

@Controller("partners")
@UseGuards(PartnerAuthGuard)
@UseInterceptors(PartnerApiLoggingInterceptor)
@ApiBearerAuth("partner-key")
export class PartnersController {
  constructor(private readonly partners: PartnerService) {}

  @Get("capabilities")
  @PartnerScopes("catalog:read")
  capabilities(@Req() request: PartnerRequest) {
    return this.partners.capabilities(request.partner!.id);
  }

  @Get("plans")
  @PartnerScopes("catalog:read")
  @ApiQuery({ name: "country", required: false, example: "JP" })
  plans(@Req() request: PartnerRequest, @Query("country") country?: string) {
    return this.partners.plans(request.partner!.id, country);
  }

  @Post("quotes")
  @PartnerScopes("catalog:read")
  @PartnerMutation()
  @LegacyPartnerRoute()
  @ApiBody({
    schema: {
      type: "object",
      required: ["planId", "settlementMethod"],
      properties: {
        planId: { type: "string", format: "uuid" },
        settlementMethod: {
          type: "string",
          enum: Object.values(PartnerSettlementMethod),
        },
      },
      example: {
        planId: "10000000-0000-4000-8000-000000000001",
        settlementMethod: "PARTNER_ACCOUNT",
      },
    },
  })
  quote() {
    throw new GoneException({
      code: "QUOTES_DEPRECATED",
      message:
        "Quotes are no longer available. Place a complete order instead (POST /partners/orders).",
    });
  }

  @Post("document-upload-sessions")
  @PartnerScopes("documents:write")
  @PartnerMutation()
  @ApiBody({
    schema: {
      type: "object",
      required: ["mode", "externalOrderId", "documents"],
      properties: {
        mode: {
          type: "string",
          enum: ["EXTRACT_FIRST"],
          description: "Passport extraction must precede traveller confirmation.",
        },
        externalOrderId: { type: "string", example: "agency-order-1042" },
        documents: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          items: {
            type: "object",
            required: ["type", "fileName", "contentType", "sizeBytes"],
            properties: {
              type: { type: "string", enum: Object.values(DocumentType) },
              fileName: { type: "string", example: "passport.pdf" },
              contentType: {
                type: "string",
                enum: ["application/pdf", "image/jpeg", "image/png"],
              },
              sizeBytes: { type: "integer", maximum: 10485760 },
            },
          },
        },
      },
    },
  })
  uploadSessions(@Body() body: unknown, @Req() request: PartnerRequest) {
    return this.partners.createUploadSessions(
      request.partner!.id,
      uploadSessionSchema.parse(body),
    );
  }

  @Get("document-verifications/:verificationId")
  @PartnerScopes("documents:write")
  documentVerification(
    @Param("verificationId") verificationId: string,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.documentVerification(
      request.partner!.id,
      verificationId,
    );
  }

  @Post("document-verifications/:verificationId/documents/:documentId/confirm")
  @PartnerScopes("documents:write")
  @PartnerMutation()
  confirmVerificationDocument(
    @Param("verificationId") verificationId: string,
    @Param("documentId") documentId: string,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.confirmVerificationDocument(
      request.partner!.id,
      verificationId,
      documentId,
    );
  }

  @Post("document-verifications/:verificationId/traveler")
  @PartnerScopes("documents:write")
  @PartnerMutation()
  @ApiOperation({
    summary: "Confirm the traveler after passport extraction",
    description:
      "Required for EXTRACT_FIRST sessions after all documents have been uploaded and passport extraction has completed.",
  })
  confirmExtractedTraveler(
    @Param("verificationId") verificationId: string,
    @Body() body: unknown,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.confirmExtractedTraveler(
      request.partner!.id,
      verificationId,
      confirmExtractedTravelerSchema.parse(body),
    );
  }

  @Post("document-verifications/:verificationId/traveler-corrections")
  @PartnerScopes("documents:write")
  @PartnerMutation()
  @ApiOperation({ summary: "Submit an audited traveller-data correction" })
  correctExtractedTraveler(
    @Param("verificationId") verificationId: string,
    @Headers() headers: Record<string, string | undefined>,
    @Body() body: unknown,
    @Req() request: PartnerRequest,
  ) {
    const input = correctExtractedTravelerSchema.parse(body);
    return this.partners.correctExtractedTraveler(
      request.partner!.id,
      verificationId,
      input,
      headers["idempotency-key"] ?? headers["x-idempotency-key"] ?? "",
    );
  }

  @Post("orders")
  @PartnerScopes("orders:write")
  @PartnerMutation()
  @ApiBody({
    schema: {
      oneOf: [
        {
          type: "object",
          title: "Complete order (recommended)",
          required: [
            "externalOrderId",
            "externalCustomerId",
            "planId",
            "consent",
          ],
          properties: {
            externalOrderId: { type: "string", example: "agency-order-1042" },
            externalCustomerId: { type: "string", example: "customer-91" },
            planId: { type: "string", format: "uuid" },
            purchaseType: {
              type: "string",
              enum: ["INITIAL_PURCHASE", "TOPUP"],
              description:
                "Defaults to TOPUP when topUpMobile is supplied; otherwise INITIAL_PURCHASE",
            },
            settlement: { type: "object" },
            documentVerificationId: {
              type: "string",
              format: "uuid",
              description:
                "Required only for INITIAL_PURCHASE and forbidden for TOPUP",
            },
            topUpMobile: {
              type: "string",
              description:
                "Required only for TOPUP and forbidden for INITIAL_PURCHASE",
              example: "+9779800000000",
            },
            consent: { type: "object" },
            metadata: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
        },
        {
          type: "object",
          title: "Legacy quote order (deprecated)",
          required: [
            "quoteId",
            "externalOrderId",
            "externalCustomerId",
            "compatibilityAccepted",
          ],
          properties: {
            quoteId: { type: "string", format: "uuid" },
            externalOrderId: { type: "string" },
            externalCustomerId: { type: "string" },
            compatibilityAccepted: { type: "boolean", enum: [true] },
          },
        },
      ],
    },
  })
  create(
    @Body() body: unknown,
    @Req() request: PartnerRequest,
    @Ip() ipAddress: string,
    @Headers("user-agent") userAgent?: string,
  ) {
    const input = createSchema.parse(body);
    if ("quoteId" in input)
      return this.partners.createOrder(request.partner!.id, input);
    const { settlement, ...rest } = input;
    return this.partners.createCompleteOrder(
      request.partner!.id,
      { ...rest, ...(settlement ? { settlement } : {}) },
      {
        ipAddress,
        userAgent: userAgent ?? "unknown",
      },
    );
  }

  @Get("account")
  @PartnerScopes("orders:read")
  account(@Req() request: PartnerRequest) {
    return this.partners.account(request.partner!.id);
  }

  @Get("ledger")
  @PartnerScopes("orders:read")
  ledger(@Query() query: unknown, @Req() request: PartnerRequest) {
    return this.partners.ledger(request.partner!.id, ledgerSchema.parse(query));
  }

  @Post("hosted-checkout-sessions")
  @PartnerScopes("checkout:write")
  @PartnerMutation()
  @ApiOperation({
    summary: "Create a hosted (no-code) checkout session",
    description:
      "For partners that cannot integrate the full REST API. Creates a DRAFT order",
  })
  hostedCheckoutSession(@Body() body: unknown, @Req() request: PartnerRequest) {
    return this.partners.createHostedCheckoutSession(
      request.partner!.id,
      hostedCheckoutSessionSchema.parse(body),
    );
  }

  @Get("orders")
  @PartnerScopes("orders:read")
  list(@Query() query: unknown, @Req() request: PartnerRequest) {
    return this.partners.listOrders(
      request.partner!.id,
      listSchema.parse(query),
    );
  }

  @Get("orders/by-external-id/:externalOrderId")
  @PartnerScopes("orders:read")
  byExternalId(
    @Param("externalOrderId") externalOrderId: string,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.orderByExternalId(
      request.partner!.id,
      externalOrderId,
    );
  }

  @Get("orders/:id")
  @PartnerScopes("orders:read")
  status(@Param("id") id: string, @Req() request: PartnerRequest) {
    return this.partners.order(request.partner!.id, id);
  }

  @Post("orders/:id/finalize")
  @PartnerScopes("orders:write")
  @PartnerMutation()
  @ApiOperation({
    summary: "Debit and provision a document-verified pending order",
  })
  finalize(@Param("id") id: string, @Req() request: PartnerRequest) {
    return this.partners.finalizeOrder(request.partner!.id, id);
  }

  @Post("orders/:id/document-replacements")
  @PartnerScopes("documents:write")
  @PartnerMutation()
  declareReplacement(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.declareDocumentReplacement(
      request.partner!.id,
      id,
      replacementDocumentSchema.parse(body),
    );
  }

  @Post("orders/:id/document-replacements/:documentId/confirm")
  @PartnerScopes("documents:write")
  @PartnerMutation()
  confirmReplacement(
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.confirmDocumentReplacement(
      request.partner!.id,
      id,
      documentId,
    );
  }

  @Get("orders/:id/esim")
  @PartnerScopes("esims:read")
  activationDetails(@Param("id") id: string, @Req() request: PartnerRequest) {
    return this.partners.activationDetails(request.partner!.id, id);
  }

  @Post("orders/:id/traveler")
  @PartnerScopes("orders:write")
  @PartnerMutation()
  @LegacyPartnerRoute()
  traveler(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.setTraveler(
      request.partner!.id,
      id,
      travelerSchema.parse(body),
    );
  }

  @Post("orders/:id/documents")
  @PartnerScopes("documents:write")
  @PartnerMutation()
  @LegacyPartnerRoute()
  document(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: PartnerRequest,
  ) {
    const input = documentRequestSchema.parse(body);
    return this.partners.addDocument(request.partner!.id, id, {
      type: input.type as DocumentType,
      fileName: input.fileName,
      contentType: input.contentType,
    });
  }

  @Post("orders/:id/documents/:documentId/confirm")
  @PartnerScopes("documents:write")
  @PartnerMutation()
  @LegacyPartnerRoute()
  confirmDocument(
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.confirmDocument(request.partner!.id, id, documentId);
  }

  @Post("orders/:id/hosted-checkout-session")
  @PartnerScopes("catalog:read")
  @PartnerMutation()
  @LegacyPartnerRoute()
  hosted() {
    throw new GoneException({
      code: "HOSTED_PAYMENT_DEPRECATED",
      message:
        'Hosted payments are no longer available. Include settlement.method = "PARTNER_ACCOUNT" when creating an order.',
    });
  }

  @Post("orders/:id/payment-session")
  @PartnerScopes("catalog:read")
  @PartnerMutation()
  @LegacyPartnerRoute()
  payment() {
    throw new GoneException({
      code: "HOSTED_PAYMENT_DEPRECATED",
      message:
        'Hosted payments are no longer available. Include settlement.method = "PARTNER_ACCOUNT" when creating an order.',
    });
  }

  @Post("orders/:id/cancel")
  @PartnerScopes("orders:write")
  @PartnerMutation()
  cancel(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.cancel(
      request.partner!.id,
      id,
      reasonSchema.parse(body).reason,
    );
  }

  @Post("orders/:id/refund-requests")
  @PartnerScopes("refunds:write")
  @PartnerMutation()
  refund(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.requestRefund(
      request.partner!.id,
      id,
      reasonSchema.parse(body).reason,
    );
  }

  @Get("orders/:id/usage")
  @PartnerScopes("usage:read")
  usage(@Param("id") id: string, @Req() request: PartnerRequest) {
    return this.partners.usage(request.partner!.id, id);
  }

  @Get("esims/:id/usage")
  @PartnerScopes("usage:read")
  esimUsage(@Param("id") id: string, @Req() request: PartnerRequest) {
    return this.partners.usageByEsim(request.partner!.id, id);
  }

  @Get("customers/:externalCustomerId/usage")
  @PartnerScopes("usage:read")
  customerUsage(
    @Param("externalCustomerId") externalCustomerId: string,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.customerUsage(request.partner!.id, externalCustomerId);
  }

  @Post("orders/:id/usage/refresh")
  @PartnerScopes("usage:read")
  @PartnerMutation()
  refreshOrderUsage(@Param("id") id: string, @Req() request: PartnerRequest) {
    return this.partners.refreshOrderUsage(request.partner!.id, id);
  }

  @Post("esims/:id/usage/refresh")
  @PartnerScopes("usage:read")
  @PartnerMutation()
  refreshEsimUsage(@Param("id") id: string, @Req() request: PartnerRequest) {
    return this.partners.refreshEsimUsage(request.partner!.id, id);
  }

  @Get("orders/:id/events")
  @PartnerScopes("orders:read")
  events(@Param("id") id: string, @Req() request: PartnerRequest) {
    return this.partners.events(request.partner!.id, id);
  }

  @Post("orders/:id/notifications")
  @PartnerScopes("orders:write")
  @PartnerMutation()
  notify(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: PartnerRequest,
  ) {
    return this.partners.notify(
      request.partner!.id,
      id,
      notificationSchema.parse(body),
    );
  }
}
