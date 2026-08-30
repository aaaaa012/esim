import AuthenticatedApiProvider from "../authenticated-api-provider";

export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthenticatedApiProvider waitForSession>
      {children}
    </AuthenticatedApiProvider>
  );
}
