import type { Metadata, Viewport } from "next";
import Image from "next/image";
import "./globals.css";
import CustomerHeader from "./customer-header";
import { ClerkProvider } from "@clerk/nextjs";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Visa Compass eSIM",
  description: "Travel connected from the moment you land.",
};

export const viewport: Viewport = {
  themeColor: "#f7f8f6",
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
      <html lang="en" suppressHydrationWarning>
        <head>
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var t=localStorage.getItem("vc-customer-theme");if(t!=="dark"&&t!=="light")t="light";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="light"}})();`,
            }}
          />
        </head>
        <body>
          <CustomerHeader />
          {children}
          <footer className="footer">
            <div className="shell">
              <Image
                className="footer-logo"
                src="/brand/visa-compass-services-white.png"
                alt="Visa Compass Services"
                width={933}
                height={373}
              />
              <div className="footer-copy">
                <span>
                  © {new Date().getFullYear()} Visa Compass Nepal. All rights
                  reserved.
                </span>
                <span>
                  Coverage depends on local partner networks · Device
                  compatibility required
                </span>
                <b>Travel eSIM connectivity powered by Ubigi.</b>
                <span><Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link> · <Link href="/refund-policy">Refund policy</Link></span>
              </div>
            </div>
          </footer>
        </body>
      </html>
    </ClerkProvider>
  );
}
