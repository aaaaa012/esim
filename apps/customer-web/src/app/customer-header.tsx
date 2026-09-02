"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Menu, X } from "lucide-react";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import ThemeToggle from "./theme-toggle";

export default function CustomerHeader() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [activeHash, setActiveHash] = useState("");

  useEffect(() => {
    const syncHash = () => setActiveHash(window.location.hash);
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [path]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.body.classList.add("menu-open");
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.classList.remove("menu-open");
    };
  }, [open]);

  const navLink = (href: string, label: string) => (
    <Link
      href={href}
      className={path === href || path.startsWith(href) || (href.startsWith("/#") && path === "/" && activeHash === href.slice(1)) ? "nav-active" : ""}
      onClick={() => setOpen(false)}
    >
      {label}
    </Link>
  );

  return (
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
          {navLink("/#plans", "Destinations")}
          {navLink("/#recharge", "Recharge")}
          {navLink("/#how", "How it works")}
          {navLink("/compatibility", "Compatibility")}
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
        <button
          className="nav-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={open}
          aria-controls="customer-navigation-menu"
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
      {open && (
        <div className="nav-menu" id="customer-navigation-menu">
          <div className="shell nav-menu-inner">
            {navLink("/#plans", "Destinations")}
            {navLink("/#recharge", "Recharge")}
            {navLink("/#how", "How it works")}
            {navLink("/compatibility", "Compatibility")}
            <div className="nav-menu-divider" />
            <ThemeToggle />
            <SignedOut>
              <Link className="nav-menu-item" href="/sign-in" onClick={() => setOpen(false)}>Sign in</Link>
            </SignedOut>
            <SignedIn>
              {navLink("/account/esims", "My eSIMs")}
              {navLink("/account/orders", "Orders")}
              {navLink("/account/notifications", "Notifications")}
              <div className="nav-menu-account">
                <span>Account</span>
                <UserButton />
              </div>
            </SignedIn>
          </div>
        </div>
      )}
    </header>
  );
}
