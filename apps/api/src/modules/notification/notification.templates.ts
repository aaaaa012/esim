export type NotificationTemplate = 'ORDER_STATUS' | 'QR_READY' | 'DOCUMENT_REUPLOAD';
export function renderNotification(template: NotificationTemplate, data: { orderNumber:string; reason?:string }) {
  if (template === 'QR_READY') return { subject:`Your Visa Compass eSIM is ready — ${data.orderNumber}`, text:`Your eSIM is ready for order ${data.orderNumber}. Open the attached PDF and enter the mobile number you provided when prompted to reveal the activation QR.` };
  if (template === 'DOCUMENT_REUPLOAD') return { subject:`Action required for ${data.orderNumber}`, text:`A replacement travel document is required for ${data.orderNumber}.${data.reason ? ` Reason: ${data.reason}` : ''} Sign in to upload it securely.` };
  return { subject:`Visa Compass order update — ${data.orderNumber}`, text:`There is an update for order ${data.orderNumber}. Sign in to view its secure timeline.` };
}
