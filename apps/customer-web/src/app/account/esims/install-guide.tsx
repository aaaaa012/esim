"use client";
import { useState } from "react";
import {
  Apple,
  Settings,
  Smartphone,
  Wifi,
  Share2,
  QrCode,
  Upload,
  CheckCircle2,
  Download,
  MonitorSmartphone,
} from "lucide-react";

type Step = { icon: React.ComponentType<{ size?: number | string; className?: string }>; title: string; body: string };

const iOS_STEPS: Step[] = [
  { icon: Settings, title: "Open Settings", body: "Go to Settings on your iPhone and tap Cellular (or Mobile Data)." },
  { icon: Smartphone, title: "Add an eSIM", body: "Choose “Add Cellular Plan” or “Add eSIM” and select “Use QR Code”." },
  { icon: QrCode, title: "Scan the QR", body: "Open the password-protected QR PDF and scan it with your camera. Enter the MSISDN when prompted." },
  { icon: CheckCircle2, title: "Label & finish", body: "Name your plan (e.g. “Travel Data”), then tap Activate. Keep it as your data line." },
];

const ANDROID_STEPS: Step[] = [
  { icon: Settings, title: "Open network settings", body: "Go to Settings → Network & internet → SIMs / eSIMs." },
  { icon: Upload, title: "Add eSIM", body: "Tap “Add eSIM” or “Download a SIM instead” and choose “Use QR code”." },
  { icon: QrCode, title: "Scan the QR", body: "Open the password-protected QR PDF and point your camera at it. Use your MSISDN when asked." },
  { icon: Wifi, title: "Confirm & activate", body: "Follow the on-screen prompts to finish. Your eSIM becomes active once you reach the destination." },
];

export default function InstallGuide({ canInstall, onOpenQr }: { canInstall: boolean; onOpenQr?: (() => void) | undefined }) {
  const [tab, setTab] = useState<"ios" | "android">("ios");
  const steps = tab === "ios" ? iOS_STEPS : ANDROID_STEPS;
  return (
    <section className="install-guide">
      <div className="install-guide-head">
        <div>
          <span className="install-kicker">
            <Share2 size={14} />
            Install your eSIM
          </span>
          <h3>Install step by step</h3>
          <p>Choose your phone, then follow the setup path that works for the device you are using now.</p>
        </div>
        <div className="install-tabs">
          <button className={tab === "ios" ? "selected" : ""} onClick={() => setTab("ios")}>
            <Apple size={16} /> iPhone
          </button>
          <button className={tab === "android" ? "selected" : ""} onClick={() => setTab("android")}>
            <Smartphone size={16} /> Android
          </button>
        </div>
      </div>
      <div className="install-paths">
        <div><MonitorSmartphone size={19} /><span><b>Installing on this phone?</b><small>Open the QR on another screen, or download the protected PDF first.</small></span></div>
        <div><QrCode size={19} /><span><b>Using another device?</b><small>Open the secure QR here and scan it with the phone you want to connect.</small></span></div>
        {canInstall && onOpenQr ? <button className="button" onClick={onOpenQr}><QrCode size={16} />Open installation QR</button> : <span className="install-waiting">QR available when preparation finishes</span>}
      </div>
      <ol className="install-steps">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.title}>
              <span className="install-step-num">{index + 1}</span>
              <span className="install-step-icon">
                <Icon size={18} />
              </span>
              <div>
                <b>{step.title}</b>
                <p>{step.body}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="install-note">
        <Download size={16} />
        You&apos;ll find the password (MSISDN) in your QR email — enter it when the PDF asks for one.
      </div>
    </section>
  );
}
