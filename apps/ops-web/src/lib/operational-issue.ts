export type OperationalIssue = {
  code: string;
  title: string;
  summary: string;
  action: string;
};

const knownIssues: Record<string, Omit<OperationalIssue, "code">> = {
  SUBSCRIBER_STATUS_NOT_ELIGIBLE: {
    title: "eSIM is not eligible for a top-up",
    summary:
      "The network rejected the new package because the eSIM's current network status does not allow another subscription.",
    action:
      "Check the live eSIM and subscription status. If it is suspended, terminated, still activating, or has another network change in progress, resolve or wait for that state before retrying. Do not charge the customer again.",
  },
  ELIGIBILITY_REJECTED: {
    title: "Top-up eligibility was rejected",
    summary:
      "The network says this eSIM cannot receive the selected package in its current state.",
    action:
      "Check the live network status and selected plan, then retry only after the blocking state is resolved.",
  },
  AMBIGUOUS_OUTCOME: {
    title: "Network result is uncertain",
    summary:
      "The request may have reached the network, but our system did not receive a final answer.",
    action:
      "Use Check provider status. Do not start another activation until reconciliation confirms the result.",
  },
  CONNECTIVITY_UNAVAILABLE: {
    title: "Network provider is temporarily unavailable",
    summary: "The provider could not complete or confirm the request.",
    action: "Wait briefly, then check provider status before retrying.",
  },
  INVENTORY_UNAVAILABLE: {
    title: "No safe eSIM stock is available",
    summary: "The order is waiting for an assignable eSIM profile.",
    action: "Check inventory and import or release verified stock.",
  },
};

function extractCode(raw?: string | null, category?: string | null) {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { title?: string; type?: string };
      if (parsed.title) return parsed.title.toUpperCase();
      const typeCode = parsed.type?.split("/").at(-1);
      if (typeCode) return typeCode.toUpperCase();
    } catch {
      const match = raw.match(
        /SUBSCRIBER_STATUS_NOT_ELIGIBLE|ELIGIBILITY_REJECTED|AMBIGUOUS_OUTCOME|CONNECTIVITY_UNAVAILABLE|INVENTORY_UNAVAILABLE/i,
      );
      if (match) return match[0].toUpperCase();
    }
  }
  return (category || "UNCLASSIFIED_PROVIDER_ISSUE").toUpperCase();
}

export function operationalIssue(
  raw?: string | null,
  category?: string | null,
): OperationalIssue {
  const code = extractCode(raw, category);
  const known = knownIssues[code];
  if (known) return { code, ...known };
  return {
    code,
    title: "Network set-up needs review",
    summary:
      "The last network request did not complete normally. Technical details remain available in Integration logs.",
    action:
      "Open the order, check its current provider status, and retry only when the displayed action allows it.",
  };
}
