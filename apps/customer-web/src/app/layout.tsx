import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import CustomerHeader from "./customer-header";
import { ClerkProvider } from "@clerk/nextjs";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Visa Compass eSIM",
  description: "Travel connected from the moment you land.",
};

export const viewport: Viewport = {
  themeColor: "#0b1c33",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en" className={inter.variable} suppressHydrationWarning>
        <head>
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var t=localStorage.getItem("vc-customer-theme");if(!t)t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="light"}})();`,
            }}
          />
        </head>
        <body>
          <CustomerHeader />
          {children}
          <footer className="footer">
            <div className="shell">
              <span>© {new Date().getFullYear()} Visa Compass Nepal. All rights reserved.</span>
              <span>
                Coverage depends on local partner networks · Device
                compatibility required
              </span>
            </div>
          </footer>
        </body>
      </html>
    </ClerkProvider>
  );
}
