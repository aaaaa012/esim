import { Body, Controller, Post } from "@nestjs/common";
import { AdminService } from "./admin.service.js";

/** Public only to holders of a single-use staff invitation link. */
@Controller("staff-activation")
export class StaffActivationController {
  constructor(private readonly admin: AdminService) {}

  @Post("complete")
  complete(
    @Body()
    body: {
      token?: string;
      firstName?: string;
      lastName?: string;
      password?: string;
    },
  ) {
    return this.admin.activateInvitation(
      body?.token ?? "",
      body?.firstName ?? "",
      body?.lastName ?? "",
      body?.password ?? "",
    );
  }
}
