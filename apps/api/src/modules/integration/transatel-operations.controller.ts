import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@visa-compass/shared";
import { UserRoleName } from "@prisma/client";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
  requireRole,
} from "../../common/auth.guard.js";
import { TransatelOperationsService } from "./transatel-operations.service.js";

type LifecycleBody = { reason?: string; idempotencyKey?: string };

@Controller("operations/transatel")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class TransatelOperationsController {
  constructor(private readonly transatel: TransatelOperationsService) {}

  @Get()
  dashboard(
    @Req() request: AuthenticatedRequest,
    @Query("scope")
    scope?: "subscribers" | "inventory" | "failures" | "actions",
    @Query("q") q?: string,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.dashboard({
      actorId: request.user!.localUserId,
      ...(scope ? { scope } : {}),
      ...(q ? { q } : {}),
    });
  }

  @Get("diagnostics")
  diagnostics(@Req() request: AuthenticatedRequest) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.diagnostics();
  }

  @Post("sync-usage")
  syncUsage(@Req() request: AuthenticatedRequest) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.syncAllUsage();
  }

  @Post("orders/:id/reconcile")
  reconcile(
    @Param("id") orderId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.reconcile(orderId, request.user!.localUserId);
  }

  @Post("orders/:id/suspend")
  suspend(
    @Param("id") orderId: string,
    @Body() body: LifecycleBody,
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.suspend({
      orderId,
      reason: body.reason ?? "",
      idempotencyKey: body.idempotencyKey ?? "",
      actorId: request.user!.localUserId,
    });
  }

  @Post("inventory/:id/suspend")
  suspendInventory(
    @Param("id") inventoryId: string,
    @Body() body: LifecycleBody,
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.suspendInventory(inventoryId, {
      reason: body.reason ?? "",
      idempotencyKey: body.idempotencyKey ?? "",
      actorId: request.user!.localUserId,
    });
  }

  @Post("orders/:id/terminate")
  terminate(
    @Param("id") orderId: string,
    @Body() body: LifecycleBody,
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.SUPER_ADMIN]);
    return this.transatel.terminate({
      orderId,
      reason: body.reason ?? "",
      idempotencyKey: body.idempotencyKey ?? "",
      actorId: request.user!.localUserId,
    });
  }

  @Post("inventory/:id/terminate")
  terminateInventory(
    @Param("id") inventoryId: string,
    @Body() body: LifecycleBody,
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.SUPER_ADMIN]);
    return this.transatel.terminateInventory(inventoryId, {
      reason: body.reason ?? "",
      idempotencyKey: body.idempotencyKey ?? "",
      actorId: request.user!.localUserId,
    });
  }

  @Post("orders/:id/reactivate-request")
  requestReactivation(
    @Param("id") orderId: string,
    @Body() body: LifecycleBody,
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.requestReactivation({
      orderId,
      reason: body.reason ?? "",
      idempotencyKey: body.idempotencyKey ?? "",
      actorId: request.user!.localUserId,
    });
  }

  @Post("inventory/:id/reactivate-request")
  requestInventoryReactivation(
    @Param("id") inventoryId: string,
    @Body() body: LifecycleBody,
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.requestInventoryReactivation(inventoryId, {
      reason: body.reason ?? "",
      idempotencyKey: body.idempotencyKey ?? "",
      actorId: request.user!.localUserId,
    });
  }

  @Post("reactivations/:id/approve")
  approveReactivation(
    @Param("id") operationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.SUPER_ADMIN]);
    return this.transatel.approveReactivation(
      operationId,
      request.user!.localUserId,
    );
  }

  @Post("reactivations/:id/reject")
  rejectReactivation(
    @Param("id") operationId: string,
    @Body() body: { reason?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.SUPER_ADMIN]);
    return this.transatel.rejectReactivation(
      operationId,
      request.user!.localUserId,
      body.reason ?? "",
    );
  }
}
