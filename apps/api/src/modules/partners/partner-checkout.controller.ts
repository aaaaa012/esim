import {
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  DocumentType,
  PaymentProvider,
  UserRoleName,
} from "@prisma/client";
import { travelerSchema } from "@visa-compass/shared";
import { z } from "zod";
import { PartnerService } from "./partner.service.js";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";

const hostedDocumentSchema = z.object({
  type: z.enum(DocumentType),
  fileName: z.string().trim().min(1).max(180),
  contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
});

const hostedPaymentSchema = z.object({
  provider: z.union([
    z.literal(PaymentProvider.KHALTI),
    z.literal(PaymentProvider.FONEPAY),
  ]),
});

const hostedVerifySchema = z.object({
  reference: z.string().trim().min(1).max(120).optional(),
});

@Controller("partner-checkout")
export class PartnerCheckoutController {
  constructor(private readonly partners: PartnerService) {}

  @Get(":token")
  checkout(@Param("token") token: string) {
    return this.partners.hostedCheckout(token);
  }

  @Post(":token/claim")
  @UseGuards(AuthGuard, AccountGuard)
  @AccountTypes(UserRoleName.CUSTOMER)
  claim(
    @Param("token") token: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.partners.claimHostedCheckout(
      token,
      req.user!.id,
      req.user!.localUserId,
    );
  }

  @Get(":token/documents")
  documents(@Param("token") token: string) {
    return this.partners.hostedCheckoutDocuments(token);
  }

  @Post(":token/traveler")
  traveler(@Param("token") token: string, @Body() body: unknown) {
    return this.partners.setHostedTraveler(token, travelerSchema.parse(body));
  }

  @Post(":token/documents")
  document(@Param("token") token: string, @Body() body: unknown) {
    const input = hostedDocumentSchema.parse(body);
    return this.partners.addHostedDocument(token, {
      type: input.type as DocumentType,
      fileName: input.fileName,
      contentType: input.contentType,
    });
  }

  @Post(":token/documents/:documentId/confirm")
  confirm(
    @Param("token") token: string,
    @Param("documentId") documentId: string,
  ) {
    return this.partners.confirmHostedDocument(token, documentId);
  }

  @Post(":token/complete")
  complete(
    @Param("token") token: string,
    @Body() body: unknown,
    @Ip() ipAddress: string,
    @Headers("user-agent") userAgent?: string,
  ) {
    z
      .object({
        consentAccepted: z.literal(true),
        compatibilityAccepted: z.literal(true),
      })
      .parse(body);
    return this.partners.completeHostedCheckout(token, {
      ipAddress,
      userAgent: userAgent ?? "unknown",
    });
  }

  @Post(":token/verify-passport")
  verifyPassport(@Param("token") token: string) {
    return this.partners.verifyHostedPassport(token);
  }

  @Post(":token/payment")
  payment(@Param("token") token: string, @Body() body: unknown) {
    const { provider } = hostedPaymentSchema.parse(body);
    return this.partners.hostedCheckoutInitiate(token, provider);
  }

  @Post(":token/payment/simulate-complete")
  simulatePayment(@Param("token") token: string, @Body() body: unknown) {
    const input = z
      .object({
        reference: hostedVerifySchema.shape.reference,
        scenario: z
          .enum([
            "SUCCESS",
            "CANCELLED",
            "PENDING",
            "WRONG_AMOUNT",
            "REFUNDED",
            "TIMEOUT",
          ])
          .default("SUCCESS"),
      })
      .parse(body);
    return this.partners.hostedCheckoutSimulate(
      token,
      input.reference,
      input.scenario,
    );
  }

  @Post(":token/verify")
  verify(@Param("token") token: string, @Body() body: unknown) {
    const { reference } = hostedVerifySchema.parse(body);
    return this.partners.hostedCheckoutVerify(token, reference);
  }
}
