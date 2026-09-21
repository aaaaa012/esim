import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  CreditCard,
  FileSearch,
  Mail,
  MessageCircle,
  Phone,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import "./help.css";
import {
  JourneyArtwork,
  JourneySkyline,
  JourneyTrustStrip,
} from "../journey-chrome";

export const metadata: Metadata = {
  title: "Help and support | Visa Compass eSIM",
  description:
    "Get help with Visa Compass eSIM payments, orders, verification, installation, compatibility, and recharge tracking.",
};

const SUPPORT_EMAIL = "support@visacompassnepal.com";

function supportEmail(subject: string) {
  const body = [
    "Hello Visa Compass Support,",
    "",
    "Please help me with:",
    "Order number (if available):",
    "Purchase email:",
    "What happened:",
    "",
    "I understand I should not email passport files, full card information, passwords, or verification codes.",
  ].join("\n");
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function HelpPage() {
  return (
    <main className="help-page">
      <JourneyArtwork />
      <div className="shell help-shell">
        <section className="help-hero" aria-labelledby="help-title">
          <div>
            <span className="eyebrow">
              <BadgeCheck size={14} /> Visa Compass support
            </span>
            <h1 id="help-title">How can we help?</h1>
            <p>
              Choose the issue closest to yours. We&apos;ll point you to the
              safest next step or connect you with our support team.
            </p>
          </div>
          <aside
            className="help-contact-summary"
            aria-label="Primary support contact"
          >
            <Mail size={22} aria-hidden="true" />
            <div>
              <span>Email support</span>
              <a href={supportEmail("Visa Compass support request")}>
                {SUPPORT_EMAIL}
              </a>
              <small>Typically responds within 24 hours.</small>
            </div>
            <ArrowRight aria-hidden="true" />
          </aside>
        </section>

        <section
          className="help-payment-alert"
          aria-labelledby="payment-help-title"
        >
          <AlertTriangle size={22} aria-hidden="true" />
          <div>
            <h2 id="payment-help-title">Payment failed or money deducted?</h2>
            <p>
              If money may have left your account, do not pay again. Check your
              order first so we can avoid a duplicate payment.
            </p>
          </div>
          <div className="help-alert-actions">
            <Link href="/account/orders">View my orders</Link>
            <a href={supportEmail("Payment failed or money deducted")}>
              Email payment support
            </a>
          </div>
        </section>

        <section className="help-topics" aria-labelledby="help-topics-title">
          <div className="help-section-heading">
            <span>Self-service help</span>
            <h2 id="help-topics-title">What do you need help with?</h2>
          </div>
          <div className="help-topic-grid">
            <article className="help-topic-card help-install-card">
              <span className="help-topic-icon">
                <FileSearch />
              </span>
              <h3>Order or verification issue</h3>
              <p>
                Review your order for document re-upload, manual review, or
                another action. Guests can reopen the private checkout link
                previously provided to them.
              </p>
              <div className="help-topic-actions">
                <Link href="/account/orders">
                  Check my orders <ArrowRight />
                </Link>
                <a href={supportEmail("Order or verification support")}>
                  Email support
                </a>
              </div>
            </article>

            <article className="help-topic-card">
              <span className="help-topic-icon">
                <RefreshCw />
              </span>
              <h3>Recharge problem</h3>
              <p>
                Track an existing recharge using its order number and the email
                used for the original eSIM purchase.
              </p>
              <div className="help-topic-actions">
                <Link href="/recharge/recover">
                  Find my recharge <ArrowRight />
                </Link>
                <a href={supportEmail("Recharge support")}>Email support</a>
              </div>
            </article>

            <article className="help-topic-card">
              <span className="help-topic-icon">
                <Smartphone />
              </span>
              <h3>Install or use my eSIM</h3>
              <p>
                Open My eSIM to find installation details, your QR code, usage,
                expiry information, and available actions.
              </p>
              <div className="help-topic-actions">
                <Link href="/help/install">
                  Open setup guide <ArrowRight />
                </Link>
                <a
                  href={supportEmail("eSIM installation or connection support")}
                >
                  Email support
                </a>
              </div>
            </article>

            <article className="help-topic-card">
              <span className="help-topic-icon">
                <ShieldCheck />
              </span>
              <h3>Check phone compatibility</h3>
              <p>
                Confirm that your phone has an EID and is network-unlocked
                before purchasing a plan.
              </p>
              <div className="help-topic-actions">
                <Link href="/compatibility">
                  Check my phone <ArrowRight />
                </Link>
                <a href={supportEmail("Device compatibility support")}>
                  Email support
                </a>
              </div>
            </article>
          </div>
        </section>

        <JourneyTrustStrip />

        <section
          className="help-contact"
          aria-labelledby="contact-support-title"
        >
          <div className="help-contact-copy">
            <span>Human support</span>
            <h2 id="contact-support-title">Still need help?</h2>
            <p>
              Include your order number and purchase email when relevant. This
              helps us locate the correct order without exposing sensitive data.
            </p>
            <div className="help-privacy-note">
              <CreditCard size={18} aria-hidden="true" />
              <span>
                Never send passport files, complete card details, passwords, or
                authentication codes by email or WhatsApp.
              </span>
            </div>
          </div>
          <div className="help-contact-actions">
            <a
              className="button"
              href={supportEmail("Visa Compass support request")}
            >
              <Mail size={18} /> Email support
            </a>
            <a
              className="button secondary"
              href="https://wa.me/9779715200219"
              target="_blank"
              rel="noreferrer"
            >
              <MessageCircle size={18} /> WhatsApp +977 9715200219
            </a>
            <a className="help-phone-link" href="tel:+97715927413">
              <Phone size={17} /> Call +977 1 5927413
            </a>
          </div>
        </section>
      </div>
      <JourneySkyline />
    </main>
  );
}
