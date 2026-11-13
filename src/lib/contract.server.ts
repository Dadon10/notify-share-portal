/**
 * Contract workflow: send a PDF with signature places for each signer, sign in order, optionally notarize, and
 * finish with a certificate of completion.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDocumentVisible,
  crmUserId,
  database,
  recordDocumentActivity,
  signatureDirectory,
  uploadDirectory,
} from "./local-db.server";
import { sendDocumentApprovalEmail, sendDocumentCompletedEmail } from "./email.server";
import { cleanSignatureImage } from "./invoice-pr.server";
import {
  appendCompletionCertificate,
  initialsOf,
  stampNotaryInitials,
  inspectContractPdf,
  sha256,
  stampContractFields,
} from "./contract-pdf.server";
import {
  CONTRACT_CATEGORY,
  CONTRACT_DOCUMENT_TYPES,
  type ContractField,
  type ContractFieldInput,
  type ContractFieldKind,
  type ContractSummary,
} from "./contract-types";

const MAX_CONTRACT_BYTES = 20 * 1024 * 1024;
const FIELD_KINDS: ContractFieldKind[] = ["signature", "initials", "date", "name"];

type ProfileRow = {
  id: string;
  full_name: string;
  email: string;
  is_notary: number;
};

function getProfile(id: string) {
  return database
    .prepare("SELECT id, full_name, email, is_notary FROM profiles WHERE id = ?")
    .get(id) as ProfileRow | undefined;
}

function assertNotaryActive(notary: ProfileRow) {
  if (!notary.is_notary)
    throw new Error(`${notary.full_name || "This person"} is not set up as a notary in Settings.`);
}

function safeName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 140) || "contract.pdf";
}

/** Writes the new copy next to the old one and swaps it in, so a crash never leaves a half-written contract. */
function replaceFile(path: string, bytes: Uint8Array) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx" });
  renameSync(temporary, path);
}

function validateField(field: ContractFieldInput, pageCount: number, signerIds: Set<string>) {
  const numbers = [field.x, field.y, field.width, field.height];
  if (!signerIds.has(field.signerId))
    throw new Error("A signature place is assigned to someone who is not a signer.");
  if (!FIELD_KINDS.includes(field.kind)) throw new Error("A signature place has an unknown type.");
  if (!Number.isInteger(field.page) || field.page < 0 || field.page >= pageCount)
    throw new Error("A signature place is on a page that does not exist.");
  if (numbers.some((value) => typeof value !== "number" || !Number.isFinite(value)))
    throw new Error("A signature place has an invalid position.");
  const tolerance = 0.001;
  if (field.width < 0.01 || field.height < 0.008)
    throw new Error("A signature place is too small. Make it bigger.");
  if (
    field.x < -tolerance ||
    field.y < -tolerance ||
    field.x + field.width > 1 + tolerance ||
    field.y + field.height > 1 + tolerance
  ) {
    throw new Error(
      `A signature place on page ${field.page + 1} sticks out of the page. Move it fully onto the page.`,
    );
  }
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    ...field,
    x: clamp(field.x),
    y: clamp(field.y),
    width: Math.min(field.width, 1 - clamp(field.x)),
    height: Math.min(field.height, 1 - clamp(field.y)),
  };
}

export async function createContractDocument(input: {
  ownerId: string;
  title: string;
  documentType: string;
  department: string;
  dueDate: string | null;
  fileName: string;
  fileData: string;
  signerIds: string[];
  fields: ContractFieldInput[];
  notarize: boolean;
  notaryId: string | null;
}) {
  const title = input.title.trim();
  if (!title || title.length > 160)
    throw new Error("Contract title must be between 1 and 160 characters.");
  if (!(CONTRACT_DOCUMENT_TYPES as readonly string[]).includes(input.documentType))
    throw new Error("Choose a contract type.");
  const department = input.department.trim();
  if (department.length > 100) throw new Error("Department must be 100 characters or fewer.");
  if (
    input.dueDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ||
      Number.isNaN(new Date(`${input.dueDate}T00:00:00Z`).getTime()))
  ) {
    throw new Error("Choose a valid due date.");
  }
  if (!/\.pdf$/i.test(input.fileName)) throw new Error("Contracts must be uploaded as PDF files.");
  const bytes = Buffer.from(input.fileData, "base64");
  if (!bytes.length || bytes.length > MAX_CONTRACT_BYTES)
    throw new Error("Contracts must be between 1 byte and 20 MB.");
  const { pageCount } = await inspectContractPdf(bytes);

  const signerIds = input.signerIds.map((id) => id.trim()).filter(Boolean);
  if (!signerIds.length) throw new Error("Add at least one signer.");
  if (new Set(signerIds).size !== signerIds.length)
    throw new Error("Each signer can only appear once in the signing order.");
  if (signerIds.length > 20) throw new Error("A contract can have at most 20 signers.");
  const signers = signerIds.map((id) => {
    if (id === crmUserId)
      throw new Error("The shared CRM workspace account cannot sign contracts.");
    const profile = getProfile(id);
    if (!profile) throw new Error("A signer is not available in the CRM directory.");
    return profile;
  });

  if (input.fields.length > 500)
    throw new Error("A contract can have at most 500 signature places.");
  const signerSet = new Set(signerIds);
  const fields = input.fields.map((field) => validateField(field, pageCount, signerSet));
  for (const signer of signers) {
    if (!fields.some((field) => field.signerId === signer.id && field.kind === "signature")) {
      throw new Error(`Place at least one signature box for ${signer.full_name || signer.email}.`);
    }
  }

  let notary: ProfileRow | null = null;
  if (input.notarize) {
    if (!input.notaryId) throw new Error("Choose the notary who will notarize this contract.");
    notary = getProfile(input.notaryId) ?? null;
    if (!notary) throw new Error("The chosen notary is not available.");
    assertNotaryActive(notary);
    if (signerSet.has(notary.id))
      throw new Error("The notary cannot also sign the contract as a party.");
    if (notary.id === input.ownerId)
      throw new Error("You cannot notarize a contract you are sending.");
  }

  const owner = getProfile(input.ownerId);
  if (!owner?.full_name) throw new Error("Your CRM profile could not be found.");

  const documentId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const originalAttachmentId = crypto.randomUUID();
  const workingAttachmentId = crypto.randomUUID();
  const baseName = safeName(input.fileName).replace(/\.pdf$/i, "");
  const originalName = `${baseName}.pdf`;
  const workingName = `${baseName} - signed.pdf`;
  const originalPath = join(
    uploadDirectory,
    `${documentId}-${originalAttachmentId}-${originalName}`,
  );
  const workingPath = join(
    uploadDirectory,
    `${documentId}-${workingAttachmentId}-${safeName(workingName)}`,
  );
  const firstSigner = signers[0]!;
  const originalSha256 = sha256(bytes);

  try {
    writeFileSync(originalPath, bytes, { flag: "wx" });
    writeFileSync(workingPath, bytes, { flag: "wx" });
    database.exec("BEGIN");
    database
      .prepare(
        "INSERT INTO documents (id, owner_id, title, document_type, category, department, status, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        documentId,
        input.ownerId,
        title,
        input.documentType,
        CONTRACT_CATEGORY,
        department,
        `Pending ${firstSigner.full_name}`,
        input.dueDate || null,
        createdAt,
      );
    const insertAttachment = database.prepare(
      "INSERT INTO document_attachments (id, document_id, file_name, mime_type, size_bytes, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertAttachment.run(
      originalAttachmentId,
      documentId,
      originalName,
      "application/pdf",
      bytes.length,
      originalPath,
      createdAt,
    );
    insertAttachment.run(
      workingAttachmentId,
      documentId,
      workingName,
      "application/pdf",
      bytes.length,
      workingPath,
      createdAt,
    );
    database
      .prepare(
        `INSERT INTO contract_details (document_id, original_attachment_id, working_attachment_id, page_count, notarize, notary_id, original_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        originalAttachmentId,
        workingAttachmentId,
        pageCount,
        notary ? 1 : 0,
        notary?.id ?? null,
        originalSha256,
      );
    const insertField = database.prepare(
      "INSERT INTO contract_fields (id, document_id, signer_id, kind, page_index, x, y, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const field of fields)
      insertField.run(
        crypto.randomUUID(),
        documentId,
        field.signerId,
        field.kind,
        field.page,
        field.x,
        field.y,
        field.width,
        field.height,
      );
    const insertStep = database.prepare(
      "INSERT INTO document_approvals (id, document_id, approver_id, sequence_no, status, step_role) VALUES (?, ?, ?, ?, ?, ?)",
    );
    signers.forEach((signer, index) => {
      insertStep.run(
        crypto.randomUUID(),
        documentId,
        signer.id,
        index + 1,
        index === 0 ? "pending" : "waiting",
        "signer",
      );
      const count = fields.filter((field) => field.signerId === signer.id).length;
      recordDocumentActivity(
        documentId,
        "assigned_signer",
        `Signing order ${index + 1}: ${signer.full_name} (${count} ${count === 1 ? "place" : "places"} to complete)`,
        input.ownerId,
      );
    });
    if (notary) {
      insertStep.run(
        crypto.randomUUID(),
        documentId,
        notary.id,
        signers.length + 1,
        "waiting",
        "notary",
      );
      recordDocumentActivity(
        documentId,
        "assigned_notary",
        `${notary.full_name} will notarize after all parties sign.`,
        input.ownerId,
      );
    }
    recordDocumentActivity(
      documentId,
      "submitted",
      `${owner.full_name} sent the contract for signature (${pageCount} ${pageCount === 1 ? "page" : "pages"}, SHA-256 ${originalSha256.slice(0, 16)}…).`,
      input.ownerId,
    );
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    for (const path of [originalPath, workingPath]) {
      try {
        unlinkSync(path);
      } catch {
        // The file may not have been written.
      }
    }
    throw error;
  }

  const notification = await sendDocumentApprovalEmail({
    email: firstSigner.email,
    fullName: firstSigner.full_name,
    documentTitle: title,
    documentId,
    kind: "contract",
  });
  if (!notification.sent)
    recordDocumentActivity(
      documentId,
      notification.queued ? "notification_delayed" : "notification_failed",
      notification.reason,
      input.ownerId,
    );
  return { id: documentId };
}

type ContractRow = {
  document_id: string;
  working_attachment_id: string;
  page_count: number;
  notarize: number;
  notary_id: string | null;
  original_sha256: string;
  final_sha256: string | null;
  notarized_at: string | null;
  notarial_act: string | null;
};

function getContractRow(documentId: string) {
  const row = database
    .prepare("SELECT * FROM contract_details WHERE document_id = ?")
    .get(documentId) as ContractRow | undefined;
  if (!row) throw new Error("This document is not a contract.");
  return row;
}

function getWorkingCopy(contract: ContractRow) {
  const attachment = database
    .prepare("SELECT storage_path FROM document_attachments WHERE id = ?")
    .get(contract.working_attachment_id) as { storage_path: string } | undefined;
  if (!attachment) throw new Error("The contract file is missing.");
  return attachment.storage_path;
}

function getFields(documentId: string) {
  return (
    database
      .prepare(
        `SELECT f.id, f.signer_id, f.kind, f.page_index, f.x, f.y, f.width, f.height, f.completed_at, COALESCE(p.full_name, p.email, f.signer_id) AS signer_name
     FROM contract_fields f LEFT JOIN profiles p ON p.id = f.signer_id
     WHERE f.document_id = ? ORDER BY f.page_index, f.y, f.x`,
      )
      .all(documentId) as {
      id: string;
      signer_id: string;
      kind: ContractFieldKind;
      page_index: number;
      x: number;
      y: number;
      width: number;
      height: number;
      completed_at: string | null;
      signer_name: string;
    }[]
  ).map((field): ContractField & { signerName: string } => ({
    id: field.id,
    signerId: field.signer_id,
    kind: field.kind,
    page: field.page_index,
    x: field.x,
    y: field.y,
    width: field.width,
    height: field.height,
    completedAt: field.completed_at,
    signerName: field.signer_name,
  }));
}

function getSteps(documentId: string) {
  return database
    .prepare(
      `SELECT a.id, a.approver_id, a.sequence_no, a.status, a.decided_at, a.step_role, p.full_name, p.email
     FROM document_approvals a JOIN profiles p ON p.id = a.approver_id
     WHERE a.document_id = ? ORDER BY a.sequence_no`,
    )
    .all(documentId) as {
    id: string;
    approver_id: string;
    sequence_no: number;
    status: string;
    decided_at: string | null;
    step_role: string;
    full_name: string;
    email: string;
  }[];
}

export function getContractSummary(
  documentId: string,
  currentUserId: string,
  isAdmin: boolean,
): ContractSummary {
  assertDocumentVisible(documentId, currentUserId, isAdmin);
  const contract = getContractRow(documentId);
  const notary = contract.notary_id ? getProfile(contract.notary_id) : undefined;
  return {
    documentId,
    pageCount: contract.page_count,
    notarize: Boolean(contract.notarize),
    notary: notary
      ? {
          id: notary.id,
          full_name: notary.full_name,
        }
      : null,
    originalSha256: contract.original_sha256,
    finalSha256: contract.final_sha256,
    notarizedAt: contract.notarized_at,
    notarialAct: contract.notarial_act,
    signers: getSteps(documentId)
      .filter((step) => step.step_role === "signer")
      .map((step) => ({
        id: step.approver_id,
        full_name: step.full_name,
        email: step.email,
        sequence_no: step.sequence_no,
        status: step.status,
        decided_at: step.decided_at,
      })),
    fields: getFields(documentId),
  };
}

async function finishContract(
  documentId: string,
  workingBytes: Uint8Array,
  notarized: { notaryName: string; notarizedAt: Date } | null,
  completedAt: Date,
) {
  const document = database
    .prepare(
      "SELECT d.title, d.created_at, p.full_name FROM documents d LEFT JOIN profiles p ON p.id = d.owner_id WHERE d.id = ?",
    )
    .get(documentId) as { title: string; created_at: string; full_name: string | null };
  const contract = getContractRow(documentId);
  const fields = getFields(documentId);
  const signerSteps = getSteps(documentId).filter((step) => step.step_role === "signer");
  return await appendCompletionCertificate(workingBytes, {
    documentId,
    title: document.title,
    senderName: document.full_name || "Unknown sender",
    sentAt: new Date(document.created_at),
    originalSha256: contract.original_sha256,
    signers: signerSteps.map((step) => ({
      fullName: step.full_name,
      email: step.email,
      // The current signer's step is not yet saved as approved when the certificate is built.
      signedAt: step.decided_at ? new Date(step.decided_at) : completedAt,
      fieldCount: fields.filter((field) => field.signerId === step.approver_id).length,
    })),
    notarized,
    completedAt,
  });
}

function completionRecipients(documentId: string) {
  return database
    .prepare(
      `SELECT p.email, p.full_name FROM document_approvals a JOIN profiles p ON p.id = a.approver_id WHERE a.document_id = ?
     UNION
     SELECT p.email, p.full_name FROM documents d JOIN profiles p ON p.id = d.owner_id WHERE d.id = ?`,
    )
    .all(documentId, documentId) as { email: string; full_name: string }[];
}

async function notifyAfterStep(
  documentId: string,
  actorId: string,
  title: string,
  next: { full_name: string; email: string; step_role: string } | undefined,
  notarized: boolean,
) {
  if (next) {
    const notification = await sendDocumentApprovalEmail({
      email: next.email,
      fullName: next.full_name,
      documentTitle: title,
      documentId,
      kind: next.step_role === "notary" ? "notarization" : "contract",
    });
    if (!notification.sent)
      recordDocumentActivity(
        documentId,
        notification.queued ? "notification_delayed" : "notification_failed",
        notification.reason,
        actorId,
      );
    return;
  }
  const results = await Promise.all(
    completionRecipients(documentId).map((recipient) =>
      sendDocumentCompletedEmail({
        email: recipient.email,
        fullName: recipient.full_name,
        documentTitle: title,
        documentId,
        kind: notarized ? "notarization" : "contract",
      }),
    ),
  );
  for (const result of results)
    if (!result.sent)
      recordDocumentActivity(
        documentId,
        result.queued ? "notification_delayed" : "notification_failed",
        result.reason,
        actorId,
      );
}

/** Applies the signer's saved signature to every place marked for them and moves the contract to the next step. */
export async function signContract(input: {
  documentId: string;
  signerId: string;
  mimeType: string;
  fileData: string;
}) {
  if (!/^image\/(png|jpeg)$/.test(input.mimeType))
    throw new Error("Signature must be a PNG or JPEG image.");
  const signatureBytes = Buffer.from(input.fileData, "base64");
  if (!signatureBytes.length || signatureBytes.length > 2 * 1024 * 1024)
    throw new Error("Signature images must be 2 MB or smaller.");
  const contract = getContractRow(input.documentId);
  const signer = getProfile(input.signerId);
  if (!signer?.full_name) throw new Error("Your CRM profile could not be found.");
  const steps = getSteps(input.documentId);
  const current = steps.find((step) => step.status === "pending");
  if (!current || current.approver_id !== input.signerId)
    throw new Error("This contract is not waiting for your signature.");
  if (current.step_role !== "signer")
    throw new Error("This step is for the notary. Use Notarize instead.");
  const myFields = getFields(input.documentId).filter(
    (field) => field.signerId === input.signerId && !field.completedAt,
  );
  if (!myFields.length) throw new Error("No signature places are marked for you on this contract.");

  const signaturePng = (await cleanSignatureImage(signatureBytes)).png;
  const signedAtDate = new Date();
  const signedAt = signedAtDate.toISOString();
  const workingPath = getWorkingCopy(contract);
  const before = readFileSync(workingPath);
  let after: Buffer = await stampContractFields(before, myFields, {
    fullName: signer.full_name,
    signaturePng,
    signedAt: signedAtDate,
  });
  const next = steps.find(
    (step) => step.sequence_no > current.sequence_no && step.status === "waiting",
  );
  if (!next) after = await finishContract(input.documentId, after, null, signedAtDate);
  const signatureId = crypto.randomUUID();
  const signaturePath = join(signatureDirectory, `${input.documentId}-${signatureId}.png`);
  const title = (
    database.prepare("SELECT title FROM documents WHERE id = ?").get(input.documentId) as {
      title: string;
    }
  ).title;

  try {
    writeFileSync(signaturePath, signaturePng, { flag: "wx" });
    database.exec("BEGIN");
    const stillCurrent = database
      .prepare(
        "SELECT id FROM document_approvals WHERE document_id = ? AND status = 'pending' ORDER BY sequence_no LIMIT 1",
      )
      .get(input.documentId) as { id: string } | undefined;
    if (stillCurrent?.id !== current.id)
      throw new Error("This contract has already moved on to the next person.");
    database
      .prepare(
        "INSERT INTO document_signatures (id, document_id, signer_id, signature_path, mime_type, signed_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(signatureId, input.documentId, input.signerId, signaturePath, "image/png", signedAt);
    database
      .prepare(
        "UPDATE contract_fields SET completed_at = ? WHERE document_id = ? AND signer_id = ? AND completed_at IS NULL",
      )
      .run(signedAt, input.documentId, input.signerId);
    database
      .prepare("UPDATE document_approvals SET status = 'approved', decided_at = ? WHERE id = ?")
      .run(signedAt, current.id);
    if (next) {
      database
        .prepare("UPDATE document_approvals SET status = 'pending' WHERE id = ?")
        .run(next.id);
      database
        .prepare("UPDATE documents SET status = ? WHERE id = ?")
        .run(`Pending ${next.full_name}`, input.documentId);
    } else {
      database
        .prepare("UPDATE documents SET status = 'Completed' WHERE id = ?")
        .run(input.documentId);
      database
        .prepare("UPDATE contract_details SET final_sha256 = ? WHERE document_id = ?")
        .run(sha256(after), input.documentId);
    }
    database
      .prepare("UPDATE document_attachments SET size_bytes = ? WHERE id = ?")
      .run(after.length, contract.working_attachment_id);
    recordDocumentActivity(
      input.documentId,
      "signed",
      `${signer.full_name} signed the contract (${myFields.length} ${myFields.length === 1 ? "place" : "places"} completed).`,
      input.signerId,
    );
    if (!next)
      recordDocumentActivity(
        input.documentId,
        "completed",
        "All parties signed. Certificate of completion added.",
        input.signerId,
      );
    else if (next.step_role === "notary")
      recordDocumentActivity(
        input.documentId,
        "awaiting_notarization",
        `All parties signed. Waiting for ${next.full_name} to notarize.`,
        input.signerId,
      );
    replaceFile(workingPath, after);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    writeFileSync(workingPath, before);
    try {
      unlinkSync(signaturePath);
    } catch {
      // Not written.
    }
    throw error;
  }
  await notifyAfterStep(input.documentId, input.signerId, title, next, false);
  return { signedAt, completed: !next };
}

/**
 * Notarizes a fully signed contract: the notary's handwritten-style initials go in the bottom-right corner of every
 * page, then the certificate of completion is added.
 */
export async function notarizeContract(input: {
  documentId: string;
  notaryId: string;
  identityConfirmed: boolean;
}) {
  if (!input.identityConfirmed)
    throw new Error("Confirm that you verified each signer's identity before notarizing.");

  const contract = getContractRow(input.documentId);
  if (!contract.notarize || contract.notary_id !== input.notaryId)
    throw new Error("You are not the notary for this contract.");
  const steps = getSteps(input.documentId);
  const current = steps.find((step) => step.status === "pending");
  if (!current || current.approver_id !== input.notaryId || current.step_role !== "notary") {
    throw new Error(
      "This contract is not ready for notarization yet. Every party must sign first.",
    );
  }
  const notary = getProfile(input.notaryId);
  if (!notary) throw new Error("Your CRM profile could not be found.");
  assertNotaryActive(notary);

  const notarizedAtDate = new Date();
  const notarizedAt = notarizedAtDate.toISOString();
  const workingPath = getWorkingCopy(contract);
  const before = readFileSync(workingPath);
  const signedSha256 = sha256(before);
  // Signers' boxes are passed so the initials never land on top of an initials line in the corner.
  let after: Buffer = await stampNotaryInitials(
    before,
    notary.full_name,
    getFields(input.documentId),
  );
  after = await finishContract(
    input.documentId,
    after,
    {
      notaryName: notary.full_name,
      notarizedAt: notarizedAtDate,
    },
    notarizedAtDate,
  );
  const title = (
    database.prepare("SELECT title FROM documents WHERE id = ?").get(input.documentId) as {
      title: string;
    }
  ).title;

  try {
    database.exec("BEGIN");
    const stillCurrent = database
      .prepare(
        "SELECT id FROM document_approvals WHERE document_id = ? AND status = 'pending' ORDER BY sequence_no LIMIT 1",
      )
      .get(input.documentId) as { id: string } | undefined;
    if (stillCurrent?.id !== current.id)
      throw new Error("This contract has already been notarized or rejected.");
    database
      .prepare("UPDATE document_approvals SET status = 'approved', decided_at = ? WHERE id = ?")
      .run(notarizedAt, current.id);
    database
      .prepare("UPDATE documents SET status = 'Completed' WHERE id = ?")
      .run(input.documentId);
    database
      .prepare(
        "UPDATE contract_details SET final_sha256 = ?, notarized_at = ?, notarial_act = ?, notarization_details = ? WHERE document_id = ?",
      )
      .run(
        sha256(after),
        notarizedAt,
        "Initialled",
        JSON.stringify({
          initials: initialsOf(notary.full_name),
          signedSha256,
        }),
        input.documentId,
      );
    database
      .prepare("UPDATE document_attachments SET size_bytes = ? WHERE id = ?")
      .run(after.length, contract.working_attachment_id);
    recordDocumentActivity(
      input.documentId,
      "notarized",
      `${notary.full_name} confirmed the signers' identities and notarized the contract (initials ${initialsOf(notary.full_name)} on every page).`,
      input.notaryId,
    );
    recordDocumentActivity(
      input.documentId,
      "completed",
      "Certificate of completion added.",
      input.notaryId,
    );
    replaceFile(workingPath, after);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    writeFileSync(workingPath, before);
    throw error;
  }
  await notifyAfterStep(input.documentId, input.notaryId, title, undefined, true);
  return { notarizedAt };
}

/** The untouched upload, for comparing against the signed copy. */
export function getContractOriginal(documentId: string, currentUserId: string, isAdmin: boolean) {
  assertDocumentVisible(documentId, currentUserId, isAdmin);
  const attachment = database
    .prepare(
      `SELECT a.file_name, a.mime_type, a.storage_path FROM contract_details c JOIN document_attachments a ON a.id = c.original_attachment_id WHERE c.document_id = ?`,
    )
    .get(documentId) as { file_name: string; mime_type: string; storage_path: string } | undefined;
  if (!attachment) throw new Error("This document is not a contract.");
  return {
    fileName: attachment.file_name,
    mimeType: attachment.mime_type,
    fileData: readFileSync(attachment.storage_path).toString("base64"),
  };
}
