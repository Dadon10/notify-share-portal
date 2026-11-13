# Notify & Share Portal

Internal document approval portal. Users sign in through the CRM, submit documents (payment requisitions, invoices, HR, Legal, Compliance and Operations documents), route them through an ordered chain of approvers who sign them, and get notified by SMTP email.

## Requirements

- Node.js 22 (see `.nvmrc`); the app uses the built-in `node:sqlite` module
- LibreOffice (`libreoffice` on the PATH) to convert payment requisitions to PDF

## Development

```sh
nvm install
nvm use
npm i
cp .env.example .env   # fill in SMTP, PORTAL_SSO_SECRET and URLs
npm run dev            # http://localhost:3005
```

Data is stored locally in `data/` (SQLite database, uploads and signatures), which is not committed.

## Scripts

- `npm run build` / `npm run preview` — production build (Node server in `.output/`)
- `npm run lint` / `npm run format`
- `npm run test:signatures` — signature cleaning and placement checks (generated data only)
- `npm run test:invoices` — invoice extraction checks (needs fixtures in `tests/invoice-extraction/fixtures/`)
