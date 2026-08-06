import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { tabularToRecords } from './tabular.util.js';

async function excelBase64(sheet: string[][]): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sheet1');
  for (const row of sheet) worksheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

describe('tabularToRecords', () => {
  it('parses CSV content when no Excel file name is supplied', async () => {
    const { records, errors } = await tabularToRecords(
      'iccid,eid\n899770100000000001,EID1\n899770100000000002,',
      ['iccid'],
    );
    expect(errors).toEqual([]);
    expect(records).toEqual([
      { iccid: '899770100000000001', eid: 'EID1' },
      { iccid: '899770100000000002', eid: '' },
    ]);
  });

  it('parses an Excel workbook supplied as base64 with a .xlsx file name', async () => {
    const base64 = await excelBase64([
      ['countryiso2', 'name', 'costprice'],
      ['NP', 'Nepal 1GB 7d', '50'],
      ['JP', 'Japan 5GB 30d', '120'],
    ]);
    const { records, errors } = await tabularToRecords(
      base64,
      ['countryiso2', 'name', 'costprice'],
      { fileName: 'plans.xlsx' },
    );
    expect(errors).toEqual([]);
    expect(records).toEqual([
      { countryiso2: 'NP', name: 'Nepal 1GB 7d', costprice: '50' },
      { countryiso2: 'JP', name: 'Japan 5GB 30d', costprice: '120' },
    ]);
  });

  it('reports missing required columns for an Excel file', async () => {
    const base64 = await excelBase64([['name', 'price'], ['Travel', '100']]);
    const { records, errors } = await tabularToRecords(base64, ['iccid'], { fileName: 'plans.xlsx' });
    expect(records).toEqual([]);
    expect(errors[0]).toContain('iccid');
  });

  it('rejects non-read >able Excel content', async () => {
    const { records, errors } = await tabularToRecords(
      Buffer.from('not a real workbook').toString('base64'),
      ['iccid'],
      { fileName: 'plans.xlsx' },
    );
    expect(records).toEqual([]);
    expect(errors[0]).toMatch(/could not be read/);
  });
});