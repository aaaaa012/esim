import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return <main className="grid min-h-[70dvh] place-items-center px-4"><section className="w-full max-w-xl rounded-xl border bg-card p-8"><p className="text-sm font-medium text-muted-foreground">404</p><h1 className="mt-2 text-xl font-semibold">Workspace page not found</h1><p className="mt-3 text-sm text-muted-foreground">The record may have been removed or you may not have access.</p><Button asChild className="mt-6"><Link href="/">Return to dashboard</Link></Button></section></main>;
}
