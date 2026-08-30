/**
 * One-off audit script: re-runs passport verification through the REAL
 * PassportVerificationService (including the MRZ band second pass) for a
 * stored traveler document, without mutating any state.
 *
 * Usage:
 *   node --env-file-if-exists=../../.env node_modules/tsx/dist/cli.mjs prisma/ocr-diag.mts <documentId>
 */
import { PrismaService } from "../dist/src/infrastructure/prisma.service.js";
import { CryptoService } from "../dist/src/infrastructure/crypto.service.js";
import { S3StorageService } from "../dist/src/infrastructure/s3-storage.service.js";
import { PassportVerificationService } from "../dist/src/modules/orders/passport-verification.service.js";

const documentId = process.argv[2];
if (!documentId) {
  console.error("Usage: tsx prisma/ocr-diag.mts <travelerDocumentId>");
  process.exit(1);
}

const p = new PrismaService();
await p.$connect();
const doc = await p.travelerDocument.findUnique({
  where: { id: documentId },
  include: { order: { include: { traveler: true } } },
});
if (!doc || !doc.order?.traveler) throw new Error("document/order missing");
const t = doc.order.traveler;
const crypto = new CryptoService();
const order = {
  id: doc.orderId,
  purchaseType: doc.order.orderType === "TOPUP" ? "TOPUP" : "INITIAL_PURCHASE",
  traveler: {
    firstName: t.firstName,
    surname: t.surname,
    dateOfBirth: crypto.decrypt(t.dateOfBirthEncrypted ?? ""),
    passportNumber: crypto.decrypt(t.passportNumberEncrypted ?? ""),
    passportExpiryDate: crypto.decrypt(t.passportExpiryEncrypted ?? ""),
  },
  documents: [
    {
      id: doc.id,
      type: "PASSPORT",
      fileName: doc.fileName,
      privateAssetId: doc.privateAssetId,
      status: doc.status,
      uploadVerified: true,
    },
  ],
};
const verifier = new PassportVerificationService(new S3StorageService());
const result = await verifier.verify(order as never);
console.log("TRAVELER:", JSON.stringify(order.traveler));
console.log("RESULT:", JSON.stringify(result, null, 1));
await p.$disconnect();
process.exit(0);
