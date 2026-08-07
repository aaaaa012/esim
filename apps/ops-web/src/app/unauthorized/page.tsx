import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 dark:bg-slate-950">
      <section className="panel" style={{ maxWidth: 520 }}>
        <h1>This account can&apos;t access the operations console</h1>
        <p>
          The account you signed in with doesn&apos;t have staff access. Only
          OPERATIONS or SUPER_ADMIN accounts can use this portal. If you
          believe this is a mistake, contact your administrator.
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <Link className="primary-action" href="/sign-in">
            Sign in with a staff account
          </Link>
          <Link className="secondary-action" href="/">
            Go to customer portal
          </Link>
        </div>
      </section>
    </main>
  );
}
