import { Suspense } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Globe2,
  Headset,
  Plane,
  QrCode,
  ShieldCheck,
  Smartphone,
  Timer,
  Wifi,
  Zap,
} from "lucide-react";
import CatalogPlans from "./catalog-plans";
import TopupLookup from "./topup-lookup";
import Faq from "./faq";
import PartnersShowcase from "./partners-showcase";
import {
  CampaignProvider,
  FeaturedCampaign,
  GuideCampaign,
  OfferGallery,
  PoweredByBar,
  WhyCampaign,
} from "./homepage-campaigns";
import "./home.css";

export default function Home() {
  return (
    <CampaignProvider>
      <main>
        <PoweredByBar />
        <section className="hero">
          <div className="shell hero-grid">
            <div>
              <span className="eyebrow">
                <Plane size={14} />
                Built for Nepali travellers
              </span>
              <h1>
                Land connected.
                <br />
                Travel <em>freely.</em>
              </h1>
              <p>
                Get secure travel data before you fly. No airport queues, no
                physical SIM swaps—just scan your Visa Compass eSIM and go.
              </p>
              <div className="actions">
                <Link className="button" href="#plans">
                  Find your plan <ArrowRight size={17} />
                </Link>
                <Link className="button secondary" href="#how">
                  How it works
                </Link>
              </div>
              <div
                className="hero-proof"
                aria-label="Why travellers choose Visa Compass"
              >
                <span>
                  <CheckCircle2 size={16} /> Keep your number
                </span>
                <span>
                  <CheckCircle2 size={16} /> Install before you fly
                </span>
                <span>
                  <CheckCircle2 size={16} /> Support when you need it
                </span>
              </div>
            </div>
            <div className="phone-stage">
              <div className="phone">
                <div className="screen">
                  <div className="screen-head">
                    <div className="app-ident">
                      <Wifi size={15} />
                      <b>My eSIM</b>
                    </div>
                    <span className="signal">
                      <i />
                      READY
                    </span>
                  </div>
                  <div className="plan-chip">
                    <span className="flag">🇦🇪</span>
                    <span className="pc-txt">
                      <small>Active plan</small>
                      <b>UAE Essential · 5 GB</b>
                    </span>
                    <span className="pc-meta">
                      <b>15 days</b>
                      <small>valid</small>
                    </span>
                  </div>
                  <div className="qr" />
                  <div className="qr-caption">Scan to install your eSIM</div>
                  <button className="install-pill" disabled>
                    <QrCode size={15} />
                    Install now
                  </button>
                </div>
              </div>
              <div className="float-chip float-a">
                <span className="fc-ic">
                  <Zap size={15} />
                </span>
                <span className="fc-txt">
                  <em>Instant</em>
                  <small>QR in minutes</small>
                </span>
              </div>
              <div className="float-chip float-b">
                <span className="fc-ic">
                  <ShieldCheck size={15} />
                </span>
                <span className="fc-txt">
                  <em>NPR pricing</em>
                  <small>No hidden fees</small>
                </span>
              </div>
            </div>
          </div>
        </section>

        <FeaturedCampaign />
        <OfferGallery />

        <section className="section" id="plans">
          <div className="shell">
            <div className="section-title">
              <span className="eyebrow">
                <Globe2 size={14} />
                Popular destinations
              </span>
              <h2>One plan. Zero roaming surprises.</h2>
              <p>
                Clear NPR pricing, trusted coverage, and a secure digital
                delivery experience from checkout to activation.
              </p>
            </div>
            <TopupLookup />
            <Suspense fallback={null}>
              <CatalogPlans />
            </Suspense>
          </div>
        </section>

        <section className="section" id="how">
          <div className="shell">
            <div className="section-title">
              <span className="eyebrow">
                <Smartphone size={14} />
                Simple by design
              </span>
              <h2>Connected in three steps</h2>
            </div>
            <div className="how-layout">
              <GuideCampaign />
              <div className="steps-panel">
                <div className="steps-intro">
                  <span>From compatible phone to active eSIM</span>
                  <p>Complete these steps before departure, then connect as soon as you land.</p>
                </div>
                <ol className="steps">
                <li className="step">
                  <span className="step-number">1</span>
                  <div>
                    <h3>Check your phone</h3>
                    <p>
                      Dial <strong>*#06#</strong> and confirm that your device shows an EID before buying.
                    </p>
                  </div>
                </li>
                <li className="step">
                  <span className="step-number">2</span>
                  <div>
                    <h3>Choose and purchase your plan</h3>
                    <p>
                      Select your destination and data allowance, then pay securely in NPR.
                    </p>
                  </div>
                </li>
                <li className="step">
                  <span className="step-number">3</span>
                  <div>
                    <h3>Install and activate</h3>
                    <p>
                      Scan the private QR code from your email and install the eSIM before departure.
                    </p>
                  </div>
                </li>
                </ol>
                <div className="activation-tip">
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <p><strong>Before landing:</strong> turn on your Ubigi line. Your selected plan starts automatically when you arrive.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="why-us">
          <div className="shell">
            <div className="section-title">
              <span className="eyebrow">
                <Zap size={14} />
                Why Visa Compass
              </span>
              <h2>Travel light. Stay connected.</h2>
              <p>
                Everything a traveller needs to land connected — priced clearly
                in NPR, without the roaming shock.
              </p>
            </div>
            <WhyCampaign />
            <div className="why-grid">
              <div className="why-card">
                <span className="why-icon">
                  <Wifi size={22} />
                </span>
                <h3>Instant digital eSIM</h3>
                <p>
                  Receive your QR code after payment verification and successful
                  provider provisioning. No physical SIM or airport counter.
                </p>
              </div>
              <div className="why-card">
                <span className="why-icon">
                  <Timer size={22} />
                </span>
                <h3>Connect before you fly</h3>
                <p>
                  Activate your data the moment you land. Skip queues and start
                  exploring while others wait in roaming lines.
                </p>
              </div>
              <div className="why-card">
                <span className="why-icon">
                  <ShieldCheck size={22} />
                </span>
                <h3>Transparent NPR pricing</h3>
                <p>
                  Every plan shows its full cost in NPR before you pay. No
                  hidden fees, no surprise roaming bills on return.
                </p>
              </div>
              <div className="why-card">
                <span className="why-icon">
                  <QrCode size={22} />
                </span>
                <h3>One eSIM, many plans</h3>
                <p>
                  Store several country plans on a single eSIM and top up an
                  existing one using just your mobile number.
                </p>
              </div>
              <div className="why-card">
                <span className="why-icon">
                  <Headset size={22} />
                </span>
                <h3>Local support</h3>
                <p>
                  Travel document review, activation help and re-delivery of
                  your QR — handled by a team that responds.
                </p>
              </div>
              <div className="why-card">
                <span className="why-icon">
                  <Globe2 size={22} />
                </span>
                <h3>Real-time usage</h3>
                <p>
                  Track your data in your account and refresh live usage
                  whenever you need a quick top-up decision.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="section section-alt" id="faq">
          <div className="shell">
            <div className="section-title">
              <span className="eyebrow">
                <Headset size={14} />
                Questions, answered
              </span>
              <h2>Frequently asked questions</h2>
              <p>Quick answers about compatibility, payment and activation.</p>
            </div>
            <Faq />
          </div>
        </section>

        <PartnersShowcase />

        <section className="section" id="support">
          <div className="shell">
            <div className="notice">
              <div className="notice-graphic" aria-hidden="true">
                <span>
                  <Smartphone size={30} />
                </span>
                <i className="notice-check">
                  <CheckCircle2 size={18} />
                </i>
              </div>
              <div>
                <span className="notice-kicker">Before you purchase</span>
                <h2>Not sure your phone supports eSIM?</h2>
                <p>
                  Take our two-minute compatibility check before payment and
                  travel with confidence.
                </p>
              </div>
              <Link href="/compatibility" className="button secondary">
                <ShieldCheck size={18} />
                Check compatibility
              </Link>
            </div>
          </div>
        </section>
      </main>
    </CampaignProvider>
  );
}
