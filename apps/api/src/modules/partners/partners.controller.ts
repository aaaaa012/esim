import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Ip,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
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

const quoteSchema = z.object({
  planId: z.string().uuid(),
  settlementMethod: z.enum(PartnerSettlementMethod),
});
const legacyCreateSchema = z.object({
  quoteId: z.string().uuid(),
  externalOrderId: z.string().trim().min(1).max(120),
  externalCustomerId: z.string().trim().min(1).max(120),
  compatibilityAccepted: z.literal(true),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
});
export const uploadSessionSchema = z.object({
  externalOrderId: z.string().trim().min(1).max(120),
  documents: z
    .array(
      z.object({
        type: z.enum(DocumentType),
        fileName: z.string().trim().min(1).max(180),
        contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
        sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024),
      }),
    )
    .min(1)
    .max(3)
    .refine(
      (documents) => new Set(documents.map((item) => item.type)).size === documents.length,
      "Document types must be unique",
    ),
});
export const completeCreateSchema = z.object({
  externalOrderId: z.string().trim().min(1).max(120),
  externalCustomerId: z.string().trim().min(1).max(120),
  planId: z.string().uuid(),
  settlement: z.discriminatedUnion("method", [
    z.object({ method: z.literal("PARTNER_ACCOUNT") }),
    z.object({
      method: z.literal("HOSTED_PAYMENT"),
      provider: z.enum(PaymentProvider),
      redirectUrl: z.url(),
    }),
  ]).optional(),
  traveler: travelerSchema,
  documents: z
    .array(z.object({ type: z.enum(DocumentType), uploadId: z.string().uuid() }))
    .min(2)
    .max(3)
    .refine(
      (documents) => new Set(documents.map((item) => item.type)).size === documents.length,
      "Document types must be unique",
    ),
  consent: z.object({
    compatibilityAccepted: z.literal(true),
    termsAccepted: z.literal(true),
    privacyAccepted: z.literal(true),
    acceptedAt: z.iso.datetime(),
  }),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
});
const createSchema = z.union([completeCreateSchema, legacyCreateSchema]);
const listSchema = z.object({
  cursor: z.string().uuid().optional(),
  status: z.enum(OrderStatus).optional(),
  externalOrderId: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const hostedSchema = z.object({ redirectUrl: z.url() });
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(1000) });
const notificationSchema = z.object({
  channel: z.enum(["EMAIL", "WHATSAPP"]),
  template: z.enum(["ORDER_STATUS", "QR_READY", "DOCUMENT_REUPLOAD"]),
});
const ledgerSchema = z.object({
  cursor: z.string().uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  externalOrderId: z.string().max(120).optional(),
  orderNumber: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
  type: z.enum(["CREDIT", "DEBIT", "REFUND", "ADJUSTMENT"]).optional(),
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
  @PartnerScopes("quotes:write")
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
  quote(@Body() body: unknown, @Req() request: PartnerRequest) {
    const input = quoteSchema.parse(body);
    return this.partners.createQuote(
      request.partner!.id,
      input.planId,
      input.settlementMethod,
    );
  }

  @Post("document-upload-sessions")
  @PartnerScopes("documents:write")
  @PartnerMutation()
  @ApiBody({
    schema: {
      type: "object",
      required: ["externalOrderId", "documents"],
      properties: {
        externalOrderId: { type: "string", example: "agency-order-1042" },
        documents: {
          type: "array",
          minItems: 1,
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
            "traveler",
            "documents",
            "consent",
          ],
          properties: {
            externalOrderId: { type: "string", example: "agency-order-1042" },
            externalCustomerId: { type: "string", example: "customer-91" },
            planId: { type: "string", format: "uuid" },
            settlement: { type: "object" },
            traveler: { type: "object" },
            documents: { type: "array", items: { type: "object" } },
            consent: { type: "object" },
            metadata: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        {
          type: "object",
          title: "Legacy quote order (deprecated)",
          required: ["quoteId", "externalOrderId", "externalCustomerId", "compatibilityAccepted"],
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
    return this.partners.createCompleteOrder(request.partner!.id, input, {
      ipAddress,
      userAgent: userAgent ?? "unknown",
    });
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
  @PartnerScopes("payments:write")
  @PartnerMutation()
  @LegacyPartnerRoute()
  hosted(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: PartnerRequest,
  ) {
    const input = hostedSchema.parse(body);
    return this.partners.hostedSession(
      request.partner!.id,
      id,
      input.redirectUrl,
    );
  }

  @Post("orders/:id/payment-session")
  @PartnerScopes("payments:write")
  @PartnerMutation()
  @LegacyPartnerRoute()
  payment(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: PartnerRequest,
  ) {
    const input = hostedSchema.parse(body);
    return this.partners.hostedSession(
      request.partner!.id,
      id,
      input.redirectUrl,
    );
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
