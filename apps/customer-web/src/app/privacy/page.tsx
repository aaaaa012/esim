import { LegalDocument } from "../components/legal-document";

export default function PrivacyPage() {
  return <LegalDocument title="Privacy policy" version="1.0">
    <h2>Information we collect</h2><p>We process account, traveller, identity-document, order, payment and eSIM information needed to sell, verify and support the service.</p>
    <h2>How we use information</h2><p>We use it for identity verification, fulfilment, fraud prevention, customer support, legal compliance and service security.</p>
    <h2>Sharing and retention</h2><p>We share only necessary data with payment, identity, storage and connectivity providers. Records are retained according to legal and operational requirements.</p>
    <h2>Your choices</h2><p>Contact Visa Compass to request access or correction and to ask which deletion or restriction rights apply to your records.</p>
  </LegalDocument>;
}
