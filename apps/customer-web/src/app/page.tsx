import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CheckCircle2,
  CreditCard,
  Headset,
  Plane,
  QrCode,
  ShieldCheck,
  Smartphone,
  Signal,
  Wifi,
  Zap,
} from "lucide-react";
import heroLight from "../../../../visa_compass_ui_assets/01_hero_light.webp";
import heroDark from "../../../../visa_compass_ui_assets/02_hero_dark.webp";
import skylineLight from "../../../../visa_compass_ui_assets/03_bottom_skyline_light.png";
import skylineDark from "../../../../visa_compass_ui_assets/04_bottom_skyline_dark.png";
import Faq from "./faq";
import PartnersShowcase from "./partners-showcase";
import {
  CampaignProvider,
  FeaturedCampaign,
  GuideCampaign,
  OfferGallery,
} from "./homepage-campaigns";
import {
  HeroDestinationSearch,
  HomepageExplorerProvider,
  PopularRightNow,
} from "./homepage-explorer";
import "./home.css";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ country?: string }>;
}) {
  const { country } = await searchParams;
  if (country && /^[A-Za-z]{2}$/.test(country))
    redirect(`/destinations?country=${country.toUpperCase()}`);
  return (
    <CampaignProvider>
      <HomepageExplorerProvider>
        <main>
          <section className="hero" aria-labelledby="home-hero-title">
            <div className="hero-scene" aria-hidden="true">
              <Image
                className="hero-scene-image hero-scene-light"
                src={heroLight}
                alt=""
                priority
                sizes="(max-width: 860px) 100vw, 58vw"
              />
              <Image
                className="hero-scene-image hero-scene-dark"
                src={heroDark}
                alt=""
                sizes="(max-width: 860px) 100vw, 58vw"
              />
            </div>
            <div className="hero-mobile-notes" aria-hidden="true">
              <span className="hero-note-origin">
                From
                <br />
                Nepal
                <br />
                to the World
              </span>
              <span className="hero-note-journey">
                More Places.
                <br />
                Brighter Journeys.
              </span>
              <Plane className="hero-note-plane" size={28} />
            </div>
            <div className="shell hero-grid">
              <div className="hero-copy">
                <span className="eyebrow">
                  <Plane size={14} />
                  Built for Nepali travellers
                </span>
                <h1 id="home-hero-title">
                  Your data lands <em>before you do.</em>
                </h1>
                <p>
                  Buy a travel eSIM in Nepali rupees, install it before takeoff,
                  and connect when you arrive.
                </p>
                <div
                  className="hero-partner-trust"
                  aria-label="Connectivity partner"
                >
                  <Wifi size={14} aria-hidden="true" />
                  <span>Global connectivity</span>
                  <b>powered by Ubigi</b>
                </div>
                <HeroDestinationSearch />
              </div>
              <div className="phone-stage">
                <div className="phone">
                  <span className="phone-button phone-button-silent" />
                  <span className="phone-button phone-button-volume-up" />
                  <span className="phone-button phone-button-volume-down" />
                  <span className="phone-button phone-button-power" />
                  <div className="screen">
                    <div className="iphone-status" aria-hidden="true">
                      <span>9:41</span>
                      <span className="iphone-status-icons">
                        <Signal size={12} strokeWidth={2.5} />
                        <Wifi size={12} strokeWidth={2.5} />
                        <i className="iphone-battery" />
                      </span>
                    </div>
                    <Image
                      className="screen-watermark"
                      src="/brand/visa-compass-nepal-outline.png"
                      alt=""
                      width={933}
                      height={371}
                    />
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
                      <span
                        className="flag"
                        role="img"
                        aria-label="United Arab Emirates"
                      >
                        🇦🇪
                      </span>
                      <span className="pc-txt">
                        <small>Active plan</small>
                        <b>UAE Essential · 5 GB</b>
                      </span>
                      <span className="pc-meta">
                        <b>15 days</b>
                        <small>valid</small>
                      </span>
                    </div>
                    <div className="connection-route" aria-hidden="true">
                      <span>Kathmandu</span>
                      <i>
                        <Plane size={12} />
                      </i>
                      <span>Dubai</span>
                    </div>
                    <div className="qr">
                      <span className="qr-scan" aria-hidden="true" />
                    </div>
                    <div className="qr-caption">Scan to install your eSIM</div>
                    <button className="install-pill" disabled>
                      <QrCode size={15} />
                      Install now
                    </button>
                    <div className="activation-toast" aria-hidden="true">
                      <span>
                        <CheckCircle2 size={14} />
                      </span>
                      <div>
                        <b>Ready before take-off</b>
                        <small>Your plan activates on arrival</small>
                      </div>
                    </div>
                    <span
                      className="iphone-home-indicator"
                      aria-hidden="true"
                    />
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
            <div
              className="shell hero-confidence"
              aria-label="Why travellers choose Visa Compass"
            >
              <div>
                <span>
                  <CreditCard size={22} aria-hidden="true" />
                </span>
                <p>
                  <b>Secure NPR payments</b>
                  <small>Khalti and Fonepay</small>
                </p>
              </div>
              <div>
                <span>
                  <Wifi size={22} aria-hidden="true" />
                </span>
                <p>
                  <b>Reliable global coverage</b>
                  <small>Powered by Ubigi</small>
                </p>
              </div>
              <div>
                <span>
                  <Headset size={22} aria-hidden="true" />
                </span>
                <p>
                  <b>Local support from Nepal</b>
                  <small>Here to help</small>
                </p>
              </div>
            </div>
            <div className="hero-skyline" aria-hidden="true">
              <Image
                className="hero-skyline-image hero-skyline-light"
                src={skylineLight}
                alt=""
                sizes="100vw"
              />
              <Image
                className="hero-skyline-image hero-skyline-dark"
                src={skylineDark}
                alt=""
                sizes="100vw"
              />
            </div>
          </section>

          <PopularRightNow />
          <FeaturedCampaign />
          <OfferGallery />
          <section
            className="trust-assurance"
            aria-labelledby="trust-assurance-title"
          >
            <div className="shell">
              <div className="trust-panel">
                <div className="trust-panel-intro">
                  <span>Travel with confidence</span>
                  <h2 id="trust-assurance-title">Clear before you pay.</h2>
                  <p>
                    Local payment, proven connectivity and practical support
                    from purchase to activation.
                  </p>
                  <div className="trust-panel-links">
                    <Link href="/compatibility">Check compatibility</Link>
                    <Link href="/refund-policy">Refund policy</Link>
                  </div>
                </div>
                <ul className="trust-proof-list">
                  <li>
                    <span>
                      <ShieldCheck size={20} aria-hidden="true" />
                    </span>
                    <div>
                      <b>Secure NPR payment</b>
                      <small>Khalti and Fonepay</small>
                    </div>
                  </li>
                  <li>
                    <span>
                      <Wifi size={20} aria-hidden="true" />
                    </span>
                    <div>
                      <b>Ubigi connectivity</b>
                      <small>Global network partner</small>
                    </div>
                  </li>
                  <li>
                    <span>
                      <QrCode size={20} aria-hidden="true" />
                    </span>
                    <div>
                      <b>Digital QR delivery</b>
                      <small>After verification and provisioning</small>
                    </div>
                  </li>
                  <li>
                    <span>
                      <Headset size={20} aria-hidden="true" />
                    </span>
                    <div>
                      <b>Local Nepal support</b>
                      <small>Help from Kathmandu</small>
                    </div>
                  </li>
                </ul>
              </div>
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
                    <p>
                      Complete these steps before departure, then connect as
                      soon as you land.
                    </p>
                  </div>
                  <ol className="steps">
                    <li className="step">
                      <span className="step-number">1</span>
                      <div>
                        <h3>Check your phone</h3>
                        <p>
                          Dial <strong>*#06#</strong> and confirm that your
                          device shows an EID before buying.
                        </p>
                      </div>
                    </li>
                    <li className="step">
                      <span className="step-number">2</span>
                      <div>
                        <h3>Choose and purchase your plan</h3>
                        <p>
                          Select your destination and data allowance, then pay
                          securely in NPR.
                        </p>
                      </div>
                    </li>
                    <li className="step">
                      <span className="step-number">3</span>
                      <div>
                        <h3>Install and activate</h3>
                        <p>
                          Scan the private QR code from your email and install
                          the eSIM before departure.
                        </p>
                      </div>
                    </li>
                  </ol>
                  <div className="activation-tip">
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <p>
                      <strong>Before landing:</strong> turn on your Ubigi line.
                      Your selected plan starts automatically when you arrive.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section
            className="recharge-section recharge-teaser"
            id="recharge"
            aria-labelledby="recharge-title"
          >
            <div className="shell">
              <div className="recharge-panel">
                <div className="recharge-marker" aria-hidden="true">
                  <span>02</span>
                  <i />
                  <small>Recharge</small>
                </div>
                <div className="recharge-content">
                  <span className="recharge-icon" aria-hidden="true">
                    <QrCode size={21} />
                  </span>
                  <p className="recharge-kicker">Keep your eSIM installed</p>
                  <h2 id="recharge-title">Ready for your next trip?</h2>
                  <p className="recharge-description">
                    Signed-in customers can choose their eSIM and go straight to
                    plans. You can also securely recharge an eSIM for a friend.
                  </p>
                  <Link
                    className="button recharge-teaser-action"
                    href="/recharge"
                  >
                    Recharge an eSIM <span aria-hidden="true">→</span>
                  </Link>
                  <Link
                    className="recharge-recovery-link"
                    href="/recharge/recover"
                  >
                    Already paid? Track an existing recharge
                  </Link>
                </div>
                <aside
                  className="recharge-note"
                  aria-label="How recharge works"
                >
                  <span>No reinstall</span>
                  <strong>Your existing eSIM stays on your phone.</strong>
                  <p>
                    Choose a new data plan, pay securely in NPR, and keep
                    travelling.
                  </p>
                </aside>
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
                <p>
                  Quick answers about compatibility, payment and activation.
                </p>
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
      </HomepageExplorerProvider>
    </CampaignProvider>
  );
}
