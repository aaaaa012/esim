"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, CircleHelp, ShieldCheck } from "lucide-react";

const ITEMS = [
  {
    q: "How do I know my phone supports eSIM?",
    a: 'Use the "Check my device" guide before paying. You confirm compatibility during checkout, but the system does not inspect your device or carrier lock automatically. Purchases cannot be refunded for incompatible devices, so always check first.',
  },
  {
    q: "How do I receive my eSIM after paying?",
    a: "Once your payment is confirmed, we set up your plan and send your activation QR by email as an image. If you have an account, you can also find your eSIM under My eSIMs.",
  },
  {
    q: "How do I install the eSIM?",
    a: "Open the QR image on another screen, then scan it from your phone\u2019s mobile or cellular settings. Follow your phone manufacturer\u2019s current eSIM installation guidance if the settings look different.",
  },
  {
    q: "Which payment methods do you support?",
    a: "We accept payments via Khalti in NPR. All prices shown are in NPR and include the full cost of the plan with no hidden fees.",
  },
  {
    q: "Can I top up an existing eSIM?",
    a: "Yes. If you already have a Visa Compass eSIM, enter your mobile number on the homepage and we\u2019ll find your current plan so you can add another destination or data plan.",
  },
  {
    q: "What happens if my eSIM runs out of data?",
    a: "Track your live usage in My eSIM and refresh it anytime. When you need more data, top up using your mobile number — no need to go through check-in again.",
  },
];

export default function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="faq-layout">
      <aside className="faq-aside">
        <span className="faq-aside-icon">
          <ShieldCheck size={24} />
        </span>
        <h3>Start with compatibility</h3>
        <p>
          Check your device before buying so you can install confidently when
          your eSIM arrives.
        </p>
        <Link href="/compatibility">
          Check my device <ArrowRight size={16} />
        </Link>
      </aside>
      <div className="faq-list">
        {ITEMS.map((item, index) => {
          const isOpen = open === index;
          const answerId = `faq-answer-${index}`;
          return (
            <div key={item.q} className={`faq-item ${isOpen ? "open" : ""}`}>
              <button
                className="faq-question"
                onClick={() => setOpen(isOpen ? null : index)}
                aria-expanded={isOpen}
                aria-controls={answerId}
              >
                <CircleHelp size={18} />
                <span>{item.q}</span>
                <ChevronDown size={18} className="faq-chevron" />
              </button>
              <div className="faq-answer" id={answerId} aria-hidden={!isOpen}>
                <div className="faq-answer-inner">
                  <p>{item.a}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
