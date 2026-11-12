'use strict';
/** Categories created on a fresh installation. Administrators can add more. */
module.exports.CATEGORIES = [
  ['Desktop Computer', 'PC'],
  ['Laptop', 'LAP'],
  ['Server & Storage', 'SRV'],
  ['Projector', 'PRJ'],
  ['Printer & Copier', 'PRN'],
  ['Scanner', 'SCN'],
  ['Network Equipment', 'NET'],
  ['UPS & Power Backup', 'UPS'],
  ['Air Conditioner', 'AC'],
  ['Smart Board & Display', 'SBD'],
  ['CCTV Camera', 'CAM'],
  ['Audio System', 'AUD'],
  ['Lab Instrument', 'INS'],
  ['Trainer Kit & Dev Board', 'KIT'],
  ['Workshop Machine', 'MCH'],
  ['Fire Extinguisher', 'FEX'],
  ['Water Cooler & Purifier', 'WTR'],
  ['Furniture', 'FUR'],
  ['Other Equipment', 'OTH'],
];

module.exports.ensureCategories = function ensureCategories(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO categories (name, prefix) VALUES (?, ?)');
  db.transaction(() => { for (const [name, prefix] of module.exports.CATEGORIES) insert.run(name, prefix); })();
};
