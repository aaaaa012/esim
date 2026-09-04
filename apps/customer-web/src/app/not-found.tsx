import Link from "next/link";

export default function NotFound() {
  return <main className="shell" id="main-content"><section className="account-empty"><p className="recharge-kicker">404</p><h1>Page not found</h1><p>The page may have moved, expired or never existed.</p><Link className="button" href="/">Return home</Link></section></main>;
}
