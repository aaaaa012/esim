import { SignIn } from "@clerk/nextjs";
import CustomerAuthFrame from "../../auth-frame";

export default function CustomerSignInPage() {
  return (
    <CustomerAuthFrame
      title="Your trip starts connected."
      description="Sign in to view your eSIMs, orders, and travel-ready connection details."
    >
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl="/account/esims"
      />
    </CustomerAuthFrame>
  );
}
