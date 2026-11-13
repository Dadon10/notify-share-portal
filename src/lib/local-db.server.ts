import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sendApproverWelcomeEmail, sendDocumentApprovalEmail, sendDocumentCompletedEmail, sendDocumentRejectedEmail } from "./email.server";
import { addSignatureToRequisition, appendInvoiceToRequisitionPdf, buildPaymentRequisition, convertRequisitionDocxToPdf, prepareSignatureImage, type InvoiceOverrides } from "./invoice-pr.server";

const databasePath = join(process.cwd(), "data", "portal.sqlite");
export const uploadDirectory = join(process.cwd(), "data", "uploads");
export const signatureDirectory = join(process.cwd(), "data", "signatures");
mkdirSync(dirname(databasePath), { recursive: true });
mkdirSync(uploadDirectory, { recursive: true });
mkdirSync(signatureDirectory, { recursive: true });

export const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    finance_role TEXT NOT NULL DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS consumed_sso_tokens (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    document_type TEXT NOT NULL,
    category TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending_review',
    due_date TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS document_attachments (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS document_approvals (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    approver_id TEXT NOT NULL,
    sequence_no INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    comment TEXT NOT NULL DEFAULT '',
    decided_at TEXT,
    UNIQUE(document_id, sequence_no)
  );
  CREATE TABLE IF NOT EXISTS document_signatures (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    signer_id TEXT NOT NULL,
    signature_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    signed_at TEXT NOT NULL,
    UNIQUE (document_id, signer_id)
  );
  CREATE TABLE IF NOT EXISTS user_signatures (
    user_id TEXT PRIMARY KEY,
    signature_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS document_activity (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invoice_metadata (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    invoice_number TEXT NOT NULL,
    payee TEXT NOT NULL,
    invoice_date TEXT NOT NULL,
    billing_period TEXT NOT NULL,
    account_id TEXT,
    source_file TEXT NOT NULL,
    extraction_warnings TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS contract_details (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    original_attachment_id TEXT NOT NULL,
    working_attachment_id TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    notarize INTEGER NOT NULL DEFAULT 0 CHECK (notarize IN (0,1)),
    notary_id TEXT,
    original_sha256 TEXT NOT NULL,
    final_sha256 TEXT,
    notarized_at TEXT,
    notarial_act TEXT,
    notarization_details TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS contract_fields (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    signer_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('signature','initials','date','name')),
    page_index INTEGER NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS contract_fields_document ON contract_fields(document_id, signer_id);
`);

function ensureProfileSchema() {
  const columns = database.prepare("PRAGMA table_info(profiles)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "is_admin")) {
    database.exec("ALTER TABLE profiles ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "finance_role")) {
    database.exec("ALTER TABLE profiles ADD COLUMN finance_role TEXT NOT NULL DEFAULT ''");
  }
  // Notaries are ordinary CRM profiles marked in Settings; they can be asked to notarize contracts.
  // (The notary_commission* columns are no longer used but are kept so existing databases still open.)
  if (!columns.some((column) => column.name === "is_notary")) {
    database.exec("ALTER TABLE profiles ADD COLUMN is_notary INTEGER NOT NULL DEFAULT 0");
  }
  for (const column of ["notary_commission", "notary_jurisdiction", "notary_commission_expires"]) {
    if (!columns.some((existing) => existing.name === column)) {
      database.exec(`ALTER TABLE profiles ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
  }
}

ensureProfileSchema();

function ensureApprovalSchema() {
  const columns = database.prepare("PRAGMA table_info(document_approvals)").all() as { name: string }[];
  const indexes = database.prepare("PRAGMA index_list(document_approvals)").all() as { name: string; unique: number }[];
  const uniqueDocumentIndex = indexes.find((index) => {
    if (!index.unique) return false;
    const indexedColumns = database.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as { name: string }[];
    return indexedColumns.length === 1 && indexedColumns[0]?.name === "document_id";
  });
  if (!columns.some((column) => column.name === "sequence_no") || uniqueDocumentIndex) {
    database.exec("BEGIN");
    try {
      database.exec(`
        CREATE TABLE document_approvals_v2 (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          approver_id TEXT NOT NULL,
          sequence_no INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'pending',
          comment TEXT NOT NULL DEFAULT '',
          decided_at TEXT,
          UNIQUE(document_id, sequence_no)
        );
        INSERT INTO document_approvals_v2 (id, document_id, approver_id, sequence_no, status, comment, decided_at)
        SELECT id, document_id, approver_id, ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY rowid), status, comment, decided_at
        FROM document_approvals;
        DROP TABLE document_approvals;
        ALTER TABLE document_approvals_v2 RENAME TO document_approvals;
      `);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

ensureApprovalSchema();
// '' for requisition approvers, 'signer' or 'notary' for contract steps.
if (!(database.prepare("PRAGMA table_info(document_approvals)").all() as { name: string }[]).some((column) => column.name === "step_role")) {
  database.exec("ALTER TABLE document_approvals ADD COLUMN step_role TEXT NOT NULL DEFAULT ''");
}
database.exec(`
  UPDATE document_approvals
  SET status = 'waiting'
  WHERE status = 'pending'
    AND sequence_no > (
      SELECT MIN(first_step.sequence_no)
      FROM document_approvals first_step
      WHERE first_step.document_id = document_approvals.document_id
        AND first_step.status = 'pending'
    )
`);

function ensureDocumentSignatureSchema() {
  const indexes = database.prepare("PRAGMA index_list(document_signatures)").all() as { name: string; unique: number }[];
  const hasUniqueSigner = indexes.some((index) => {
    if (!index.unique) return false;
    const columns = database.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as { name: string }[];
    return columns.length === 2 && columns.some((column) => column.name === "document_id") && columns.some((column) => column.name === "signer_id");
  });
  if (!hasUniqueSigner) return;
  database.exec("BEGIN");
  try {
    database.exec(`
      CREATE TABLE document_signatures_v2 (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        signer_id TEXT NOT NULL,
        signature_path TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        signed_at TEXT NOT NULL
      );
      INSERT INTO document_signatures_v2 (id, document_id, signer_id, signature_path, mime_type, signed_at)
      SELECT id, document_id, signer_id, signature_path, mime_type, signed_at FROM document_signatures;
      DROP TABLE document_signatures;
      ALTER TABLE document_signatures_v2 RENAME TO document_signatures;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

ensureDocumentSignatureSchema();

export const crmUserId = "00000000-0000-4000-8000-000000000001";

export function ensureDefaultProfiles() {
  const rows = database.prepare("SELECT 1 FROM profiles WHERE id = ?").get(crmUserId) as { 1: number } | undefined;
  if (!rows) {
    database.prepare(
      "INSERT INTO profiles (id, full_name, email, department, is_admin) VALUES (?, ?, ?, ?, 0)",
    ).run(crmUserId, "CRM workspace", "crm@sanlam.local", "Administration");
  } else {
    database.prepare(
      "UPDATE profiles SET full_name = ?, email = ?, department = ?, is_admin = 0 WHERE id = ?",
    ).run("CRM workspace", "crm@sanlam.local", "Administration", crmUserId);
  }
}

ensureDefaultProfiles();

export type PortalDocument = {
  id: string;
  title: string;
  document_type: string;
  category: string;
  department: string;
  status: string;
  due_date: string | null;
  created_at: string;
  worked_at: string;
  owner_id: string;
  is_contract?: boolean;
  approver_ids?: string[];
  active_approver_id?: string | null;
  approval_steps?: {
    approver_id: string;
    full_name: string;
    email: string;
    sequence_no: number;
    status: string;
    decided_at: string | null;
    role_label?: string;
  }[];
};

export type PortalProfile = {
  id: string;
  full_name: string;
  email: string;
  department: string;
  finance_role: "" | "preparer" | "approver";
  is_admin: boolean;
  has_signature?: boolean;
  is_notary: boolean;
};

export type CrmIdentity = {
  id: string;
  crm_user_id: string;
  full_name: string;
  email: string;
  department: string;
  role: string;
};

export function resolveCrmProfileId(email: string, crmProfileId: string) {
  const matches = database.prepare(
    "SELECT id, finance_role FROM profiles WHERE lower(email) = lower(?) ORDER BY id",
  ).all(email.trim()) as { id: string; finance_role: string }[];
  const managedProfiles = matches.filter((profile) => !profile.id.startsWith("crm:"));
  const financeProfiles = managedProfiles.filter((profile) => profile.finance_role !== "");
  if (financeProfiles.length > 1 || (financeProfiles.length === 0 && managedProfiles.length > 1))
    throw new Error("More than one portal profile uses this CRM email. Ask an administrator to remove the duplicate profile.");
  return financeProfiles[0]?.id ?? managedProfiles[0]?.id ?? matches.find((profile) => profile.id === crmProfileId)?.id ?? matches[0]?.id ?? crmProfileId;
}

export function upsertCrmProfile(identity: CrmIdentity) {
  database.prepare(
    `INSERT INTO profiles (id, full_name, email, department, is_admin)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       full_name = excluded.full_name,
       email = excluded.email,
       department = excluded.department,
       is_admin = excluded.is_admin`,
  ).run(identity.id, identity.full_name, identity.email, identity.department, identity.role.toLowerCase() === "admin" ? 1 : 0);
}

export function getPortalData(currentUserId: string, isAdmin: boolean) {
  const documents = database.prepare(
    `SELECT d.id, d.title, d.document_type, d.category, d.department, d.status, d.due_date, d.created_at,
            COALESCE(
              (SELECT MAX(activity.worked_at) FROM (
                SELECT s.signed_at AS worked_at
                FROM document_signatures s
                WHERE s.document_id = d.id AND s.signer_id = ?
                UNION ALL
                SELECT a.decided_at AS worked_at
                FROM document_approvals a
                WHERE a.document_id = d.id AND a.approver_id = ? AND a.decided_at IS NOT NULL
              ) activity),
              d.created_at
            ) AS worked_at,
            d.owner_id,
            EXISTS (SELECT 1 FROM contract_details c WHERE c.document_id = d.id) AS is_contract
     FROM documents d
     -- Everyone in the approval chain can view the document at every stage (before their turn,
     -- after signing, after rejecting). Signing and rejecting are still restricted to the active step.
     WHERE d.owner_id = ? OR ? = 1 OR EXISTS (
       SELECT 1 FROM document_approvals a
       WHERE a.document_id = d.id AND a.approver_id = ?
     ) OR EXISTS (
       SELECT 1 FROM document_signatures s
       WHERE s.document_id = d.id AND s.signer_id = ?
     )
     ORDER BY d.created_at DESC`,
  ).all(currentUserId, currentUserId, currentUserId, isAdmin ? 1 : 0, currentUserId, currentUserId) as unknown as PortalDocument[];
  const approvalRows = database.prepare(
    `SELECT a.document_id, a.approver_id, a.sequence_no, a.status, a.decided_at, a.step_role, p.full_name, p.email
     FROM document_approvals a JOIN profiles p ON p.id = a.approver_id
     ORDER BY a.document_id, a.sequence_no`,
  ).all() as { document_id: string; approver_id: string; sequence_no: number; status: string; decided_at: string | null; step_role: string; full_name: string; email: string }[];
  const approvalsByDocument = new Map<string, typeof approvalRows>();
  for (const approval of approvalRows) {
    approvalsByDocument.set(approval.document_id, [...(approvalsByDocument.get(approval.document_id) ?? []), approval]);
  }

  for (const document of documents) {
    document.is_contract = Boolean(document.is_contract);
    const steps = approvalsByDocument.get(document.id) ?? [];
    document.approver_ids = steps.map((step) => step.approver_id);
    document.active_approver_id = steps.find((step) => step.status === "pending")?.approver_id ?? null;
    const owner = database.prepare("SELECT full_name, email FROM profiles WHERE id = ?").get(document.owner_id) as { full_name: string; email: string } | undefined;
    document.approval_steps = [
      { approver_id: document.owner_id, full_name: owner?.full_name || owner?.email || document.owner_id, email: owner?.email || "", sequence_no: 0, status: "approved", decided_at: document.created_at, role_label: document.is_contract ? "Sender" : "Preparer" },
      ...steps.map(({ document_id: _documentId, step_role: stepRole, ...step }) => ({
        ...step,
        ...(stepRole === "signer" ? { role_label: "Signer" } : stepRole === "notary" ? { role_label: "Notary" } : {}),
      })),
    ];
  }
  const profiles = database.prepare(
    `SELECT id, full_name, email, department, finance_role,
       CAST(is_admin AS INTEGER) AS is_admin,
       CAST(is_notary AS INTEGER) AS is_notary,
       EXISTS (SELECT 1 FROM user_signatures s WHERE s.user_id = profiles.id) AS has_signature
     FROM profiles ORDER BY full_name`,
  ).all() as unknown as PortalProfile[];
  return {
    documents,
    profiles: profiles.map((profile) => ({
      ...profile,
      is_admin: Boolean(profile.is_admin),
      is_notary: Boolean(profile.is_notary),
      has_signature: Boolean(profile.has_signature),
    })),
  };
}

export function getInvoiceDuplicateWarning(payee: string, invoiceNumber: string) {
  if (!payee.trim() || !invoiceNumber.trim()) return null;
  const existing = database.prepare(
    `SELECT d.title FROM invoice_metadata m
     JOIN documents d ON d.id = m.document_id
     WHERE lower(trim(m.payee)) = lower(trim(?))
       AND upper(trim(m.invoice_number)) = upper(trim(?))
     LIMIT 1`,
  ).get(payee, invoiceNumber) as { title: string } | undefined;
  return existing
    ? `A PR for ${payee} with invoice number ${invoiceNumber} already exists (${existing.title}).`
    : null;
}

export async function upsertApproverProfile(input: {
  id?: string;
  full_name: string;
  email: string;
  department: string;
  finance_role?: "" | "preparer" | "approver";
  is_admin?: boolean;
  is_notary?: boolean;
}) {
  const fullName = input.full_name.trim();
  const isNotary = Boolean(input.is_notary);
  const email = input.email.trim();
  const department = input.department.trim();
  const financeRole = input.finance_role ?? "";
  if (!fullName) throw new Error("Approver name is required.");
  if (!email) throw new Error("Approver email is required.");
  if (!["", "preparer", "approver"].includes(financeRole)) throw new Error("Choose a valid finance role.");
  const profileId = input.id && input.id.trim() ? input.id.trim() : crypto.randomUUID();
  database.exec("BEGIN");
  try {
    database.prepare(
      `INSERT INTO profiles (id, full_name, email, department, finance_role, is_admin, is_notary)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         full_name = excluded.full_name,
         email = excluded.email,
         department = excluded.department,
         finance_role = excluded.finance_role,
         is_admin = excluded.is_admin,
         is_notary = excluded.is_notary`,
    ).run(profileId, fullName, email, department, financeRole, input.is_admin ? 1 : 0, isNotary ? 1 : 0);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const notification = await sendApproverWelcomeEmail({
    fullName,
    email,
    department,
    portalUrl: process.env["APP_BASE_URL"] || process.env["VITE_APP_URL"] || "http://localhost:3000",
  }).catch((error) => ({
    sent: false,
    configured: false,
    reason: error instanceof Error ? error.message : "Unknown email error.",
  }));

  return {
    id: profileId,
    full_name: fullName,
    email,
    department,
    finance_role: financeRole,
    is_admin: Boolean(input.is_admin),
    is_notary: isNotary,
    email_notification: notification,
  };
}

export function deleteApproverProfile(id: string) {
  const cleaned = id.trim();
  if (!cleaned) throw new Error("An approver ID is required.");
  if (cleaned === crmUserId) throw new Error("The admin profile cannot be removed.");
  const existing = database.prepare("SELECT id FROM profiles WHERE id = ?").get(cleaned) as { id?: string } | undefined;
  if (!existing) return false;
  database.prepare("DELETE FROM profiles WHERE id = ?").run(cleaned);
  return true;
}

export function recordDocumentActivity(documentId: string, action: string, details: string, actorId = crmUserId) {
  database.prepare(
    "INSERT INTO document_activity (id, document_id, actor_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(crypto.randomUUID(), documentId, actorId, action, details, new Date().toISOString());
  return true;
}

export function assertDocumentVisible(documentId: string, currentUserId: string, isAdmin: boolean) {
  const document = database.prepare("SELECT owner_id FROM documents WHERE id = ?").get(documentId) as { owner_id: string } | undefined;
  if (!document) throw new Error("The requested document could not be found.");
  if (isAdmin || document.owner_id === currentUserId) return;
  // Anyone in the approval chain may view (signing/rejecting is checked separately against the active step).
  const inApprovalChain = database.prepare(
    "SELECT 1 FROM document_approvals WHERE document_id = ? AND approver_id = ? LIMIT 1",
  ).get(documentId, currentUserId);
  if (inApprovalChain) return;
  const signedByCurrentUser = database.prepare(
    "SELECT 1 FROM document_signatures WHERE document_id = ? AND signer_id = ? LIMIT 1",
  ).get(documentId, currentUserId);
  if (!signedByCurrentUser) throw new Error("You are not part of this document’s approval chain.");
}

export function getDocumentActivity(documentId: string, currentUserId: string, isAdmin: boolean) {
  assertDocumentVisible(documentId, currentUserId, isAdmin);
  return database.prepare(
    `SELECT a.id, a.document_id, a.actor_id, COALESCE(p.full_name, p.email, a.actor_id) AS actor_name,
            a.action, a.details, a.created_at
     FROM document_activity a LEFT JOIN profiles p ON p.id = a.actor_id
     WHERE a.document_id = ? ORDER BY a.created_at DESC`,
  ).all(documentId) as {
    id: string;
    document_id: string;
    actor_id: string;
    actor_name: string;
    action: string;
    details: string;
    created_at: string;
  }[];
}

export function getDocumentFile(documentId: string, mode: "preview" | "download", currentUserId: string, isAdmin: boolean) {
  assertDocumentVisible(documentId, currentUserId, isAdmin);
  // Contracts always show the copy that carries every signature applied so far.
  const contractCopy = database.prepare(
    `SELECT a.file_name, a.mime_type, a.storage_path
     FROM contract_details c JOIN document_attachments a ON a.id = c.working_attachment_id
     WHERE c.document_id = ?`,
  ).get(documentId) as { file_name: string; mime_type: string; storage_path: string } | undefined;
  if (contractCopy) {
    return { fileName: contractCopy.file_name, mimeType: contractCopy.mime_type, fileData: readFileSync(contractCopy.storage_path).toString("base64") };
  }
  const attachments = database.prepare(
    "SELECT file_name, mime_type, storage_path FROM document_attachments WHERE document_id = ? ORDER BY created_at DESC",
  ).all(documentId) as { file_name: string; mime_type: string; storage_path: string }[];

  const rankAttachment = (attachment: { file_name: string; mime_type: string }) => {
    const name = attachment.file_name.toLowerCase();
    const mime = attachment.mime_type.toLowerCase();
    const isPrName = /(pr form|payment requisition)/i.test(attachment.file_name);
    const isPdf = mime === "application/pdf";
    const isWord = /\.docx?$/i.test(attachment.file_name) || /word|document/i.test(mime);

    if (mode === "preview") {
      if (isPrName && isPdf) return 0;
      if (isPrName) return 1;
      if (isPdf) return 2;
      return 3;
    }

    if (isPrName && isWord) return 0;
    if (isPrName) return 1;
    if (isWord) return 2;
    return 3;
  };

  const preferred = [...attachments].sort((left, right) => {
    const leftRank = rankAttachment(left);
    const rightRank = rankAttachment(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.file_name.localeCompare(right.file_name);
  })[0];

  if (!preferred) throw new Error("No uploaded file is attached to this document.");
  return {
    fileName: preferred.file_name,
    mimeType: preferred.mime_type,
    fileData: readFileSync(preferred.storage_path).toString("base64"),
  };
}

export function getUserSignature(userId: string) {
  const signature = database.prepare(
    "SELECT signature_path, mime_type FROM user_signatures WHERE user_id = ?",
  ).get(userId) as { signature_path: string; mime_type: string } | undefined;
  if (!signature) return null;
  return {
    mimeType: signature.mime_type,
    fileData: readFileSync(signature.signature_path).toString("base64"),
  };
}

export function getFinancePreparer(userId: string) {
  const profile = database.prepare("SELECT id, full_name, email, department FROM profiles WHERE id = ? AND is_admin = 0 AND finance_role = 'preparer'").get(userId) as { id: string; full_name: string; email: string; department: string } | undefined;
  if (!profile) throw new Error("Choose a Finance Preparer configured in Settings.");
  return profile;
}

export function getFinanceApprover(userId: string) {
  const profile = database.prepare("SELECT id, full_name, email, department FROM profiles WHERE id = ? AND finance_role = 'approver'").get(userId) as { id: string; full_name: string; email: string; department: string } | undefined;
  if (!profile) throw new Error("Choose a Finance Approver configured in Settings.");
  return profile;
}

export async function saveUserSignature(input: { userId: string; mimeType: string; fileData: string }) {
  if (!["image/png", "image/jpeg"].includes(input.mimeType)) {
    throw new Error("Signature must be a PNG or JPEG image.");
  }
  const uploaded = Buffer.from(input.fileData, "base64");
  if (!uploaded.length || uploaded.length > 2 * 1024 * 1024) {
    throw new Error("Signature images must be between 1 byte and 2 MB.");
  }
  // Store the cleaned version (background removed, cropped, navy ink) so the saved preview matches the PR.
  const bytes = (await prepareSignatureImage(uploaded)).png;
  const old = database.prepare("SELECT signature_path FROM user_signatures WHERE user_id = ?").get(input.userId) as { signature_path: string } | undefined;
  const extension = "png";
  const signatureId = crypto.randomUUID();
  const safeUserId = input.userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const storagePath = join(signatureDirectory, `${safeUserId}-${signatureId}.${extension}`);
  writeFileSync(storagePath, bytes, { flag: "wx" });
  try {
    database.prepare(
      `INSERT INTO user_signatures (user_id, signature_path, mime_type, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         signature_path = excluded.signature_path,
         mime_type = excluded.mime_type,
         updated_at = excluded.updated_at`,
    ).run(input.userId, storagePath, "image/png", new Date().toISOString());
  } catch (error) {
    unlinkSync(storagePath);
    throw error;
  }
  if (old && old.signature_path !== storagePath) unlinkSync(old.signature_path);
  return { mimeType: "image/png", fileData: bytes.toString("base64") };
}

export async function createPortalDocument(input: {
  title: string;
  documentType: string;
  category: string;
  department: string;
  dueDate: string | null;
  fileName: string;
  mimeType: string;
  fileData: string;
  approverId: string | null;
  approverIds?: string[] | undefined;
  financeApproverId?: string | undefined;
  financePreparerId?: string | undefined;
  preparedByName?: string | undefined;
  approvedByName?: string | undefined;
  invoiceOverrides?: InvoiceOverrides | undefined;
  manualEntry?: boolean | undefined;
  ownerId: string;
}) {
  if (input.category === "Contracts") throw new Error("Contracts are submitted from the New contract page so signature places can be marked.");
  const approverIds = [...new Set((input.approverIds?.length ? input.approverIds : input.approverId ? [input.approverId] : []).map((id) => id.trim()).filter(Boolean))];
  if (!approverIds.length) throw new Error("No approvers are configured for this category.");
  const approverProfiles = approverIds.map((id) => {
    const profile = database.prepare("SELECT id, full_name, email FROM profiles WHERE id = ? AND finance_role = ''").get(id) as { id: string; full_name: string; email: string } | undefined;
    if (!profile) throw new Error("An assigned approver is not available in the CRM directory.");
    if (id === input.ownerId) throw new Error("You cannot add yourself to the approval order.");
    return profile;
  });
  if (!input.financeApproverId || !input.financePreparerId) {
    throw new Error("Choose a Finance Approver and Finance Preparer configured in Settings.");
  }
  const financeApprover = getFinanceApprover(input.financeApproverId);
  const financePreparer = getFinancePreparer(input.financePreparerId);
  const fileBytes = Buffer.from(input.fileData, "base64");
  if (fileBytes.length === 0 || fileBytes.length > 20 * 1024 * 1024) {
    throw new Error("Files must be between 1 byte and 20 MB.");
  }
  const isInvoicePdf = input.mimeType === "application/pdf" || input.fileName.toLowerCase().endsWith(".pdf");
  // Manual PRs are generated from typed fields; the upload (PDF or image) is only attached behind the PR.
  const generatesRequisition = isInvoicePdf || Boolean(input.manualEntry);
  const submitter = database.prepare("SELECT id, full_name, email, department FROM profiles WHERE id = ?").get(input.ownerId) as { id: string; full_name: string; email: string; department: string } | undefined;
  if (!submitter?.full_name) throw new Error("The preparer’s CRM profile could not be found.");
  const preparerSignature = getUserSignature(input.ownerId);
  if (generatesRequisition && !preparerSignature) {
    throw new Error("Save your signature before previewing and submitting the requisition.");
  }
  const orderedApproverIds = [...approverIds, financeApprover.id, financePreparer.id];
  const orderedApproverProfiles = [...approverProfiles, financeApprover, financePreparer];
  const firstApprover = orderedApproverProfiles[0];
  if (!firstApprover) throw new Error("At least one approver must be configured.");
  const generated = generatesRequisition ? await buildPaymentRequisition(fileBytes, input.fileName, {
    ...input.invoiceOverrides,
    department: submitter.department || input.department,
    preparedByName: submitter.full_name,
    approvedByName: approverProfiles[0]?.full_name || financeApprover.full_name,
    approvedByNames: approverProfiles.map((profile) => profile.full_name),
    financePreparerName: financePreparer.full_name,
    financeApproverName: financeApprover.full_name,
  }, {
    submitter: preparerSignature ? { mimeType: preparerSignature.mimeType, bytes: Buffer.from(preparerSignature.fileData, "base64") } : null,
  }, { manual: input.manualEntry, mimeType: input.mimeType }) : null;
  const duplicateWarning = generated
    ? getInvoiceDuplicateWarning(generated.fields.payee, generated.fields.invoiceNumber)
    : null;
  if (duplicateWarning && generated) generated.fields.extractionWarnings.push(duplicateWarning);
  const attachmentId = crypto.randomUUID();
  const generatedAttachmentId = generated ? crypto.randomUUID() : null;
  const generatedPreviewAttachmentId = generated ? crypto.randomUUID() : null;
  const documentTitle = generated?.fileName ?? input.title;
  const document = {
    id: crypto.randomUUID(),
    owner_id: input.ownerId,
    title: documentTitle,
    document_type: generated ? "Payment requisition" : input.documentType,
    category: input.category,
    department: submitter.department || input.department,
    status: `Pending ${firstApprover.full_name}`,
    due_date: input.dueDate,
    created_at: new Date().toISOString(),
  };
  // Image attachments on manual PRs are stored as their PDF conversion so signing can keep appending them.
  const storeAsPdf = Boolean(input.manualEntry && generated && !isInvoicePdf);
  const storedBytes = storeAsPdf && generated ? generated.attachmentPdf : fileBytes;
  const storedMimeType = storeAsPdf ? "application/pdf" : input.mimeType || "application/octet-stream";
  const storedFileName = storeAsPdf ? input.fileName.replace(/\.[^.]+$/, "") + ".pdf" : input.fileName;
  const safeFileName = storedFileName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 160) || "document";
  const storagePath = join(uploadDirectory, `${document.id}-${attachmentId}-${safeFileName}`);
  const generatedStoragePath = generated && generatedAttachmentId ? join(uploadDirectory, `${document.id}-${generatedAttachmentId}-${generated.fileName.replace(/[^a-zA-Z0-9._-]/g, "-")}`) : null;
  const generatedPreviewStoragePath = generated && generatedPreviewAttachmentId ? join(uploadDirectory, `${document.id}-${generatedPreviewAttachmentId}-${generated.previewFileName.replace(/[^a-zA-Z0-9._-]/g, "-")}`) : null;
  const submissionSignatureId = crypto.randomUUID();
  const signatureExtension = preparerSignature?.mimeType === "image/png" ? "png" : "jpg";
  const submissionSignaturePath = join(signatureDirectory, `${document.id}-${submissionSignatureId}.${signatureExtension}`);
  try {
    writeFileSync(storagePath, storedBytes, { flag: "wx" });
    if (generated && generatedStoragePath) writeFileSync(generatedStoragePath, Buffer.from(generated.fileData, "base64"), { flag: "wx" });
    if (generated && generatedPreviewStoragePath) writeFileSync(generatedPreviewStoragePath, Buffer.from(generated.previewFileData, "base64"), { flag: "wx" });
    if (preparerSignature) writeFileSync(submissionSignaturePath, Buffer.from(preparerSignature.fileData, "base64"), { flag: "wx" });
    database.exec("BEGIN");
    database.prepare(
      "INSERT INTO documents (id, owner_id, title, document_type, category, department, status, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(document.id, document.owner_id, document.title, document.document_type, document.category, document.department, document.status, document.due_date, document.created_at);
    if (generated) {
      database.prepare(
        `INSERT INTO invoice_metadata
          (document_id, invoice_number, payee, invoice_date, billing_period, account_id, source_file, extraction_warnings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        document.id,
        generated.fields.invoiceNumber,
        generated.fields.payee,
        generated.fields.invoiceDate,
        generated.fields.billingPeriod,
        generated.fields.accountId,
        input.fileName,
        JSON.stringify(generated.fields.extractionWarnings),
      );
    }
    database.prepare(
      "INSERT INTO document_attachments (id, document_id, file_name, mime_type, size_bytes, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(attachmentId, document.id, safeFileName, storedMimeType, storedBytes.length, storagePath, document.created_at);
    if (generated && generatedAttachmentId && generatedStoragePath) {
      database.prepare(
        "INSERT INTO document_attachments (id, document_id, file_name, mime_type, size_bytes, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(generatedAttachmentId, document.id, generated.fileName, generated.mimeType, Buffer.from(generated.fileData, "base64").length, generatedStoragePath, document.created_at);
    }
    if (generated && generatedPreviewAttachmentId && generatedPreviewStoragePath) {
      database.prepare(
        "INSERT INTO document_attachments (id, document_id, file_name, mime_type, size_bytes, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(generatedPreviewAttachmentId, document.id, generated.previewFileName, generated.previewMimeType, Buffer.from(generated.previewFileData, "base64").length, generatedPreviewStoragePath, document.created_at);
    }
    const insertApproval = database.prepare("INSERT INTO document_approvals (id, document_id, approver_id, sequence_no, status) VALUES (?, ?, ?, ?, ?)");
    orderedApproverIds.forEach((approverId, index) => {
      insertApproval.run(crypto.randomUUID(), document.id, approverId, index + 1, index === 0 ? "pending" : "waiting");
      recordDocumentActivity(document.id, "assigned_approver", `Approval order ${index + 1}: ${orderedApproverProfiles[index]?.full_name || approverId}`, input.ownerId);
    });
    if (preparerSignature) {
      database.prepare(
        "INSERT INTO document_signatures (id, document_id, signer_id, signature_path, mime_type, signed_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(submissionSignatureId, document.id, input.ownerId, submissionSignaturePath, preparerSignature.mimeType, document.created_at);
    }
    recordDocumentActivity(document.id, "submitted", `${submitter.full_name} signed and submitted the requisition.`, input.ownerId);
    recordDocumentActivity(document.id, generated ? "generated_pr" : "uploaded_document", generated ? (input.manualEntry ? `Generated manual PR with attachment ${input.fileName}` : `Generated PR from invoice ${input.fileName}`) : `Uploaded document ${safeFileName}`, input.ownerId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    unlinkSync(storagePath);
    if (generatedStoragePath) unlinkSync(generatedStoragePath);
    if (generatedPreviewStoragePath) unlinkSync(generatedPreviewStoragePath);
    if (preparerSignature) unlinkSync(submissionSignaturePath);
    throw error;
  }
  const notification = await sendDocumentApprovalEmail({ email: firstApprover.email, fullName: firstApprover.full_name, documentTitle: document.title, documentId: document.id });
  if (!notification.sent) recordDocumentActivity(document.id, "notification_failed", notification.reason, input.ownerId);
  return { ...document, generatedFields: generated?.fields ?? null };
}

export async function updatePortalDocument(input: {
  id: string;
  actorId: string;
  isAdmin: boolean;
  title: string;
  documentType: string;
  category: string;
  department: string;
  dueDate: string | null;
  approverIds: string[];
  financeApproverId: string;
  financePreparerId: string;
}) {
  const title = input.title.trim();
  const documentType = input.documentType.trim();
  const category = input.category.trim();
  const department = input.department.trim();
  if (!title || title.length > 160) throw new Error("Document title must be between 1 and 160 characters.");
  if (!documentType || documentType.length > 100) throw new Error("Enter a valid document type.");
  if (!category || category.length > 100) throw new Error("Enter a valid category.");
  if (department.length > 100) throw new Error("Department must be 100 characters or fewer.");
  if (input.dueDate) {
    const parsedDueDate = new Date(`${input.dueDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) || Number.isNaN(parsedDueDate.getTime()) || parsedDueDate.toISOString().slice(0, 10) !== input.dueDate) {
      throw new Error("Choose a valid due date.");
    }
  }
  const cleanedApproverIds = [...new Set(input.approverIds.map((id) => id.trim()).filter(Boolean))];

  const document = database.prepare("SELECT owner_id, status FROM documents WHERE id = ?").get(input.id) as { owner_id: string; status: string } | undefined;
  if (!document) throw new Error("The requested document could not be found.");
  if (!input.isAdmin && document.owner_id !== input.actorId) throw new Error("Only the document owner or an administrator can edit this document.");
  if (isContractDocument(input.id)) {
    // Signers, signature places and notarization are fixed once a contract is sent; only its details can change.
    const actor = database.prepare("SELECT full_name FROM profiles WHERE id = ?").get(input.actorId) as { full_name: string } | undefined;
    database.exec("BEGIN");
    try {
      database.prepare("UPDATE documents SET title = ?, department = ?, due_date = ? WHERE id = ?").run(title, department, input.dueDate || null, input.id);
      recordDocumentActivity(input.id, "document_edited", `${actor?.full_name || input.actorId} updated contract details.`, input.actorId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return true;
  }
  if (!cleanedApproverIds.length) throw new Error("Add at least one approver to the approval order.");
  if (cleanedApproverIds.includes(input.actorId)) throw new Error("You cannot add yourself to the approval order.");

  const approverProfiles = cleanedApproverIds.map((id) => {
    const profile = database.prepare("SELECT id, full_name, email FROM profiles WHERE id = ? AND finance_role = ''").get(id) as { id: string; full_name: string; email: string } | undefined;
    if (!profile) throw new Error("An assigned approver is not available in the CRM directory.");
    return profile;
  });
  const financeApprover = getFinanceApprover(input.financeApproverId);
  const financePreparer = getFinancePreparer(input.financePreparerId);
  const orderedApproverIds = [...cleanedApproverIds, financeApprover.id, financePreparer.id];
  const currentSteps = database.prepare(
    "SELECT approver_id, status FROM document_approvals WHERE document_id = ? ORDER BY sequence_no",
  ).all(input.id) as { approver_id: string; status: string }[];
  const routeChanged = currentSteps.length !== orderedApproverIds.length ||
    currentSteps.some((step, index) => step.approver_id !== orderedApproverIds[index]);
  if (routeChanged && !isPendingDocument(document.status)) throw new Error("Approval routing can only be changed while the document is pending.");
  if (routeChanged && currentSteps.some((step) => step.status === "approved" || step.status === "rejected")) {
    throw new Error("Approval routing can no longer be changed because a reviewer has already acted.");
  }

  const nextFirstApproverId = orderedApproverIds[0];
  const previousFirstApproverId = currentSteps.find((step) => step.status === "pending")?.approver_id ?? null;
  const actor = database.prepare("SELECT full_name FROM profiles WHERE id = ?").get(input.actorId) as { full_name: string } | undefined;
  database.exec("BEGIN");
  try {
    database.prepare(
      "UPDATE documents SET title = ?, document_type = ?, category = ?, department = ?, due_date = ? WHERE id = ?",
    ).run(title, documentType, category, department, input.dueDate || null, input.id);
    if (routeChanged) {
      database.prepare("DELETE FROM document_approvals WHERE document_id = ?").run(input.id);
      const insertApproval = database.prepare(
        "INSERT INTO document_approvals (id, document_id, approver_id, sequence_no, status) VALUES (?, ?, ?, ?, ?)",
      );
      orderedApproverIds.forEach((approverId, index) => {
        insertApproval.run(crypto.randomUUID(), input.id, approverId, index + 1, index === 0 ? "pending" : "waiting");
      });
      database.prepare("UPDATE documents SET status = ? WHERE id = ?").run(`Pending ${approverProfiles[0]?.full_name ?? ""}`, input.id);
    }
    const changes = ["document details"];
    if (routeChanged) changes.push("approval order");
    recordDocumentActivity(input.id, "document_edited", `${actor?.full_name || input.actorId} updated ${changes.join(" and ")}.`, input.actorId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  if (routeChanged && nextFirstApproverId !== previousFirstApproverId) {
    const firstApprover = approverProfiles[0];
    if (!firstApprover) throw new Error("The updated approval order has no first approver.");
    const notification = await sendDocumentApprovalEmail({
      email: firstApprover.email,
      fullName: firstApprover.full_name,
      documentTitle: title,
      documentId: input.id,
    });
    if (!notification.sent) recordDocumentActivity(input.id, "notification_failed", notification.reason, input.actorId);
  }
  return true;
}

export function deletePortalDocument(documentId: string, actorId: string, isAdmin: boolean) {
  const document = database.prepare("SELECT owner_id FROM documents WHERE id = ?").get(documentId) as { owner_id: string } | undefined;
  if (!document) throw new Error("The requested document could not be found.");
  if (!isAdmin && document.owner_id !== actorId) throw new Error("Only the document owner or an administrator can delete this document.");
  const attachmentFiles = database.prepare("SELECT storage_path FROM document_attachments WHERE document_id = ?").all(documentId) as { storage_path: string }[];
  const signatureFiles = database.prepare("SELECT signature_path AS storage_path FROM document_signatures WHERE document_id = ?").all(documentId) as { storage_path: string }[];
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM document_activity WHERE document_id = ?").run(documentId);
    database.prepare("DELETE FROM document_approvals WHERE document_id = ?").run(documentId);
    database.prepare("DELETE FROM document_signatures WHERE document_id = ?").run(documentId);
    database.prepare("DELETE FROM document_attachments WHERE document_id = ?").run(documentId);
    database.prepare("DELETE FROM invoice_metadata WHERE document_id = ?").run(documentId);
    database.prepare("DELETE FROM contract_fields WHERE document_id = ?").run(documentId);
    database.prepare("DELETE FROM contract_details WHERE document_id = ?").run(documentId);
    database.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  for (const { storage_path: path } of [...attachmentFiles, ...signatureFiles]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`The document was deleted, but an attached file could not be removed: ${path}`, { cause: error });
      }
    }
  }
  return true;
}

export function isContractDocument(documentId: string) {
  return Boolean(database.prepare("SELECT 1 FROM contract_details WHERE document_id = ?").get(documentId));
}

function isPendingDocument(status: string) {
  return status === "pending_review" || status.startsWith("Pending ");
}

export async function updateDocumentStatus(id: string, status: "rejected", approverId: string, comment = "") {
  const resolvedApproverId = approverId;
  if (!id || !status) throw new Error("A document and decision are required.");
  const normalizedComment = (comment ?? "").trim();
  if (status === "rejected" && !normalizedComment) throw new Error("Add a reason before rejecting this document.");
  let ownerNotification: { email: string; full_name: string; title: string } | undefined;
  database.exec("BEGIN");
  try {
    const currentStep = database.prepare("SELECT id, approver_id FROM document_approvals WHERE document_id = ? AND status = 'pending' ORDER BY sequence_no LIMIT 1").get(id) as { id: string; approver_id: string } | undefined;
    if (!currentStep) throw new Error("This requisition has no pending approver.");
    if (resolvedApproverId !== currentStep.approver_id) throw new Error("This requisition is waiting for a different approver.");
    database.prepare("UPDATE document_approvals SET status = 'rejected', comment = ?, decided_at = ? WHERE id = ?").run(normalizedComment, new Date().toISOString(), currentStep.id);
    database.prepare("UPDATE document_approvals SET status = 'skipped' WHERE document_id = ? AND status IN ('pending', 'waiting')").run(id);
    database.prepare("UPDATE documents SET status = 'Rejected' WHERE id = ?").run(id);
    ownerNotification = database.prepare(
      "SELECT p.email, p.full_name, d.title FROM documents d JOIN profiles p ON p.id = d.owner_id WHERE d.id = ?",
    ).get(id) as { email: string; full_name: string; title: string } | undefined;
    const actor = database.prepare("SELECT full_name FROM profiles WHERE id = ?").get(resolvedApproverId) as { full_name: string } | undefined;
    recordDocumentActivity(id, status, `${actor?.full_name || resolvedApproverId} rejected the ${isContractDocument(id) ? "contract" : "requisition"}: ${normalizedComment}`, resolvedApproverId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  if (ownerNotification?.email) {
    const notification = await sendDocumentRejectedEmail({ email: ownerNotification.email, fullName: ownerNotification.full_name, documentTitle: ownerNotification.title, documentId: id, reason: normalizedComment, kind: isContractDocument(id) ? "contract" : "requisition" });
    if (!notification.sent) recordDocumentActivity(id, "notification_failed", notification.reason, approverId);
  }
}

export async function signPortalDocument(input: {
  documentId: string;
  signerId: string;
  fileName: string;
  mimeType: string;
  fileData: string;
}) {
  if (isContractDocument(input.documentId)) throw new Error("Contracts are signed through the contract signing flow.");
  const fileBytes = Buffer.from(input.fileData, "base64");
  if (!/^image\/(png|jpeg)$/.test(input.mimeType)) {
    throw new Error("Signature must be a PNG or JPEG image.");
  }
  if (fileBytes.length === 0 || fileBytes.length > 2 * 1024 * 1024) {
    throw new Error("Signature images must be 2 MB or smaller.");
  }
  // Rejects screenshots/photos before anything is stamped onto the requisition.
  await prepareSignatureImage(fileBytes);
  const signedAtDate = new Date();
  const signer = database.prepare("SELECT full_name, finance_role FROM profiles WHERE id = ?").get(input.signerId) as { full_name: string; finance_role: string } | undefined;
  if (!signer?.full_name) throw new Error("The signer’s CRM profile could not be found.");
  const currentStep = database.prepare(
    `SELECT id, approver_id, sequence_no FROM document_approvals
     WHERE document_id = ? AND status = 'pending' ORDER BY sequence_no LIMIT 1`,
  ).get(input.documentId) as { id: string; approver_id: string; sequence_no: number } | undefined;
  if (!currentStep || currentStep.approver_id !== input.signerId) {
    throw new Error("This requisition is not waiting for your signature.");
  }
  const requisitionFiles = database.prepare(
    "SELECT file_name, mime_type, storage_path FROM document_attachments WHERE document_id = ?",
  ).all(input.documentId) as { file_name: string; mime_type: string; storage_path: string }[];
  const requisitionWord = requisitionFiles.find((file) => /pr form|payment requisition/i.test(file.file_name) && /\.docx$/i.test(file.file_name));
  const requisitionPdf = requisitionFiles.find((file) => /pr form|payment requisition/i.test(file.file_name) && file.mime_type === "application/pdf");
  const invoicePdf = requisitionFiles.find((file) => file.mime_type === "application/pdf" && !/pr form|payment requisition/i.test(file.file_name));
  const originalWord = requisitionWord ? readFileSync(requisitionWord.storage_path) : null;
  const originalPdf = requisitionPdf ? readFileSync(requisitionPdf.storage_path) : null;
  const originalInvoicePdf = invoicePdf ? readFileSync(invoicePdf.storage_path) : null;
  const signatureTarget = signer.finance_role === "preparer"
    ? "finance-preparer"
    : signer.finance_role === "approver"
      ? "finance-approver"
      : "approval";
  const signedWord = originalWord
    ? await addSignatureToRequisition(originalWord, signer.full_name, input.mimeType, fileBytes, signatureTarget, signedAtDate)
    : null;
  const signedRequisitionPdf = signedWord && requisitionWord ? convertRequisitionDocxToPdf(signedWord, requisitionWord.file_name) : null;
  const signedPdf = signedRequisitionPdf && originalInvoicePdf
    ? await appendInvoiceToRequisitionPdf(signedRequisitionPdf, originalInvoicePdf)
    : signedRequisitionPdf;
  const signatureId = crypto.randomUUID();
  const signedAt = signedAtDate.toISOString();
  const extension = input.mimeType.split("/")[1] === "jpeg" ? "jpg" : input.mimeType.split("/")[1];
  const storagePath = join(signatureDirectory, `${input.documentId}-${signatureId}.${extension}`);
  let nextApprover: { id: string; full_name: string; email: string } | undefined;
  let completedRecipients: { id: string; email: string; full_name: string; title: string }[] = [];
  try {
    writeFileSync(storagePath, fileBytes, { flag: "wx" });
    database.exec("BEGIN");
    const activeStep = database.prepare(
      "SELECT id, approver_id FROM document_approvals WHERE document_id = ? AND status = 'pending' ORDER BY sequence_no LIMIT 1",
    ).get(input.documentId) as { id: string; approver_id: string } | undefined;
    if (!activeStep || activeStep.id !== currentStep.id || activeStep.approver_id !== input.signerId) {
      throw new Error("This requisition has already advanced to another approver.");
    }
    database.prepare(
      "INSERT INTO document_signatures (id, document_id, signer_id, signature_path, mime_type, signed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(signatureId, input.documentId, input.signerId, storagePath, input.mimeType, signedAt);
    database.prepare("UPDATE document_approvals SET status = 'approved', decided_at = ? WHERE id = ?").run(signedAt, currentStep.id);
    const nextStep = database.prepare(
      `SELECT id FROM document_approvals
       WHERE document_id = ? AND status = 'waiting' ORDER BY sequence_no LIMIT 1`,
    ).get(input.documentId) as { id: string } | undefined;
    if (nextStep) database.prepare("UPDATE document_approvals SET status = 'pending' WHERE id = ?").run(nextStep.id);
    nextApprover = database.prepare(
      `SELECT p.id, p.full_name, p.email
       FROM document_approvals a JOIN profiles p ON p.id = a.approver_id
       WHERE a.document_id = ? AND a.status = 'pending' ORDER BY a.sequence_no LIMIT 1`,
    ).get(input.documentId) as { id: string; full_name: string; email: string } | undefined;
    const actorName = database.prepare("SELECT full_name FROM profiles WHERE id = ?").get(input.signerId) as { full_name: string } | undefined;
    if (nextApprover) {
      database.prepare("UPDATE documents SET status = ? WHERE id = ?").run(`Pending ${nextApprover.full_name}`, input.documentId);
    } else {
      database.prepare("UPDATE documents SET status = 'Completed' WHERE id = ?").run(input.documentId);
      completedRecipients = database.prepare(
        `SELECT p.id, p.email, p.full_name, d.title
         FROM document_approvals a
         JOIN profiles p ON p.id = a.approver_id
         JOIN documents d ON d.id = a.document_id
         WHERE a.document_id = ?
         UNION
         SELECT p.id, p.email, p.full_name, d.title
         FROM documents d
         JOIN profiles p ON p.id = d.owner_id
         WHERE d.id = ?`,
      ).all(input.documentId, input.documentId) as { id: string; email: string; full_name: string; title: string }[];
    }
    recordDocumentActivity(input.documentId, "signed", `${actorName?.full_name || input.signerId} signed the requisition.`, input.signerId);
    if (requisitionWord && signedWord) writeFileSync(requisitionWord.storage_path, signedWord);
    if (requisitionPdf && signedPdf) writeFileSync(requisitionPdf.storage_path, signedPdf);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    if (requisitionWord && originalWord) writeFileSync(requisitionWord.storage_path, originalWord);
    if (requisitionPdf && originalPdf) writeFileSync(requisitionPdf.storage_path, originalPdf);
    unlinkSync(storagePath);
    throw error;
  }
  if (nextApprover) {
    const notification = await sendDocumentApprovalEmail({ email: nextApprover.email, fullName: nextApprover.full_name, documentTitle: requisitionWord?.file_name ?? "Payment requisition", documentId: input.documentId });
    if (!notification.sent) recordDocumentActivity(input.documentId, "notification_failed", notification.reason, input.signerId);
  } else {
    const notifications = await Promise.all(completedRecipients.map((recipient) =>
      sendDocumentCompletedEmail({
        email: recipient.email,
        fullName: recipient.full_name,
        documentTitle: recipient.title,
        documentId: input.documentId,
      }),
    ));
    for (const notification of notifications) {
      if (!notification.sent) recordDocumentActivity(input.documentId, "notification_failed", notification.reason, input.signerId);
    }
  }
  return { id: signatureId, signedAt };
}
