'use strict';
/** Rules shared by the equipment and report routes. */
const QRCode = require('qrcode');

const TAG_PATTERN = /^[A-Z]{2,5}-\d{5}$/;

function formatTag(prefix, seq) {
  return `${prefix.toUpperCase()}-${String(seq).padStart(5, '0')}`;
}

function makeInventory(db, config) {
  const q = {
    category: db.prepare('SELECT * FROM categories WHERE id = ?'),
    bumpSeq: db.prepare('UPDATE categories SET next_seq = ? WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO equipment (asset_tag, name, category_id, location_id, brand, model, serial_no, specs,
         purchase_date, purchase_cost, vendor, warranty_until, status, notes, created_by, created_at, updated_at)
       VALUES (@asset_tag, @name, @category_id, @location_id, @brand, @model, @serial_no, @specs,
         @purchase_date, @purchase_cost, @vendor, @warranty_until, 'working', @notes, @created_by, @now, @now)`
    ),
    status: db.prepare('SELECT status FROM equipment WHERE id = ?'),
    setStatus: db.prepare('UPDATE equipment SET status = ?, updated_at = ? WHERE id = ?'),
    openCounts: db.prepare(
      `SELECT SUM(status = 'open') AS open, SUM(status = 'in_progress') AS in_progress
       FROM reports WHERE equipment_id = ?`
    ),
  };

  /**
   * Adds `quantity` identical items and gives each its own asset tag.
   * Runs in one transaction so two people adding at once can never get the same tag.
   */
  const createEquipment = db.transaction((fields, quantity, userId) => {
    const category = q.category.get(fields.category_id);
    if (!category) throw new Error('Unknown category');
    const now = Date.now();
    const created = [];
    let seq = category.next_seq;
    for (let i = 0; i < quantity; i++, seq++) {
      const asset_tag = formatTag(category.prefix, seq);
      const info = q.insert.run({ ...fields, asset_tag, created_by: userId, now });
      created.push({ id: Number(info.lastInsertRowid), asset_tag });
    }
    q.bumpSeq.run(seq, category.id);
    return created;
  });

  /**
   * Equipment status is always derived from its reports, never typed in by hand:
   *   any report in progress -> under_repair
   *   any open report        -> issue_reported
   *   otherwise              -> working
   * Written-off items are left alone. Call inside the same transaction as the report change.
   */
  function syncStatus(equipmentId) {
    const row = q.status.get(equipmentId);
    if (!row || row.status === 'retired') return row ? row.status : null;
    const c = q.openCounts.get(equipmentId);
    const next = c.in_progress > 0 ? 'under_repair' : c.open > 0 ? 'issue_reported' : 'working';
    if (next !== row.status) q.setStatus.run(next, Date.now(), equipmentId);
    return next;
  }

  /** The site address that QR labels are made with: the configured one, else the one in use right now. */
  function scanBase(req) {
    return config.baseUrl || `${req.protocol}://${req.get('host')}`;
  }

  /** The address encoded in the QR label of an item. */
  function scanUrl(req, assetTag) {
    return `${scanBase(req)}/e/${encodeURIComponent(assetTag)}`;
  }

  /**
   * Whether QR codes made right now deserve a warning:
   *   'preview' - hosted demo preview, whose address is private
   *   'local'   - opened as localhost: no other device can open that
   *   'unset'   - no permanent address configured yet (fine for a trial, not for printing)
   * or null when BASE_URL is set.
   */
  function scanNote(req) {
    const base = scanBase(req);
    if (config.embedPreview) return { kind: 'preview', base };
    if (config.baseUrl) return null;
    const host = String(req.get('host') || '').toLowerCase();
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    const local = name === 'localhost' || name === '[::1]' || /^127(\.\d{1,3}){3}$/.test(name);
    return { kind: local ? 'local' : 'unset', base };
  }

  function qrSvg(url) {
    return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  }

  return { createEquipment, syncStatus, scanUrl, scanNote, qrSvg };
}

module.exports = { makeInventory, formatTag, TAG_PATTERN };
