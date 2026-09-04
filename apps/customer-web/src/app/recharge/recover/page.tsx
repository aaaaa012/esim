"use client";
import Link from "next/link";
import { useState } from "react";
import "../../esim/checkout/checkout.css";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
export default function RecoverRecharge() {
  const [orderNumber, setOrderNumber] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="checkout-page">
      <section className="checkout-card form-section">
        <h1>Find your recharge</h1>
        <p>
          Enter the recharge order number and the original purchase email used
          to authorize it.
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage("");
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
          <label>
            Order number
            <input
              required
              maxLength={100}
              value={orderNumber}
              onChange={(event) => setOrderNumber(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Original purchase email
            <input
              required
              type="email"
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />
          </label>
          <button className="button" disabled={busy}>
            {busy ? "Requesting…" : "Send tracking link"}
          </button>
        </form>
        <p role="status">{message}</p>
        <Link href="/">Return home</Link>
      </section>
    </main>
  );
}
