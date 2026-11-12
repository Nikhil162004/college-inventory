'use strict';
/** Input validation. Every form and query string is checked against a schema
 *  before it reaches the database. */
const { z } = require('zod');

// Reject control characters (anything below space except tab / newline / CR).
const CLEAN = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const BAD_CHARS = 'Contains characters that are not allowed';

const text = (max, min = 1) =>
  z.string().trim()
    .min(min, min === 1 ? 'This field is required' : `Enter at least ${min} characters`)
    .max(max, `Keep this under ${max} characters`)
    .regex(CLEAN, BAD_CHARS);

const optText = (max) =>
  z.string().trim().max(max, `Keep this under ${max} characters`).regex(CLEAN, BAD_CHARS)
    .transform((v) => (v === '' ? null : v));

const id = z.string().regex(/^[1-9]\d{0,8}$/, 'Choose an option').transform(Number);
const optId = z.string().regex(/^([1-9]\d{0,8})?$/, 'Choose a valid option').transform((v) => (v === '' ? null : Number(v)));

function isRealDate(v) {
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1980 && y <= 2100;
}
const optDate = z.string().trim()
  .refine((v) => v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && isRealDate(v)), 'Enter a valid date')
  .transform((v) => (v === '' ? null : v));

const optMoney = z.string().trim()
  .regex(/^(\d{1,9})?$/, 'Enter a whole number of rupees, without commas')
  .transform((v) => (v === '' ? null : Number(v)));

const oneOf = (values, message = 'Choose an option') =>
  z.string().refine((v) => values.includes(v), message);

const optEmail = z.string().trim().max(120)
  .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v), 'Enter a valid email address')
  .transform((v) => (v === '' ? null : v.toLowerCase()));

const page = z.string().regex(/^\d{1,6}$/).transform(Number).catch(1);

/**
 * Validates `input` against a zod object schema.
 * Missing fields are treated as empty strings so messages stay readable.
 * Returns { data, errors } where errors is { field: message } or null.
 */
function check(schema, input) {
  const source = {};
  for (const key of Object.keys(schema.shape)) {
    const v = input ? input[key] : undefined;
    source[key] = v === undefined || v === null ? '' : v;
  }
  const result = schema.safeParse(source);
  if (result.success) return { data: result.data, errors: null };
  const errors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (key !== undefined && !errors[key]) {
      errors[key] = /^Invalid input/.test(issue.message) ? 'Enter a valid value' : issue.message;
    }
  }
  return { data: null, errors };
}

/** Escapes % and _ so user text is matched literally inside LIKE. */
function likePattern(term) {
  return '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

function paginate(total, requestedPage, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, requestedPage || 1), pages);
  return { total, pages, page: current, pageSize, offset: (current - 1) * pageSize };
}

module.exports = { z, text, optText, id, optId, optDate, optMoney, oneOf, optEmail, page, check, likePattern, paginate };
