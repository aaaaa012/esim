export function paymentActionDisabled(input: {
  isTopUp: boolean;
  verifyingPassport: boolean;
  passportGatePassed: boolean;
}) {
  return (
    input.verifyingPassport ||
    (!input.isTopUp && !input.passportGatePassed)
  );
}
