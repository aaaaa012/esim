"use client";

import { useState } from "react";

export function FonepayBankLogo({
  name,
  src,
}: {
  name: string;
  src?: string | undefined;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <span className="fonepay-bank-logo">
      {!loaded ? (
        <span className="fonepay-bank-fallback" aria-hidden="true">
          {name.trim().slice(0, 1).toUpperCase() || "B"}
        </span>
      ) : null}
      {showImage ? (
        <img
          className={loaded ? "loaded" : ""}
          src={src}
          alt={`${name} logo`}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}
