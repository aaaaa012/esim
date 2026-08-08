import './compatibility.css';

export default function Compatibility() {
  return (
    <main className="compatibility-page">
      <div className="shell compatibility-shell">
        <span className="eyebrow">Device check</span>
        <h1>Is your phone eSIM ready?</h1>
        <p className="compatibility-intro">
          Confirm your device supports eSIM before you buy. Compatible devices activate in seconds; incompatible ones
          are not eligible for a refund.
        </p>
        <div className="card">
          <h3>Quick manual check</h3>
          <p>
            Dial <b>*#06#</b>. If your device shows an EID, it generally supports eSIM. Also confirm with your
            manufacturer that the device is network-unlocked and supports eSIM in your market.
          </p>
          <p className="card-note">
            Important: Visa Compass cannot guarantee compatibility for every regional device variant. Please verify
            before payment.
          </p>
        </div>
      </div>
    </main>
  );
}
