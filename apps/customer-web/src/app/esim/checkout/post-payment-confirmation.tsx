"use client";

import Link from "next/link";
import {
  Check,
  ChevronRight,
  Clock3,
  QrCode,
  ShieldCheck,
  Signal,
} from "lucide-react";
import "./post-payment-confirmation.css";

type PaymentJourneyConfirmationProps = {
  orderNumber: string;
  amountNpr: number;
  status: string;
  trackingHref?: string | undefined;
  trackingLabel: string;
  deliveryNote?: string;
  pendingDeliveryNote?: string;
  onResend?: (() => void) | undefined;
  resending?: boolean;
  mode?: "new-esim" | "recharge";
};

export default function PaymentJourneyConfirmation({
  orderNumber,
  amountNpr,
  status,
  trackingHref,
  trackingLabel,
  deliveryNote,
  pendingDeliveryNote,
  onResend,
  resending = false,
  mode = "new-esim",
}: PaymentJourneyConfirmationProps) {
  const recharge = mode === "recharge";
  const reviewing = status === "REVIEW_PENDING";
  const ready =
    !recharge &&
    ["QR_READY", "ACTIVATION_ATTENTION", "COMPLETED"].includes(status);
  const dataAdded =
    recharge &&
    ["QR_READY", "ACTIVATION_ATTENTION", "COMPLETED"].includes(status);
  const dataActive = recharge && status === "COMPLETED";
  const preparationCopy =
    status === "PAYMENT_CONFIRMED" || status === "APPROVED"
      ? "Payment is secure. Your eSIM will be prepared next."
      : "Your eSIM is being prepared. This page updates as the order progresses.";

  return (
    <section
      className="payment-journey"
      aria-label={
        recharge ? "Payment and recharge status" : "Payment and eSIM status"
      }
    >
      <div className="payment-journey-receipt" role="status">
        <span className="payment-journey-receipt-icon" aria-hidden="true">
          <Check size={29} />
        </span>
        <div className="payment-journey-receipt-copy">
          <h3>Payment confirmed</h3>
          <p>
            {recharge
              ? "We’ve received your payment for more data."
              : "We’ve received your payment. Your eSIM order is safe."}
          </p>
        </div>
        <div className="payment-journey-receipt-details">
          <span>
            <small>Amount paid</small>
            <strong>NPR {amountNpr.toLocaleString()}</strong>
          </span>
          <span>
            <small>Order number</small>
            <strong>{orderNumber}</strong>
          </span>
        </div>
      </div>

      <ol className="payment-journey-timeline" aria-label="Order progress">
        <li className="complete">
          <span className="payment-journey-marker" aria-hidden="true">
            <Check size={19} />
          </span>
          <div>
            <b>Payment confirmed</b>
            <p>Your payment has been received.</p>
          </div>
        </li>
        {recharge ? (
          <>
            <li
              className={
                dataAdded
                  ? "complete"
                  : status === "PROVISIONING"
                    ? "active"
                    : "upcoming"
              }
            >
              <span className="payment-journey-marker" aria-hidden="true">
                {dataAdded ? <Check size={19} /> : <Signal size={19} />}
              </span>
              <div>
                <b>Adding data</b>
                <p>
                  {dataAdded
                    ? "The package has been added to your existing eSIM."
                    : status === "PROVISIONING"
                      ? "We’re adding the package to your existing eSIM."
                      : "We’ll add the package after payment processing."}
                </p>
              </div>
            </li>
            <li className={dataActive ? "complete" : "upcoming"}>
              <span className="payment-journey-marker" aria-hidden="true">
                {dataActive ? <Check size={19} /> : <Clock3 size={19} />}
              </span>
              <div>
                <b>Data active</b>
                <p>
                  {dataActive
                    ? "Your new data package is active."
                    : "The package becomes active when the provider confirms first use."}
                </p>
              </div>
            </li>
          </>
        ) : (
          <>
            {reviewing && (
              <li className="active">
                <span className="payment-journey-marker" aria-hidden="true">
                  <ShieldCheck size={19} />
                </span>
                <div>
                  <b>Reviewing documents</b>
                  <p>We&apos;ll resume eSIM preparation after the review.</p>
                </div>
              </li>
            )}
            <li
              className={
                ready
                  ? "complete"
                  : status === "PROVISIONING"
                    ? "active"
                    : "upcoming"
              }
            >
              <span className="payment-journey-marker" aria-hidden="true">
                {ready ? <Check size={19} /> : <Clock3 size={19} />}
              </span>
              <div>
                <b>Preparing eSIM</b>
                <p>
                  {ready
                    ? "Your eSIM has been prepared."
                    : reviewing
                      ? "Preparation starts after document review."
                      : preparationCopy}
                </p>
              </div>
            </li>
            <li className={ready ? "complete" : "upcoming"}>
              <span className="payment-journey-marker" aria-hidden="true">
                {ready ? <Check size={19} /> : <QrCode size={19} />}
              </span>
              <div>
                <b>Ready to install</b>
                <p>
                  {ready
                    ? "Your installation details are ready."
                    : "Installation details appear when your eSIM is ready."}
                </p>
              </div>
            </li>
          </>
        )}
      </ol>

      <div
        className={`payment-journey-next${ready || dataAdded ? " is-ready" : ""}`}
      >
        <span className="payment-journey-next-icon" aria-hidden="true">
          {recharge ? <Signal size={29} /> : <QrCode size={29} />}
        </span>
        <div>
          <b>
            {recharge
              ? dataActive
                ? "Your new data package is active"
                : dataAdded
                  ? "Data has been added to your eSIM"
                  : status === "PROVISIONING"
                    ? "We’re adding data to your eSIM"
                    : "Payment received. We’ll add your data next"
              : ready
                ? "Your eSIM is ready"
                : reviewing
                  ? "We’ll update this order after review"
                  : "Your installation details are on the way"}
          </b>
          <p>
            {recharge
              ? dataAdded
                ? dataActive
                  ? "Your existing eSIM is ready to use with the new package. No new QR code or installation is needed."
                  : "The package is on your existing eSIM and will activate on first use. No new QR code or installation is needed."
                : "No new QR code or installation is needed. Track this recharge while the package is added."
              : ready
                ? (deliveryNote ?? "Open your order for installation details.")
                : reviewing
                  ? "No further payment is needed. After approval, we’ll prepare the eSIM and email your installation QR."
                  : (pendingDeliveryNote ??
                    "No need to start another payment. Track this order for the next update.")}
          </p>
        </div>
      </div>

      <div className="payment-journey-actions">
        {trackingHref && (
          <Link className="button" href={trackingHref}>
            {trackingLabel} <ChevronRight size={18} aria-hidden="true" />
          </Link>
        )}
        {ready && onResend && (
          <button
            className="button secondary"
            type="button"
            onClick={onResend}
            disabled={resending}
          >
            {resending ? "Sending QR…" : "Re-send QR email"}
          </button>
        )}
        <Link className="button secondary" href="/destinations">
          Explore plans
        </Link>
      </div>
    </section>
  );
}
