import { SignUp } from "@clerk/nextjs";

export default function BootstrapSignUpPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 dark:bg-slate-950">
      <div style={{ width: "100%", maxWidth: 480 }}>
        <SignUp routing="path" path="/sign-up" forceRedirectUrl="/" />
        <p className="panel" style={{ marginTop: 12, fontSize: 13 }}>
          Staff accounts are created by your administrator. Registration here is
          only for the one-time initial Super Admin bootstrap; any other sign-up
          is treated as a customer identity and cannot access this console.
        </p>
      </div>
    </main>
  );
}
