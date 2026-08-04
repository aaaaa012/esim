import type { Metadata } from "next";
import "./globals.css";
import "./portal-upgrades.css";
import "./theme.css";
import { ClerkProvider } from "@clerk/nextjs";
import AuthenticatedApiProvider from "./authenticated-api-provider";
import OpsShell from "./ops-shell";
export const metadata: Metadata = { title: "Visa Compass Operations" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <AuthenticatedApiProvider>
            <OpsShell>{children}</OpsShell>
          </AuthenticatedApiProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
