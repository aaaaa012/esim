import { SignUp } from "@clerk/nextjs";
import CustomerAuthFrame from "../../auth-frame";

export default function CustomerSignUpPage() {
  return (
    <CustomerAuthFrame
      title="Travel ready, from your first destination."
      description="Create your customer account to keep your eSIMs and orders in one place."
    >
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        forceRedirectUrl="/account/esims"
      />
    </CustomerAuthFrame>
  );
}
