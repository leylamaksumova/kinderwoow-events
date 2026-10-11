# KinderWoow

Website and booking backend for KinderWoow events (Node.js + Express + PostgreSQL).

## Local setup

1. Install dependencies: `npm install`
2. Create a PostgreSQL database (for example `createdb kinderwoow`).
3. Copy `.env.example` to `.env` and fill in the values.
4. Start the server: `npm run dev` (reads `.env`), then open http://localhost:3000.
   The admin panel is at http://localhost:3000/admin.html.

All tables are created automatically on first start. On the very first start the server also
creates an admin account: username `ADMIN_USERNAME` (default `admin`), password `ADMIN_PASSWORD`.
After that, accounts are managed in the admin panel (section "Users") and `ADMIN_PASSWORD` is no longer used.

## Languages and SEO

Each language has its own URL, rendered on the server so search engines can index all of them:
`/` (German, default), `/ru/` and `/en/`. Every page has its own `<title>`, meta description,
canonical and `hreflang` links. `/sitemap.xml` and `/robots.txt` are generated automatically.

- Page template: `views/index.html`. Elements with `data-i18n="key"` get their text from
  `public/js/site-texts.js`, or from the admin text editor if the text was changed there.
- The SEO title/description and the contact address, phone and e-mail can be edited in the
  admin panel (text editor → "SEO" and "Contact").
- Images in `public/images` are WebP, max. 1200px wide (hero 1920px). Please keep new images small too.
- Social icons (Instagram, TikTok, WhatsApp) appear in the footer only after their link is filled in the
  admin text editor (group "Contact"). Links must start with `https://`, e.g. `https://wa.me/49151...` for WhatsApp.

## Styles (Tailwind CSS)

The pages use a prebuilt stylesheet `public/css/site.css` (no Tailwind CDN script, so pages load faster).
After adding or changing Tailwind classes in `views/index.html`, `public/admin.html` or `server.js`, rebuild it
and commit the result:

```
npm run build:css
```

## Admin panel

- Every person logs in with their own username and password.
- Roles: **Administrator** (can also add/delete users, reset passwords and see the activity log)
  and **Staff** (bookings and site texts).
- The activity log records logins, booking status changes, deletions, text changes and user changes, with who and when.
- The booking list shows when each request was received and who last changed its status.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `DATABASE_SSL` | no | `true` if the database requires SSL |
| `ADMIN_USERNAME` | no | Username of the first admin account (default `admin`) |
| `ADMIN_PASSWORD` | first start | Password of the first admin account (only used while there are no admin users) |
| `SESSION_SECRET` | yes | Long random string used to sign admin sessions |
| `RESEND_API_KEY` | no | [Resend](https://resend.com) API key: sends notifications over HTTPS (use this on DigitalOcean, which blocks SMTP) |
| `MAIL_FROM` | no | Sender for Resend (default `KinderWoow Website <onboarding@resend.dev>`) |
| `GMAIL_USER` | no | Gmail address that sends notifications (used when `RESEND_API_KEY` is not set) |
| `GMAIL_APP_PASSWORD` | no | Gmail App Password (emails are disabled if missing) |
| `NOTIFY_EMAIL` | no | Recipient of notifications (defaults to `GMAIL_USER`; required with Resend) |
| `SITE_URL` | recommended | Public address of the site, e.g. `https://kinderwoow.de` (used for canonical links and the sitemap) |
| `BUSINESS_TIMEZONE` | no | Timezone for "today" when checking booking dates (default `Europe/Berlin`) |
| `NODE_ENV` | no | Set to `production` on the live server |

## Deploying on your own server (DigitalOcean droplet, Ubuntu 24.04)

1. Point the domain to the server: DNS `A` records for `@` and `www` → the server's IP.
2. Log in as root (`ssh root@<server-ip>`) and run the setup script once:
   ```
   curl -fsSL https://raw.githubusercontent.com/leylamaksumova/kinderwoow-events/main/deploy/setup.sh -o setup.sh
   bash setup.sh kinderwoow.de you@example.com
   ```
   It installs Node.js 22, PostgreSQL, nginx and the firewall, creates the database with random passwords
   (stored in `/etc/kinderwoow.env`), runs the site as the `kinderwoow` systemd service and gets a free
   Let's Encrypt HTTPS certificate. The first admin password is printed once at the end.
3. Put new code live after merging to `main`: `bash /opt/kinderwoow/deploy/update.sh`

Useful commands: `systemctl status kinderwoow`, `journalctl -u kinderwoow -f` (logs),
`nano /etc/kinderwoow.env` then `systemctl restart kinderwoow` (settings, e.g. Gmail notifications).

## Deploying on Render

1. Create a PostgreSQL database in Render and copy its **Internal Database URL**.
2. In the web service → **Environment**, add the variables above
   (`DATABASE_URL` = the internal URL, `NODE_ENV=production`).
3. Build command: `npm install`, start command: `npm start`.

## API

| Method | Path | Access |
| --- | --- | --- |
| `POST` | `/api/bookings` | public, rate limited (5 requests / 15 min per IP) |
| `GET` | `/api/bookings` | admin only |
| `DELETE` | `/api/bookings/:id` | admin only |
| `PATCH` | `/api/bookings/:id/status` | admin only |
| `GET` | `/api/content` | public |
| `GET`/`POST` | `/api/admin/content` | admin only |
| `POST` | `/api/admin/login` | public, rate limited |
| `POST` | `/api/admin/logout` | public |
| `GET` | `/api/admin/session` | admin only |
| `POST` | `/api/admin/password` | admin only (own password) |
| `GET`/`POST` | `/api/admin/users` | administrators only |
| `PATCH` | `/api/admin/users/:id/password` | administrators only |
| `DELETE` | `/api/admin/users/:id` | administrators only |
| `GET` | `/api/admin/audit` | administrators only |
