'use client';
import { useState } from 'react';
import { ChevronDown, CircleHelp } from 'lucide-react';

const ITEMS = [
  {
    q: 'How do I know my phone supports eSIM?',
    a: 'Use the "Check my device" guide before paying. You confirm compatibility during checkout, but the system does not inspect your device or carrier lock automatically. Purchases cannot be refunded for incompatible devices, so always check first.',
  },
  {
    q: 'How do I receive my eSIM after paying?',
    a: 'Once your payment is confirmed, we set up your plan and send your activation QR by email as a protected PDF. If you have an account, you can also find your eSIM under My eSIMs.',
  },
  {
    q: 'How do I install the eSIM?',
    a: 'Open the QR PDF and enter the mobile number it requests when prompted. Then scan the QR from your phone\u2019s mobile or cellular settings. Follow your phone manufacturer\u2019s current eSIM installation guidance if the settings look different.',
  },
  {
    q: 'Which payment methods do you support?',
    a: 'We accept payments via Khalti in NPR. All prices shown are in NPR and include the full cost of the plan with no hidden fees.',
  },
  {
    q: 'Can I top up an existing eSIM?',
    a: 'Yes. If you already have a Visa Compass eSIM, enter your mobile number on the homepage and we\u2019ll find your current plan so you can add another destination or data plan.',
  },
  {
    q: 'What happens if my eSIM runs out of data?',
    a: 'Track your live usage in My eSIM and refresh it anytime. When you need more data, top up using your mobile number — no need to go through check-in again.',
  },
];

export default function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="faq-list">
      {ITEMS.map((item, index) => {
        const isOpen = open === index;
        return (
          <div key={item.q} className={`faq-item ${isOpen ? 'open' : ''}`}>
            <button
              className="faq-question"
              onClick={() => setOpen(isOpen ? null : index)}
              aria-expanded={isOpen}
            >
              <CircleHelp size={18} />
              <span>{item.q}</span>
              <ChevronDown size={18} className="faq-chevron" />
            </button>
            <div className="faq-answer">
              <p>{item.a}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
