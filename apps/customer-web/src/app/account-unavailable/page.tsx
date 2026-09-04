import Link from "next/link";

export default function AccountUnavailablePage() {
  return <main className="shell" id="main-content"><section className="account-empty"><h1>Account unavailable</h1><p>This account is currently disabled. Contact Visa Compass support if you believe this is incorrect.</p><Link className="button" href="/">Return home</Link></section></main>;
}
