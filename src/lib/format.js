'use strict';
/** Display helpers shared by all pages. */

const STATUS = {
  working: 'Working',
  issue_reported: 'Issue reported',
  under_repair: 'Under repair',
  retired: 'Written off',
};
const REPORT_STATUS = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  rejected: 'Rejected',
};
const ISSUE = {
  not_working: 'Not working / will not start',
  damaged: 'Physically damaged',
  missing_part: 'Part missing',
  software: 'Software problem',
  network: 'Network / internet problem',
  other: 'Something else',
};
const ROLE = { admin: 'Administrator', staff: 'Lab staff', faculty: 'Faculty', student: 'Student' };
const KIND = {
  lab: 'Laboratory', classroom: 'Classroom', office: 'Office', library: 'Library',
  hall: 'Hall', store: 'Store room', other: 'Other',
};

function makeFormatter(timezone) {
  const dt = new Intl.DateTimeFormat('en-IN', { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  const d = new Intl.DateTimeFormat('en-IN', { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric' });
  const num = new Intl.NumberFormat('en-IN');
  return {
    STATUS, REPORT_STATUS, ISSUE, ROLE, KIND,
    dateTime: (ms) => (ms ? dt.format(new Date(ms)) : '—'),
    date: (ms) => (ms ? d.format(new Date(ms)) : '—'),
    /** 'YYYY-MM-DD' -> '05 Mar 2024' */
    day: (iso) => {
      if (!iso) return '—';
      const [y, m, dd] = iso.split('-').map(Number);
      return d.format(new Date(Date.UTC(y, m - 1, dd, 12)));
    },
    number: (n) => num.format(n || 0),
    money: (n) => (n === null || n === undefined ? '—' : '₹' + num.format(n)),
    ticket: (id) => 'R-' + String(id).padStart(5, '0'),
    /** Builds a query string, dropping empty values. */
    qs: (params) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
      }
      const s = p.toString();
      return s ? '?' + s : '';
    },
  };
}

module.exports = { makeFormatter, STATUS, REPORT_STATUS, ISSUE, ROLE, KIND };
