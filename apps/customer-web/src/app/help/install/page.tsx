import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Mail,
  Plane,
  QrCode,
  Settings,
  Smartphone,
  Wifi,
} from "lucide-react";
import {
  JourneyArtwork,
  JourneySkyline,
  JourneyTrustStrip,
} from "../../journey-chrome";
import "../help.css";
import "./install.css";

export const metadata: Metadata = {
  title: "eSIM installation guide | Visa Compass",
  description:
    "Install your Visa Compass travel eSIM before departure and connect safely when you arrive.",
};

const steps = [
  {
    icon: Mail,
    title: "Find your installation email",
    copy: "After verification and provisioning succeed, we send your QR image and installation details to your purchase email. Signed-in customers can also open My eSIM.",
  },
  {
    icon: QrCode,
    title: "Open the QR on another screen",
    copy: "Keep the QR visible on a laptop, tablet, or another phone so your travelling phone can scan it.",
  },
  {
    icon: Settings,
    title: "Add the eSIM in phone settings",
    copy: "On iPhone, open Settings, Mobile or Cellular Data, then Add eSIM. On Android, open Network or Connections, SIM manager, then Add eSIM.",
  },
  {
    icon: Plane,
    title: "Install before departure",
    copy: "Complete installation while you have reliable Wi-Fi. Keep your usual SIM enabled unless your phone requires otherwise.",
  },
  {
    icon: Wifi,
    title: "Enable the Ubigi line near arrival",
    copy: "Choose the installed Ubigi line for mobile data and enable data roaming for that line when you are ready to connect.",
  },
];

export default function InstallGuidePage() {
  return (
    <main className="install-guide-page">
      <JourneyArtwork />
      <div className="shell install-guide-shell">
        <Link className="install-back" href="/help">
          <ArrowLeft /> Back to Help
        </Link>
        <header className="install-guide-hero">
          <span className="eyebrow">
            <Smartphone /> eSIM setup guide
          </span>
          <h1>Install before you travel.</h1>
          <p>
            Use these device-neutral steps after your QR is ready. Menu names
            can vary by phone manufacturer and software version.
          </p>
        </header>
        <section className="install-steps" aria-label="eSIM installation steps">
          {steps.map(({ icon: Icon, title, copy }, index) => (
            <article key={title}>
              <span>
                <Icon aria-hidden="true" />
              </span>
              <div>
                <small>Step {index + 1}</small>
                <h2>{title}</h2>
                <p>{copy}</p>
              </div>
            </article>
          ))}
        </section>
        <aside className="install-support">
          <div>
            <b>Still cannot install?</b>
            <p>
              Do not delete a partially installed eSIM. Contact us with your
              order number and phone model.
            </p>
          </div>
          <div>
            <Link className="button" href="/account/esims">
              Open My eSIM <ArrowRight />
            </Link>
            <a
              className="button secondary"
              href="mailto:support@visacompassnepal.com"
            >
              Contact support
            </a>
          </div>
        </aside>
        <JourneyTrustStrip compact />
      </div>
      <JourneySkyline />
    </main>
  );
}
