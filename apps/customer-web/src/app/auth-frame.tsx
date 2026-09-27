import Image from "next/image";
import Link from "next/link";

export default function CustomerAuthFrame({
  children,
  title,
  description,
}: {
  children: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <main className="customer-auth-page">
      <div className="customer-auth-orbit customer-auth-orbit-one" aria-hidden="true" />
      <div className="customer-auth-orbit customer-auth-orbit-two" aria-hidden="true" />
      <section className="customer-auth-layout">
        <div className="customer-auth-intro">
          <Link href="/" className="customer-auth-brand" aria-label="Visa Compass Services home">
            <Image
              src="/brand/visa-compass-services-white.png"
              alt="Visa Compass Services"
              width={933}
              height={373}
              priority
            />
          </Link>
          <p className="customer-auth-kicker">Travel connectivity</p>
          <h1>{title}</h1>
          <p>{description}</p>
          <div className="customer-auth-route" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="customer-auth-panel">{children}</div>
      </section>
    </main>
  );
}
