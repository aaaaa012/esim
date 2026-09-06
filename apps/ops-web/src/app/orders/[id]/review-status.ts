export function orderSourceLabel(channel?: string, hasPartner = false) {
  if (channel === "PARTNER_HOSTED") return "Partner hosted checkout";
  if (channel === "PARTNER_API") return "Partner API";
  if (channel === "CUSTOMER_WEB") return "Direct website checkout";
  return hasPartner ? "Partner" : "Not recorded";
}

export function documentReviewLabel(
  document: { type: string; status: string; uploadVerified?: boolean },
  passportVerificationStatus?: string,
) {
  if (document.status === "APPROVED")
    return document.type === "PASSPORT" &&
      passportVerificationStatus === "VERIFIED"
      ? "Verified automatically"
      : "Approved";
  // A replacement request is authoritative even if an older OCR verdict exists.
  if (document.status === "PENDING") {
    if (
      document.type === "PASSPORT" &&
      passportVerificationStatus === "VERIFIED"
    )
      return "Verified automatically";
    return document.uploadVerified
      ? "Uploaded · awaiting manual review"
      : "Awaiting manual review";
  }
  return document.status;
}

export function orderEventLabel(event: {
  from?: string | null;
  to: string;
  reason?: string;
}) {
  if (event.from === event.to) {
    if (event.reason === "Passport verified automatically")
      return "Passport verified";
    if (event.reason === "Passport partially matched; routed to manual review")
      return "Documents need manual review";
    if (event.reason === "Passport verification failed; replacement requested")
      return "Document re-upload requested";
  }
  if (event.to === "APPROVED" && event.reason === "Auto-approved after payment")
    return "Approved for activation";
  return event.to;
}
