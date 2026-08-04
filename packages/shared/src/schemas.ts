import { z } from 'zod';
import { DocumentType, PaymentProvider } from './contracts.js';

export const createOrderSchema = z.object({ planId: z.string().uuid(), compatibilityAccepted: z.literal(true) });
export const travelerSchema = z.object({
  title: z.enum(['MR', 'MS', 'MRS']),
  firstName: z.string().trim().min(1).max(80),
  middleName: z.string().trim().max(80).optional(),
  surname: z.string().trim().min(1).max(80),
  dateOfBirth: z.iso.date(),
  nationality: z.string().length(2),
  city: z.string().trim().min(1).max(100),
  countryOfResidence: z.string().length(2),
  employerOrBusinessName: z.string().trim().max(160).optional(),
  email: z.email(),
  mobile: z.string().trim().min(7).max(20),
  passportNumber: z.string().trim().min(5).max(30),
  passportExpiryDate: z.iso.date(),
  pointOfSaleCode: z.string().trim().max(40).optional(),
});
export const initiatePaymentSchema = z.object({ provider: z.enum(PaymentProvider) });
export const documentRequestSchema = z.object({ type: z.enum(DocumentType), fileName: z.string().min(1).max(180), contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']) });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type TravelerInput = z.infer<typeof travelerSchema>;
export type InitiatePaymentInput = z.infer<typeof initiatePaymentSchema>;
