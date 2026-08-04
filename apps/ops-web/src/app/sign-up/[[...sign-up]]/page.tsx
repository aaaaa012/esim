import { SignUp } from "@clerk/nextjs";

export default function BootstrapSignUpPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 dark:bg-slate-950">
      <SignUp routing="path" path="/sign-up" forceRedirectUrl="/" />
    </main>
  );
}
