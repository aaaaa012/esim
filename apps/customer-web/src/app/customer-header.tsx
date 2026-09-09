"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, CircleHelp, Globe2, Home, RefreshCw, Smartphone } from "lucide-react";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import ThemeToggle from "./theme-toggle";

export function scrollToHomeSection(href: string, pathname: string) {
  if (pathname !== "/" || !href.startsWith("/#")) return false;

  const hash = href.slice(1);
  const target = document.getElementById(href.slice(2));
  if (!target) return false;

  if (window.location.hash !== hash) {
    window.history.pushState(null, "", hash);
  }
  target.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
    block: "start",
  });
  return true;
}

export function isCustomerNavActive(
  href: string,
  pathname: string,
  activeHash: string,
) {
  if (href === "/help")
    return pathname === "/help" || pathname.startsWith("/compatibility");
  if (href === "/") return pathname === "/" && !activeHash;
  if (href.startsWith("/#"))
    return pathname === "/" && activeHash === href.slice(1);
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function CustomerHeader() {
  const path = usePathname();
  const [activeHash, setActiveHash] = useState("");

  useEffect(() => {
    const syncHash = () => setActiveHash(window.location.hash);
    syncHash();
    if (path === "/" && window.location.hash.startsWith("#topup=")) {
      window.location.replace(`/recharge${window.location.hash}`);
      return;
    }
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  const navLink = (href: string, label: string) => (
    <Link
      href={href}
      className={isCustomerNavActive(href, path, activeHash) ? "nav-active" : ""}
      onClick={(event) => {
        if (scrollToHomeSection(href, path)) event.preventDefault();
        setActiveHash(window.location.hash);
      }}
    >
      {label}
    </Link>
  );

  return (
    <>
      <header className="site-header">
        <div className="shell header-inner">
        <Link
          className="brand"
          href="/"
          aria-label="Visa Compass Services home"
        >
          <Image
            className="brand-mark-logo"
            src="/brand/visa-compass-mark.png"
            alt=""
            width={370}
            height={484}
            priority
          />
          <Image
            className="brand-wordmark brand-wordmark-color"
            src="/brand/visa-compass-services-color.png"
            alt=""
            width={1267}
            height={466}
            priority
          />
          <Image
            className="brand-wordmark brand-wordmark-white"
            src="/brand/visa-compass-services-white.png"
            alt=""
            width={933}
            height={373}
            priority
          />
        </Link>
        <nav className="navlinks">
          {navLink("/", "Home")}
          {navLink("/destinations", "Destinations")}
          {navLink("/recharge", "Recharge")}
          {navLink("/#how", "How it works")}
          {navLink("/help", "Help")}
          <span className="nav-user">
            <ThemeToggle />
            <SignedOut>
              <Link className="button secondary" href="/sign-in">Sign in</Link>
            </SignedOut>
            <SignedIn>
              <Link
                href="/account/notifications"
                aria-label="Notifications"
                className={
                  path === "/account/notifications" ? "nav-active" : ""
                }
              >
                <Bell size={17} />
              </Link>
              <Link
                className={`button secondary ${path.startsWith("/account/esims") ? "nav-active" : ""}`}
                href="/account/esims"
              >
                My eSIMs
              </Link>
              <Link
                href="/account/orders"
                aria-label="Orders"
                className={
                  path.startsWith("/account/orders") ? "nav-active" : ""
                }
              >
                Orders
              </Link>
              <UserButton />
            </SignedIn>
          </span>
        </nav>
        <div className="mobile-header-actions">
          <ThemeToggle />
          <SignedOut>
            <Link className="mobile-sign-in" href="/sign-in">Sign in</Link>
          </SignedOut>
          <SignedIn>
            <UserButton />
          </SignedIn>
        </div>
        </div>
      </header>
      <nav className="mobile-bottom-nav" aria-label="Primary mobile navigation">
        <Link
          href="/"
          className={path === "/" && !activeHash ? "nav-active" : ""}
          aria-current={path === "/" && !activeHash ? "page" : undefined}
        >
          <Home size={20} /><span>Home</span>
        </Link>
        <Link
          href="/destinations"
          className={path.startsWith("/destinations") ? "nav-active" : ""}
          aria-current={path.startsWith("/destinations") ? "page" : undefined}
        >
          <Globe2 size={20} /><span>Explore</span>
        </Link>
        <Link
          href="/recharge"
          className={path.startsWith("/recharge") ? "nav-active" : ""}
          aria-current={path.startsWith("/recharge") ? "page" : undefined}
        >
          <RefreshCw size={20} /><span>Recharge</span>
        </Link>
        <Link
          href="/account/esims"
          className={path.startsWith("/account/esims") ? "nav-active" : ""}
          aria-current={path.startsWith("/account/esims") ? "page" : undefined}
        >
          <Smartphone size={20} /><span>My eSIM</span>
        </Link>
        <Link
          href="/help"
          className={isCustomerNavActive("/help", path, activeHash) ? "nav-active" : ""}
          aria-current={isCustomerNavActive("/help", path, activeHash) ? "page" : undefined}
        >
          <CircleHelp size={20} /><span>Help</span>
        </Link>
      </nav>
    </>
  );
}
