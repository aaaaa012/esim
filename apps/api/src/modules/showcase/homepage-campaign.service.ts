import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  HomepageCampaignFormat,
  HomepageCampaignPlacement,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { PublicAssetStorageService } from "../../infrastructure/public-asset-storage.service.js";
import { ProductionResilienceService } from "../../jobs/production-resilience.service.js";

const SINGLETON_PLACEMENTS = new Set<HomepageCampaignPlacement>([
  HomepageCampaignPlacement.FEATURED_BANNER,
  HomepageCampaignPlacement.HOW_GUIDE,
  HomepageCampaignPlacement.WHY_ESIM_BANNER,
]);

type CampaignInput = {
  title: string;
  altText: string;
  placement: HomepageCampaignPlacement;
  countryCode?: string | null | undefined;
  ctaLabel: string;
  sortOrder?: number | undefined;
  active?: boolean | undefined;
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
};

type CampaignUpdate = {
  [Key in keyof CampaignInput]?: CampaignInput[Key] | undefined;
} & { assetKey?: string | undefined };

@Injectable()
export class HomepageCampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: PublicAssetStorageService,
    private readonly resilience: ProductionResilienceService,
  ) {}

  async listAll() {
    if (!this.prisma.enabled) return [];
    const items = await this.prisma.homepageCampaign.findMany({
      orderBy: [
        { placement: "asc" },
        { sortOrder: "asc" },
        { createdAt: "asc" },
      ],
    });
    return items.map((item) => this.present(item));
  }

  async listActive() {
    const grouped = this.emptyGroups();
    if (!this.prisma.enabled) return grouped;
    const now = new Date();
    const items = await this.prisma.homepageCampaign.findMany({
      where: {
        active: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
      select: {
        id: true,
        title: true,
        altText: true,
        imageUrl: true,
        assetKey: true,
        placement: true,
        format: true,
        imageWidth: true,
        imageHeight: true,
        countryCode: true,
        ctaLabel: true,
        sortOrder: true,
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    for (const item of items) {
      grouped[item.placement].push({
        ...this.present(item),
        ctaHref: this.ctaHref(item.countryCode, item.placement),
      });
    }
    return grouped;
  }

  private present<T extends { imageUrl: string; assetKey?: string | null }>(
    item: T,
  ) {
    return {
      ...item,
      imageUrl: item.assetKey
        ? this.assets.publicUrl(item.assetKey)
        : item.imageUrl,
    };
  }

  async create(input: CampaignInput & { assetKey: string }, actorId: string) {
    if (!this.prisma.enabled)
      throw new NotFoundException("Database is required");
    this.validateSchedule(input.startsAt ?? null, input.endsAt ?? null);
    await this.validateCountry(input.countryCode ?? null);
    const image = await this.assets.verifyCampaignAsset(input.assetKey);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.assertSingletonAvailable(
            {
              placement: input.placement,
              active: input.active ?? true,
              startsAt: input.startsAt ?? null,
              endsAt: input.endsAt ?? null,
            },
            tx,
          );
          const created = await tx.homepageCampaign.create({
            data: {
              title: input.title,
              altText: input.altText,
              imageUrl: image.imageUrl,
              assetKey: input.assetKey,
              placement: input.placement,
              format: image.format as HomepageCampaignFormat,
              imageWidth: image.width,
              imageHeight: image.height,
              countryCode: input.countryCode ?? null,
              ctaLabel: input.ctaLabel,
              sortOrder: input.sortOrder ?? 0,
              active: input.active ?? true,
              startsAt: input.startsAt ?? null,
              endsAt: input.endsAt ?? null,
            },
          });
          await this.audit(tx, actorId, created.id, "CREATED", null, created);
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      await this.scheduleAssetCleanup(input.assetKey, "CREATE_ROLLED_BACK");
      throw error;
    }
  }

  async update(id: string, input: CampaignUpdate, actorId: string) {
    if (!this.prisma.enabled)
      throw new NotFoundException("Database is required");
    const existing = await this.prisma.homepageCampaign.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException("Homepage campaign not found");

    const next = {
      placement: input.placement ?? existing.placement,
      active: input.active ?? existing.active,
      startsAt:
        input.startsAt === undefined ? existing.startsAt : input.startsAt,
      endsAt: input.endsAt === undefined ? existing.endsAt : input.endsAt,
    };
    this.validateSchedule(next.startsAt, next.endsAt);
    if (input.countryCode !== undefined)
      await this.validateCountry(input.countryCode);
    const image = input.assetKey
      ? await this.assets.verifyCampaignAsset(input.assetKey)
      : null;
    let updated;
    try {
      updated = await this.prisma.$transaction(
        async (tx) => {
          await this.assertSingletonAvailable({ ...next, excludeId: id }, tx);
          const result = await tx.homepageCampaign.update({
            where: { id },
            data: {
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.altText !== undefined
                ? { altText: input.altText }
                : {}),
              ...(input.placement !== undefined
                ? { placement: input.placement }
                : {}),
              ...(input.countryCode !== undefined
                ? { countryCode: input.countryCode }
                : {}),
              ...(input.ctaLabel !== undefined
                ? { ctaLabel: input.ctaLabel }
                : {}),
              ...(input.sortOrder !== undefined
                ? { sortOrder: input.sortOrder }
                : {}),
              ...(input.active !== undefined ? { active: input.active } : {}),
              ...(input.startsAt !== undefined
                ? { startsAt: input.startsAt }
                : {}),
              ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
              ...(image
                ? {
                    imageUrl: image.imageUrl,
                    assetKey: input.assetKey!,
                    format: image.format as HomepageCampaignFormat,
                    imageWidth: image.width,
                    imageHeight: image.height,
                  }
                : {}),
            },
          });
          await this.audit(tx, actorId, id, "UPDATED", existing, result);
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (input.assetKey)
        await this.scheduleAssetCleanup(input.assetKey, "UPDATE_ROLLED_BACK");
      throw error;
    }
    if (image && existing.assetKey && existing.assetKey !== input.assetKey)
      await this.scheduleAssetCleanup(existing.assetKey, "ASSET_REPLACED");
    return updated;
  }

  async remove(id: string, actorId: string) {
    if (!this.prisma.enabled)
      throw new NotFoundException("Database is required");
    const existing = await this.prisma.homepageCampaign.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException("Homepage campaign not found");
    await this.prisma.$transaction(async (tx) => {
      await tx.homepageCampaign.delete({ where: { id } });
      await this.audit(tx, actorId, id, "DELETED", existing, null);
    });
    if (existing.assetKey)
      await this.scheduleAssetCleanup(existing.assetKey, "CAMPAIGN_DELETED");
    return { deleted: true };
  }

  private async scheduleAssetCleanup(assetKey: string, reason: string) {
    await this.resilience.outbox({
      dedupeKey: `homepage-asset-cleanup:${assetKey}`,
      topic: "reconciliation",
      jobName: "homepage-asset-cleanup",
      payload: { kind: "homepage-asset-cleanup", assetKey, reason },
    });
  }

  private async validateCountry(countryCode: string | null | undefined) {
    if (!countryCode) return;
    const country = await this.prisma.country.findUnique({
      where: { isoCode: countryCode },
      select: { id: true },
    });
    if (!country)
      throw new BadRequestException("Select a supported destination");
  }

  private validateSchedule(startsAt: Date | null, endsAt: Date | null) {
    if (startsAt && endsAt && startsAt >= endsAt)
      throw new BadRequestException(
        "Campaign end time must be after its start time",
      );
  }

  private async assertSingletonAvailable(
    input: {
      placement: HomepageCampaignPlacement;
      active: boolean;
      startsAt: Date | null;
      endsAt: Date | null;
      excludeId?: string;
    },
    database: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (!input.active || !SINGLETON_PLACEMENTS.has(input.placement)) return;
    const others = await database.homepageCampaign.findMany({
      where: {
        placement: input.placement,
        active: true,
        ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      },
      select: { id: true, startsAt: true, endsAt: true },
    });
    const start = input.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const end = input.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const conflicts = others.some((item) => {
      const otherStart = item.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const otherEnd = item.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
      return start < otherEnd && otherStart < end;
    });
    if (conflicts)
      throw new BadRequestException(
        "This homepage slot already has an active campaign during that time",
      );
  }

  private ctaHref(
    countryCode: string | null,
    placement: HomepageCampaignPlacement,
  ) {
    if (countryCode)
      return `/?country=${encodeURIComponent(countryCode)}#plans`;
    if (placement === HomepageCampaignPlacement.HOW_GUIDE)
      return "/compatibility";
    return "/#plans";
  }

  private emptyGroups(): Record<HomepageCampaignPlacement, Array<object>> {
    return {
      FEATURED_BANNER: [],
      OFFER_GALLERY: [],
      HOW_GUIDE: [],
      WHY_ESIM_BANNER: [],
    };
  }

  private async audit(
    tx: Prisma.TransactionClient | PrismaService,
    actorClerkId: string,
    entityId: string,
    action: string,
    previousValue: object | null,
    newValue: object | null,
  ) {
    const actor = await tx.user.findUnique({
      where: { clerkId: actorClerkId },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        module: "HOMEPAGE_CAMPAIGNS",
        entity: "HomepageCampaign",
        entityId,
        action,
        ...(actor ? { performedById: actor.id } : {}),
        ...(previousValue ? { previousValue } : {}),
        ...(newValue ? { newValue } : {}),
      },
    });
  }
}
