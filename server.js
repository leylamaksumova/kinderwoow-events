const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

// --- CONFIGURATION (all secrets come from environment variables, see .env.example) ---
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const REQUIRED_ENV = ['DATABASE_URL', 'ADMIN_PASSWORD', 'SESSION_SECRET'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingEnv.join(', ')}`);
    process.exit(1);
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || GMAIL_USER;

const SESSION_COOKIE = 'kw_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// Business timezone, used to decide what "today" is when rejecting past dates
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Europe/Berlin';
const MAX_BOOKING_YEARS_AHEAD = 2;

// Only these services can be booked (must match <option value="..."> in index.html)
const ALLOWED_SERVICES = [
    'Маскоты и персонажи',
    'Шоу фокусов и магии',
    'Детский день рождения',
    'Пенная вечеринка',
    'Шар шоу',
    'Диджей и музыка',
    'Спецэффекты',
    'Аквагрим',
];

const LIMITS = { name: 100, phone: 25, message: 1000 };

const app = express();

// Render (and most hosts) sit behind a reverse proxy; needed so rate limiting sees the real client IP
app.set('trust proxy', 1);

// Reject oversized request bodies
app.use(express.json({ limit: '10kb' }));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE (PostgreSQL) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL error:', err);
});

async function initDatabase() {
    await pool.query(`CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        name VARCHAR(${LIMITS.name}) NOT NULL,
        phone VARCHAR(${LIMITS.phone}) NOT NULL,
        service VARCHAR(100) NOT NULL,
        event_date DATE NOT NULL,
        message VARCHAR(${LIMITS.message}) NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    console.log('📦 Connected to PostgreSQL, bookings table is ready.');
}

// --- EMAIL (Nodemailer) ---
const transporter = GMAIL_USER && GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    })
    : null;

if (!transporter) {
    console.warn('⚠️  GMAIL_USER / GMAIL_APP_PASSWORD not set, email notifications are disabled.');
}

// Escape user input before putting it into HTML (prevents HTML injection / phishing links in emails)
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Helper function to send email notifications for new bookings
async function sendEmailNotification(booking) {
    if (!transporter) return;

    const mailOptions = {
        from: `"KinderWoow Website" <${GMAIL_USER}>`,
        to: NOTIFY_EMAIL,
        subject: `🎉 New Event Booking: ${booking.service}`,
        html: `
            <h2>New Booking from KinderWoow Website!</h2>
            <p><strong>Client Name:</strong> ${escapeHtml(booking.name)}</p>
            <p><strong>Phone:</strong> ${escapeHtml(booking.phone)}</p>
            <p><strong>Service:</strong> ${escapeHtml(booking.service)}</p>
            <p><strong>Event Date:</strong> ${escapeHtml(booking.date)}</p>
            <p><strong>Message / Special Requests:</strong> ${escapeHtml(booking.message || 'None provided')}</p>
            <hr>
            <p><small>Automated notification sent from your KinderWoow server.</small></p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('📧 Email notification sent successfully!');
    } catch (error) {
        console.error('❌ Failed to send email notification:', error);
    }
}

// --- VALIDATION ---
function todayInBusinessTimezone() {
    // 'en-CA' formats dates as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE }).format(new Date());
}

function isValidCalendarDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Returns { errors: [...] } or { booking: {...} } with cleaned values
function validateBooking(body) {
    const errors = [];
    const str = (value) => (typeof value === 'string' ? value.trim() : '');

    const name = str(body.name);
    const phone = str(body.phone);
    const service = str(body.service);
    const date = str(body.date);
    const message = str(body.message);

    if (name.length < 2 || name.length > LIMITS.name) {
        errors.push(`Name must be between 2 and ${LIMITS.name} characters.`);
    }

    if (!/^\+?[0-9\s\-()]{6,25}$/.test(phone)) {
        errors.push('Please enter a valid phone number.');
    }

    if (!ALLOWED_SERVICES.includes(service)) {
        errors.push('Please choose a service from the list.');
    }

    if (!isValidCalendarDate(date)) {
        errors.push('Please enter a valid date (YYYY-MM-DD).');
    } else {
        const today = todayInBusinessTimezone();
        const maxYear = Number(today.slice(0, 4)) + MAX_BOOKING_YEARS_AHEAD;
        const maxDate = `${maxYear}${today.slice(4)}`;
        if (date < today) {
            errors.push('The event date cannot be in the past.');
        } else if (date > maxDate) {
            errors.push(`The event date cannot be more than ${MAX_BOOKING_YEARS_AHEAD} years ahead.`);
        }
    }

    if (message.length > LIMITS.message) {
        errors.push(`Message must be at most ${LIMITS.message} characters.`);
    }

    if (errors.length > 0) return { errors };
    return { booking: { name, phone, service, date, message } };
}

// --- ADMIN AUTHENTICATION ---
// The session is an HttpOnly cookie "<expiresAt>.<hmac>" signed with SESSION_SECRET,
// so it can't be read by page scripts or forged without the secret.
function sign(value) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function safeEqual(a, b) {
    // Hash first so both buffers always have the same length
    const hashA = crypto.createHash('sha256').update(String(a)).digest();
    const hashB = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

function createSessionToken() {
    const expiresAt = String(Date.now() + SESSION_TTL_MS);
    return `${expiresAt}.${sign(expiresAt)}`;
}

function isValidSessionToken(token) {
    if (typeof token !== 'string') return false;
    const [expiresAt, signature] = token.split('.');
    if (!expiresAt || !signature) return false;
    if (!safeEqual(signature, sign(expiresAt))) return false;
    return Number(expiresAt) > Date.now();
}

function getCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return decodeURIComponent(rest.join('='));
    }
    return undefined;
}

const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict', // cookie is not sent on cross-site requests (CSRF protection)
    secure: IS_PRODUCTION,
    path: '/api',
};

function requireAdmin(req, res, next) {
    if (isValidSessionToken(getCookie(req, SESSION_COOKIE))) return next();
    res.status(401).json({ error: 'Unauthorized.' });
}

// --- RATE LIMITING ---
const bookingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many booking requests. Please try again later.' },
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again later.' },
});

// --- API ROUTES ---

// Admin login: checks the password on the server and sets the session cookie
app.post('/api/admin/login', loginLimiter, (req, res) => {
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!safeEqual(password, ADMIN_PASSWORD)) {
        return res.status(401).json({ error: 'Invalid password.' });
    }
    res.cookie(SESSION_COOKIE, createSessionToken(), { ...cookieOptions, maxAge: SESSION_TTL_MS });
    res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json({ success: true });
});

// Lets the admin page check whether the current session is still valid
app.get('/api/admin/session', requireAdmin, (req, res) => {
    res.json({ authenticated: true });
});

// 1. Get all bookings (admin only)
app.get('/api/bookings', requireAdmin, async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, name, phone, service, to_char(event_date, 'YYYY-MM-DD') AS date, message, created_at
             FROM bookings ORDER BY id DESC`
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// 2. Create a new booking (public, rate limited; saves to DB and sends email notification)
app.post('/api/bookings', bookingLimiter, async (req, res, next) => {
    const body = req.body || {};

    // Honeypot: real users never see or fill the "website" field, bots usually do.
    // Pretend success so the bot doesn't learn it was blocked.
    if (body.website) {
        return res.json({ success: true, message: 'Booking saved successfully!' });
    }

    const { errors, booking } = validateBooking(body);
    if (errors) {
        return res.status(400).json({ error: errors.join(' ') });
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO bookings (name, phone, service, event_date, message)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [booking.name, booking.phone, booking.service, booking.date, booking.message]
        );
        const id = rows[0].id;

        // Email is sent in the background; a mail failure must not fail the booking
        sendEmailNotification({ id, ...booking });

        res.json({ success: true, id, message: 'Booking saved successfully!' });
    } catch (err) {
        next(err);
    }
});

// 3. Delete a booking (admin only)
app.delete('/api/bookings/:id', requireAdmin, async (req, res, next) => {
    const { id } = req.params;
    if (!/^\d{1,9}$/.test(id)) {
        return res.status(400).json({ error: 'Invalid booking id.' });
    }

    try {
        const result = await pool.query('DELETE FROM bookings WHERE id = $1', [Number(id)]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Booking not found.' });
        }
        res.json({ success: true, deletedID: Number(id) });
    } catch (err) {
        next(err);
    }
});

// Unknown API routes
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found.' });
});

// Central error handler: log details on the server, never send them to the client
app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request is too large.' });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON.' });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error. Please try again later.' });
});

// Start Express server only after the database is ready
initDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`🚀 Server running at: http://localhost:${PORT}`);
        });
    })
    .catch((err) => {
        console.error('❌ Failed to initialize database:', err);
        process.exit(1);
    });
