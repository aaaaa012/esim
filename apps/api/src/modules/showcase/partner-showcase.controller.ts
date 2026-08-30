import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { UserRoleName } from "@prisma/client";
import { z } from "zod";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";
import { PartnerShowcaseService } from "./partner-showcase.service.js";

const logoUrlSchema = z
  .string()
  .url()
  .max(500)
  .refine(
    (value) => new URL(value).protocol === "https:",
    "Logo URL must use HTTPS",
  );

const createSchema = z.object({
  name: z.string().min(1).max(120),
  logoUrl: logoUrlSchema.optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  logoUrl: logoUrlSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
});

@Controller("admin/partner-showcase")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class PartnerShowcaseAdminController {
  constructor(private readonly showcase: PartnerShowcaseService) {}

  @Get()
  list() {
    return this.showcase.listAll();
  }

  @Post()
  create(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    return this.showcase.create(createSchema.parse(body), req.user!.id);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.showcase.update(id, updateSchema.parse(body), req.user!.id);
  }

  @Delete(":id")
  remove(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.showcase.remove(id, req.user!.id);
  }
}

@Controller("public/partner-showcase")
export class PartnerShowcasePublicController {
  constructor(private readonly showcase: PartnerShowcaseService) {}

  @Get()
  list() {
    return this.showcase.listActive();
  }
}
