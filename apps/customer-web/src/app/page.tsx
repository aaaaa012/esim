import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Globe2, Headset, Plane, QrCode, ShieldCheck, Smartphone, Timer, Wifi, Zap } from 'lucide-react';
import CatalogPlans from './catalog-plans';
import TopupLookup from './topup-lookup';
import Faq from './faq';
import PartnersShowcase from './partners-showcase';
import './home.css';

export default function Home() {
  return (
    <main>
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
              Get secure travel data before you fly. No airport queues, no physical SIM swaps—just scan your Visa
              Compass eSIM and go.
            </p>
            <div className="actions">
              <Link className="button" href="#plans">
                Find your plan <ArrowRight size={17} />
              </Link>
              <Link className="button secondary" href="#how">
                How it works
              </Link>
            </div>
            <div className="hero-proof" aria-label="Why travellers choose Visa Compass">
              <span><CheckCircle2 size={16} /> Keep your number</span>
              <span><CheckCircle2 size={16} /> Install before you fly</span>
              <span><CheckCircle2 size={16} /> Support when you need it</span>
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
                    <i />READY
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

      <section className="section" id="plans">
        <div className="shell">
          <div className="section-title">
            <span className="eyebrow">
              <Globe2 size={14} />
              Popular destinations
            </span>
            <h2>One plan. Zero roaming surprises.</h2>
            <p>Clear NPR pricing, trusted coverage, and a secure digital delivery experience from checkout to activation.</p>
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
          <div className="steps">
            <div className="step">
              <span className="step-number">1</span>
              <h3>Choose your destination</h3>
              <p>Compare country plans with transparent data, validity, and coverage details.</p>
            </div>
            <div className="step">
              <span className="step-number">2</span>
              <h3>Verify and pay securely</h3>
              <p>Confirm device compatibility, add travel documents, and pay via Khalti.</p>
            </div>
            <div className="step">
              <span className="step-number">3</span>
              <h3>Scan your QR code</h3>
              <p>After review, your eSIM QR stays available in your private Visa Compass account.</p>
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
            <p>Everything a traveller needs to land connected — priced clearly in NPR, without the roaming shock.</p>
          </div>
          <div className="why-grid">
            <div className="why-card">
              <span className="why-icon"><Wifi size={22} /></span>
              <h3>Instant digital eSIM</h3>
              <p>Receive your QR code after payment verification and successful provider provisioning. No physical SIM or airport counter.</p>
            </div>
            <div className="why-card">
              <span className="why-icon"><Timer size={22} /></span>
              <h3>Connect before you fly</h3>
              <p>Activate your data the moment you land. Skip queues and start exploring while others wait in roaming lines.</p>
            </div>
            <div className="why-card">
              <span className="why-icon"><ShieldCheck size={22} /></span>
              <h3>Transparent NPR pricing</h3>
              <p>Every plan shows its full cost in NPR before you pay. No hidden fees, no surprise roaming bills on return.</p>
            </div>
            <div className="why-card">
              <span className="why-icon"><QrCode size={22} /></span>
              <h3>One eSIM, many plans</h3>
              <p>Store several country plans on a single eSIM and top up an existing one using just your mobile number.</p>
            </div>
            <div className="why-card">
              <span className="why-icon"><Headset size={22} /></span>
              <h3>Local support</h3>
              <p>Travel document review, activation help and re-delivery of your QR — handled by a team that responds.</p>
            </div>
            <div className="why-card">
              <span className="why-icon"><Globe2 size={22} /></span>
              <h3>Real-time usage</h3>
              <p>Track your data in your account and refresh live usage whenever you need a quick top-up decision.</p>
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
            <div>
              <h2>Not sure your phone supports eSIM?</h2>
              <p>Check compatibility before payment. Purchases cannot be refunded for incompatible devices.</p>
            </div>
            <Link href="/compatibility" className="button secondary">
              <ShieldCheck size={18} />
              Check my device
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
