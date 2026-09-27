import type { Metadata } from "next";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import AuthenticatedApiProvider from "./authenticated-api-provider";
import OpsShell from "./ops-shell";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmationProvider } from "@/components/confirmation-provider";

export const metadata: Metadata = { title: "Visa Compass Operations" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <head>
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var t=localStorage.getItem("vc-ops-theme");if(t!=="dark"&&t!=="light")t="light";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="light"}})();`,
            }}
          />
        </head>
        <body>
          <ConfirmationProvider>
            <AuthenticatedApiProvider>
              <OpsShell>{children}</OpsShell>
            </AuthenticatedApiProvider>
          </ConfirmationProvider>
          <Toaster />
        </body>
      </html>
    </ClerkProvider>
  );
}
