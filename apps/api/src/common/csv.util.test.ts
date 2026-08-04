import { describe, expect, it } from 'vitest';
import { csvToRecords, parseCsv } from './csv.util.js';

describe('parseCsv', () => {
  it('parses simple rows with CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('parses quoted fields containing commas and escaped quotes', () => {
    expect(parseCsv('name,note\n"Smith, John","said ""hi"""')).toEqual([
      ['name', 'note'],
      ['Smith, John', 'said "hi"'],
    ]);
  });

  it('skips empty lines', () => {
    expect(parseCsv('a\n\n1\n')).toEqual([['a'], ['1']]);
  });

  it('tolerates LF-only line endings and missing trailing newline', () => {
    expect(parseCsv('x,y\np,q')).toEqual([['x', 'y'], ['p', 'q']]);
  });
});

describe('csvToRecords', () => {
  it('maps header columns into records', () => {
    const { records, errors } = csvToRecords('iccid,eid\n899770100000000001,EID1\n899770100000000002,', ['iccid']);
    expect(errors).toEqual([]);
    expect(records).toEqual([
      { iccid: '899770100000000001', eid: 'EID1' },
      { iccid: '899770100000000002', eid: '' },
    ]);
  });

  it('reports missing required columns', () => {
    const { records, errors } = csvToRecords('name,price\nTravel,100', ['iccid']);
    expect(records).toEqual([]);
    expect(errors[0]).toContain('iccid');
  });

  it('rejects an empty file', () => {
    const { records, errors } = csvToRecords('', ['iccid']);
    expect(records).toEqual([]);
    expect(errors[0]).toContain('empty');
  });

  it('ignores fully empty data rows', () => {
    const { records, errors } = csvToRecords('iccid\n\n899770100000000001\n', ['iccid']);
    expect(errors).toEqual([]);
    expect(records).toEqual([{ iccid: '899770100000000001' }]);
  });
});
