import { UserProfile } from "@clerk/nextjs";

export default function SecurityEnrollmentPage() {
  return (
    <section className="panel">
      <div className="top">
        <div>
          <h1>Super Admin security</h1>
          <p>
            Enable an authenticator or backup-code second factor, then sign out
            and sign back in before opening Administration.
          </p>
        </div>
      </div>
      <UserProfile routing="path" path="/security" />
    </section>
  );
}
