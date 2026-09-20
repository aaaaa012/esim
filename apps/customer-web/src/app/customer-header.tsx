"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  Bell,
  CircleHelp,
  ClipboardList,
  Globe2,
  RefreshCw,
  Smartphone,
} from "lucide-react";
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

export function isExploreNavActive(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/destinations" ||
    pathname.startsWith("/destinations/")
  );
}

export function returnToHomepageExplore(pathname: string) {
  if (pathname !== "/") return false;

  const target = document.getElementById("explore");
  if (!target) return false;

  if (window.location.hash) {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  target.focus({ preventScroll: true });
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
  if (href === "/recharge") return pathname === "/recharge";
  if (href === "/account/orders")
    return (
      pathname.startsWith("/account/orders") || pathname === "/recharge/recover"
    );
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
      className={
        isCustomerNavActive(href, path, activeHash) ? "nav-active" : ""
      }
      onClick={(event) => {
        if (scrollToHomeSection(href, path)) event.preventDefault();
        setActiveHash(window.location.hash);
      }}
    >
      {label}
    </Link>
  );

  if (path.startsWith("/esim/checkout")) {
    return (
      <header className="site-header checkout-focus-header">
        <div className="shell checkout-focus-inner">
          <Link href="/destinations" aria-label="Back to plans">
            <ArrowLeft size={18} /> <span>Plans</span>
          </Link>
          <strong className="checkout-focus-brand">Visa Compass</strong>
          <Link href="/help">Support</Link>
        </div>
      </header>
    );
  }

  return (
    <>
      <header
        className={`site-header ${path === "/" ? "home-site-header" : ""}`}
      >
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
                <Link className="button secondary" href="/sign-in">
                  Sign in
                </Link>
              </SignedOut>
              <SignedIn>
                <Link
                  href="/account/notifications"
                  prefetch={false}
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
                  prefetch={false}
                >
                  My eSIMs
                </Link>
                <Link
                  href="/account/orders"
                  prefetch={false}
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
              <Link className="mobile-sign-in" href="/sign-in">
                Sign in
              </Link>
            </SignedOut>
            <SignedIn>
              <UserButton />
            </SignedIn>
          </div>
        </div>
      </header>
      <nav
        className={`mobile-bottom-nav ${path === "/" ? "mobile-bottom-nav-home" : ""}`}
        aria-label="Primary mobile navigation"
      >
        <Link
          href="/"
          className={isExploreNavActive(path) ? "nav-active" : ""}
          aria-current={isExploreNavActive(path) ? "page" : undefined}
          onClick={(event) => {
            if (returnToHomepageExplore(path)) {
              event.preventDefault();
              setActiveHash("");
            }
          }}
        >
          <Globe2 size={20} />
          <span>Explore</span>
        </Link>
        <Link
          href="/recharge"
          className={path === "/recharge" ? "nav-active" : ""}
          aria-current={path === "/recharge" ? "page" : undefined}
        >
          <RefreshCw size={20} />
          <span>Recharge</span>
        </Link>
        <Link
          href="/account/esims"
          prefetch={false}
          className={path.startsWith("/account/esims") ? "nav-active" : ""}
          aria-current={path.startsWith("/account/esims") ? "page" : undefined}
        >
          <Smartphone size={20} />
          <span>My eSIM</span>
        </Link>
        <SignedOut>
          <Link
            href="/recharge/recover"
            className={path === "/recharge/recover" ? "nav-active" : ""}
            aria-current={path === "/recharge/recover" ? "page" : undefined}
          >
            <ClipboardList size={20} />
            <span>Orders</span>
          </Link>
        </SignedOut>
        <SignedIn>
          <Link
            href="/account/orders"
            prefetch={false}
            className={
              isCustomerNavActive("/account/orders", path, activeHash)
                ? "nav-active"
                : ""
            }
            aria-current={
              isCustomerNavActive("/account/orders", path, activeHash)
                ? "page"
                : undefined
            }
          >
            <ClipboardList size={20} />
            <span>Orders</span>
          </Link>
        </SignedIn>
        <Link
          href="/help"
          className={
            isCustomerNavActive("/help", path, activeHash) ? "nav-active" : ""
          }
          aria-current={
            isCustomerNavActive("/help", path, activeHash) ? "page" : undefined
          }
        >
          <CircleHelp size={20} />
          <span>Help</span>
        </Link>
      </nav>
    </>
  );
}
