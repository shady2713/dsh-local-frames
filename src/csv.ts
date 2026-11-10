export interface SourceMeta {
  url: string;
  author: string;
  license: string;
  region: 'CN' | 'SEA' | 'OTHER' | 'UNKNOWN';
  regionEvidence: string;
  family: string;
}

export const EMPTY_SOURCE: SourceMeta = {
  url: '',
  author: '',
  license: '',
  region: 'UNKNOWN',
  regionEvidence: '',
  family: '',
};

const REGION_VALUES = new Set(['CN', 'SEA', 'OTHER']);

/**
 * Region is recorded only when the CSV also gives region_evidence.
 * Anything else, including a region guessed from the picture, stays UNKNOWN.
 */
export function normalizeRegion(region: string, evidence: string): SourceMeta['region'] {
  const cleanedEvidence = evidence.trim();
  const cleanedRegion = region.trim().toUpperCase();
  if (cleanedEvidence.length === 0) return 'UNKNOWN';
  if (REGION_VALUES.has(cleanedRegion)) return cleanedRegion as SourceMeta['region'];
  return 'UNKNOWN';
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** RFC-style CSV: commas, quotes, CRLF, and a leading UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  const source = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      sawQuote = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      sawQuote = false;
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.length > 0) || sawQuote) rows.push(row);
      row = [];
      sawQuote = false;
      continue;
    }
    field += char;
  }
  if (inQuotes) throw new CsvError('CSV 引号没有闭合');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function headerIndex(header: string[], names: readonly string[]): number {
  const wanted = new Set(names);
  for (let index = 0; index < header.length; index += 1) {
    const cell = (header[index] ?? '').trim().toLowerCase();
    if (wanted.has(cell)) return index;
  }
  return -1;
}

function cell(row: string[], index: number): string {
  if (index < 0) return '';
  return (row[index] ?? '').trim();
}

export interface CsvTable {
  /** Keys are the file/path cell and the basename, first row wins. */
  byKey: Map<string, SourceMeta>;
}

/**
 * Parse a metadata CSV. A missing file/path column, or a broken quote, throws.
 * Unknown columns are ignored. Empty rows are skipped.
 */
export function parseSourceCsv(text: string): CsvTable {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CsvError('CSV 是空的');
  const header = rows[0] ?? [];
  const fileIndex = headerIndex(header, ['file', 'path']);
  if (fileIndex < 0) throw new CsvError('CSV 缺少 file 或 path 列');
  const urlIndex = headerIndex(header, ['url']);
  const authorIndex = headerIndex(header, ['author']);
  const licenseIndex = headerIndex(header, ['license']);
  const regionIndex = headerIndex(header, ['region']);
  const evidenceIndex = headerIndex(header, ['region_evidence']);
  const familyIndex = headerIndex(header, ['family']);
  const byKey = new Map<string, SourceMeta>();
  for (const row of rows.slice(1)) {
    const file = cell(row, fileIndex);
    if (file.length === 0) continue;
    const evidence = cell(row, evidenceIndex);
    const meta: SourceMeta = {
      url: cell(row, urlIndex),
      author: cell(row, authorIndex),
      license: cell(row, licenseIndex),
      regionEvidence: evidence,
      region: normalizeRegion(cell(row, regionIndex), evidence),
      family: cell(row, familyIndex),
    };
    if (!byKey.has(file)) byKey.set(file, meta);
    const base = file.split(/[\\/]/u).pop() ?? file;
    if (!byKey.has(base)) byKey.set(base, meta);
  }
  return { byKey };
}

export function lookupSource(table: CsvTable | null, filePath: string): SourceMeta {
  if (table === null) return { ...EMPTY_SOURCE };
  const base = filePath.split(/[\\/]/u).pop() ?? filePath;
  return table.byKey.get(filePath) ?? table.byKey.get(base) ?? { ...EMPTY_SOURCE };
}
