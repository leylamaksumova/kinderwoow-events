# KinderWoow

Website and booking backend for KinderWoow events (Node.js + Express + PostgreSQL).

## Local setup

1. Install dependencies: `npm install`
2. Create a PostgreSQL database (for example `createdb kinderwoow`).
3. Copy `.env.example` to `.env` and fill in the values.
4. Start the server: `npm run dev` (reads `.env`), then open http://localhost:3000.
   The admin panel is at http://localhost:3000/admin.html.

The `bookings` table is created automatically on first start.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `DATABASE_SSL` | no | `true` if the database requires SSL |
| `ADMIN_PASSWORD` | yes | Password for the admin panel |
| `SESSION_SECRET` | yes | Long random string used to sign admin sessions |
| `GMAIL_USER` | no | Gmail address that sends notifications |
| `GMAIL_APP_PASSWORD` | no | Gmail App Password (emails are disabled if missing) |
| `NOTIFY_EMAIL` | no | Recipient of notifications (defaults to `GMAIL_USER`) |
| `NODE_ENV` | no | Set to `production` on the live server |

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
| `POST` | `/api/admin/login` | public, rate limited |
| `POST` | `/api/admin/logout` | public |
| `GET` | `/api/admin/session` | admin only |
