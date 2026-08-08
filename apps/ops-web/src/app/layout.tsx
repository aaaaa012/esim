import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import AuthenticatedApiProvider from "./authenticated-api-provider";
import OpsShell from "./ops-shell";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = { title: "Visa Compass Operations" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={inter.variable} suppressHydrationWarning>
        <head>
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var t=localStorage.getItem("vc-ops-theme");if(!t)t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="light"}})();`,
            }}
          />
        </head>
        <body>
          <AuthenticatedApiProvider>
            <OpsShell>{children}</OpsShell>
          </AuthenticatedApiProvider>
          <Toaster />
        </body>
      </html>
    </ClerkProvider>
  );
}