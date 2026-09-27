import { LegalDocument } from "../components/legal-document";

export default function RefundPolicyPage() {
  return <LegalDocument title="Refund policy" version="1.0">
    <h2>Before activation</h2><p>Contact support promptly if fulfilment has not started. Eligibility depends on the order and payment state.</p>
    <h2>After activation</h2><p>Used, installed or activated eSIM services are generally not refundable unless Visa Compass or its provider failed to supply the purchased service.</p>
    <h2>Device compatibility</h2><p>Purchases made for locked or incompatible devices are not eligible for a compatibility-based refund after fulfilment.</p>
    <h2>How to request review</h2><p>Provide your order number and a clear explanation. Approved refunds return through the applicable payment process and may require provider confirmation.</p>
  </LegalDocument>;
}
