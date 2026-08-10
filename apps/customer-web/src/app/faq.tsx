'use client';
import { useState } from 'react';
import { ChevronDown, CircleHelp } from 'lucide-react';

const ITEMS = [
  {
    q: 'How do I know my phone supports eSIM?',
    a: 'Use the "Check my device" tool before paying. Compatibility is confirmed before checkout, so you never pay for an eSIM your phone cannot install. Purchases cannot be refunded for incompatible devices, so always check first.',
  },
  {
    q: 'How do I receive my eSIM after paying?',
    a: 'Once your travel documents are reviewed and payment is confirmed, your order is provisioned automatically. Your activation QR is emailed to you as a password-protected PDF, and stays available inside your Visa Compass account under My eSIM.',
  },
  {
    q: 'How do I install the eSIM?',
    a: 'Open the QR PDF, enter the eSIM number (MSISDN) shown in your email, then scan the QR from your phone\u2019s settings. Detailed step-by-step guides for both iPhone and Android are available on each eSIM in your account.',
  },
  {
    q: 'Which payment methods do you support?',
    a: 'We accept payments via Khalti in NPR. All prices shown are in NPR and include the full cost of the plan with no hidden fees.',
  },
  {
    q: 'Can I top up an existing eSIM?',
    a: 'Yes. If you already have a Visa Compass eSIM, enter your mobile number on the homepage and we\u2019ll find your current plan so you can recharge it with another destination or data plan.',
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