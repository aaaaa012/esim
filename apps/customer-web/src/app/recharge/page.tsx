import type { Metadata } from "next";
import AuthenticatedApiProvider from "../authenticated-api-provider";
import RechargeClient from "./recharge-client";
import "../home.css";

export const metadata: Metadata = {
  title: "Recharge your eSIM | Visa Compass",
  description: "Add data to your own Visa Compass eSIM or securely recharge for someone else.",
};

export default function RechargePage() {
  return (
    <AuthenticatedApiProvider>
      <RechargeClient />
    </AuthenticatedApiProvider>
  );
}
