import { SignIn } from '@clerk/nextjs';

export default function CustomerSignInPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <SignIn routing="path" path="/sign-in" forceRedirectUrl="/account" />
    </main>
  );
}
