-- Remove the never-used ESEWA enum values (project decision: no ESEWA anywhere).
ALTER TYPE "CustomerSource" DROP VALUE 'ESEWA';
ALTER TYPE "PaymentProvider" DROP VALUE 'ESEWA';
