'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell,Globe2 } from 'lucide-react';
import { SignInButton,SignedIn,SignedOut,UserButton } from '@clerk/nextjs';
export default function CustomerHeader(){const path=usePathname();return <header className="shell nav"><Link className="brand" href="/"><span className="mark"><Globe2 size={21}/></span>Visa Compass</Link><nav className="navlinks"><Link href="/#plans">Destinations</Link><Link href="/#how">How it works</Link><Link href="/compatibility" className={path==='/compatibility'?'nav-active':''}>Compatibility</Link><SignedOut><SignInButton mode="modal"><button className="button secondary">Sign in</button></SignInButton></SignedOut><SignedIn><Link href="/account/notifications" aria-label="Notifications" className={path==='/account/notifications'?'nav-active':''}><Bell size={17}/></Link><Link className={`button secondary ${path.startsWith('/account/esims')?'nav-active':''}`} href="/account/esims">My eSIMs</Link><UserButton/></SignedIn></nav></header>}
