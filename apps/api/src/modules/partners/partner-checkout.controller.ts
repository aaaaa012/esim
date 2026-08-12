import {
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Param,
  Post,
} from "@nestjs/common";
import { DocumentType } from "@prisma/client";
import { travelerSchema } from "@visa-compass/shared";
import { z } from "zod";
import { PartnerService } from "./partner.service.js";

const hostedDocumentSchema = z.object({
  type: z.enum(DocumentType),
  fileName: z.string().trim().min(1).max(180),
});

@Controller("partner-checkout")
export class PartnerCheckoutController {
  constructor(private readonly partners: PartnerService) {}

  @Get(":token")
  checkout(@Param("token") token: string) {
    return this.partners.hostedCheckout(token);
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
    z.object({ consentAccepted: z.literal(true) }).parse(body);
    return this.partners.completeHostedCheckout(token, {
      ipAddress,
      userAgent: userAgent ?? "unknown",
    });
  }

  @Post(":token/verify-passport")
  verifyPassport(@Param("token") token: string) {
    return this.partners.verifyHostedPassport(token);
  }
}
