import Image from "next/image";
import { CreditCard, Headset, Wifi } from "lucide-react";
import heroLight from "../../../../visa_compass_ui_assets/01_hero_light.webp";
import heroDark from "../../../../visa_compass_ui_assets/02_hero_dark.webp";
import skylineLight from "../../../../visa_compass_ui_assets/03_bottom_skyline_light.png";
import skylineDark from "../../../../visa_compass_ui_assets/04_bottom_skyline_dark.png";

export function JourneyArtwork({ className = "" }: { className?: string }) {
  return (
    <div className={`journey-artwork ${className}`} aria-hidden="true">
      <Image
        className="journey-artwork-light"
        src={heroLight}
        alt=""
        width={579}
        height={379}
        priority
        sizes="(max-width: 880px) 100vw, 1px"
      />
      <Image
        className="journey-artwork-dark"
        src={heroDark}
        alt=""
        width={579}
        height={379}
        priority
        sizes="(max-width: 880px) 100vw, 1px"
      />
    </div>
  );
}

export function JourneyTrustStrip({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`journey-trust${compact ? " compact" : ""}`}
      aria-label="Why travellers choose Visa Compass"
    >
      <div>
        <span>
          <CreditCard aria-hidden="true" />
        </span>
        <p>
          <b>Secure NPR payments</b>
          <small>Khalti and Fonepay</small>
        </p>
      </div>
      <div>
        <span>
          <Wifi aria-hidden="true" />
        </span>
        <p>
          <b>Reliable global coverage</b>
          <small>Powered by Ubigi</small>
        </p>
      </div>
      <div>
        <span>
          <Headset aria-hidden="true" />
        </span>
        <p>
          <b>Local support from Nepal</b>
          <small>Here to help</small>
        </p>
      </div>
    </div>
  );
}

export function JourneySkyline() {
  return (
    <div className="journey-skyline" aria-hidden="true">
      <Image
        className="journey-skyline-light"
        src={skylineLight}
        alt=""
        width={570}
        height={101}
        sizes="(max-width: 880px) 100vw, 1px"
      />
      <Image
        className="journey-skyline-dark"
        src={skylineDark}
        alt=""
        width={570}
        height={101}
        sizes="(max-width: 880px) 100vw, 1px"
      />
    </div>
  );
}
