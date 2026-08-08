'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, Globe2, Menu, X } from 'lucide-react';
import { SignInButton, SignedIn, SignedOut, UserButton } from '@clerk/nextjs';

export default function CustomerHeader() {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  const navLink = (href: string, label: string) => (
    <Link href={href} className={path === href || path.startsWith(href) ? 'nav-active' : ''} onClick={() => setOpen(false)}>
      {label}
    </Link>
  );

  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link className="brand" href="/">
          <span className="mark">
            <Globe2 size={21} />
          </span>
          Visa Compass
        </Link>
        <nav className="navlinks">
          {navLink('/#plans', 'Destinations')}
          {navLink('/#how', 'How it works')}
          {navLink('/compatibility', 'Compatibility')}
          <span className="nav-user">
            <SignedOut>
              <SignInButton mode="modal">
                <button className="button secondary">Sign in</button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <Link href="/account/notifications" aria-label="Notifications" className={path === '/account/notifications' ? 'nav-active' : ''}>
                <Bell size={17} />
              </Link>
              <Link className={`button secondary ${path.startsWith('/account/esims') ? 'nav-active' : ''}`} href="/account/esims">
                My eSIMs
              </Link>
              <UserButton />
            </SignedIn>
          </span>
        </nav>
        <button className="nav-toggle" onClick={() => setOpen((value) => !value)} aria-label="Toggle menu" aria-expanded={open}>
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
      {open && (
        <div className="nav-menu">
          <div className="shell nav-menu-inner">
            {navLink('/#plans', 'Destinations')}
            {navLink('/#how', 'How it works')}
            {navLink('/compatibility', 'Compatibility')}
            <div className="nav-menu-divider" />
            <SignedOut>
              <SignInButton mode="modal">
                <button className="nav-menu-item">Sign in</button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              {navLink('/account/esims', 'My eSIMs')}
              {navLink('/account/notifications', 'Notifications')}
            </SignedIn>
          </div>
        </div>
      )}
    </header>
  );
}
