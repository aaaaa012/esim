export type NotificationTemplate = 'ORDER_STATUS' | 'QR_READY' | 'DOCUMENT_REUPLOAD' | 'PLAN_EXHAUSTED' | 'PLAN_EXPIRED' | 'OPS_ALERT';
export function renderNotification(template: NotificationTemplate, data: { orderNumber:string; reason?:string; msisdn?:string }) {
  if (template === 'OPS_ALERT') return { subject:`[Ops Alert] ${data.reason ?? 'Action required'}`, text:`Operational alert for order ${data.orderNumber}: ${data.reason ?? 'Review required.'} Log in to the operations console.` };
  if (template === 'QR_READY') return { subject:`Your Visa Compass eSIM is ready - ${data.orderNumber}`, text:`Your eSIM is ready for order ${data.orderNumber}. The activation QR is attached as an image. Keep it private and scan it from your device's eSIM settings.` };
  if (template === 'DOCUMENT_REUPLOAD') return { subject:`Action required for ${data.orderNumber}`, text:`A replacement travel document is required for ${data.orderNumber}.${data.reason ? ` Reason: ${data.reason}` : ''} Sign in to upload it securely.` };
  if (template === 'PLAN_EXHAUSTED') return { subject:`Your data plan is used up - ${data.orderNumber}`, text:`The data allowance for order ${data.orderNumber} has been fully consumed. Top up on Visa Compass to stay connected.` };
  if (template === 'PLAN_EXPIRED') return { subject:`Your data plan has expired - ${data.orderNumber}`, text:`The plan for order ${data.orderNumber} has expired.${data.reason ? ` Reason: ${data.reason}` : ''} Recharge with a new plan on Visa Compass to continue using mobile data.` };
  return { subject:`Visa Compass order update - ${data.orderNumber}`, text:`There is an update for order ${data.orderNumber}. Sign in to view its secure timeline.` };
}
