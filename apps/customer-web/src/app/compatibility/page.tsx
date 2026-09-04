import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Smartphone,
  Wifi,
} from "lucide-react";
import "./compatibility.css";

export default function Compatibility() {
  return (
    <main className="compatibility-page">
      <div className="shell compatibility-shell">
        <div className="compatibility-hero">
          <div className="compatibility-copy">
            <span className="eyebrow">
              <Smartphone size={14} /> Device check
            </span>
            <h1>Is your phone eSIM ready?</h1>
            <p className="compatibility-intro">
              Take two quick checks before you buy. Your phone must support eSIM
              and be network-unlocked.
            </p>
            <div className="compatibility-points">
              <span>
                <CheckCircle2 /> Find an EID on your device
              </span>
              <span>
                <CheckCircle2 /> Confirm it is network-unlocked
              </span>
            </div>
          </div>
          <div className="compatibility-visual">
            <Image
              src="/images/esim-compatibility-guide.jpeg"
              alt="Three-step guide to check eSIM compatibility by dialing star hash zero six hash and looking for an EID"
              width={768}
              height={1376}
              priority
              sizes="(max-width: 800px) 100vw, 460px"
            />
          </div>
        </div>

        <div className="compatibility-guide">
          <div className="check-card primary-check">
            <span className="check-number">01</span>
            <div>
              <h2>Look for your EID</h2>
              <p>
                Open your phone dialler and enter <strong>*#06#</strong>. If an
                EID appears, your device generally has eSIM hardware.
              </p>
            </div>
          </div>
          <div className="check-card">
            <span className="check-number">02</span>
            <div>
              <h2>Confirm the device is unlocked</h2>
              <p>
                Check with your manufacturer or current carrier. Regional
                variants and carrier-locked phones may restrict eSIM.
              </p>
            </div>
          </div>
        </div>

        <div className="compatibility-note" role="note">
          <Wifi size={20} />
          <div>
            <b>One final reminder</b>
            <p>
              Visa Compass cannot verify every regional device variant remotely.
              Confirm compatibility before payment; incompatible devices are not
              eligible for a refund.
            </p>
          </div>
        </div>
        <div className="compatibility-actions">
          <Link href="/destinations" className="button">
            Browse plans <ArrowRight size={17} />
          </Link>
          <Link href="/" className="button secondary">
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
