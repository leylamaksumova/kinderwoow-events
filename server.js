const express = require('express');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const util = require('util');
const crypto = require('crypto');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

// --- CONFIGURATION (all secrets come from environment variables, see .env.example) ---
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const REQUIRED_ENV = ['DATABASE_URL', 'SESSION_SECRET'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingEnv.join(', ')}`);
    process.exit(1);
}

// Only used once, to create the first admin account when there are no admin users yet
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || GMAIL_USER;
// Public address of the website, used for canonical / hreflang links and the sitemap
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');

const SESSION_COOKIE = 'kw_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// Business timezone, used to decide what "today" is when rejecting past dates
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Europe/Berlin';
const MAX_BOOKING_YEARS_AHEAD = 2;

const LIMITS = { name: 100, phone: 25, message: 1000, contentText: 2000 };

const BOOKING_STATUSES = ['pending', 'accepted', 'rejected'];
const ADMIN_ROLES = ['admin', 'staff'];

// --- SITE TEXTS (shared with the browser through public/js/site-texts.js) ---
const PUBLIC_DIR = path.join(__dirname, 'public');

function loadSharedTexts() {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'site-texts.js'), 'utf8'), sandbox);
    return sandbox.window;
}

const { SITE_TEXTS, SERVICE_OPTIONS } = loadSharedTexts();

// Only these services can be booked (codes from SERVICE_OPTIONS)
const ALLOWED_SERVICES = SERVICE_OPTIONS.map((service) => service.code);

// Bookings made before services had codes were stored with their Russian names
const LEGACY_SERVICE_NAMES = {
    'Маскоты и персонажи': 'mascot',
    'Шоу фокусов и магии': 'magic',
    'Детский день рождения': 'birthday',
    'Пенная вечеринка': 'foam',
    'Шар шоу': 'balloon',
    'Диджей и музыка': 'dj',
    'Спецэффекты': 'effects',
    'Аквагрим': 'facepaint',
};

function serviceLabel(code, lang = 'de') {
    const service = SERVICE_OPTIONS.find((s) => s.code === code);
    return service ? SITE_TEXTS[lang][service.textKey] : code;
}

const app = express();

// Render (and most hosts) sit behind a reverse proxy; needed so rate limiting sees the real client IP
app.set('trust proxy', 1);

// Reject oversized request bodies
app.use(express.json({ limit: '10kb' }));

// Images never change under the same name, so browsers may cache them for a long time
app.use('/images', express.static(path.join(PUBLIC_DIR, 'images'), { maxAge: '30d' }));
// Serve static files from the 'public' directory (the language pages are rendered below)
app.use(express.static(PUBLIC_DIR, { index: false }));

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
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Columns added after the first release (no-op if they already exist)
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending'`);
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status_updated_by VARCHAR(50)`);
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ`);

    // Store service codes instead of the old Russian service names
    for (const [name, code] of Object.entries(LEGACY_SERVICE_NAMES)) {
        await pool.query('UPDATE bookings SET service = $1 WHERE service = $2', [code, name]);
    }

    // CMS table for editable site texts (one row per text, in three languages)
    await pool.query(`CREATE TABLE IF NOT EXISTS site_content (
        section_key VARCHAR(64) PRIMARY KEY,
        ru TEXT NOT NULL DEFAULT '',
        de TEXT NOT NULL DEFAULT '',
        en TEXT NOT NULL DEFAULT ''
    )`);
    await pool.query(`ALTER TABLE site_content ADD COLUMN IF NOT EXISTS updated_by VARCHAR(50)`);
    await pool.query(`ALTER TABLE site_content ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);

    // Admin panel accounts: every person logs in with their own username and password
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role VARCHAR(10) NOT NULL DEFAULT 'staff',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
    )`);

    // Who changed what in the admin panel
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        username VARCHAR(50) NOT NULL DEFAULT '',
        action VARCHAR(40) NOT NULL,
        details JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admin_users');
    if (rows[0].count === 0) {
        if (!ADMIN_PASSWORD) {
            throw new Error('There are no admin users yet: set ADMIN_PASSWORD to create the first admin account.');
        }
        if (!isValidUsername(ADMIN_USERNAME)) {
            throw new Error('ADMIN_USERNAME may only contain letters, digits, ".", "_" and "-" (3-50 characters).');
        }
        await pool.query(
            'INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3)',
            [ADMIN_USERNAME, await hashPassword(ADMIN_PASSWORD), 'admin']
        );
        console.log(`👤 Created the first admin user "${ADMIN_USERNAME}" (password from ADMIN_PASSWORD).`);
    }
    console.log('📦 Connected to PostgreSQL, tables are ready.');
}

// Texts edited in the admin panel: { key: { ru, de, en } }. Cached until the next save.
let contentCache = null;

async function getSiteContent() {
    if (!contentCache) {
        const { rows } = await pool.query('SELECT section_key, ru, de, en FROM site_content');
        const content = {};
        rows.forEach((row) => {
            content[row.section_key] = { ru: row.ru, de: row.de, en: row.en };
        });
        contentCache = content;
    }
    return contentCache;
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

    const service = serviceLabel(booking.service, 'de');
    const mailOptions = {
        from: `"KinderWoow Website" <${GMAIL_USER}>`,
        to: NOTIFY_EMAIL,
        subject: `🎉 New Event Booking: ${service}`,
        html: `
            <h2>New Booking from KinderWoow Website!</h2>
            <p><strong>Client Name:</strong> ${escapeHtml(booking.name)}</p>
            <p><strong>Phone:</strong> ${escapeHtml(booking.phone)}</p>
            <p><strong>Service:</strong> ${escapeHtml(service)}</p>
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

// --- PUBLIC PAGES (one URL per language, rendered on the server so search engines see every language) ---
const LANGUAGES = ['de', 'ru', 'en'];
const DEFAULT_LANG = 'de';
const LANG_PATHS = { de: '/', ru: '/ru/', en: '/en/' };
const LANG_NAMES = { de: 'Deutsch', ru: 'Русский', en: 'English' };
const OG_LOCALES = { de: 'de_DE', ru: 'ru_RU', en: 'en_US' };

const PAGE_TEMPLATE = fs.readFileSync(path.join(__dirname, 'views', 'index.html'), 'utf8');

function siteBaseUrl(req) {
    return SITE_URL || `${req.protocol}://${req.get('host')}`;
}

// Website defaults with the texts saved in the admin panel on top
function pageTexts(lang, content) {
    const texts = { ...SITE_TEXTS[lang] };
    for (const [key, saved] of Object.entries(content)) {
        if (saved[lang]) texts[key] = saved[lang];
    }
    return texts;
}

// JSON inside <script> must not be able to close the tag
function jsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function seoHead(lang, t, baseUrl) {
    const pageUrl = baseUrl + LANG_PATHS[lang];
    const imageUrl = `${baseUrl}/images/hero-banner.webp`;
    const alternates = LANGUAGES
        .map((l) => `<link rel="alternate" hreflang="${l}" href="${escapeHtml(baseUrl + LANG_PATHS[l])}">`)
        .join('\n  ');
    const business = {
        '@context': 'https://schema.org',
        '@type': 'LocalBusiness',
        name: 'KinderWoow Events',
        description: t.meta_description,
        url: pageUrl,
        image: imageUrl,
        telephone: t.contact_phone,
        email: t.contact_email,
        address: { '@type': 'PostalAddress', addressCountry: 'DE' },
        areaServed: 'DE',
        sameAs: SOCIAL_NETWORKS.map(({ key }) => String(t[key] || '').trim()).filter((url) => url.startsWith('https://')),
    };

    return `<meta name="description" content="${escapeHtml(t.meta_description)}">
  <link rel="canonical" href="${escapeHtml(pageUrl)}">
  ${alternates}
  <link rel="alternate" hreflang="x-default" href="${escapeHtml(baseUrl + LANG_PATHS[DEFAULT_LANG])}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="KinderWoow Events">
  <meta property="og:title" content="${escapeHtml(t.meta_title)}">
  <meta property="og:description" content="${escapeHtml(t.meta_description)}">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">
  <meta property="og:locale" content="${OG_LOCALES[lang]}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">${jsonForScript(business)}</script>`;
}

const SOCIAL_NETWORKS = [
    { key: 'contact_instagram', icon: 'fa-instagram', label: 'Instagram' },
    { key: 'contact_tiktok', icon: 'fa-tiktok', label: 'TikTok' },
    { key: 'contact_whatsapp', icon: 'fa-whatsapp', label: 'WhatsApp' },
];

// Icons only for the social links filled in the admin panel (and only real https:// addresses)
function socialLinks(t) {
    return SOCIAL_NETWORKS
        .map(({ key, icon, label }) => ({ url: String(t[key] || '').trim(), icon, label }))
        .filter(({ url }) => /^https:\/\/[^\s"<>]+$/.test(url))
        .map(({ url, icon, label }) => `
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener" aria-label="${label}" class="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center hover:bg-pink-500 hover:border-pink-500 transition text-white">
            <i class="fa-brands ${icon}"></i>
          </a>`)
        .join('');
}

function renderPage(lang, content, baseUrl) {
    const t = pageTexts(lang, content);
    const tokens = {
        LANG: lang,
        TITLE: escapeHtml(t.meta_title),
        SEO_HEAD: seoHead(lang, t, baseUrl),
        LANG_CODE: lang.toUpperCase(),
        LANG_NAME: LANG_NAMES[lang],
        HOME_URL: LANG_PATHS[lang],
        TEL: escapeHtml(String(t.contact_phone).replace(/\(0\)/g, '').replace(/[^\d+]/g, '')),
        EMAIL: escapeHtml(t.contact_email),
        SOCIAL_LINKS: socialLinks(t),
        CLIENT_TEXTS: jsonForScript({ msg_error: t.msg_error, msg_connection_failed: t.msg_connection_failed }),
    };

    let html = PAGE_TEMPLATE.replace(/\{\{([A-Z_]+)\}\}/g, (match, name) => (name in tokens ? tokens[name] : match));

    // Text of elements marked with data-i18n="key" (these elements contain plain text only)
    html = html.replace(
        /(<([a-z0-9]+)\b[^>]*\sdata-i18n="([a-z0-9_]+)"[^>]*>)[^<]*(<\/\2>)/g,
        (match, open, tag, key, close) => (t[key] ? open + escapeHtml(t[key]) + close : match)
    );

    // Attributes marked with data-i18n-placeholder="key" / data-i18n-alt="key"
    html = html.replace(/<[a-z0-9]+\b[^>]*\sdata-i18n-(?:placeholder|alt)="[^"]*"[^>]*>/g, (tag) => {
        let result = tag;
        for (const [, attr, key] of tag.matchAll(/\sdata-i18n-(placeholder|alt)="([a-z0-9_]+)"/g)) {
            if (t[key]) {
                result = result.replace(new RegExp(`\\s${attr}="[^"]*"`), () => ` ${attr}="${escapeHtml(t[key])}"`);
            }
        }
        return result;
    });

    return html;
}

async function sendPage(lang, req, res, next) {
    try {
        const html = renderPage(lang, await getSiteContent(), siteBaseUrl(req));
        res.set('Content-Language', lang).type('html').send(html);
    } catch (err) {
        next(err);
    }
}

app.get('/', (req, res, next) => sendPage(DEFAULT_LANG, req, res, next));

app.get(/^\/(ru|en)\/?$/, (req, res, next) => {
    if (!req.path.endsWith('/')) return res.redirect(301, `${req.path}/`);
    sendPage(req.params[0], req, res, next);
});

// Old address of the home page
app.get('/index.html', (req, res) => res.redirect(301, '/'));

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
        `User-agent: *\nDisallow: /api/\nDisallow: /admin.html\n\nSitemap: ${siteBaseUrl(req)}/sitemap.xml\n`
    );
});

app.get('/sitemap.xml', (req, res) => {
    const baseUrl = siteBaseUrl(req);
    const alternates = LANGUAGES
        .map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${escapeHtml(baseUrl + LANG_PATHS[l])}"/>`)
        .join('\n');
    const urls = LANGUAGES.map((lang) => `  <url>
    <loc>${escapeHtml(baseUrl + LANG_PATHS[lang])}</loc>
${alternates}
    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeHtml(baseUrl + LANG_PATHS[DEFAULT_LANG])}"/>
  </url>`).join('\n');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`);
});

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

const str = (value) => (typeof value === 'string' ? value.trim() : '');

// Returns { errors: [...] } or { booking: {...} } with cleaned values
function validateBooking(body) {
    const errors = [];

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

function isValidUsername(username) {
    return /^[a-z0-9._-]{3,50}$/.test(username);
}

function passwordError(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
        return 'Password must be between 8 and 200 characters.';
    }
    return null;
}

// --- PASSWORDS (scrypt, stored as "scrypt$<salt>$<hash>") ---
const scrypt = util.promisify(crypto.scrypt);

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
    const [scheme, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, 'hex');
    const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(key, expected);
}

// Checked when the username doesn't exist, so the response time doesn't reveal valid usernames
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// --- ADMIN AUTHENTICATION ---
// The session is an HttpOnly cookie "<userId>.<expiresAt>.<hmac>" signed with SESSION_SECRET.
// The signature also covers the user's password hash, so changing a password ends that user's old sessions.
function sign(value) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function safeEqual(a, b) {
    // Hash first so both buffers always have the same length
    const hashA = crypto.createHash('sha256').update(String(a)).digest();
    const hashB = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

function sessionSignature(userId, expiresAt, passwordHash) {
    return sign(`${userId}.${expiresAt}.${passwordHash}`);
}

function createSessionToken(user) {
    const expiresAt = String(Date.now() + SESSION_TTL_MS);
    return `${user.id}.${expiresAt}.${sessionSignature(user.id, expiresAt, user.password_hash)}`;
}

// Returns { id, username, role } for a valid session, otherwise null
async function getSessionUser(token) {
    if (typeof token !== 'string') return null;
    const [userId, expiresAt, signature] = token.split('.');
    if (!/^\d{1,9}$/.test(userId || '') || !signature || !(Number(expiresAt) > Date.now())) return null;

    const { rows } = await pool.query(
        'SELECT id, username, role, password_hash FROM admin_users WHERE id = $1',
        [Number(userId)]
    );
    const user = rows[0];
    if (!user || !safeEqual(signature, sessionSignature(user.id, expiresAt, user.password_hash))) return null;
    return { id: user.id, username: user.username, role: user.role };
}

function getCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) {
            try {
                return decodeURIComponent(rest.join('='));
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict', // cookie is not sent on cross-site requests (CSRF protection)
    secure: IS_PRODUCTION,
    path: '/api',
};

function setSessionCookie(res, user) {
    res.cookie(SESSION_COOKIE, createSessionToken(user), { ...cookieOptions, maxAge: SESSION_TTL_MS });
}

async function requireAdmin(req, res, next) {
    try {
        const user = await getSessionUser(getCookie(req, SESSION_COOKIE));
        if (!user) return res.status(401).json({ error: 'Unauthorized.' });
        req.user = user;
        next();
    } catch (err) {
        next(err);
    }
}

// Use after requireAdmin: only users with the "admin" role (manage users, see the activity log)
function requireAdminRole(req, res, next) {
    if (req.user.role === 'admin') return next();
    res.status(403).json({ error: 'Only administrators can do this.' });
}

// Records who did what in the admin panel. A logging failure must not fail the action itself.
async function audit(user, action, details = {}) {
    try {
        await pool.query(
            'INSERT INTO admin_audit_log (user_id, username, action, details) VALUES ($1, $2, $3, $4)',
            [user ? user.id : null, user ? user.username : '', action, JSON.stringify(details)]
        );
    } catch (err) {
        console.error('Failed to write audit log:', err);
    }
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

// Admin login: checks username and password on the server and sets the session cookie
app.post('/api/admin/login', loginLimiter, async (req, res, next) => {
    const body = req.body || {};
    const username = str(body.username).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';

    try {
        const { rows } = await pool.query(
            'SELECT id, username, role, password_hash FROM admin_users WHERE username = $1',
            [username]
        );
        const user = rows[0];
        const passwordOk = await verifyPassword(password, user ? user.password_hash : await DUMMY_PASSWORD_HASH);
        if (!user || !passwordOk) {
            await audit(null, 'login_failed', { username: username.slice(0, 50) });
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        await pool.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [user.id]);
        await audit(user, 'login');
        setSessionCookie(res, user);
        res.json({ success: true, user: { username: user.username, role: user.role } });
    } catch (err) {
        next(err);
    }
});

app.post('/api/admin/logout', async (req, res, next) => {
    try {
        const user = await getSessionUser(getCookie(req, SESSION_COOKIE));
        if (user) await audit(user, 'logout');
        res.clearCookie(SESSION_COOKIE, cookieOptions);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// Lets the admin page check whether the current session is still valid
app.get('/api/admin/session', requireAdmin, (req, res) => {
    res.json({ authenticated: true, user: { username: req.user.username, role: req.user.role } });
});

// Change your own password
app.post('/api/admin/password', requireAdmin, async (req, res, next) => {
    const body = req.body || {};
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const error = passwordError(body.newPassword);
    if (error) return res.status(400).json({ error });

    try {
        const { rows } = await pool.query('SELECT password_hash FROM admin_users WHERE id = $1', [req.user.id]);
        if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
            return res.status(400).json({ error: 'Current password is wrong.' });
        }
        const passwordHash = await hashPassword(body.newPassword);
        await pool.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [passwordHash, req.user.id]);
        await audit(req.user, 'password_change');
        // Old sessions are now invalid, so give this browser a new one
        setSessionCookie(res, { id: req.user.id, password_hash: passwordHash });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// Admin users (administrators only)
app.get('/api/admin/users', requireAdmin, requireAdminRole, async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, username, role, created_at, last_login_at FROM admin_users ORDER BY username'
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

app.post('/api/admin/users', requireAdmin, requireAdminRole, async (req, res, next) => {
    const body = req.body || {};
    const username = str(body.username).toLowerCase();
    const role = ADMIN_ROLES.includes(body.role) ? body.role : 'staff';
    if (!isValidUsername(username)) {
        return res.status(400).json({ error: 'Username may only contain letters, digits, ".", "_" and "-" (3-50 characters).' });
    }
    const error = passwordError(body.password);
    if (error) return res.status(400).json({ error });

    try {
        const { rows } = await pool.query(
            `INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3)
             ON CONFLICT (username) DO NOTHING RETURNING id`,
            [username, await hashPassword(body.password), role]
        );
        if (rows.length === 0) return res.status(409).json({ error: 'This username already exists.' });
        await audit(req.user, 'user_create', { username, role });
        res.json({ success: true, id: rows[0].id });
    } catch (err) {
        next(err);
    }
});

app.patch('/api/admin/users/:id/password', requireAdmin, requireAdminRole, async (req, res, next) => {
    const { id } = req.params;
    if (!/^\d{1,9}$/.test(id)) return res.status(400).json({ error: 'Invalid user id.' });
    const error = passwordError(req.body && req.body.password);
    if (error) return res.status(400).json({ error });

    try {
        const passwordHash = await hashPassword(req.body.password);
        const { rows } = await pool.query(
            'UPDATE admin_users SET password_hash = $1 WHERE id = $2 RETURNING id, username',
            [passwordHash, Number(id)]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
        await audit(req.user, 'user_password_reset', { username: rows[0].username });
        if (rows[0].id === req.user.id) setSessionCookie(res, { id: req.user.id, password_hash: passwordHash });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

app.delete('/api/admin/users/:id', requireAdmin, requireAdminRole, async (req, res, next) => {
    const { id } = req.params;
    if (!/^\d{1,9}$/.test(id)) return res.status(400).json({ error: 'Invalid user id.' });
    if (Number(id) === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });

    try {
        const { rows } = await pool.query('DELETE FROM admin_users WHERE id = $1 RETURNING username', [Number(id)]);
        if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
        await audit(req.user, 'user_delete', { username: rows[0].username });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// Activity log (administrators only)
app.get('/api/admin/audit', requireAdmin, requireAdminRole, async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, username, action, details, created_at FROM admin_audit_log ORDER BY id DESC LIMIT 300'
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// 1. Get all bookings (admin only)
app.get('/api/bookings', requireAdmin, async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, name, phone, service, to_char(event_date, 'YYYY-MM-DD') AS date, message, status, is_read,
                    created_at, status_updated_by, status_updated_at
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

// 3. Update booking status (admin only)
app.patch('/api/bookings/:id/status', requireAdmin, async (req, res, next) => {
    const { id } = req.params;
    const status = req.body && req.body.status;
    if (!/^\d{1,9}$/.test(id)) {
        return res.status(400).json({ error: 'Invalid booking id.' });
    }
    if (!BOOKING_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status.' });
    }

    try {
        const { rows } = await pool.query(
            `UPDATE bookings b
             SET status = $1, is_read = TRUE, status_updated_by = $3, status_updated_at = NOW()
             FROM (SELECT id, status FROM bookings WHERE id = $2 FOR UPDATE) old
             WHERE b.id = old.id
             RETURNING b.name, old.status AS old_status, b.status_updated_at`,
            [status, Number(id), req.user.username]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found.' });
        }
        await audit(req.user, 'booking_status', { id: Number(id), name: rows[0].name, from: rows[0].old_status, to: status });
        res.json({ success: true, status_updated_by: req.user.username, status_updated_at: rows[0].status_updated_at });
    } catch (err) {
        next(err);
    }
});

// 4. Delete a booking (admin only)
app.delete('/api/bookings/:id', requireAdmin, async (req, res, next) => {
    const { id } = req.params;
    if (!/^\d{1,9}$/.test(id)) {
        return res.status(400).json({ error: 'Invalid booking id.' });
    }

    try {
        const { rows } = await pool.query(
            `DELETE FROM bookings WHERE id = $1
             RETURNING name, phone, service, to_char(event_date, 'YYYY-MM-DD') AS date`,
            [Number(id)]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found.' });
        }
        await audit(req.user, 'booking_delete', { id: Number(id), ...rows[0] });
        res.json({ success: true, deletedID: Number(id) });
    } catch (err) {
        next(err);
    }
});

// 5. Get editable site texts (public)
app.get('/api/content', async (req, res, next) => {
    try {
        res.json(await getSiteContent());
    } catch (err) {
        next(err);
    }
});

// Site texts with who changed them last (admin only)
app.get('/api/admin/content', requireAdmin, async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT section_key, ru, de, en, updated_by, updated_at FROM site_content');
        const content = {};
        rows.forEach((row) => {
            content[row.section_key] = {
                ru: row.ru, de: row.de, en: row.en, updated_by: row.updated_by, updated_at: row.updated_at,
            };
        });
        res.json(content);
    } catch (err) {
        next(err);
    }
});

// 6. Save or update a site text (admin only)
app.post('/api/admin/content', requireAdmin, async (req, res, next) => {
    const body = req.body || {};
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!/^[a-z0-9_]{1,64}$/.test(key)) {
        return res.status(400).json({ error: 'Key may only contain lowercase letters, digits and "_".' });
    }

    const texts = {};
    for (const lang of LANGUAGES) {
        const value = typeof body[lang] === 'string' ? body[lang].trim() : '';
        if (value.length > LIMITS.contentText) {
            return res.status(400).json({ error: `Text must be at most ${LIMITS.contentText} characters.` });
        }
        texts[lang] = value;
    }

    try {
        const before = await pool.query('SELECT ru, de, en FROM site_content WHERE section_key = $1', [key]);
        const { rows } = await pool.query(
            `INSERT INTO site_content (section_key, ru, de, en, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (section_key) DO UPDATE
             SET ru = EXCLUDED.ru, de = EXCLUDED.de, en = EXCLUDED.en, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
             RETURNING updated_at`,
            [key, texts.ru, texts.de, texts.en, req.user.username]
        );
        contentCache = null;
        await audit(req.user, 'content_update', { key, before: before.rows[0] || null, after: texts });
        res.json({ success: true, updated_by: req.user.username, updated_at: rows[0].updated_at });
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
