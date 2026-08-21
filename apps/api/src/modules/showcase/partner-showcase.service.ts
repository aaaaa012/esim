import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/prisma.service.js";

@Injectable()
export class PartnerShowcaseService {
  constructor(private readonly prisma: PrismaService) {}

  async listAll() {
    if (!this.prisma.enabled) return [];
    return this.prisma.partnerShowcase.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  }

  async listActive() {
    if (!this.prisma.enabled) return [];
    return this.prisma.partnerShowcase.findMany({
      where: { active: true },
      select: { id: true, name: true, logoUrl: true, sortOrder: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  }

  async create(
    input: {
      name: string;
      logoUrl?: string | undefined;
      sortOrder?: number | undefined;
      active?: boolean | undefined;
    },
    actorId: string,
  ) {
    if (!this.prisma.enabled)
      throw new NotFoundException("Database is required");
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.partnerShowcase.create({
        data: {
          name: input.name,
          logoUrl: input.logoUrl ?? null,
          sortOrder: input.sortOrder ?? 0,
          active: input.active ?? true,
        },
      });
      await this.audit(
        tx,
        actorId,
        created.id,
        "CREATED",
        null,
        this.publicValue(created),
      );
      return created;
    });
  }

  async update(
    id: string,
    input: {
      name?: string | undefined;
      logoUrl?: string | null | undefined;
      sortOrder?: number | undefined;
      active?: boolean | undefined;
    },
    actorId: string,
  ) {
    if (!this.prisma.enabled)
      throw new NotFoundException("Database is required");
    const existing = await this.prisma.partnerShowcase.findUnique({
      where: { id },
    });
    if (!existing)
      throw new NotFoundException("Partner showcase entry not found");
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.partnerShowcase.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
          ...(input.sortOrder !== undefined
            ? { sortOrder: input.sortOrder }
            : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      await this.audit(
        tx,
        actorId,
        id,
        "UPDATED",
        this.publicValue(existing),
        this.publicValue(updated),
      );
      return updated;
    });
  }

  async remove(id: string, actorId: string) {
    if (!this.prisma.enabled)
      throw new NotFoundException("Database is required");
    const existing = await this.prisma.partnerShowcase.findUnique({
      where: { id },
    });
    if (!existing)
      throw new NotFoundException("Partner showcase entry not found");
    await this.prisma.$transaction(async (tx) => {
      await tx.partnerShowcase.delete({ where: { id } });
      await this.audit(
        tx,
        actorId,
        id,
        "DELETED",
        this.publicValue(existing),
        null,
      );
    });
    return { deleted: true };
  }

  private publicValue(item: {
    name: string;
    logoUrl: string | null;
    sortOrder: number;
    active: boolean;
  }) {
    return {
      name: item.name,
      logoUrl: item.logoUrl,
      sortOrder: item.sortOrder,
      active: item.active,
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
        module: "PARTNER_SHOWCASE",
        entity: "PartnerShowcase",
        entityId,
        action,
        ...(actor ? { performedById: actor.id } : {}),
        ...(previousValue ? { previousValue } : {}),
        ...(newValue ? { newValue } : {}),
      },
    });
  }
}
