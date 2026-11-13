import { database } from "./local-db.server";
import { retargetPaymentPurpose, type InvoiceSuggestion, type RequisitionFields } from "./invoice-pr.server";

/**
 * Auto-fill memory and accuracy tracking.
 *
 * supplier_profiles  what each supplier's most recent submitted PR used, so the next invoice from the
 *                    same supplier can be pre-filled (expenditure item, account, currency, wording, ...).
 * autofill_feedback  for every auto-filled invoice PR: what the portal suggested per field versus what
 *                    was actually submitted, to measure where auto-fill gets corrected.
 */
database.exec(`
  CREATE TABLE IF NOT EXISTS supplier_profiles (
    payee_key TEXT PRIMARY KEY,
    payee TEXT NOT NULL,
    tax_ids TEXT NOT NULL DEFAULT '[]',
    account_id TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '',
    expenditure_item TEXT NOT NULL DEFAULT '',
    budgeted TEXT NOT NULL DEFAULT 'Y',
    mode_of_payment TEXT NOT NULL DEFAULT '',
    payment_purpose TEXT NOT NULL DEFAULT '',
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS autofill_feedback (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    payee TEXT NOT NULL DEFAULT '',
    field TEXT NOT NULL,
    suggested TEXT NOT NULL DEFAULT '',
    submitted TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL,
    changed INTEGER NOT NULL CHECK (changed IN (0,1)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS autofill_feedback_field ON autofill_feedback(field);
`);

type ModeOfPayment = "Cash" | "Cheque" | "EFT" | "TT" | "Mobile";
type SupplierProfileRow = {
  payee_key: string;
  payee: string;
  tax_ids: string;
  account_id: string;
  currency: string;
  expenditure_item: string;
  budgeted: string;
  mode_of_payment: string;
  payment_purpose: string;
  use_count: number;
  last_used_at: string;
};

export type FieldOrigin = "read" | "remembered" | "none";
export const TRACKED_FIELDS = [
  "invoiceNumber",
  "invoiceDate",
  "billingPeriod",
  "accountId",
  "payee",
  "amount",
  "currency",
  "expenditureItem",
  "budgeted",
  "paymentPurpose",
] as const;
export type TrackedField = (typeof TRACKED_FIELDS)[number];

export type RememberedSuggestion = InvoiceSuggestion & {
  expenditureItem: string;
  budgeted: "Y" | "N";
  modeOfPayment: ModeOfPayment | "";
  origins: Record<TrackedField, FieldOrigin>;
  rememberedSupplier: { payee: string; lastUsedAt: string; useCount: number } | null;
};

// Legal-form and filler words that differ between invoices from the same company.
const NAME_NOISE = /\b(?:limited|ltd|plc|pty|proprietary|corporation|corp|company|co|inc|incorporated|llc|zambia|the|t\/a|and)\b/g;

function payeeKey(payee: string) {
  return payee.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(NAME_NOISE, " ").replace(/\s+/g, "");
}

function parseIds(value: string) {
  try {
    const ids = JSON.parse(value) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function findSupplierProfile(payee: string, taxIds: string[]) {
  const key = payee ? payeeKey(payee) : "";
  if (key) {
    const exact = database.prepare("SELECT * FROM supplier_profiles WHERE payee_key = ?").get(key) as SupplierProfileRow | undefined;
    if (exact) return exact;
  }
  if (!taxIds.length) return undefined;
  // A TPIN only identifies a supplier when exactly one profile has it. A number shared by several
  // suppliers is almost certainly the customer's (Sanlam's) own TPIN and is ignored.
  const profiles = database.prepare("SELECT * FROM supplier_profiles").all() as SupplierProfileRow[];
  const owners = new Map<string, SupplierProfileRow[]>();
  for (const profile of profiles) {
    for (const id of parseIds(profile.tax_ids)) owners.set(id, [...(owners.get(id) ?? []), profile]);
  }
  for (const id of taxIds) {
    const matches = owners.get(id);
    if (matches?.length === 1) return matches[0];
  }
  return undefined;
}

function formatDay(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

/** Fills gaps in an invoice suggestion from the supplier's last PR, and flags disagreements with it. */
export function applySupplierMemory(suggestion: InvoiceSuggestion): RememberedSuggestion {
  const origins = Object.fromEntries(
    TRACKED_FIELDS.map((field) => {
      const value = field in suggestion ? String(suggestion[field as keyof InvoiceSuggestion] ?? "") : "";
      return [field, value.trim() ? "read" : "none"];
    }),
  ) as Record<TrackedField, FieldOrigin>;
  const result: RememberedSuggestion = {
    ...suggestion,
    uncertainFields: [...suggestion.uncertainFields],
    extractionWarnings: [...suggestion.extractionWarnings],
    sources: { ...suggestion.sources },
    expenditureItem: "",
    budgeted: "Y",
    modeOfPayment: "",
    origins,
    rememberedSupplier: null,
  };
  const profile = findSupplierProfile(suggestion.payee, suggestion.taxIds);
  if (!profile) return result;

  const when = formatDay(profile.last_used_at);
  const note = `Remembered from the last PR for ${profile.payee}${when ? ` (${when})` : ""}`;
  const remember = (field: TrackedField, value: string) => {
    if (!value) return;
    (result as Record<string, unknown>)[field] = value;
    result.origins[field] = "remembered";
    result.sources[field] = note;
  };

  if (!result.payee) remember("payee", profile.payee);
  if (!result.accountId) remember("accountId", profile.account_id);
  else if (profile.account_id && result.accountId.toLowerCase() !== profile.account_id.toLowerCase()) {
    result.extractionWarnings.push(`The account on this invoice (${result.accountId}) differs from the last PR for ${profile.payee} (${profile.account_id}).`);
    result.uncertainFields.push("accountId");
  }
  if (!result.currency) remember("currency", profile.currency);
  else if (profile.currency && result.currency !== profile.currency) {
    result.extractionWarnings.push(`This invoice is in ${result.currency}, but the last PR for ${profile.payee} was in ${profile.currency}.`);
    result.uncertainFields.push("currency");
  }
  remember("expenditureItem", profile.expenditure_item);
  if (profile.budgeted === "N" || profile.budgeted === "Y") {
    result.budgeted = profile.budgeted;
    result.origins.budgeted = "remembered";
  }
  if (["Cash", "Cheque", "EFT", "TT", "Mobile"].includes(profile.mode_of_payment)) result.modeOfPayment = profile.mode_of_payment as ModeOfPayment;
  if (!result.paymentPurpose && profile.payment_purpose) {
    remember("paymentPurpose", retargetPaymentPurpose(profile.payment_purpose, result.billingPeriod));
  }
  result.uncertainFields = [...new Set(result.uncertainFields)];
  result.rememberedSupplier = { payee: profile.payee, lastUsedAt: profile.last_used_at, useCount: profile.use_count };
  return result;
}

/** Saves the submitted values as the supplier's profile for next time. */
export function rememberSupplier(fields: RequisitionFields, modeOfPayment: string) {
  const key = payeeKey(fields.payee);
  if (!key) return;
  const existing = database.prepare("SELECT tax_ids FROM supplier_profiles WHERE payee_key = ?").get(key) as { tax_ids: string } | undefined;
  const taxIds = [...new Set([...parseIds(existing?.tax_ids ?? "[]"), ...fields.taxIds])];
  database.prepare(
    `INSERT INTO supplier_profiles
       (payee_key, payee, tax_ids, account_id, currency, expenditure_item, budgeted, mode_of_payment, payment_purpose, use_count, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(payee_key) DO UPDATE SET
       payee = excluded.payee,
       tax_ids = excluded.tax_ids,
       account_id = excluded.account_id,
       currency = excluded.currency,
       expenditure_item = excluded.expenditure_item,
       budgeted = excluded.budgeted,
       mode_of_payment = excluded.mode_of_payment,
       payment_purpose = excluded.payment_purpose,
       use_count = supplier_profiles.use_count + 1,
       last_used_at = excluded.last_used_at`,
  ).run(
    key,
    fields.payee,
    JSON.stringify(taxIds),
    fields.accountId ?? "",
    fields.currency,
    fields.expenditureItem,
    fields.budgeted,
    modeOfPayment,
    fields.paymentPurpose,
    new Date().toISOString(),
  );
}

export type AutofillSnapshot = {
  suggested: Partial<Record<TrackedField, string>>;
  origins: Partial<Record<TrackedField, FieldOrigin>>;
};

function comparable(field: TrackedField, value: string) {
  if (field === "amount") {
    const amount = Number(value.replaceAll(",", "").trim());
    return value.trim() && Number.isFinite(amount) ? amount.toFixed(2) : "";
  }
  if (field === "invoiceDate") {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  }
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Records, per field, what auto-fill suggested and what the person actually submitted. */
export function recordAutofillFeedback(documentId: string, fields: RequisitionFields, snapshot: AutofillSnapshot) {
  const submitted: Record<TrackedField, string> = {
    invoiceNumber: fields.invoiceNumber,
    invoiceDate: fields.invoiceDate,
    billingPeriod: fields.billingPeriod,
    accountId: fields.accountId ?? "",
    payee: fields.payee,
    amount: Number.isFinite(fields.amount) ? fields.amount.toFixed(2) : "",
    currency: fields.currency,
    expenditureItem: fields.expenditureItem,
    budgeted: fields.budgeted,
    paymentPurpose: fields.paymentPurpose,
  };
  const createdAt = new Date().toISOString();
  const insert = database.prepare(
    `INSERT INTO autofill_feedback (id, document_id, payee, field, suggested, submitted, origin, changed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const field of TRACKED_FIELDS) {
    const suggested = String(snapshot.suggested[field] ?? "").slice(0, 500);
    const origin = snapshot.origins[field] ?? (suggested.trim() ? "read" : "none");
    const changed = comparable(field, suggested) !== comparable(field, submitted[field]) ? 1 : 0;
    insert.run(crypto.randomUUID(), documentId, fields.payee, field, suggested, submitted[field].slice(0, 500), origin, changed, createdAt);
  }
}

const FIELD_LABELS: Record<TrackedField, string> = {
  invoiceNumber: "Invoice number",
  invoiceDate: "Invoice date",
  billingPeriod: "Billing period",
  accountId: "Account ID",
  payee: "Supplier",
  amount: "Amount",
  currency: "Currency",
  expenditureItem: "Expenditure item",
  budgeted: "Budgeted",
  paymentPurpose: "Being payment for",
};

export function getAutofillStats() {
  const prs = (database.prepare("SELECT COUNT(DISTINCT document_id) AS n FROM autofill_feedback").get() as { n: number }).n;
  const fieldRows = database.prepare(
    `SELECT field, origin, COUNT(*) AS total, SUM(changed) AS changed
     FROM autofill_feedback GROUP BY field, origin`,
  ).all() as { field: TrackedField; origin: FieldOrigin; total: number; changed: number }[];
  const fields = TRACKED_FIELDS.map((field) => {
    const rows = fieldRows.filter((row) => row.field === field);
    const pick = (origin: FieldOrigin) => rows.find((row) => row.origin === origin) ?? { total: 0, changed: 0 };
    const read = pick("read");
    const remembered = pick("remembered");
    const none = pick("none");
    return {
      field,
      label: FIELD_LABELS[field],
      read: { total: read.total, corrected: read.changed },
      remembered: { total: remembered.total, corrected: remembered.changed },
      typedByUser: none.total,
    };
  });
  const suppliers = database.prepare(
    `SELECT payee, COUNT(DISTINCT document_id) AS prs,
            SUM(CASE WHEN origin != 'none' THEN 1 ELSE 0 END) AS filled,
            SUM(CASE WHEN origin != 'none' AND changed = 1 THEN 1 ELSE 0 END) AS corrected
     FROM autofill_feedback GROUP BY payee ORDER BY prs DESC, payee LIMIT 20`,
  ).all() as { payee: string; prs: number; filled: number; corrected: number }[];
  const recentCorrections = (database.prepare(
    `SELECT payee, field, suggested, submitted, origin, created_at
     FROM autofill_feedback WHERE changed = 1 AND origin != 'none'
     ORDER BY created_at DESC LIMIT 15`,
  ).all() as { payee: string; field: TrackedField; suggested: string; submitted: string; origin: FieldOrigin; created_at: string }[])
    .map((row) => ({ ...row, label: FIELD_LABELS[row.field] ?? row.field }));
  const filled = fields.reduce((sum, field) => sum + field.read.total + field.remembered.total, 0);
  const corrected = fields.reduce((sum, field) => sum + field.read.corrected + field.remembered.corrected, 0);
  return { prs, filled, corrected, fields, suppliers, recentCorrections };
}
