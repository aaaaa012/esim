import Link from "next/link";

export function LegalDocument({ title, version, children }: { title: string; version: string; children: React.ReactNode }) {
  return (
    <main className="shell" id="main-content" style={{ paddingBlock: "4rem 6rem", maxWidth: "52rem" }}>
      <Link href="/">← Back to Visa Compass</Link>
      <article style={{ marginTop: "2rem" }}>
        <p className="recharge-kicker">Legal information · version {version}</p>
        <h1>{title}</h1>
        <p>Effective 4 September 2026</p>
        {children}
      </article>
    </main>
  );
}
