import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function AccountUnavailablePage() {
  return <main className="grid min-h-screen place-items-center bg-muted/30 px-4"><section className="w-full max-w-xl rounded-xl border bg-card p-8"><h1 className="text-xl font-semibold">Staff account unavailable</h1><p className="mt-3 text-sm text-muted-foreground">This staff account is disabled. Ask a Super Admin to review the account status.</p><Button asChild className="mt-6"><Link href="/sign-in">Return to sign in</Link></Button></section></main>;
}
