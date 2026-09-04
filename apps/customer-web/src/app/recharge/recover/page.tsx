"use client";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  LoaderCircle,
  Mail,
  ReceiptText,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import "../../esim/checkout/checkout.css";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
export default function RecoverRecharge() {
  const [orderNumber, setOrderNumber] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <main className="checkout-page recharge-recovery-page">
      <section className="checkout-card form-section recharge-recovery-card">
        <Link className="recovery-back-link" href="/#recharge">
          <ArrowLeft size={16} /> Back to recharge
        </Link>
        <span className="form-icon" aria-hidden="true">
          <ReceiptText size={23} />
        </span>
        <p className="recovery-kicker">Recharge tracking</p>
        <h1>Find your recharge</h1>
        <p>
          Enter the order number and the email used for the original eSIM
          purchase. We will send a private tracking link if they match.
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage("");
            setFailed(false);
            try {
              const response = await fetch(`${API}/recharges/recovery-link`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ orderNumber, email }),
              });
              if (!response.ok)
                throw new Error(
                  "We could not process this request. Please try again shortly.",
                );
              setMessage(
                "If these details match a recharge, a private tracking link will be sent to its recovery email.",
              );
            } catch (error) {
              setFailed(true);
              setMessage(
                error instanceof Error
                  ? error.message
                  : "Please try again shortly.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="recovery-order">
            <span>Recharge order number</span>
            <span className="recovery-input-shell">
              <ReceiptText size={17} aria-hidden="true" />
              <input
                id="recovery-order"
                required
                maxLength={100}
                value={orderNumber}
                onChange={(event) => setOrderNumber(event.target.value)}
                autoComplete="off"
                placeholder="e.g. VC-2026-520DD926"
              />
            </span>
            <small>Shown on your payment receipt and confirmation email.</small>
          </label>
          <label htmlFor="recovery-email">
            <span>Original purchase email</span>
            <span className="recovery-input-shell">
              <Mail size={17} aria-hidden="true" />
              <input
                id="recovery-email"
                required
                type="email"
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
              />
            </span>
            <small>Use the email that received the first eSIM QR code.</small>
          </label>
          <button className="button wide" disabled={busy}>
            {busy ? (
              <>
                <LoaderCircle className="spin" size={18} /> Sending securely…
              </>
            ) : (
              "Send private tracking link"
            )}
          </button>
        </form>
        {message ? (
          <div
            className={`recovery-feedback ${failed ? "error" : "success"}`}
            role={failed ? "alert" : "status"}
            aria-live="polite"
          >
            {failed ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
            <span>{message}</span>
          </div>
        ) : null}
        <p className="recovery-privacy-note">
          For privacy, the confirmation is the same whether or not an order
          matches.
        </p>
      </section>
    </main>
  );
}
