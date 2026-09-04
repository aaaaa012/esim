import Link from "next/link";

export default function UnauthorizedPage() {
  return <main className="shell" id="main-content"><section className="account-empty"><h1>Customer access required</h1><p>This area is available to customer accounts. Use the Operations portal for a staff account.</p><Link className="button" href="/sign-in">Use another account</Link><Link className="button secondary" href="/">Return home</Link></section></main>;
}
