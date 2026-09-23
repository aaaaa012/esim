import Image from "next/image";
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
