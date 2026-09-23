import { Check, Clock3, FileCheck2, LockKeyhole, Mail } from "lucide-react";

type TravelerIdentity = {
  firstName: string;
  middleName: string;
  surname: string;
  dateOfBirth: string;
  passportNumber: string;
  passportExpiryDate: string;
  nationality: string;
};

export default function ManualReviewTracking({
  traveler,
  orderNumber,
  failureCode,
}: {
  traveler: TravelerIdentity;
  orderNumber: string;
  failureCode?: string | undefined;
}) {
  const details = [
    [
      "Name",
      [traveler.firstName, traveler.middleName, traveler.surname]
        .filter(Boolean)
        .join(" "),
    ],
    ["Date of birth", traveler.dateOfBirth],
    ["Passport number", traveler.passportNumber],
    ["Passport expiry", traveler.passportExpiryDate],
    ["Nationality", traveler.nationality],
  ];
  const reason =
    failureCode === "MRZ_REVIEW_REQUIRED"
      ? "We couldn't reliably read the passport's machine-readable lines. Our team will compare your submitted details with the saved document."
      : "Your passport requires a human check before payment. Our team will compare your submitted details with the saved document.";
  const supportSubject = encodeURIComponent(
    `Correction needed for order ${orderNumber}`,
  );
  return (
    <section
      className="manual-review-tracking"
      aria-labelledby="manual-review-title"
    >
      <span className="manual-review-status">
        <Clock3 size={17} aria-hidden="true" /> Awaiting human review
      </span>
      <h1 id="manual-review-title">Your documents are awaiting approval</h1>
      <p className="manual-review-lead">
        Your files and traveller details are saved. You can leave this page and
        return later. This page checks for a decision automatically, and payment
        becomes available after approval.
      </p>
      <p className="manual-review-order">Order #{orderNumber}</p>
      <ol className="manual-review-timeline" aria-label="Verification progress">
        <li className="complete">
          <Check size={19} aria-hidden="true" />
          <span>Documents submitted</span>
        </li>
        <li className="current" aria-current="step">
          <Clock3 size={19} aria-hidden="true" />
          <span>Awaiting human review</span>
        </li>
        <li>
          <LockKeyhole size={19} aria-hidden="true" />
          <span>Payment after approval</span>
        </li>
      </ol>
      <div className="manual-review-explanation">
        <FileCheck2 size={20} aria-hidden="true" />
        <p>{reason}</p>
      </div>
      <details className="manual-review-submission">
        <summary>Review submitted identity details</summary>
        <dl className="manual-review-details">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || "Not provided"}</dd>
            </div>
          ))}
        </dl>
      </details>
      <div className="manual-review-help">
        <div>
          <h2>Spot a mistake?</h2>
          <p>
            These details are locked during review. Tell support your order
            number so they can help correct them before approval. Please don't
            email your passport image.
          </p>
        </div>
        <a
          className="button secondary"
          href={`mailto:support@visacompassnepal.com?subject=${supportSubject}`}
        >
          <Mail size={17} aria-hidden="true" /> Report an error
        </a>
      </div>
    </section>
  );
}
