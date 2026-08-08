import { SignIn } from '@clerk/nextjs';

export default function CustomerSignInPage() {
  return (
    <main className="auth-page">
      <SignIn routing="path" path="/sign-in" forceRedirectUrl="/account/esims" />
    </main>
  );
}
