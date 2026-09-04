import { LegalDocument } from "../components/legal-document";

export default function TermsPage() {
  return <LegalDocument title="Terms of service" version="1.0">
    <h2>Purchasing an eSIM</h2><p>You must provide accurate traveller information, confirm device compatibility and pay the displayed price before activation.</p>
    <h2>Service availability</h2><p>Coverage, speed and activation depend on the destination, device and mobile-network provider. Do not remove an installed eSIM that you intend to recharge.</p>
    <h2>Account and order security</h2><p>Keep order-recovery and recharge links private. Contact Visa Compass promptly if you believe a link or account has been compromised.</p>
    <h2>Support</h2><p>Contact Visa Compass support with your order number for purchase, activation or connectivity assistance.</p>
  </LegalDocument>;
}
