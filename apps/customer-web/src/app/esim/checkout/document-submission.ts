import { DocumentType } from "@visa-compass/shared";

export type CheckoutDocumentFiles = {
  passport: File | undefined;
  ticket: File | undefined;
  visa: File | undefined;
};

export type CheckoutDocument = {
  key: keyof CheckoutDocumentFiles;
  file: File;
  type: DocumentType;
};

const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;

export async function submitCheckoutDocumentsSequentially(
  files: CheckoutDocumentFiles,
  submit: (document: CheckoutDocument) => Promise<void>,
) {
  const documents: CheckoutDocument[] = [
    ...(files.passport
      ? [
          {
            key: "passport" as const,
            file: files.passport,
            type: DocumentType.PASSPORT,
          },
        ]
      : []),
    ...(files.ticket
      ? [
          {
            key: "ticket" as const,
            file: files.ticket,
            type: DocumentType.TICKET,
          },
        ]
      : []),
    ...(files.visa
      ? [
          {
            key: "visa" as const,
            file: files.visa,
            type: DocumentType.VISA,
          },
        ]
      : []),
  ];

  for (const document of documents) {
    if (document.file.size > MAX_DOCUMENT_SIZE_BYTES)
      throw new Error(`${document.file.name} exceeds the 10 MB limit`);
    await submit(document);
  }
}
