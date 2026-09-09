import type { Metadata, Viewport } from "next";
import Image from "next/image";
import "./globals.css";
import CustomerHeader from "./customer-header";
import { ClerkProvider } from "@clerk/nextjs";
import Link from "next/link";
import { ExternalLink, MapPin, MessageCircle, Phone } from "lucide-react";

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
              <address className="footer-contact">
                <b>Visit or contact us</b>
                <a
                  href="https://maps.app.goo.gl/wE3iigygzFDKuyib7"
                  target="_blank"
                  rel="noreferrer"
                >
                  <MapPin size={16} aria-hidden="true" />
                  <span>
                    Prime-Rose Apartment Building, Ground Floor, Panchayan
                    Marg, Thapathali, Kathmandu
                  </span>
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
                <a
                  href="https://wa.me/9779715200219"
                  target="_blank"
                  rel="noreferrer"
                >
                  <MessageCircle size={16} aria-hidden="true" />
                  <span>WhatsApp: +977 9715200219</span>
                </a>
                <a href="tel:+97715927413">
                  <Phone size={16} aria-hidden="true" />
                  <span>Phone: +977 1 5927413</span>
                </a>
                <a
                  href="https://www.facebook.com/profile.php?id=61577297199446"
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={16} aria-hidden="true" />
                  <span>Facebook</span>
                </a>
              </address>
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
