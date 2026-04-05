/**
 * Tests for utils/file-decode.js
 */

const { decodeFileData, detectFileType } = require('../../utils/file-decode');

describe('detectFileType', () => {
    it('returns explicit fileType when provided', () => {
        expect(detectFileType('xlsx', 'whatever.csv')).toBe('xlsx');
        expect(detectFileType('csv', 'whatever.xlsx')).toBe('csv');
    });

    it('infers xlsx from .xlsx filename', () => {
        expect(detectFileType(undefined, 'PriceList.XLSX')).toBe('xlsx');
        expect(detectFileType(undefined, 'file.xlsx')).toBe('xlsx');
    });

    it('infers csv for any other extension', () => {
        expect(detectFileType(undefined, 'data.csv')).toBe('csv');
        expect(detectFileType(undefined, 'data.txt')).toBe('csv');
    });

    it('defaults to csv when both fileType and fileName are absent', () => {
        expect(detectFileType(undefined, undefined)).toBe('csv');
        expect(detectFileType(null, null)).toBe('csv');
    });
});

describe('decodeFileData', () => {
    it('returns Buffer for xlsx type', () => {
        const raw = 'hello xlsx';
        const b64 = Buffer.from(raw).toString('base64');
        const { fileData, type } = decodeFileData(b64, 'xlsx', undefined);
        expect(type).toBe('xlsx');
        expect(Buffer.isBuffer(fileData)).toBe(true);
        expect(fileData.toString()).toBe(raw);
    });

    it('returns UTF-8 string for csv base64', () => {
        const csv = 'upc,cost\n123,4.99';
        const b64 = Buffer.from(csv).toString('base64');
        const { fileData, type } = decodeFileData(b64, 'csv', undefined);
        expect(type).toBe('csv');
        expect(typeof fileData).toBe('string');
        expect(fileData).toBe(csv);
    });

    it('infers type from fileName when fileType is absent', () => {
        const b64 = Buffer.from('dummy').toString('base64');
        const { type: xlsxType } = decodeFileData(b64, undefined, 'catalog.xlsx');
        const { type: csvType } = decodeFileData(b64, undefined, 'catalog.csv');
        expect(xlsxType).toBe('xlsx');
        expect(csvType).toBe('csv');
    });

    it('falls back to raw string when csv data is not valid base64', () => {
        const raw = 'not,base64,at,all\n1,2,3,4';
        const { fileData, type } = decodeFileData(raw, 'csv', undefined);
        expect(type).toBe('csv');
        expect(typeof fileData).toBe('string');
    });

    it('defaults to csv type when neither fileType nor fileName given', () => {
        const b64 = Buffer.from('a,b').toString('base64');
        const { type } = decodeFileData(b64, undefined, undefined);
        expect(type).toBe('csv');
    });
});
