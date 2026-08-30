import { SignUp } from "@clerk/nextjs";

export default function BootstrapSignUpPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <div className="w-full max-w-md">
        <SignUp routing="path" path="/sign-up" forceRedirectUrl="/" />
        <p className="mt-3 rounded-xl border bg-card p-4 text-sm text-muted-foreground">
          Staff accounts are created by your administrator. Registration here is
          only for the one-time initial Super Admin bootstrap; any other sign-up
          is treated as a customer identity and cannot access this console.
        </p>
      </div>
    </main>
  );
}
