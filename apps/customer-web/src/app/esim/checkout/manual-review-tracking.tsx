import { LockKeyhole, ShieldCheck } from "lucide-react";

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
  onBack,
}: {
  traveler: TravelerIdentity;
  onBack: () => void;
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
  return (
    <section
      className="manual-review-tracking"
      aria-labelledby="manual-review-title"
    >
      <div className="manual-review-heading">
        <ShieldCheck size={24} aria-hidden="true" />
        <div>
          <h3 id="manual-review-title">Review in progress</h3>
          <p>
            No action is needed right now. We will update this order and email
            you when payment is available. If a replacement is needed, we will
            show the exact document and reason here.
          </p>
        </div>
      </div>
      <dl className="manual-review-details">
        {details.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || "Not provided"}</dd>
          </div>
        ))}
      </dl>
      <p className="manual-review-lock">
        <LockKeyhole size={16} aria-hidden="true" />
        These identity details are read-only while the review is open.
      </p>
      <button type="button" className="button secondary" onClick={onBack}>
        View uploaded documents
      </button>
    </section>
  );
}
