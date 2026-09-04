"use client";

export default function ServiceUnavailablePage() {
  return <main className="shell" id="main-content"><section className="account-empty"><h1>Service temporarily unavailable</h1><p>We couldn’t verify your account because the service did not respond. Your orders have not been changed.</p><button className="button" onClick={() => window.location.reload()}>Try again</button><a className="button secondary" href="/">Return home</a></section></main>;
}
