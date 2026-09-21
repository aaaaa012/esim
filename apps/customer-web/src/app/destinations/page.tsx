import { Suspense } from "react";
import { Globe2 } from "lucide-react";
import CatalogPlans from "../catalog-plans";
import {
  JourneyArtwork,
  JourneySkyline,
  JourneyTrustStrip,
} from "../journey-chrome";
import "../home.css";

export default function DestinationsPage() {
  return (
    <main>
      <section className="section destinations-page" id="plans">
        <JourneyArtwork />
        <div className="shell">
          <div className="plans-intro">
            <div className="section-title">
              <span className="eyebrow">
                <Globe2 size={14} /> Available destinations
              </span>
              <h1>Choose where you need data.</h1>
              <p>
                Select a destination to compare available eSIM plans without
                leaving this page.
              </p>
            </div>
          </div>
          <Suspense
            fallback={<p className="catalog-empty">Loading destinations…</p>}
          >
            <CatalogPlans />
          </Suspense>
          <JourneyTrustStrip compact />
        </div>
        <JourneySkyline />
      </section>
    </main>
  );
}
