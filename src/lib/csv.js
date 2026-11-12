'use strict';

/** Minimal RFC 4180 parser: handles quoted fields, escaped quotes and CRLF. */
function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(input).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/**
 * Quotes one CSV cell. Cells that begin with = + - @ (or tab / CR) are prefixed
 * with an apostrophe so spreadsheet programs never run them as formulas.
 */
function csvCell(value) {
  let v = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function toCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

module.exports = { parseCsv, csvCell, toCsv };
