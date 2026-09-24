# NexusX Node.js backend

The backend is `backend/server.js`. It uses Express, PostgreSQL, and Safaricom Daraja for real payment testing. Without `DATABASE_URL`, it uses the ignored `data/nexusx.json` fallback for local UI development.

## Run locally

Install the npm dependencies, then run from this folder:

```powershell
npm install
npm start
```

Open `http://localhost:3000` in the browser. The API is available at `/api?action=...`.

## PostgreSQL

Copy `.env.example` to `.env`, create a PostgreSQL database, and set `DATABASE_URL`. The server creates the `users` and `transactions` tables on startup. Set `DATABASE_SSL=true` for hosted PostgreSQL providers that require TLS.

## Daraja sandbox

Create a Safaricom Daraja sandbox app and fill in the `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, and `MPESA_PASSKEY` values in `.env`. Set `MPESA_CALLBACK_URL` to a public HTTPS URL pointing to `/api/daraja/callback`; a tunnel such as ngrok is needed for local callbacks. Keep `MPESA_ENV=sandbox` while testing.

Supported actions:

- `POST /api?action=signup` with `name`, `email`, `password`
- `POST /api?action=login` with `email`, `password`
- `POST /api?action=logout`
- `GET /api?action=state`
- `POST /api?action=deposit` with `amount`, `method`, `account_type`
- `POST /api?action=withdraw` with `amount`, `method`, `account_type`
- `POST /api?action=order` with `order_type`, `asset`, `direction`, `price`, `account_type` and `lots` or `amount`
- `POST /api?action=residency` with `country`, `full_name`, `id_number`, `address`
- `GET /api?action=daraja_status`
- `POST /api?action=mpesa_stk_push` with `amount` and `phone_number` in `254XXXXXXXXX` format

The `data/nexusx.sqlite` file is created automatically and is ignored by Git.