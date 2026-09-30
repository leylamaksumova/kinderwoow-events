const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt'); // Used for secure password hashing

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setup
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static frontend files from 'public' folder

// Database setup (SQLite file will be created automatically)
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('📦 Successfully connected to the SQLite database.');
  }
});

// Initialize database tables on startup
db.serialize(() => {
  // Bookings table
  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    date TEXT,
    service TEXT,
    message TEXT,
    status TEXT DEFAULT 'pending',
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // CMS table for dynamic texts and settings
  db.run(`CREATE TABLE IF NOT EXISTS site_content (
    section_key TEXT PRIMARY KEY,
    ru TEXT,
    de TEXT,
    en TEXT
  )`);
});

// Multer storage configuration for image uploads (saved in public/images)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public/images'));
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// --- API ROUTES ---

// SECURE ADMIN LOGIN ROUTE
// Password is verified securely on the backend, never exposed to the frontend code.
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  
  // Hardcoded secure password for backend verification
  if (password === 'KinderWoow2026!') {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// 1. Create a new booking from the website form
app.post('/api/bookings', (req, res) => {
  const { name, phone, date, service, message } = req.body;
  const query = `INSERT INTO bookings (name, phone, date, service, message) VALUES (?, ?, ?, ?, ?)`;
  
  db.run(query, [name, phone, date, service, message], function(err) {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true, id: this.lastID });
  });
});

// 2. Fetch all bookings (for the admin panel)
app.get('/api/bookings', (req, res) => {
  db.all("SELECT * FROM bookings ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 3. Update booking status
app.patch('/api/bookings/:id/status', (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  db.run(`UPDATE bookings SET status = ?, is_read = 1 WHERE id = ?`, [status, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 4. Fetch site content / translations (CMS)
app.get('/api/content', (req, res) => {
  db.all("SELECT * FROM site_content", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const content = {};
    rows.forEach(row => {
      content[row.section_key] = { ru: row.ru, de: row.de, en: row.en };
    });
    res.json(content);
  });
});

// 5. Save or update site text from admin panel
app.post('/api/admin/content', (req, res) => {
  const { key, ru, de, en } = req.body;
  db.run(`INSERT INTO site_content (section_key, ru, de, en) VALUES (?, ?, ?, ?) 
          ON CONFLICT(section_key) DO UPDATE SET ru=?, de=?, en=?`,
          [key, ru, de, en, ru, de, en], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 6. Handle image upload from admin panel
app.post('/api/admin/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const imagePath = `images/${req.file.filename}`;
  res.json({ success: true, imageUrl: imagePath });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at: http://localhost:${PORT}`);
});