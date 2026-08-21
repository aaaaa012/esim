import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { BatchStatus, InventoryStatus, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { CryptoService } from "../../infrastructure/crypto.service.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { tabularToRecords } from "../../common/tabular.util.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import { ProductionResilienceService } from "../../jobs/production-resilience.service.js";
import { ApiException } from "../../common/api-error.js";
import { ApiErrorCode } from "@visa-compass/shared";
import { QueueService } from "../../jobs/queue.service.js";
import { QUEUES } from "../../jobs/queues.js";

@Injectable()
export class InventoryService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly connectivity: ConnectivityService,
    private readonly resilience?: ProductionResilienceService,
    private readonly queues?: QueueService,
  ) {}

  async startProviderReconciliation(input: {
    trigger: "AUTOMATIC" | "BATCH_APPROVAL" | "OPS_MANUAL";
    selection: "STALE_OR_UNVERIFIED" | "SELECTED";
    profileIds?: string[];
    batchId?: string;
    requestedById?: string;
    limit?: number;
  }) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const staleHours = Math.max(
      1,
      Number(process.env.TRANSATEL_INVENTORY_RECONCILE_HOURS ?? 24),
    );
    const staleBefore = new Date(Date.now() - staleHours * 60 * 60_000);
    const ids = [...new Set(input.profileIds ?? [])].slice(0, 500);
    const profiles = await this.prisma.esimInventory.findMany({
      where: {
        assignedOrderId: null,
        status: {
          in: [
            InventoryStatus.PENDING_PROVIDER_CHECK,
            InventoryStatus.AVAILABLE,
            InventoryStatus.QUARANTINED,
          ],
        },
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...(ids.length ? { id: { in: ids } } : {}),
        ...(input.selection === "STALE_OR_UNVERIFIED" && !ids.length
          ? {
              OR: [
                { lastProviderCheckedAt: null },
                { lastProviderCheckedAt: { lte: staleBefore } },
                {
                  status: InventoryStatus.AVAILABLE,
                  OR: [
                    { providerStatus: null },
                    {
                      providerStatus: {
                        notIn: [
                          "available",
                          "allocated",
                          "AVAILABLE",
                          "ALLOCATED",
                        ],
                      },
                    },
                  ],
                },
              ],
            }
          : {}),
        reconciliationItems: {
          none: { run: { status: { in: ["QUEUED", "RUNNING"] } } },
        },
      },
      select: { id: true },
      orderBy: [
        { lastProviderCheckedAt: { sort: "asc", nulls: "first" } },
        { createdAt: "asc" },
      ],
      take: Math.min(500, Math.max(1, input.limit ?? 500)),
    });
    if (!profiles.length)
      return { run: null, message: "No eligible stale or unverified profiles" };

    const run = await this.prisma.inventoryReconciliationRun.create({
      data: {
        trigger: input.trigger,
        selection: input.selection,
        total: profiles.length,
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...(input.requestedById ? { requestedById: input.requestedById } : {}),
        items: {
          create: profiles.map((profile) => ({ inventoryId: profile.id })),
        },
      },
    });

    for (const profile of profiles) {
      try {
        if (this.queues?.enabled) {
          await this.queues.add(
            QUEUES.reconciliation,
            "reconcile-inventory-profile",
            { id: profile.id, kind: "inventory-profile", runId: run.id },
            `inventory-reconcile-${run.id}-${profile.id}`,
            { attempts: 3, backoff: { type: "exponential", delay: 2_000 } },
          );
        } else {
          await this.reconcileProviderProfile(profile.id);
          await this.completeProviderReconciliationItem(
            run.id,
            profile.id,
            "SUCCESS",
          );
        }
      } catch (error) {
        await this.completeProviderReconciliationItem(
          run.id,
          profile.id,
          error instanceof ApiException &&
            error.code === ApiErrorCode.ESIM_NOT_FOUND
            ? "NOT_FOUND"
            : "FAILED",
          error instanceof Error ? error.message : "Provider check failed",
        );
      }
    }
    return { run: await this.providerReconciliationRun(run.id) };
  }

  async completeProviderReconciliationItem(
    runId: string,
    inventoryId: string,
    status: "SUCCESS" | "NOT_FOUND" | "FAILED",
    error?: string,
  ) {
    await this.prisma.inventoryReconciliationItem.updateMany({
      where: { runId, inventoryId, status: { in: ["QUEUED", "RUNNING"] } },
      data: {
        status,
        checkedAt: new Date(),
        error: error?.slice(0, 2000) ?? null,
      },
    });
    const groups = await this.prisma.inventoryReconciliationItem.groupBy({
      by: ["status"],
      where: { runId },
      _count: { _all: true },
    });
    const completed = groups
      .filter(
        (group) => group.status !== "QUEUED" && group.status !== "RUNNING",
      )
      .reduce((sum, group) => sum + group._count._all, 0);
    const run = await this.prisma.inventoryReconciliationRun.findUnique({
      where: { id: runId },
      select: { total: true },
    });
    await this.prisma.inventoryReconciliationRun.update({
      where: { id: runId },
      data:
        run && completed >= run.total
          ? { status: "COMPLETED", completedAt: new Date() }
          : { status: "RUNNING" },
    });
  }

  async providerReconciliationRun(id: string) {
    const run = await this.prisma.inventoryReconciliationRun.findUnique({
      where: { id },
      include: {
        items: {
          where: { status: { in: ["NOT_FOUND", "FAILED"] } },
          select: {
            status: true,
            error: true,
            inventory: { select: { id: true, iccid: true } },
          },
          take: 20,
        },
      },
    });
    if (!run) throw new NotFoundException("Inventory refresh run not found");
    const groups = await this.prisma.inventoryReconciliationItem.groupBy({
      by: ["status"],
      where: { runId: id },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(
      groups.map((group) => [group.status.toLowerCase(), group._count._all]),
    );
    return { ...run, counts };
  }

  async latestProviderReconciliationRun() {
    const run = await this.prisma.inventoryReconciliationRun.findFirst({
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return run ? this.providerReconciliationRun(run.id) : null;
  }

  async onModuleInit() {
    if (!this.prisma.enabled || process.env.NODE_ENV === "production") return;
    // Synthetic SIMs must never be offered for real Transatel provisioning.
    // Only seed them for pure-local/simulator development when explicitly enabled.
    if (process.env.ENABLE_MOCK_INVENTORY !== "true") return;
    if (await this.prisma.esimInventory.count()) return;
    const batch = await this.prisma.inventoryBatch.create({
      data: {
        batchReference: `DEV-MOCK-${new Date().getUTCFullYear()}`,
        totalProfiles: 20,
        importedCount: 20,
      },
    });
    await this.prisma.esimInventory.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        batchId: batch.id,
        iccid: `899770100000000${String(index).padStart(3, "0")}`,
        eid: `890490320000000000000000000${String(index).padStart(3, "0")}`,
        msisdn: `8824700018${String(50000 + index)}`,
        status: InventoryStatus.AVAILABLE,
        activationCodeEncrypted: this.crypto.encrypt(
          `LPA:1$mock.smdp.visacompass.local$${batch.id}-${index}`,
        ),
        smDpAddress: "mock.smdp.visacompass.local",
      })),
    });
  }

  async reserve(orderId: string) {
    if (!this.prisma.enabled)
      return {
        id: `memory-${orderId}`,
        eid: `mock-${orderId}`,
        iccid: `mock-${orderId}`,
      };
    const existing = await this.prisma.esimInventory.findUnique({
      where: { assignedOrderId: orderId },
    });
    if (existing) return existing;
    const freshnessHours = Math.max(
      1,
      Number(process.env.INVENTORY_PROVIDER_FRESHNESS_HOURS ?? 24),
    );
    const freshAfter = new Date(Date.now() - freshnessHours * 60 * 60_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await this.prisma.esimInventory.findFirst({
        where: {
          status: InventoryStatus.AVAILABLE,
          assignedOrderId: null,
          providerSubscriptionId: null,
          providerStatus: {
            in: ["available", "allocated", "AVAILABLE", "ALLOCATED"],
          },
          lastProviderCheckedAt: { gte: freshAfter },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          batch: { status: BatchStatus.APPROVED },
        },
        orderBy: { createdAt: "asc" },
      });
      if (!candidate)
        throw new ConflictException("No eSIM inventory is currently available");
      const claimed = await this.prisma.esimInventory.updateMany({
        where: {
          id: candidate.id,
          status: InventoryStatus.AVAILABLE,
          assignedOrderId: null,
          providerSubscriptionId: null,
          lastProviderCheckedAt: { gte: freshAfter },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        data: {
          status: InventoryStatus.RESERVED,
          assignedOrderId: orderId,
          version: { increment: 1 },
        },
      });
      if (claimed.count === 1)
        return {
          ...candidate,
          status: InventoryStatus.RESERVED,
          assignedOrderId: orderId,
        };
    }
    throw new ConflictException(
      "Inventory reservation conflict; retry the approval",
    );
  }

  /**
   * Rejects a new eSIM purchase before an order (and any payment obligation)
   * is created when there is no profile that could be reserved right now.
   * Top-ups do not call this guard because they reuse an already assigned eSIM.
   */
  async assertAvailableForNewOrder() {
    if (!this.prisma.enabled) return;
    const freshnessHours = Math.max(
      1,
      Number(process.env.INVENTORY_PROVIDER_FRESHNESS_HOURS ?? 24),
    );
    const available = await this.prisma.esimInventory.count({
      where: {
        status: InventoryStatus.AVAILABLE,
        assignedOrderId: null,
        providerSubscriptionId: null,
        providerStatus: {
          in: ["available", "allocated", "AVAILABLE", "ALLOCATED"],
        },
        lastProviderCheckedAt: {
          gte: new Date(Date.now() - freshnessHours * 60 * 60_000),
        },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        batch: { status: BatchStatus.APPROVED },
      },
    });
    if (available === 0)
      throw new ConflictException("No eSIM inventory is currently available");
  }

  async profileForOrder(orderId: string) {
    return this.reserve(orderId);
  }

  /**
   * Releases a provider-unbound reservation back into provider verification.
   * It never becomes sellable directly: even previously safe evidence may have
   * changed while the profile was reserved, so reconciliation must prove the
   * profile is currently available/allocated again.
   */
  async release(orderId: string) {
    if (!this.prisma.enabled) return;
    const inventory = await this.prisma.esimInventory.findUnique({
      where: { assignedOrderId: orderId },
    });
    if (!inventory) return;
    if (inventory.providerSubscriptionId) return;
    await this.prisma.esimInventory.updateMany({
      where: {
        id: inventory.id,
        assignedOrderId: orderId,
        providerSubscriptionId: null,
      },
      data: {
        status: InventoryStatus.PENDING_PROVIDER_CHECK,
        assignedOrderId: null,
        lastProviderCheckedAt: null,
        providerCheckError: "Provider recheck required after reservation release",
        version: { increment: 1 },
      },
    });
  }

  /**
   * Atomically quarantines a definitively rejected, provider-unbound profile,
   * reserves a fresh provider-safe profile, and advances the durable provider
   * command generation. A new generation gets a new idempotency key; uncertain
   * outcomes must never call this method.
   */
  async replacePermanentlyRejectedProfile(orderId: string, reason: string) {
    if (!this.prisma.enabled)
      throw new ConflictException("Database persistence is required");
    const freshnessHours = Math.max(
      1,
      Number(process.env.INVENTORY_PROVIDER_FRESHNESS_HOURS ?? 24),
    );
    const freshAfter = new Date(Date.now() - freshnessHours * 60 * 60_000);
    return this.prisma.$transaction(async (tx) => {
      const rejected = await tx.esimInventory.findUnique({
        where: { assignedOrderId: orderId },
      });
      if (!rejected)
        throw new ConflictException("The order has no reserved eSIM to replace");
      if (rejected.providerSubscriptionId)
        throw new ConflictException(
          "The rejected eSIM is provider-bound and cannot be replaced automatically",
        );
      const operation = await tx.provisioningOperation.findUnique({
        where: { orderId },
      });
      if (!operation)
        throw new ConflictException("Provisioning operation is missing");

      const replacement = await tx.esimInventory.findFirst({
        where: {
          id: { not: rejected.id },
          status: InventoryStatus.AVAILABLE,
          assignedOrderId: null,
          providerSubscriptionId: null,
          providerStatus: {
            in: ["available", "allocated", "AVAILABLE", "ALLOCATED"],
          },
          lastProviderCheckedAt: { gte: freshAfter },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          batch: { status: BatchStatus.APPROVED },
        },
        orderBy: { createdAt: "asc" },
      });
      if (!replacement)
        throw new ConflictException(
          "No safe replacement eSIM is currently available",
        );
      await tx.esimInventory.update({
        where: { id: rejected.id },
        data: {
          status: InventoryStatus.QUARANTINED,
          assignedOrderId: null,
          providerCheckError: reason.slice(0, 2000),
          version: { increment: 1 },
        },
      });
      const claimed = await tx.esimInventory.updateMany({
        where: {
          id: replacement.id,
          status: InventoryStatus.AVAILABLE,
          assignedOrderId: null,
          providerSubscriptionId: null,
          lastProviderCheckedAt: { gte: freshAfter },
        },
        data: {
          status: InventoryStatus.RESERVED,
          assignedOrderId: orderId,
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1)
        throw new ConflictException(
          "Replacement inventory was claimed by another order",
        );
      const generation = operation.profileSwapCount + 1;
      await tx.provisioningOperation.update({
        where: { orderId },
        data: {
          state: "CREATED",
          idempotencyKey: `transatel:preload:${orderId}:profile-${generation}`,
          iccid: replacement.iccid,
          profileSwapCount: generation,
          providerOrderId: null,
          providerSubscriptionId: null,
          responseSnapshot: Prisma.DbNull,
          lastErrorCategory: null,
          lastErrorMessage: null,
          submittedAt: null,
          acceptedAt: null,
          nextReconcileAt: null,
          reconcileDeadlineAt: null,
          completedAt: null,
          version: { increment: 1 },
        },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { providerStatus: null, providerSubscriptionId: null },
      });
      return {
        previousIccid: rejected.iccid,
        replacement,
        generation,
      };
    });
  }

  async importBatch(
    iccdsInput: string[],
    eidsInput?: (string | null)[],
    source?: string,
    msisdnsInput?: (string | null)[],
    submittedById?: string,
  ) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    if (iccdsInput.length > 5000)
      throw new BadRequestException("A single upload is limited to 5,000 rows");
    const rows = iccdsInput.map((iccid, index) => ({
      iccid: iccid.trim(),
      eid: eidsInput?.[index]?.trim() ?? null,
      msisdn: msisdnsInput?.[index]?.trim() ?? null,
    }));
    const invalid = rows.filter((row) => !/^\d{15,25}$/.test(row.iccid));
    if (invalid.length)
      throw new BadRequestException(
        `Invalid ICCID values: ${invalid.map((row) => row.iccid).join(", ")}`,
      );
    const existing = await this.prisma.esimInventory.findMany({
      where: { iccid: { in: rows.map((row) => row.iccid) } },
      select: { iccid: true },
    });
    const existingSet = new Set(existing.map((item) => item.iccid));
    const toImport = rows.filter((row) => !existingSet.has(row.iccid));
    if (!toImport.length)
      return { imported: 0, skipped: rows.length, batch: null };
    const submitter = submittedById
      ? await this.localUser(submittedById)
      : null;
    const submittedByLocalId = submitter?.id;
    const batchReference = `MANUAL-${source ?? "ops"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inventoryBatch.create({
        data: {
          batchReference,
          totalProfiles: rows.length,
          importedCount: toImport.length,
          status: BatchStatus.PENDING,
          ...(submittedByLocalId ? { submittedById: submittedByLocalId } : {}),
        },
      });
      await tx.esimInventory.createMany({
        data: toImport.map((row) => ({
          batchId: created.id,
          iccid: row.iccid,
          eid:
            row.eid ??
            `SYNTH-${createHash("sha256").update(row.iccid).digest("hex").slice(0, 28).toUpperCase()}`,
          ...(row.msisdn ? { msisdn: row.msisdn } : {}),
          status: InventoryStatus.IMPORTED,
        })),
      });
      return created;
    });
    return {
      imported: toImport.length,
      skipped: rows.length - toImport.length,
      batch: batch.id,
    };
  }

  async importBatchCsv(
    content: string,
    source?: string,
    fileName?: string,
    submittedById?: string,
  ) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const { records, errors } = await tabularToRecords(
      content,
      ["iccid"],
      fileName ? { fileName, maxRows: 5000 } : { maxRows: 5000 },
    );
    if (errors.length) throw new BadRequestException(errors.join("; "));
    if (records.length > 5000)
      throw new BadRequestException("A single upload is limited to 5,000 rows");
    const rowErrors: string[] = [];
    const candidates: {
      line: number;
      iccid: string;
      eid: string | null;
      msisdn: string | null;
    }[] = [];
    for (const [index, row] of records.entries()) {
      const line = index + 2;
      const iccid = (row.iccid ?? "").trim();
      const eid = (row.eid ?? "").trim() || null;
      const msisdn = (row.msisdn ?? "").trim() || null;
      if (!/^\d{15,25}$/.test(iccid)) {
        rowErrors.push(`Line ${line}: invalid ICCID '${iccid || "(empty)"}'`);
        continue;
      }
      if (eid && !/^[A-Z0-9-]{16,80}$/.test(eid)) {
        rowErrors.push(`Line ${line}: invalid EID '${eid}'`);
        continue;
      }
      if (msisdn && !/^\+?\d{6,15}$/.test(msisdn)) {
        rowErrors.push(`Line ${line}: invalid MSISDN '${msisdn}'`);
        continue;
      }
      candidates.push({ line, iccid, eid, msisdn });
    }
    const seen = new Set<string>();
    const uniqueCandidates: typeof candidates = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.iccid)) {
        rowErrors.push(
          `Line ${candidate.line}: duplicate ICCID ${candidate.iccid} within the file`,
        );
        continue;
      }
      seen.add(candidate.iccid);
      uniqueCandidates.push(candidate);
    }
    const existingIccids = await this.prisma.esimInventory.findMany({
      where: { iccid: { in: uniqueCandidates.map((row) => row.iccid) } },
      select: { iccid: true },
    });
    const existingIccidSet = new Set(existingIccids.map((row) => row.iccid));
    const eidsToCheck = uniqueCandidates
      .map((row) => row.eid)
      .filter((eid): eid is string => Boolean(eid));
    const existingEids = eidsToCheck.length
      ? await this.prisma.esimInventory.findMany({
          where: { eid: { in: eidsToCheck } },
          select: { eid: true },
        })
      : [];
    const existingEidSet = new Set(existingEids.map((row) => row.eid));
    const toImport = uniqueCandidates.filter((row) => {
      if (existingIccidSet.has(row.iccid)) {
        rowErrors.push(`Line ${row.line}: ICCID ${row.iccid} already exists`);
        return false;
      }
      if (row.eid && existingEidSet.has(row.eid)) {
        rowErrors.push(`Line ${row.line}: EID ${row.eid} already exists`);
        return false;
      }
      return true;
    });
    if (!toImport.length)
      return {
        imported: 0,
        skipped: rowErrors.length,
        errors: rowErrors.slice(0, 100),
        batch: null,
      };
    const submitter = submittedById
      ? await this.localUser(submittedById)
      : null;
    const submittedByLocalId = submitter?.id;
    const batchReference = `MANUAL-CSV-${source?.trim() || "ops"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inventoryBatch.create({
        data: {
          batchReference,
          totalProfiles: toImport.length,
          importedCount: toImport.length,
          status: BatchStatus.PENDING,
          ...(submittedByLocalId ? { submittedById: submittedByLocalId } : {}),
        },
      });
      await tx.esimInventory.createMany({
        data: toImport.map((row) => ({
          batchId: created.id,
          iccid: row.iccid,
          eid:
            row.eid ??
            `SYNTH-${createHash("sha256").update(row.iccid).digest("hex").slice(0, 28).toUpperCase()}`,
          ...(row.msisdn ? { msisdn: row.msisdn } : {}),
          status: InventoryStatus.IMPORTED,
        })),
      });
      return created;
    });
    return {
      imported: toImport.length,
      skipped: rowErrors.length,
      errors: rowErrors.slice(0, 100),
      batch: batch.id,
    };
  }

  async importBatchTabular(
    content: string,
    fileName?: string,
    source?: string,
    submittedById?: string,
  ) {
    return this.importBatchCsv(content, source, fileName, submittedById);
  }

  /**
   * Approves a pending upload batch: rows flip from IMPORTED to AVAILABLE and
   * only then enter the sellable FIFO pool. Every decision is audited.
   */
  async approveBatch(batchId: string, actorClerkId: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const batch = await this.prisma.inventoryBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException("Upload batch not found");
    if (batch.status !== BatchStatus.PENDING)
      throw new BadRequestException(
        `Batch is ${batch.status.toLowerCase()}; only pending batches can be approved`,
      );
    const actor = await this.localUser(actorClerkId);
    await this.prisma.$transaction(async (tx) => {
      await tx.inventoryBatch.update({
        where: { id: batchId },
        data: {
          status: BatchStatus.APPROVED,
          approvedById: actor?.id ?? null,
          approvedAt: new Date(),
        },
      });
      await tx.esimInventory.updateMany({
        where: { batchId, status: InventoryStatus.IMPORTED },
        data: {
          status: InventoryStatus.PENDING_PROVIDER_CHECK,
          version: { increment: 1 },
        },
      });
      await tx.auditLog.create({
        data: {
          module: "INVENTORY",
          entity: "InventoryBatch",
          entityId: batchId,
          action: "BATCH_APPROVED",
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: {
            status: batch.status,
            reference: batch.batchReference,
          },
          newValue: { status: BatchStatus.APPROVED },
        },
      });
    });
    const reconciliation = await this.startProviderReconciliation({
      trigger: "BATCH_APPROVAL",
      selection: "SELECTED",
      batchId,
      limit: 500,
      ...(actor ? { requestedById: actor.id } : {}),
    });
    return {
      id: batchId,
      status: BatchStatus.APPROVED,
      reference: batch.batchReference,
      reconciliation,
    };
  }

  /**
   * Rejects a pending upload batch. Rows stay IMPORTED so they can never be
   * reserved; the reason is retained on the batch and in the audit trail.
   */
  async rejectBatch(batchId: string, actorClerkId: string, reason?: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const batch = await this.prisma.inventoryBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException("Upload batch not found");
    if (batch.status !== BatchStatus.PENDING)
      throw new BadRequestException(
        `Batch is ${batch.status.toLowerCase()}; only pending batches can be rejected`,
      );
    const actor = await this.localUser(actorClerkId);
    await this.prisma.$transaction(async (tx) => {
      await tx.inventoryBatch.update({
        where: { id: batchId },
        data: {
          status: BatchStatus.REJECTED,
          rejectedById: actor?.id ?? null,
          rejectedAt: new Date(),
          ...(reason?.trim() ? { rejectionReason: reason.trim() } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          module: "INVENTORY",
          entity: "InventoryBatch",
          entityId: batchId,
          action: "BATCH_REJECTED",
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: {
            status: batch.status,
            reference: batch.batchReference,
          },
          newValue: {
            status: BatchStatus.REJECTED,
            ...(reason?.trim() ? { reason: reason.trim() } : {}),
          },
        },
      });
    });
    return {
      id: batchId,
      status: BatchStatus.REJECTED,
      reference: batch.batchReference,
    };
  }

  private async localUser(clerkId: string) {
    try {
      return await this.prisma.user.findUnique({ where: { clerkId } });
    } catch {
      return null;
    }
  }

  async assign(
    orderId: string,
    customerId: string,
    qrPayload: string,
    providerInfo?: {
      provider: string;
      providerSubscriptionId?: string;
      expiresAt?: string;
    },
  ) {
    if (!this.prisma.enabled) return;
    const inventory = await this.prisma.esimInventory.findUnique({
      where: { assignedOrderId: orderId },
    });
    if (!inventory)
      throw new NotFoundException("Reserved inventory was not found");
    await this.prisma.$transaction(async (tx) => {
      await tx.esimInventory.update({
        where: { id: inventory.id },
        data: {
          status: InventoryStatus.ASSIGNED,
          ...(providerInfo?.providerSubscriptionId
            ? { providerSubscriptionId: providerInfo.providerSubscriptionId }
            : {}),
          version: { increment: 1 },
        },
      });
      const customerEsim = await tx.customerEsim.upsert({
        where: { orderId },
        update: { qrPayloadEncrypted: this.crypto.encrypt(qrPayload) },
        create: {
          orderId,
          inventoryId: inventory.id,
          customerId,
          qrPayloadEncrypted: this.crypto.encrypt(qrPayload),
        },
      });
      if (providerInfo?.providerSubscriptionId) {
        await tx.subscription.upsert({
          where: {
            providerSubscriptionId: providerInfo.providerSubscriptionId,
          },
          update: {
            provider: providerInfo.provider,
            ...(providerInfo.expiresAt
              ? { expiresAt: new Date(providerInfo.expiresAt) }
              : {}),
          },
          create: {
            customerEsimId: customerEsim.id,
            provider: providerInfo.provider,
            providerSubscriptionId: providerInfo.providerSubscriptionId,
            status: "PENDING",
            ...(providerInfo.expiresAt
              ? { expiresAt: new Date(providerInfo.expiresAt) }
              : {}),
          },
        });
      }
    });
  }

  /**
   * Attaches a top-up order to an already-provisioned eSIM (same country). The
   * physical eSIM is not reserved again; a new CustomerEsim row (unique per
   * order) links the order to the existing inventory so data plans can stack,
   * each with its own subscription and expiry.
   */
  async assignTopup(
    orderId: string,
    customerId: string,
    iccid: string,
    qrPayload: string,
    providerInfo?: {
      provider: string;
      providerSubscriptionId?: string;
      expiresAt?: string;
    },
  ) {
    if (!this.prisma.enabled) return;
    const inventory = await this.prisma.esimInventory.findUnique({
      where: { iccid },
    });
    if (!inventory) throw new NotFoundException("Existing eSIM was not found");
    await this.prisma.$transaction(async (tx) => {
      const customerEsim = await tx.customerEsim.upsert({
        where: { orderId },
        update: { qrPayloadEncrypted: this.crypto.encrypt(qrPayload) },
        create: {
          orderId,
          inventoryId: inventory.id,
          customerId,
          qrPayloadEncrypted: this.crypto.encrypt(qrPayload),
        },
      });
      if (providerInfo?.providerSubscriptionId) {
        await tx.subscription.upsert({
          where: {
            providerSubscriptionId: providerInfo.providerSubscriptionId,
          },
          update: {
            provider: providerInfo.provider,
            ...(providerInfo.expiresAt
              ? { expiresAt: new Date(providerInfo.expiresAt) }
              : {}),
          },
          create: {
            customerEsimId: customerEsim.id,
            provider: providerInfo.provider,
            providerSubscriptionId: providerInfo.providerSubscriptionId,
            status: "PENDING",
            ...(providerInfo.expiresAt
              ? { expiresAt: new Date(providerInfo.expiresAt) }
              : {}),
          },
        });
      }
    });
  }

  /**
   * Resolves the eSIM inventory backing an order. Initial purchases are found
   * through the reserved `assignedOrderId`; top-up orders reuse an existing
   * eSIM and are resolved through their CustomerEsim row instead.
   */
  async inventoryForOrder(orderId: string) {
    if (!this.prisma.enabled) return null;
    const byAssigned = await this.prisma.esimInventory.findUnique({
      where: { assignedOrderId: orderId },
      select: { id: true, iccid: true, msisdn: true },
    });
    if (byAssigned) return byAssigned;
    const viaEsim = await this.prisma.customerEsim.findUnique({
      where: { orderId },
      select: {
        inventory: { select: { id: true, iccid: true, msisdn: true } },
      },
    });
    return viaEsim?.inventory ?? null;
  }

  async applyLifecycle(
    orderId: string,
    event: {
      provider: string;
      status?:
        | "PRELOADED"
        | "ACTIVATED"
        | "SUSPENDED"
        | "EXPIRED"
        | "TERMINATED"
        | "CANCELED"
        | "OTHER";
      subscriptionId?: string;
      iccid?: string;
      activatedAt?: string;
      expiresAt?: string;
    },
  ) {
    if (!this.prisma.enabled) return;
    const resolved = await this.inventoryForOrder(orderId);
    if (!resolved)
      throw new NotFoundException("No inventory is associated with this order");
    const inventory = await this.prisma.esimInventory.findUnique({
      where: { id: resolved.id },
    });
    if (!inventory)
      throw new NotFoundException("Reserved inventory was not found");
    if (event.iccid && event.iccid !== inventory.iccid) {
      if (event.subscriptionId)
        await this.prisma.subscription.updateMany({
          where: { providerSubscriptionId: event.subscriptionId },
          data: {
            assignmentVerificationStatus: "MISMATCH",
            providerLastSeenAt: new Date(),
          },
        });
      await this.resilience?.attention({
        dedupeKey: `inventory-assignment-conflict:${orderId}:${event.subscriptionId ?? "unknown"}`,
        category: "INVENTORY_ASSIGNMENT_CONFLICT",
        entityType: "EsimInventory",
        entityId: inventory.id,
        orderId,
        severity: "CRITICAL",
        summary: `Provider returned an unexpected ICCID for order ${orderId}`,
        detail: `Expected ${inventory.iccid}; provider reported ${event.iccid}`,
        localState: inventory.status,
        ...(event.status ? { externalState: event.status } : {}),
        lastSuccessfulStep: "INVENTORY_RESERVED",
        failureCategory: "PROVIDER_ICCID_MISMATCH",
        availableActions: ["RECONCILE_RESERVATION"],
      });
      throw new ConflictException(
        "Provider subscription was assigned to a different eSIM",
      );
    }
    if (
      event.subscriptionId &&
      inventory.providerSubscriptionId &&
      event.subscriptionId !== inventory.providerSubscriptionId
    ) {
      await this.resilience?.attention({
        dedupeKey: `inventory-subscription-conflict:${orderId}:${event.subscriptionId}`,
        category: "INVENTORY_ASSIGNMENT_CONFLICT",
        entityType: "EsimInventory",
        entityId: inventory.id,
        orderId,
        severity: "CRITICAL",
        summary: `Provider returned an unexpected subscription for order ${orderId}`,
        detail: `The assigned inventory is already bound to a different provider subscription`,
        localState: inventory.status,
        ...(event.status ? { externalState: event.status } : {}),
        lastSuccessfulStep: "PROVIDER_SUBSCRIPTION_ASSIGNED",
        failureCategory: "PROVIDER_SUBSCRIPTION_MISMATCH",
        availableActions: ["RECONCILE_RESERVATION"],
      });
      throw new ConflictException(
        "Provider subscription does not match the assigned eSIM",
      );
    }

    const inventoryStatus = this.mapInventoryStatus(event.status);
    const subscriptionStatus = this.mapSubscriptionStatus(event.status);

    await this.prisma.$transaction(async (tx) => {
      await tx.esimInventory.update({
        where: { id: inventory.id },
        data: {
          ...(inventoryStatus ? { status: inventoryStatus } : {}),
          ...(event.status ? { providerStatus: event.status } : {}),
          ...(event.subscriptionId
            ? { providerSubscriptionId: event.subscriptionId }
            : {}),
          ...(event.activatedAt
            ? { activatedAt: new Date(event.activatedAt) }
            : {}),
          ...(event.expiresAt ? { expiresAt: new Date(event.expiresAt) } : {}),
          version: { increment: 1 },
        },
      });
      const customerEsim = await tx.customerEsim.findUnique({
        where: { orderId },
      });
      const providerSubscriptionId =
        event.subscriptionId ?? inventory.providerSubscriptionId;
      if (!customerEsim || !providerSubscriptionId) return;
      await tx.subscription.upsert({
        where: { providerSubscriptionId },
        update: {
          ...(subscriptionStatus ? { status: subscriptionStatus } : {}),
          providerLastSeenAt: new Date(),
          ...(event.status === "ACTIVATED"
            ? {
                assignmentVerificationStatus: "VERIFIED" as const,
                assignmentVerifiedAt: new Date(),
              }
            : {}),
          ...(event.activatedAt
            ? { activatedAt: new Date(event.activatedAt) }
            : {}),
          ...(event.expiresAt ? { expiresAt: new Date(event.expiresAt) } : {}),
        },
        create: {
          customerEsimId: customerEsim.id,
          provider: event.provider,
          providerSubscriptionId,
          status: subscriptionStatus ?? "PENDING",
          providerLastSeenAt: new Date(),
          ...(event.status === "ACTIVATED"
            ? {
                assignmentVerificationStatus: "VERIFIED",
                assignmentVerifiedAt: new Date(),
              }
            : {}),
          ...(event.activatedAt
            ? { activatedAt: new Date(event.activatedAt) }
            : {}),
          ...(event.expiresAt ? { expiresAt: new Date(event.expiresAt) } : {}),
        },
      });
    });
  }

  private mapInventoryStatus(
    status?:
      | "PRELOADED"
      | "ACTIVATED"
      | "SUSPENDED"
      | "EXPIRED"
      | "TERMINATED"
      | "CANCELED"
      | "OTHER",
  ) {
    if (status === "ACTIVATED") return InventoryStatus.ACTIVATED;
    if (status === "EXPIRED") return InventoryStatus.EXPIRED;
    if (status === "TERMINATED") return InventoryStatus.TERMINATED;
    return null;
  }

  private mapSubscriptionStatus(
    status?:
      | "PRELOADED"
      | "ACTIVATED"
      | "SUSPENDED"
      | "EXPIRED"
      | "TERMINATED"
      | "CANCELED"
      | "OTHER",
  ) {
    if (status === "ACTIVATED") return "ACTIVE";
    if (status === "EXPIRED") return "EXPIRED";
    if (status === "TERMINATED" || status === "CANCELED") return "TERMINATED";
    if (status === "SUSPENDED") return "SUSPENDED";
    return "PENDING";
  }

  async reconcileStaleReservations() {
    if (!this.prisma.enabled) return { released: [], attention: [] };
    const hours = Math.max(
      1,
      Number(process.env.INVENTORY_RESERVATION_STALE_HOURS ?? 2),
    );
    const staleBefore = new Date(Date.now() - hours * 60 * 60_000);
    const profiles = await this.prisma.esimInventory.findMany({
      where: {
        status: InventoryStatus.RESERVED,
        providerSubscriptionId: null,
        updatedAt: { lte: staleBefore },
      },
      include: {
        assignedOrder: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            provisioningOperation: {
              select: { state: true, providerOrderId: true },
            },
          },
        },
      },
      take: 100,
      orderBy: { updatedAt: "asc" },
    });
    const released: string[] = [];
    const attention: string[] = [];
    for (const profile of profiles) {
      const order = profile.assignedOrder;
      const operation = order?.provisioningOperation;
      const terminalOrder =
        !order ||
        [
          "CANCELLED",
          "PAYMENT_FAILED",
          "PROVISIONING_FAILED",
          "REFUNDED",
        ].includes(order.status);
      const noProviderEvidence =
        !operation ||
        (["CREATED", "REJECTED", "CANCELLED"].includes(operation.state) &&
          !operation.providerOrderId);
      if (terminalOrder && noProviderEvidence) {
        const changed = await this.prisma.esimInventory.updateMany({
          where: {
            id: profile.id,
            status: InventoryStatus.RESERVED,
            providerSubscriptionId: null,
            assignedOrderId: profile.assignedOrderId,
          },
          data: {
            status: InventoryStatus.PENDING_PROVIDER_CHECK,
            assignedOrderId: null,
            lastProviderCheckedAt: null,
            providerCheckError:
              "Provider recheck required after stale reservation release",
            version: { increment: 1 },
          },
        });
        if (changed.count === 1) released.push(profile.id);
        continue;
      }
      await this.resilience?.attention({
        dedupeKey: `stale-inventory-reservation:${profile.id}`,
        category: "INVENTORY_RESERVATION_STALE",
        entityType: "EsimInventory",
        entityId: profile.id,
        ...(order?.id ? { orderId: order.id } : {}),
        summary: `Reserved eSIM ${profile.iccid} needs reconciliation`,
        detail: `Reservation is older than ${hours} hour(s) and cannot be released without provider evidence`,
        localState: profile.status,
        ...(profile.providerStatus
          ? { externalState: profile.providerStatus }
          : {}),
        lastSuccessfulStep: "INVENTORY_RESERVED",
        failureCategory: "STALE_RESERVATION",
        availableActions: ["RECONCILE_RESERVATION"],
      });
      attention.push(profile.id);
    }
    return { released, attention };
  }

  async reconcileReservation(id: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const profile = await this.prisma.esimInventory.findUnique({
      where: { id },
      include: {
        assignedOrder: {
          select: { id: true, status: true, orderNumber: true },
        },
      },
    });
    if (!profile) throw new NotFoundException("Inventory profile not found");
    if (!profile.assignedOrderId)
      return this.reconcileProviderProfile(profile.id);
    const details = await this.connectivity.getEsimDetails(profile.iccid);
    const safe = ["available", "allocated"].includes(
      details.status.toLowerCase(),
    );
    if (
      safe &&
      !profile.providerSubscriptionId &&
      profile.assignedOrder &&
      [
        "CANCELLED",
        "PAYMENT_FAILED",
        "PROVISIONING_FAILED",
        "REFUNDED",
      ].includes(profile.assignedOrder.status)
    ) {
      await this.release(profile.assignedOrderId);
      await this.resilience?.resolve(
        `stale-inventory-reservation:${profile.id}`,
        null,
        "Provider confirmed the terminal order never bound this profile",
      );
      return { id, status: "RELEASED", providerStatus: details.status };
    }
    throw new ConflictException(
      "The reservation cannot be released; reconcile the provisioning operation using provider evidence",
    );
  }

  async customerIdForOrder(orderId: string) {
    if (!this.prisma.enabled) return `memory-${orderId}`;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    return order.customerId;
  }

  async refreshUsage(orderId: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const inventory = await this.inventoryForOrder(orderId);
    if (!inventory?.iccid)
      throw new NotFoundException(
        "No eSIM inventory is assigned to this order",
      );
    const customerEsim = await this.prisma.customerEsim.findUnique({
      where: { orderId },
      select: { id: true },
    });
    if (!customerEsim)
      throw new NotFoundException(
        "No customer eSIM record exists for this order",
      );
    const usage = await this.connectivity.getUsage(inventory.iccid);
    const checkedAt = new Date();
    if (usage.subscriptions?.length) {
      const balances = new Map(
        usage.subscriptions.map((item) => [item.providerSubscriptionId, item]),
      );
      const subscriptions = await this.prisma.subscription.findMany({
        where: { customerEsimId: customerEsim.id },
        select: { id: true, providerSubscriptionId: true },
      });
      await Promise.all(
        subscriptions.map((subscription) => {
          const balance = balances.get(subscription.providerSubscriptionId);
          return balance
            ? this.prisma.subscription.update({
                where: { id: subscription.id },
                data: {
                  usedMb: balance.usedMb,
                  totalMb: balance.totalMb,
                  usageLastCheckedAt: checkedAt,
                  providerLastSeenAt: checkedAt,
                },
              })
            : Promise.resolve();
        }),
      );
    } else {
      await this.prisma.subscription.updateMany({
        where: { customerEsimId: customerEsim.id },
        data: {
          usedMb: usage.usedMb,
          totalMb: usage.totalMb,
          usageLastCheckedAt: checkedAt,
        },
      });
    }
    return {
      orderId,
      ...usage,
      remainingMb: Math.max(0, usage.totalMb - usage.usedMb),
      lastCheckedAt: checkedAt.toISOString(),
    };
  }

  async reconcileProviderProfile(id: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const profile = await this.prisma.esimInventory.findUnique({
      where: { id },
      include: { batch: { select: { status: true } } },
    });
    if (!profile) throw new NotFoundException("Inventory profile not found");
    if (profile.batch.status !== BatchStatus.APPROVED)
      throw new BadRequestException(
        "The inventory batch must be approved before checking the provider",
      );
    try {
      const details = await this.connectivity.getEsimDetails(profile.iccid);
      const observed = details.status.toLowerCase();
      const safeUnassigned =
        observed === "available" || observed === "allocated";
      const unexpectedUse = profile.assignedOrderId === null && !safeUnassigned;
      const updated = await this.prisma.esimInventory.update({
        where: { id },
        data: {
          providerStatus: details.status,
          lastProviderCheckedAt: new Date(),
          providerCheckError: null,
          ...(details.smDpAddress ? { smDpAddress: details.smDpAddress } : {}),
          ...(unexpectedUse
            ? { status: InventoryStatus.QUARANTINED }
            : profile.assignedOrderId === null
              ? { status: InventoryStatus.AVAILABLE }
              : {}),
          version: { increment: 1 },
        },
      });
      if (unexpectedUse)
        await this.resilience?.attention({
          dedupeKey: `inventory-mismatch:${profile.id}`,
          category: "INVENTORY_MISMATCH",
          entityType: "EsimInventory",
          entityId: profile.id,
          summary: `eSIM ${profile.iccid} is not safe for sale`,
          localState: InventoryStatus.QUARANTINED,
          externalState: details.status,
          lastSuccessfulStep: "PROVIDER_CHECK",
          failureCategory: "UNSAFE_PROVIDER_STATE",
          availableActions: ["RECHECK_INVENTORY"],
        });
      else
        await this.resilience?.resolve(
          `inventory-mismatch:${profile.id}`,
          null,
          "Provider reports a safe unassigned state",
        );
      return {
        id,
        iccid: updated.iccid,
        localStatus: updated.status,
        providerStatus: details.status,
        inSync: !unexpectedUse,
        checkedAt: updated.lastProviderCheckedAt?.toISOString(),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 2000) : "unknown error";
      const providerStatus =
        error instanceof ApiException &&
        error.code === ApiErrorCode.ESIM_NOT_FOUND
          ? "not_found"
          : "check_failed";
      await this.prisma.esimInventory.update({
        where: { id },
        data: {
          providerStatus,
          lastProviderCheckedAt: new Date(),
          providerCheckError: message,
          ...(profile.status === InventoryStatus.PENDING_PROVIDER_CHECK ||
          profile.status === InventoryStatus.AVAILABLE
            ? { status: InventoryStatus.QUARANTINED }
            : {}),
          version: { increment: 1 },
        },
      });
      await this.resilience?.attention({
        dedupeKey: `inventory-mismatch:${profile.id}`,
        category: "INVENTORY_MISMATCH",
        entityType: "EsimInventory",
        entityId: profile.id,
        summary: `Provider check failed for eSIM ${profile.iccid}`,
        detail: message,
        localState: InventoryStatus.QUARANTINED,
        externalState: providerStatus,
        lastSuccessfulStep: "BATCH_APPROVED",
        failureCategory: "PROVIDER_CHECK_FAILED",
        availableActions: ["RECHECK_INVENTORY"],
      });
      throw error;
    }
  }

  /**
   * Returns quarantined, unassigned stock to the sellable pool only after a
   * fresh provider check proves that the eSIM is currently safe to allocate.
   * The guarded update prevents a concurrent reservation from being undone.
   */
  async restoreQuarantinedProfile(id: string, actorClerkId: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const profile = await this.prisma.esimInventory.findUnique({
      where: { id },
      include: {
        batch: { select: { id: true, status: true, batchReference: true } },
      },
    });
    if (!profile) throw new NotFoundException("Inventory profile not found");
    if (profile.status !== InventoryStatus.QUARANTINED)
      throw new ConflictException("Only quarantined inventory can be restored");
    if (profile.assignedOrderId || profile.providerSubscriptionId)
      throw new ConflictException(
        "Assigned or provider-bound inventory cannot be restored",
      );
    if (profile.batch?.status !== BatchStatus.APPROVED)
      throw new ConflictException(
        "Only inventory from an approved batch can be restored",
      );

    const details = await this.connectivity.getEsimDetails(profile.iccid);
    const providerStatus = details.status.toLowerCase();
    if (providerStatus !== "available" && providerStatus !== "allocated")
      throw new ConflictException(
        `Transatel reports ${providerStatus}; only available or allocated inventory can be restored`,
      );

    const actor = await this.localUser(actorClerkId);
    const checkedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const restored = await tx.esimInventory.updateMany({
        where: {
          id,
          status: InventoryStatus.QUARANTINED,
          assignedOrderId: null,
          providerSubscriptionId: null,
        },
        data: {
          status: InventoryStatus.AVAILABLE,
          providerStatus: details.status,
          lastProviderCheckedAt: checkedAt,
          providerCheckError: null,
          ...(details.smDpAddress ? { smDpAddress: details.smDpAddress } : {}),
          version: { increment: 1 },
        },
      });
      if (restored.count !== 1)
        throw new ConflictException(
          "Inventory changed during restoration; check it again",
        );
      await tx.auditLog.create({
        data: {
          module: "INVENTORY",
          entity: "EsimInventory",
          entityId: id,
          action: "QUARANTINE_RESTORED",
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: {
            status: profile.status,
            providerStatus: profile.providerStatus,
            batchReference: profile.batch.batchReference,
          },
          newValue: {
            status: InventoryStatus.AVAILABLE,
            providerStatus: details.status,
          },
        },
      });
    });
    return {
      id,
      iccid: profile.iccid,
      localStatus: InventoryStatus.AVAILABLE,
      providerStatus: details.status,
      checkedAt: checkedAt.toISOString(),
    };
  }

  async overview() {
    if (!this.prisma.enabled)
      return {
        counts: { available: 0, reserved: 0, assigned: 0, activated: 0 },
        lowStockThreshold: 10,
        lowStock: true,
        batches: [],
      };
    const [groups, batches] = await Promise.all([
      this.prisma.esimInventory.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      this.prisma.inventoryBatch.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);
    const count = (status: InventoryStatus) =>
      groups.find((item) => item.status === status)?._count._all ?? 0;
    const available = count(InventoryStatus.AVAILABLE);
    return {
      counts: {
        available,
        reserved: count(InventoryStatus.RESERVED),
        assigned: count(InventoryStatus.ASSIGNED),
        activated: count(InventoryStatus.ACTIVATED),
        pending:
          count(InventoryStatus.IMPORTED) +
          count(InventoryStatus.PENDING_PROVIDER_CHECK),
        expired: count(InventoryStatus.EXPIRED),
        terminated: count(InventoryStatus.TERMINATED),
        quarantined: count(InventoryStatus.QUARANTINED),
      },
      lowStockThreshold: 10,
      lowStock: available <= 10,
      batches: batches.map((batch) => ({
        id: batch.id,
        batchReference: batch.batchReference,
        totalProfiles: batch.totalProfiles,
        importedCount: batch.importedCount,
        failedCount: batch.failedCount,
        status: batch.status,
        rejectionReason: batch.rejectionReason,
        createdAt: batch.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Lists eSIM profiles with the overseas linkage back to the sale: which order
   * reserved/owns each SIM, which customer bought it, and which package (plan)
   * it belongs to. Available to OPERATIONS and SUPER_ADMIN.
   */
  async profiles(params?: {
    status?: InventoryStatus;
    assignment?: "ASSIGNED" | "UNASSIGNED";
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    if (!this.prisma.enabled) return { total: 0, items: [] };
    const limit = Math.min(params?.limit ?? 50, 200);
    const skip = params?.offset ? Number(params.offset) : 0;
    const query = params?.q?.trim().slice(0, 200);
    const where = {
      ...(params?.status ? { status: params.status } : {}),
      ...(params?.assignment === "ASSIGNED"
        ? { assignedOrderId: { not: null } }
        : params?.assignment === "UNASSIGNED"
          ? { assignedOrderId: null }
          : {}),
      ...(query
        ? {
            OR: [
              { iccid: { contains: query, mode: "insensitive" as const } },
              { eid: { contains: query, mode: "insensitive" as const } },
              { msisdn: { contains: query, mode: "insensitive" as const } },
              {
                providerSubscriptionId: {
                  contains: query,
                  mode: "insensitive" as const,
                },
              },
              {
                smDpAddress: { contains: query, mode: "insensitive" as const },
              },
              {
                batch: {
                  batchReference: {
                    contains: query,
                    mode: "insensitive" as const,
                  },
                },
              },
              {
                assignedOrder: {
                  is: {
                    OR: [
                      {
                        orderNumber: {
                          contains: query,
                          mode: "insensitive" as const,
                        },
                      },
                      {
                        externalOrderId: {
                          contains: query,
                          mode: "insensitive" as const,
                        },
                      },
                      {
                        providerSubscriptionId: {
                          contains: query,
                          mode: "insensitive" as const,
                        },
                      },
                      {
                        customer: {
                          is: {
                            OR: [
                              {
                                email: {
                                  contains: query,
                                  mode: "insensitive" as const,
                                },
                              },
                              {
                                customerCode: {
                                  contains: query,
                                  mode: "insensitive" as const,
                                },
                              },
                              {
                                phone: {
                                  contains: query,
                                  mode: "insensitive" as const,
                                },
                              },
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.esimInventory.count({ where }),
      this.prisma.esimInventory.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          batch: { select: { batchReference: true, status: true } },
          assignedOrder: {
            select: {
              orderNumber: true,
              status: true,
              plan: {
                select: {
                  name: true,
                  dataAllowance: true,
                  providerPlanId: true,
                  country: { select: { isoCode: true, name: true } },
                },
              },
              customer: { select: { email: true, customerCode: true } },
            },
          },
        },
      }),
    ]);
    return {
      total,
      items: items.map((profile) => ({
        id: profile.id,
        iccid: profile.iccid,
        eid: profile.eid,
        msisdn: profile.msisdn,
        status: profile.status,
        smDpAddress: profile.smDpAddress,
        providerSubscriptionId: profile.providerSubscriptionId,
        providerStatus: profile.providerStatus,
        lastProviderCheckedAt:
          profile.lastProviderCheckedAt?.toISOString() ?? null,
        providerCheckError: profile.providerCheckError,
        activatedAt: profile.activatedAt?.toISOString() ?? null,
        expiresAt: profile.expiresAt?.toISOString() ?? null,
        batchReference: profile.batch?.batchReference ?? null,
        batchStatus: profile.batch?.status ?? null,
        order: profile.assignedOrder
          ? {
              orderNumber: profile.assignedOrder.orderNumber,
              orderStatus: profile.assignedOrder.status,
              customerEmail: profile.assignedOrder.customer.email,
              customerCode: profile.assignedOrder.customer.customerCode,
              planName: profile.assignedOrder.plan.name,
              planCountry: profile.assignedOrder.plan.country.name,
              planCountryCode: profile.assignedOrder.plan.country.isoCode,
              dataAllowance: profile.assignedOrder.plan.dataAllowance,
            }
          : null,
      })),
      page: { limit, skip },
    };
  }
}
