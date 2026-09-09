const roundedGigabytes = (megabytes: number) =>
  Number((megabytes / 1024).toFixed(2));

export function formatDataMb(megabytes: number) {
  return megabytes >= 1024
    ? `${roundedGigabytes(megabytes).toLocaleString()} GB`
    : `${Math.round(megabytes).toLocaleString()} MB`;
}

export function formatPlanDataText(value: string) {
  return value.replace(
    /(\d+(?:\.\d+)?)\s*MB\b/gi,
    (_, amount: string) => formatDataMb(Number(amount)),
  );
}
