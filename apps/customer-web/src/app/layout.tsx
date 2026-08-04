import type { Metadata } from 'next';
import './globals.css';
import CustomerHeader from './customer-header';
import { ClerkProvider } from '@clerk/nextjs';
import AuthenticatedApiProvider from './authenticated-api-provider';

export const metadata: Metadata = { title: 'Visa Compass eSIM', description: 'Travel connected from the moment you land.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider><html lang="en"><body><CustomerHeader/><AuthenticatedApiProvider>{children}</AuthenticatedApiProvider><footer className="footer"><div className="shell"><span>© 2026 Visa Compass Nepal. All rights reserved.</span><span>Coverage depends on local partner networks · Device compatibility required</span></div></footer></body></html></ClerkProvider>;
}
