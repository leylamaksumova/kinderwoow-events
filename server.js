const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse incoming JSON payloads
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Connect to SQLite database
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('📦 Successfully connected to SQLite database.');
    }
});

// Create bookings table if it does not exist
db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    service TEXT NOT NULL,
    date TEXT NOT NULL,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// --- NODEMAILER CONFIGURATION ---
// Configure email transporter with your credentials
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'leylamaksumova211@gmail.com',         // <-- Enter your Gmail address here
    
        pass: 'kgvj awpy luhy zeay'           // <-- Enter your 16-character App Password here
    }
});

// Helper function to send email notifications for new bookings
async function sendEmailNotification(booking) {
    const mailOptions = {
        from: '"KinderWoow Website" <leylamaksumova211@gmail.com>', // <-- Enter your sender email here
        to: 'leylamaksumova211@gmail.com',                          // <-- Enter the recipient email address here
        subject: `🎉 New Event Booking: ${booking.service}`,
        html: `
            <h2>New Booking from KinderWoow Website!</h2>
            <p><strong>Client Name:</strong> ${booking.name}</p>
            <p><strong>Phone:</strong> ${booking.phone}</p>
            <p><strong>Service:</strong> ${booking.service}</p>
            <p><strong>Event Date:</strong> ${booking.date}</p>
            <p><strong>Message / Special Requests:</strong> ${booking.message || 'None provided'}</p>
            <hr>
            <p><small>Automated notification sent from your KinderWoow server.</small></p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('📧 Email notification sent successfully!');
    } catch (error) {
        console.error('❌ Failed to send email notification:', error);
    }
}

// --- API ROUTES ---

// 1. Get all bookings (for admin dashboard)
app.get('/api/bookings', (req, res) => {
    db.all(`SELECT * FROM bookings ORDER BY id DESC`, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// 2. Create a new booking (saves to DB and sends email notification)
app.post('/api/bookings', (req, res) => {
    const { name, phone, service, date, message } = req.body;
    
    if (!name || !phone || !service || !date) {
        return res.status(400).json({ error: 'Please fill in all required fields.' });
    }

    const query = `INSERT INTO bookings (name, phone, service, date, message) VALUES (?, ?, ?, ?, ?)`;
    db.run(query, [name, phone, service, date, message || ''], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }

        const newBooking = { id: this.lastID, name, phone, service, date, message };

        // Save to Database AND trigger email notification simultaneously
        sendEmailNotification(newBooking);

        res.json({ 
            success: true, 
            id: this.lastID,
            message: 'Booking saved successfully!' 
        });
    });
});

// 3. Delete a booking (for admin dashboard)
app.delete('/api/bookings/:id', (req, res) => {
    const id = req.params.id;
    db.run(`DELETE FROM bookings WHERE id = ?`, id, function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ success: true, deletedID: id });
    });
});

// Start Express server
app.listen(PORT, () => {
    console.log(`🚀 Server running at: http://localhost:${PORT}`);
});