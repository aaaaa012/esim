import { Injectable } from '@nestjs/common';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';

@Injectable()
export class QrPdfService {
  async build(input: { qrPayload: string; orderNumber: string; password: string }): Promise<Buffer> {
    const png = await QRCode.toBuffer(input.qrPayload, { width: 512, margin: 2 });
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 48,
        userPassword: input.password,
        ownerPassword: input.password,
        permissions: {
          printing: 'lowResolution',
          modifying: false,
          copying: false,
          annotating: false,
          fillingForms: false,
          contentAccessibility: false,
          documentAssembly: false,
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text('Visa Compass eSIM', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`Order: ${input.orderNumber}`, { align: 'center' });
      doc.moveDown(0.5);
      doc.text('Open this PDF on your phone and enter the mobile number you provided when prompted.', { align: 'center' });
      doc.moveDown(1.5);
      doc.image(png, { fit: [360, 360], align: 'center', valign: 'center' });
      doc.moveDown(1);
      doc.fontSize(9).text('Scan the QR code with your phone to install the eSIM. This QR is sensitive — do not share it.', { align: 'center' });

      doc.end();
    });
  }
}
