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
- `npm run test:contracts` — contract signing, notarization and certificate checks (generated data only)

## Contracts

**New contract** (`/contract`) sends a PDF for signature:

1. Upload the contract PDF and choose who signs it, in order. Signers must be CRM users.
2. Mark where each person signs: drag **Signature**, **Initials**, **Date signed** or **Full name** boxes onto the pages. Each signer needs at least one signature box.
3. Optionally tick **Notarize** and choose a notary. Administrators mark people as notaries in **Settings**, with their commission number, jurisdiction and expiry date.

Each signer signs from **Approvals**. Their saved signature, name and the date are stamped into their boxes, and initials are written in a handwriting-style font. When the notary's turn comes (after every party has signed), they confirm they verified each signer's identity. The portal then writes the notary's initials (e.g. "KM" for Kennedy Malama) in handwriting-style ink in the bottom-right corner of every page, moving them up if a signer's box already sits there. Every finished contract gets a certificate of completion with the SHA-256 fingerprint of the original upload. The untouched original is kept and can be downloaded.

The handwriting font is Homemade Apple (Apache 2.0), in `public/fonts/`.

The portal records an electronic notarization. Whether that is legally valid depends on the jurisdiction's rules for electronic notarial acts. The notary named on the contract is responsible for meeting them.
