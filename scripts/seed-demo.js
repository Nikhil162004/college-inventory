'use strict';
/**
 * Fills an EMPTY database with realistic demonstration data sized for a college of
 * 3,500 students and 70 faculty: 20 labs (one with 100 PCs, nineteen with 30),
 * classrooms, offices, library, server room and workshop.
 *
 *   npm run seed:demo            (refuses if the database already has accounts)
 *   npm run seed:demo -- --reset (deletes the database file first)
 *
 * Demo accounts have published passwords, so this never runs in production,
 * except for a site that declares itself a public demonstration (PUBLIC_DEMO=1).
 */
const fs = require('fs');
const { buildConfig } = require('../src/config');
const { openDb } = require('../src/db');
const passwords = require('../src/security/password');
const { makeInventory } = require('../src/lib/inventory');
const { ensureCategories } = require('./defaults');

const DEMO_LOGINS = {
  ADMIN01: 'Register#Admin26',
  STF001: 'Register#Staff26',
  FAC001: 'Register#Faculty26',
  '23CS001': 'Register#Student26',
};

// Small deterministic random generator so every run produces the same college.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261110);
const pick = (list) => list[Math.floor(rnd() * list.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const FIRST = ['Aarav', 'Aditi', 'Akash', 'Ananya', 'Aniket', 'Anjali', 'Arjun', 'Bhavna', 'Chetan', 'Devika', 'Gaurav', 'Harsh',
  'Isha', 'Kavya', 'Kunal', 'Manasi', 'Mayur', 'Neha', 'Nikhil', 'Omkar', 'Pallavi', 'Pooja', 'Pranav', 'Prachi', 'Rahul', 'Riya',
  'Rohit', 'Rutuja', 'Sahil', 'Sakshi', 'Sanket', 'Shreya', 'Shubham', 'Sneha', 'Tanvi', 'Tejas', 'Vaishnavi', 'Varun', 'Yash', 'Zoya'];
const LAST = ['Deshmukh', 'Kulkarni', 'Patil', 'Joshi', 'Wankhede', 'Bhagat', 'Thakre', 'Gawande', 'Raut', 'Meshram', 'Sharma',
  'Verma', 'Agrawal', 'Tiwari', 'Khan', 'Sheikh', 'Dhote', 'Bawankar', 'Ingle', 'Kale', 'Pawar', 'Shinde', 'Jadhav', 'More',
  'Gupta', 'Mishra', 'Nair', 'Iyer', 'Reddy', 'Fernandes', 'Sahu', 'Chavan', 'Borkar', 'Lanjewar', 'Zade', 'Hedau'];
const personName = () => `${pick(FIRST)} ${pick(LAST)}`;
const DEPARTMENTS = [['CS', 'Computer Science & Engineering'], ['IT', 'Information Technology'], ['EC', 'Electronics & Telecommunication'],
  ['EE', 'Electrical Engineering'], ['ME', 'Mechanical Engineering'], ['CE', 'Civil Engineering'], ['AD', 'AI & Data Science']];
const VENDORS = ['Vidarbha Infotech, Nagpur', 'Shree Computers & Peripherals', 'Orange City Systems', 'National Scientific Suppliers',
  'Techno Lab Instruments', 'Central India Office Automation'];

async function main() {
  const config = buildConfig();
  if (config.isProd && !config.publicDemo) throw new Error('Demo data cannot be loaded when NODE_ENV=production.');
  if (process.argv.includes('--reset')) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
  }
  const db = openDb(config.dbPath);
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    throw new Error('This database already has accounts. Use "npm run seed:demo -- --reset" to start again from nothing.');
  }
  const inventory = makeInventory(db, config);
  const started = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  ensureCategories(db);
  const categoryId = Object.fromEntries(db.prepare('SELECT prefix, id FROM categories').all().map((c) => [c.prefix, c.id]));

  // ---------- People ----------
  const people = [];
  people.push({ college_id: 'ADMIN01', name: 'Sunita Rao', role: 'admin', department: 'Administration' });
  ['Ramesh Borkar', 'Vandana Ingle', 'Imran Sheikh', 'Deepak Sahu', 'Kiran Zade', 'Lata Meshram'].forEach((name, i) => {
    people.push({ college_id: `STF${String(i + 1).padStart(3, '0')}`, name, role: 'staff', department: 'Laboratory Services' });
  });
  for (let i = 1; i <= 70; i++) {
    const title = rnd() < 0.45 ? 'Dr.' : 'Prof.';
    people.push({ college_id: `FAC${String(i).padStart(3, '0')}`, name: `${title} ${personName()}`, role: 'faculty', department: DEPARTMENTS[(i - 1) % 7][1] });
  }
  for (const year of [23, 24, 25, 26]) {
    for (const [code, department] of DEPARTMENTS) {
      for (let n = 1; n <= 125; n++) {
        people.push({ college_id: `${year}${code}${String(n).padStart(3, '0')}`, name: personName(), role: 'student', department });
      }
    }
  }
  process.stdout.write(`Creating ${people.length} accounts `);
  for (let i = 0; i < people.length; i += 16) {
    await Promise.all(people.slice(i, i + 16).map(async (p) => {
      const known = DEMO_LOGINS[p.college_id];
      p.must_change = known ? 0 : 1;
      // Everyone else gets a random temporary password that nobody knows;
      // an administrator can reset it from the People page.
      p.hash = known ? await passwords.hash(known) : await passwords.hashTemporary(passwords.generateTemporaryPassword());
    }));
    if (i % 800 === 0) process.stdout.write('.');
  }
  const insertUser = db.prepare(
    `INSERT INTO users (college_id, name, email, role, department, password_hash, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const p of people) {
      const email = p.role === 'student' ? null : `${p.college_id.toLowerCase()}@college.example`;
      insertUser.run(p.college_id, p.name, email, p.role, p.department, p.hash, p.must_change, started - 200 * DAY);
    }
  })();
  console.log(' done');
  const userId = Object.fromEntries(db.prepare('SELECT college_id, id FROM users').all().map((u) => [u.college_id, u.id]));
  const adminId = userId.ADMIN01;
  const staffIds = [1, 2, 3, 4, 5, 6].map((n) => userId[`STF00${n}`]);

  // ---------- Labs and rooms ----------
  const insertLocation = db.prepare(
    `INSERT INTO locations (code, name, kind, building, floor, incharge_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const locationId = {};
  let facultyTurn = 0;
  function location(code, name, kind, building, floor, withIncharge = true) {
    const incharge = withIncharge ? userId[`FAC${String((facultyTurn++ % 70) + 1).padStart(3, '0')}`] : null;
    locationId[code] = Number(insertLocation.run(code, name, kind, building, floor, incharge, started - 190 * DAY).lastInsertRowid);
  }

  // ---------- Equipment ----------
  const setSerial = db.prepare('UPDATE equipment SET serial_no = ?, created_at = ?, updated_at = ? WHERE id = ?');
  const insertAudit = db.prepare(
    `INSERT INTO audit_log (user_id, actor, action, entity_type, entity_id, summary, ip, created_at) VALUES (?, 'ADMIN01', 'equipment.create', 'equipment', ?, ?, NULL, ?)`
  );
  let equipmentCount = 0;
  const pcIds = [];
  function add(prefix, code, name, quantity, d = {}) {
    const year = d.year || between(2019, 2025);
    const month = String(between(1, 12)).padStart(2, '0');
    const day = String(between(1, 28)).padStart(2, '0');
    const created = inventory.createEquipment({
      name, category_id: categoryId[prefix], location_id: locationId[code],
      brand: d.brand || null, model: d.model || null, serial_no: null, specs: d.specs || null,
      purchase_date: `${year}-${month}-${day}`, purchase_cost: d.cost || null, vendor: d.vendor || pick(VENDORS),
      warranty_until: `${year + (d.warranty || 3)}-${month}-${day}`, notes: null,
    }, quantity, adminId);
    const when = started - 180 * DAY;
    for (const item of created) {
      const serial = (d.brand ? d.brand.slice(0, 2).toUpperCase() : 'SN') + String(year).slice(2) + between(100000, 999999) + String.fromCharCode(65 + between(0, 25));
      setSerial.run(serial, when, when, item.id);
      insertAudit.run(adminId, item.id, `Added ${item.asset_tag} “${name}” in ${code}`, when);
      if (prefix === 'PC') pcIds.push(item.id);
    }
    equipmentCount += created.length;
  }

  const PC_MODELS = [
    { brand: 'Dell', model: 'OptiPlex 7010 SFF', specs: 'Core i5-13500, 16 GB RAM, 512 GB SSD, 21.5" monitor, keyboard, mouse', cost: 58500 },
    { brand: 'HP', model: 'ProDesk 400 G9', specs: 'Core i5-12500, 8 GB RAM, 512 GB SSD, 21.5" monitor, keyboard, mouse', cost: 52000 },
    { brand: 'Lenovo', model: 'ThinkCentre neo 50s', specs: 'Core i3-12100, 8 GB RAM, 256 GB SSD, 19.5" monitor, keyboard, mouse', cost: 41000 },
    { brand: 'Acer', model: 'Veriton M200', specs: 'Core i5-10400, 8 GB RAM, 1 TB HDD, 19.5" monitor, keyboard, mouse', cost: 44500 },
  ];
  const LABS = [
    ['LAB-01', 'Central Computing Centre', 'Main Block', 'Ground floor', 100],
    ['LAB-02', 'Programming Lab 1', 'CSE Block', 'First floor', 30],
    ['LAB-03', 'Programming Lab 2', 'CSE Block', 'First floor', 30],
    ['LAB-04', 'Data Structures Lab', 'CSE Block', 'First floor', 30],
    ['LAB-05', 'Database Systems Lab', 'CSE Block', 'Second floor', 30],
    ['LAB-06', 'Operating Systems Lab', 'CSE Block', 'Second floor', 30],
    ['LAB-07', 'Computer Networks Lab', 'CSE Block', 'Second floor', 30],
    ['LAB-08', 'Web Technologies Lab', 'IT Block', 'First floor', 30],
    ['LAB-09', 'AI & Machine Learning Lab', 'IT Block', 'First floor', 30],
    ['LAB-10', 'Internet of Things Lab', 'IT Block', 'Second floor', 30],
    ['LAB-11', 'Software Engineering Lab', 'IT Block', 'Second floor', 30],
    ['LAB-12', 'Project Lab', 'IT Block', 'Third floor', 30],
    ['LAB-13', 'Digital Electronics Lab', 'Electronics Block', 'Ground floor', 30],
    ['LAB-14', 'Microprocessor Lab', 'Electronics Block', 'First floor', 30],
    ['LAB-15', 'Communication Systems Lab', 'Electronics Block', 'First floor', 30],
    ['LAB-16', 'Electrical Machines Lab', 'Electrical Block', 'Ground floor', 30],
    ['LAB-17', 'CAD / CAM Lab', 'Mechanical Block', 'First floor', 30],
    ['LAB-18', 'Engineering Physics Lab', 'Science Block', 'Ground floor', 30],
    ['LAB-19', 'Engineering Chemistry Lab', 'Science Block', 'First floor', 30],
    ['LAB-20', 'Language Lab', 'Main Block', 'First floor', 30],
  ];
  const LAB_EXTRAS = {
    'LAB-07': [['NET', 'Router (practical bench)', 6, { brand: 'Cisco', model: 'ISR 1111', cost: 62000 }], ['NET', 'Managed switch (practical bench)', 6, { brand: 'Cisco', model: 'Catalyst 1000-24T', cost: 48000 }],
      ['INS', 'LAN cable tester', 10, { brand: 'Fluke', model: 'MS2-100', cost: 9500 }], ['INS', 'Crimping tool set', 15, { brand: 'D-Link', cost: 900 }]],
    'LAB-09': [['SRV', 'GPU workstation', 4, { brand: 'Dell', model: 'Precision 5860', specs: 'Xeon W5, 64 GB RAM, RTX A4000 16 GB', cost: 385000 }]],
    'LAB-10': [['KIT', 'Arduino Uno starter kit', 30, { brand: 'Arduino', model: 'Uno R3', cost: 1800 }], ['KIT', 'Raspberry Pi 4 kit', 20, { brand: 'Raspberry Pi', model: '4 Model B 4 GB', cost: 7200 }],
      ['KIT', 'Sensor module kit (37 in 1)', 15, { cost: 1500 }], ['KIT', 'ESP32 development board', 25, { brand: 'Espressif', model: 'ESP32-DevKitC', cost: 650 }]],
    'LAB-13': [['KIT', 'Digital logic trainer kit', 20, { brand: 'Scientech', model: 'ST2611', cost: 14500 }], ['INS', 'Cathode ray oscilloscope 30 MHz', 10, { brand: 'Scientech', model: '803', cost: 28000 }],
      ['INS', 'Function generator 3 MHz', 10, { brand: 'Aplab', model: 'FG3M', cost: 16500 }], ['INS', 'Digital multimeter', 20, { brand: 'Fluke', model: '17B+', cost: 9800 }], ['INS', 'Regulated DC power supply 0–30 V', 12, { brand: 'Aplab', model: 'LD3202', cost: 11000 }]],
    'LAB-14': [['KIT', '8085 microprocessor trainer kit', 20, { brand: 'Vinytics', model: 'VMC-8501', cost: 9500 }], ['KIT', '8051 microcontroller trainer kit', 15, { brand: 'Vinytics', model: 'VMC-31', cost: 11200 }],
      ['KIT', 'ARM Cortex-M development board', 15, { brand: 'STMicroelectronics', model: 'NUCLEO-F401RE', cost: 2400 }]],
    'LAB-15': [['INS', 'Digital storage oscilloscope 100 MHz', 8, { brand: 'Tektronix', model: 'TBS1102C', cost: 68000 }], ['INS', 'Spectrum analyser 1.5 GHz', 2, { brand: 'Rigol', model: 'DSA815', cost: 165000 }],
      ['KIT', 'AM / FM modulation trainer', 10, { brand: 'Scientech', model: 'ST2201', cost: 18500 }], ['KIT', 'Optical fibre communication trainer', 6, { brand: 'Scientech', model: 'ST2502', cost: 32000 }]],
    'LAB-16': [['MCH', 'DC shunt motor–generator set', 6, { brand: 'Kirloskar', cost: 96000 }], ['MCH', 'Three-phase induction motor test bench', 4, { brand: 'Crompton', cost: 118000 }],
      ['MCH', 'Single-phase transformer 2 kVA', 8, { cost: 21000 }], ['INS', 'Digital tachometer', 8, { brand: 'Lutron', model: 'DT-2236', cost: 5200 }], ['INS', 'Wattmeter', 12, { brand: 'MECO', cost: 4800 }]],
    'LAB-17': [['MCH', '3D printer (FDM)', 3, { brand: 'Creality', model: 'K1 Max', cost: 92000 }], ['PRN', 'Large-format plotter A0', 1, { brand: 'HP', model: 'DesignJet T650', cost: 245000 }]],
    'LAB-18': [['INS', 'Spectrometer', 10, { brand: 'Labtronics', cost: 14500 }], ['INS', 'Travelling microscope', 10, { brand: 'Labtronics', cost: 9800 }],
      ['INS', 'He-Ne laser kit', 6, { brand: 'Holmarc', cost: 38000 }], ['INS', 'Planck constant apparatus', 5, { brand: 'SES Instruments', cost: 21000 }]],
    'LAB-19': [['INS', 'Digital pH meter', 8, { brand: 'Systronics', model: '335', cost: 12500 }], ['INS', 'Analytical balance 0.1 mg', 4, { brand: 'Shimadzu', model: 'ATX224', cost: 98000 }],
      ['INS', 'Hot air oven', 2, { brand: 'Remi', cost: 34000 }], ['INS', 'Conductivity meter', 6, { brand: 'Systronics', model: '306', cost: 14800 }], ['INS', 'UV-visible spectrophotometer', 1, { brand: 'Shimadzu', model: 'UV-1900i', cost: 465000 }]],
    'LAB-20': [['AUD', 'Language lab headset with microphone', 30, { brand: 'Logitech', model: 'H390', cost: 2900 }], ['AUD', 'Teacher audio console', 1, { brand: 'Ahuja', cost: 26000 }]],
  };

  db.transaction(() => {
    for (const [code, name, building, floor, pcs] of LABS) {
      location(code, name, 'lab', building, floor);
      const big = pcs > 50;
      const pc = pick(PC_MODELS);
      add('PC', code, 'Desktop computer', pcs, { ...pc, year: between(2020, 2025) });
      add('PRJ', code, 'Ceiling projector', big ? 2 : 1, { brand: 'Epson', model: 'EB-X51', specs: '3800 lumens, XGA', cost: 46000 });
      add('PRN', code, 'Laser printer', big ? 2 : 1, { brand: 'HP', model: 'LaserJet Pro M405dn', cost: 27500 });
      add('NET', code, 'Network switch 24-port', Math.ceil((pcs + 4) / 24), { brand: 'D-Link', model: 'DGS-1024C', cost: 7800 });
      add('NET', code, 'Wi-Fi access point', big ? 3 : 1, { brand: 'TP-Link', model: 'EAP245', cost: 8900 });
      add('UPS', code, big ? 'Online UPS 20 kVA' : 'Online UPS 6 kVA', big ? 2 : 1, { brand: 'Numeric', model: big ? 'Keor HP 20' : 'Onfiniti 6K', cost: big ? 385000 : 118000, warranty: 2 });
      add('AC', code, 'Split air conditioner 2 ton', big ? 6 : 2, { brand: 'Voltas', model: '243V Vectra', cost: 52000, warranty: 5 });
      add('CAM', code, 'CCTV dome camera', big ? 4 : 2, { brand: 'CP Plus', model: 'CP-UNC-DA41PL3', cost: 4200, warranty: 2 });
      add('FEX', code, 'Fire extinguisher CO₂ 4.5 kg', big ? 3 : 1, { brand: 'Ceasefire', cost: 6800, warranty: 1 });
      if (big || rnd() < 0.5) add('SBD', code, 'Interactive smart board 75"', 1, { brand: 'BenQ', model: 'RP7503', cost: 185000 });
      for (const [prefix, itemName, qty, details] of LAB_EXTRAS[code] || []) add(prefix, code, itemName, qty, details);
    }

    for (const floor of [1, 2]) {
      for (let n = 1; n <= 12; n++) {
        const code = `CR-${floor}${String(n).padStart(2, '0')}`;
        location(code, `Classroom ${floor}${String(n).padStart(2, '0')}`, 'classroom', 'Academic Block', floor === 1 ? 'First floor' : 'Second floor', false);
        add('PRJ', code, 'Ceiling projector', 1, { brand: 'BenQ', model: 'MX560', specs: '4000 lumens, XGA', cost: 42000 });
        add('CAM', code, 'CCTV dome camera', 1, { brand: 'CP Plus', model: 'CP-UNC-DA41PL3', cost: 4200, warranty: 2 });
        if (floor === 1) add('SBD', code, 'Interactive smart board 75"', 1, { brand: 'BenQ', model: 'RP7503', cost: 185000 });
        if (n % 3 === 0) add('AUD', code, 'Lectern amplifier with microphone', 1, { brand: 'Ahuja', model: 'PSX-600DP', cost: 14500 });
      }
    }

    location('LIB-01', 'Central Library', 'library', 'Library Building', 'Ground floor');
    add('PC', 'LIB-01', 'Desktop computer (catalogue terminal)', 12, PC_MODELS[2]);
    add('PRN', 'LIB-01', 'Multifunction photocopier', 2, { brand: 'Canon', model: 'imageRUNNER 2425', cost: 132000 });
    add('SCN', 'LIB-01', 'Barcode scanner', 4, { brand: 'Honeywell', model: 'Voyager 1250g', cost: 5200 });
    add('CAM', 'LIB-01', 'CCTV dome camera', 6, { brand: 'CP Plus', cost: 4200, warranty: 2 });
    add('AC', 'LIB-01', 'Split air conditioner 2 ton', 4, { brand: 'Voltas', cost: 52000, warranty: 5 });
    add('WTR', 'LIB-01', 'Water purifier with cooler', 1, { brand: 'Blue Star', cost: 38000 });

    location('SEM-01', 'Seminar Hall', 'hall', 'Main Block', 'Second floor');
    add('PRJ', 'SEM-01', 'Laser projector 6000 lumens', 2, { brand: 'Epson', model: 'EB-L630U', cost: 215000 });
    add('AUD', 'SEM-01', 'PA amplifier and speaker system', 1, { brand: 'Ahuja', model: 'SSA-250DP', cost: 68000 });
    add('AUD', 'SEM-01', 'Wireless microphone', 4, { brand: 'Ahuja', model: 'AWM-700U', cost: 9800 });
    add('AC', 'SEM-01', 'Cassette air conditioner 3 ton', 4, { brand: 'Daikin', cost: 128000, warranty: 5 });

    location('AUD-01', 'Auditorium', 'hall', 'Main Block', 'Ground floor');
    add('PRJ', 'AUD-01', 'Laser projector 10000 lumens', 1, { brand: 'Panasonic', model: 'PT-MZ10K', cost: 640000 });
    add('AUD', 'AUD-01', 'Line array speaker system', 2, { brand: 'JBL', model: 'CBT 70J', cost: 210000 });
    add('AUD', 'AUD-01', 'Digital audio mixer 16-channel', 1, { brand: 'Yamaha', model: 'MG16XU', cost: 58000 });
    add('AC', 'AUD-01', 'Ductable air conditioner 8.5 ton', 6, { brand: 'Blue Star', cost: 310000, warranty: 5 });

    location('SRV-01', 'Server Room', 'other', 'Main Block', 'First floor');
    add('SRV', 'SRV-01', 'Rack server', 6, { brand: 'Dell', model: 'PowerEdge R650', specs: '2 × Xeon Silver, 128 GB RAM', cost: 620000 });
    add('SRV', 'SRV-01', 'Network storage (NAS) 48 TB', 1, { brand: 'Synology', model: 'RS2423+', cost: 410000 });
    add('NET', 'SRV-01', 'Core switch 48-port', 2, { brand: 'Cisco', model: 'Catalyst 9300-48T', cost: 540000 });
    add('NET', 'SRV-01', 'Firewall appliance', 1, { brand: 'Fortinet', model: 'FortiGate 200F', cost: 480000 });
    add('UPS', 'SRV-01', 'Online UPS 20 kVA', 2, { brand: 'Numeric', model: 'Keor HP 20', cost: 385000, warranty: 2 });
    add('AC', 'SRV-01', 'Precision air conditioner', 2, { brand: 'Vertiv', cost: 420000, warranty: 5 });

    const OFFICES = [['OFF-01', 'Administrative Office', 10, 3], ['OFF-02', 'Principal’s Office', 2, 1], ['OFF-03', 'Examination Cell', 6, 2], ['OFF-04', 'Training & Placement Cell', 5, 1]];
    for (const [code, name, pcs, printers] of OFFICES) {
      location(code, name, 'office', 'Main Block', 'Ground floor', false);
      add('PC', code, 'Desktop computer', pcs, PC_MODELS[1]);
      add('PRN', code, 'Laser printer', printers, { brand: 'HP', model: 'LaserJet Pro M405dn', cost: 27500 });
      add('AC', code, 'Split air conditioner 1.5 ton', pcs > 4 ? 2 : 1, { brand: 'Voltas', cost: 44000, warranty: 5 });
    }
    add('SCN', 'OFF-01', 'Document scanner', 1, { brand: 'Canon', model: 'DR-C230', cost: 34000 });
    add('SCN', 'OFF-03', 'OMR / document scanner', 1, { brand: 'Kodak', model: 'i3300', cost: 265000 });
    add('PRN', 'OFF-03', 'High-volume photocopier', 1, { brand: 'Ricoh', model: 'IM 6000', cost: 410000 });

    for (const [code, department] of DEPARTMENTS) {
      const room = `STF-${code}`;
      location(room, `${department} Staff Room`, 'office', 'Academic Block', 'Third floor', false);
      add('LAP', room, 'Faculty laptop', 8, { brand: 'Lenovo', model: 'ThinkPad E14 Gen 5', specs: 'Core i5, 16 GB RAM, 512 GB SSD', cost: 68000 });
      add('PRN', room, 'Laser printer', 1, { brand: 'Brother', model: 'HL-L2321D', cost: 11500 });
    }

    location('WRK-01', 'Mechanical Workshop', 'other', 'Workshop Building', 'Ground floor');
    add('MCH', 'WRK-01', 'Centre lathe machine', 8, { brand: 'HMT', model: 'NH-22', cost: 485000 });
    add('MCH', 'WRK-01', 'Pillar drilling machine', 3, { brand: 'Kirloskar', cost: 78000 });
    add('MCH', 'WRK-01', 'Arc welding set', 4, { brand: 'Ador', model: 'Champ 400', cost: 42000 });
    add('MCH', 'WRK-01', 'Bench grinder', 2, { brand: 'Bosch', model: 'GBG 60-20', cost: 12500 });
    add('MCH', 'WRK-01', 'Milling machine', 2, { brand: 'BFW', cost: 720000 });
    add('FEX', 'WRK-01', 'Fire extinguisher ABC 6 kg', 4, { brand: 'Ceasefire', cost: 3200, warranty: 1 });

    location('COM-01', 'Corridors & Common Areas', 'other', 'All blocks', null, false);
    add('WTR', 'COM-01', 'Water cooler 150 L', 8, { brand: 'Voltas', cost: 46000 });
    add('FEX', 'COM-01', 'Fire extinguisher ABC 6 kg', 24, { brand: 'Ceasefire', cost: 3200, warranty: 1 });
    add('CAM', 'COM-01', 'CCTV bullet camera', 32, { brand: 'Hikvision', model: 'DS-2CD1043G2', cost: 5600, warranty: 2 });

    location('STO-01', 'Central Store', 'store', 'Main Block', 'Basement', false);
    add('PRJ', 'STO-01', 'Spare projector', 3, { brand: 'Epson', model: 'EB-X51', cost: 46000 });
    add('UPS', 'STO-01', 'Spare UPS 1 kVA', 6, { brand: 'APC', model: 'BX1100C-IN', cost: 7200, warranty: 2 });
    add('LAP', 'STO-01', 'Loan laptop', 10, { brand: 'HP', model: '250 G9', specs: 'Core i3, 8 GB RAM, 512 GB SSD', cost: 39500 });
  })();

  // ---------- Problem reports ----------
  const SAMPLE = [
    ['not_working', 'Does not power on. No light on the front panel even after changing the power cable.'],
    ['not_working', 'Starts but shuts down on its own after about ten minutes.'],
    ['not_working', 'Monitor stays black. The CPU fan is running and the keyboard lights come on.'],
    ['damaged', 'Two keys are missing from the keyboard and the space bar is stuck.'],
    ['damaged', 'Front USB ports are broken, the plastic inside is bent.'],
    ['missing_part', 'The mouse is missing from this system.'],
    ['missing_part', 'Power cable for the monitor is not there.'],
    ['software', 'Windows asks for activation and Code::Blocks will not open.'],
    ['software', 'Python and VS Code are not installed on this machine, needed for the practical.'],
    ['software', 'Very slow, takes more than ten minutes to reach the desktop.'],
    ['network', 'No internet. The network icon shows a cable is unplugged, but it is plugged in.'],
    ['network', 'Cannot reach the lab server from this system, other systems in the row work.'],
    ['other', 'Makes a loud grinding noise from the cabinet while running.'],
  ];
  const RESOLUTIONS = ['Replaced the SMPS. Tested for one hour, working normally.', 'Reinstalled the operating system and lab software image.',
    'Replaced the keyboard and mouse from store.', 'Re-crimped the LAN cable and changed the switch port.', 'RAM reseated and cabinet cleaned. Working.'];
  const students = db.prepare("SELECT id FROM users WHERE role IN ('student','faculty') ORDER BY id").all().map((u) => u.id);
  const insertReport = db.prepare(
    `INSERT INTO reports (equipment_id, reporter_id, issue_type, description, status, assigned_to, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertUpdate = db.prepare('INSERT INTO report_updates (report_id, user_id, from_status, to_status, note, created_at) VALUES (?,?,?,?,?,?)');
  const plan = [...Array(16).fill('open'), ...Array(9).fill('in_progress'), ...Array(22).fill('resolved'), ...Array(3).fill('rejected')];
  const used = new Set();
  db.transaction(() => {
    plan.forEach((status, i) => {
      let equipmentId;
      do { equipmentId = pick(pcIds); } while (used.has(equipmentId));
      used.add(equipmentId);
      const reporter = students[Math.floor(rnd() * students.length)];
      const [issue, text] = pick(SAMPLE);
      const active = status === 'open' || status === 'in_progress';
      const created = started - (active ? between(1, 9) * DAY + between(0, 20) * 3600000 : between(10, 70) * DAY);
      const staff = status === 'open' ? null : pick(staffIds);
      const closed = active ? null : created + between(1, 4) * DAY;
      const id = Number(insertReport.run(equipmentId, reporter, issue, text, status, staff, created, closed || created + 3600000, closed).lastInsertRowid);
      insertUpdate.run(id, reporter, null, 'open', null, created);
      if (status !== 'open') insertUpdate.run(id, staff, 'open', 'in_progress', 'Checked on site. Taking it up.', created + between(2, 20) * 3600000);
      if (status === 'resolved') insertUpdate.run(id, staff, 'in_progress', 'resolved', pick(RESOLUTIONS), closed);
      if (status === 'rejected') insertUpdate.run(id, staff, 'in_progress', 'rejected', 'Checked the system twice, it is working normally. The monitor power switch was off.', closed);
      inventory.syncStatus(equipmentId);
      void i;
    });
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('demo', '1')").run();
  })();

  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  console.log(`Demo college ready in ${((Date.now() - started) / 1000).toFixed(1)} s:`);
  console.log(`  ${count('users')} accounts, ${count('locations')} labs and rooms, ${equipmentCount} pieces of equipment, ${count('reports')} reports`);
  console.log('Demo sign-ins:');
  for (const [id, pw] of Object.entries(DEMO_LOGINS)) console.log(`  ${id.padEnd(8)} ${pw}`);
  db.close();
}

main().catch((err) => {
  console.error('Seeding failed: ' + err.message);
  process.exitCode = 1;
});
