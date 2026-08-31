import { SignIn } from "@clerk/nextjs";

export default function OperationsSignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <SignIn
          routing="path"
          path="/sign-in"
          fallbackRedirectUrl="/"
          transferable={false}
          withSignUp={false}
        />
      </div>
    </main>
  );
}
