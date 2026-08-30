import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { HomepageCampaignPlacement, UserRoleName } from "@prisma/client";
import type { Response } from "express";
import { z } from "zod";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";
import { PublicAssetStorageService } from "../../infrastructure/public-asset-storage.service.js";
import { HomepageCampaignService } from "./homepage-campaign.service.js";

const placementSchema = z.nativeEnum(HomepageCampaignPlacement);
const dateSchema = z.string().datetime({ offset: true }).nullable();
const commonSchema = {
  title: z.string().trim().min(2).max(160),
  altText: z.string().trim().min(12).max(500),
  placement: placementSchema,
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  ctaLabel: z.string().trim().min(2).max(80),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
  startsAt: dateSchema.optional(),
  endsAt: dateSchema.optional(),
};

const createSchema = z.object({
  ...commonSchema,
  assetKey: z.string().min(1).max(500),
});

const updateSchema = z.object({
  title: commonSchema.title.optional(),
  altText: commonSchema.altText.optional(),
  placement: commonSchema.placement.optional(),
  countryCode: commonSchema.countryCode,
  ctaLabel: commonSchema.ctaLabel.optional(),
  sortOrder: commonSchema.sortOrder,
  active: commonSchema.active,
  startsAt: commonSchema.startsAt,
  endsAt: commonSchema.endsAt,
  assetKey: z.string().min(1).max(500).optional(),
});

function dates<
  T extends {
    startsAt?: string | null | undefined;
    endsAt?: string | null | undefined;
  },
>(
  input: T,
): Omit<T, "startsAt" | "endsAt"> & {
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
} {
  return {
    ...input,
    ...(input.startsAt !== undefined
      ? { startsAt: input.startsAt ? new Date(input.startsAt) : null }
      : {}),
    ...(input.endsAt !== undefined
      ? { endsAt: input.endsAt ? new Date(input.endsAt) : null }
      : {}),
  };
}

@Controller("admin/homepage-campaigns")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class HomepageCampaignAdminController {
  constructor(
    private readonly campaigns: HomepageCampaignService,
    private readonly assets: PublicAssetStorageService,
  ) {}

  @Get()
  list() {
    return this.campaigns.listAll();
  }

  @Post("uploads")
  @UseInterceptors(
    FileInterceptor("artwork", { limits: { fileSize: 3 * 1024 * 1024 } }),
  )
  upload(
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; size: number } | undefined,
  ) {
    if (!file)
      throw new BadRequestException("Campaign artwork file is required");
    return this.assets.uploadCampaignAsset(file);
  }

  @Post()
  create(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    return this.campaigns.create(dates(createSchema.parse(body)), req.user!.id);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.campaigns.update(
      id,
      dates(updateSchema.parse(body)),
      req.user!.id,
    );
  }

  @Delete(":id")
  remove(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.campaigns.remove(id, req.user!.id);
  }
}

@Controller("public/homepage-campaigns")
export class HomepageCampaignPublicController {
  constructor(private readonly campaigns: HomepageCampaignService) {}

  @Get()
  list() {
    return this.campaigns.listActive();
  }
}

@Controller("public/marketing-assets")
export class HomepageMarketingAssetController {
  constructor(private readonly assets: PublicAssetStorageService) {}

  @Get(":fileName")
  async read(
    @Param("fileName") fileName: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res() response: Response,
  ) {
    const asset = await this.assets.readCampaignAsset(fileName);
    if (ifNoneMatch && ifNoneMatch === asset.etag)
      return response.status(304).end();
    response.setHeader("Content-Type", asset.contentType);
    response.setHeader("Content-Length", String(asset.bytes.length));
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.setHeader("ETag", asset.etag);
    response.setHeader("X-Content-Type-Options", "nosniff");
    return response.status(200).send(asset.bytes);
  }
}
