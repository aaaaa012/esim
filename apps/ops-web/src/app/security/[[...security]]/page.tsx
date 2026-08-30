import { UserProfile } from "@clerk/nextjs";

export default function SecurityEnrollmentPage() {
  return (
    <section className="mx-auto w-full max-w-3xl space-y-6 rounded-xl border bg-card p-6 shadow-card sm:p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Super Admin security
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Enable an authenticator or backup-code second factor, then sign out
          and sign back in before opening Administration.
        </p>
      </div>
      <UserProfile routing="path" path="/security" />
    </section>
  );
}
