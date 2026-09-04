import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function UnauthorizedPage() {
  return <main className="grid min-h-screen place-items-center bg-muted/30 px-4"><section className="w-full max-w-xl rounded-xl border bg-card p-8"><h1 className="text-xl font-semibold">You don’t have access to this area</h1><p className="mt-3 text-sm text-muted-foreground">Your account is signed in, but its assigned role does not permit this operation.</p><Button asChild className="mt-6"><Link href="/">Return to dashboard</Link></Button></section></main>;
}
