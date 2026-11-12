'use strict';
/** Append-only activity log: who did what, to which record, from where. */

function makeAudit(db) {
  const insert = db.prepare(
    `INSERT INTO audit_log (user_id, actor, action, entity_type, entity_id, summary, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return function audit(req, action, entityType = null, entityId = null, summary = null, actorOverride = null) {
    const user = req.user || null;
    insert.run(
      user ? user.id : null,
      actorOverride || (user ? user.college_id : null),
      action,
      entityType,
      entityId,
      summary ? String(summary).slice(0, 500) : null,
      req.ip || null,
      Date.now()
    );
  };
}

/** "field: old → new" list for the audit trail when a record is edited. */
function describeChanges(before, after, labels) {
  const out = [];
  for (const [key, label] of Object.entries(labels)) {
    const a = before[key] === null || before[key] === undefined ? '' : String(before[key]);
    const b = after[key] === null || after[key] === undefined ? '' : String(after[key]);
    if (a !== b) out.push(`${label}: ${a || '(empty)'} → ${b || '(empty)'}`);
  }
  return out.join('; ');
}

module.exports = { makeAudit, describeChanges };
