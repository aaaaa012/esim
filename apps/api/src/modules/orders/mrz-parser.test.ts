import { describe, expect, it } from 'vitest';
import { confusableNormalize, correctMrzField, editDistance, mrzCheckDigit, mrzDateToIso, parseMrz } from './mrz-parser.js';

const US_MRZ = [
  'P<USATRAVELER<<HAPPY<<<<<<<<<<<<<<<<<<<<<<<<',
  'EO00077303USA6502056F3010149500101920<091824',
].join('\n');

describe('mrzCheckDigit', () => {
  it('computes the ICAO 7-3-1 weighted check digit', () => {
    // E00007730 -> 14*7 + 0*3 + 0*1 + 0*7 + 0*3 + 7*1 + 7*7 + 3*3 + 0*1 = 163 -> 3
    expect(mrzCheckDigit('E00007730')).toBe(3);
    // A12 -> 10*7 + 1*3 + 2*1 = 75 -> 5
    expect(mrzCheckDigit('A12')).toBe(5);
  });
});

describe('correctMrzField', () => {
  it('recovers the true value when a single character is mis-read', () => {
    // OCR read O for 0 at position 1; the check digit proves the correct value.
    expect(correctMrzField('EO0007730', '3')).toContain('E00007730');
  });
  it('returns an empty array when the field already validates', () => {
    expect(correctMrzField('E00007730', '3')).toEqual([]);
  });
});

describe('mrzDateToIso', () => {
  it('maps YYMMDD to ISO with the 2000-2049 cutoff', () => {
    expect(mrzDateToIso('650205')).toBe('1965-02-05');
    expect(mrzDateToIso('301014')).toBe('2030-10-14');
    expect(mrzDateToIso('500101')).toBe('2050-01-01');
  });
  it('returns null for invalid input', () => {
    expect(mrzDateToIso('139999')).toBeNull();
    expect(mrzDateToIso('abc')).toBeNull();
  });
});

describe('parseMrz', () => {
  it('parses a US passport MRZ and corrects the mis-read number via its check digit', () => {
    const mrz = parseMrz(US_MRZ);
    expect(mrz).not.toBeNull();
    expect(mrz!.issuingCountry).toBe('USA');
    expect(mrz!.surname).toBe('TRAVELER');
    expect(mrz!.givenNames).toContain('HAPPY');
    expect(mrz!.nationality).toBe('USA');
    expect(mrz!.sex).toBe('F');
    expect(mrz!.passportNumber.value).toBe('EO0007730');
    expect(mrz!.passportNumber.valid).toBe(false);
    expect(mrz!.passportNumber.corrections).toContain('E00007730');
    expect(mrzDateToIso(mrz!.dateOfBirth.value)).toBe('1965-02-05');
    expect(mrzDateToIso(mrz!.expiryDate.value)).toBe('2030-10-14');
  });

  it('returns null for non-passport or garbled input', () => {
    expect(parseMrz('not an MRZ at all, just some words')).toBeNull();
  });
});

describe('confusableNormalize', () => {
  it('maps O/I/S/B/Z to their digit lookalikes', () => {
    expect(confusableNormalize('EO00077303USA')).toBe('E000077303U5A');
  });
});

describe('editDistance', () => {
  it('counts single character differences', () => {
    expect(editDistance('E00007730', 'EO0007730')).toBe(1);
    expect(editDistance('E00007730', 'E00007730')).toBe(0);
    expect(editDistance('E00007730', 'E00007730X')).toBe(1);
  });
});
