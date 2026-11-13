import nodemailer from "nodemailer";

export type ApproverNotificationInput = {
  fullName: string;
  email: string;
  department: string;
  portalUrl?: string;
};

type DocumentNotificationInput = {
  email: string;
  fullName: string;
  documentTitle: string;
  documentId: string;
  /** What the email is about; defaults to a payment requisition. */
  kind?: "requisition" | "contract" | "notarization";
};

const NOTIFICATION_WORDING = {
  requisition: {
    noun: "requisition",
    readySubject: "Approval required",
    ready: "A requisition is ready for your approval",
    readyAction: "Preview requisition",
    readyHint: "Preview the requisition before choosing to approve and sign or reject it.",
    doneSubject: "Requisition approved",
    done: "The requisition has been approved",
  },
  contract: {
    noun: "contract",
    readySubject: "Signature required",
    ready: "A contract is ready for your signature",
    readyAction: "Review and sign",
    readyHint: "Review the contract and the places marked for you before signing or rejecting it.",
    doneSubject: "Contract completed",
    done: "Every party has signed the contract",
  },
  notarization: {
    noun: "contract",
    readySubject: "Notarization required",
    ready: "A signed contract is ready for you to notarize",
    readyAction: "Review and notarize",
    readyHint: "Confirm the signers' identities and review the contract before notarizing or rejecting it.",
    doneSubject: "Contract notarized",
    done: "The contract has been signed and notarized",
  },
} as const;

type RejectionNotificationInput = DocumentNotificationInput & { reason: string };

function getBooleanEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function getSmtpConfig() {
  return {
    host: process.env["SMTP_HOST"]?.trim() || "",
    port: Number(process.env["SMTP_PORT"] || "587"),
    secure: getBooleanEnv(process.env["SMTP_SECURE"], false),
    user: process.env["SMTP_USER"]?.trim() || "",
    pass: process.env["SMTP_PASS"]?.trim() || "",
    from: process.env["SMTP_FROM"]?.trim() || process.env["SMTP_USER"]?.trim() || "noreply@localhost",
  };
}

export function getSmtpStatus() {
  const config = getSmtpConfig();
  const missing = [
    !config.host && "SMTP_HOST",
    config.port !== 25 && !config.user && "SMTP_USER",
    config.port !== 25 && !config.pass && "SMTP_PASS",
    !config.from && "SMTP_FROM",
  ].filter(Boolean) as string[];

  return {
    configured: missing.length === 0,
    missing,
    host: config.host,
    port: config.port,
    from: config.from,
  };
}

export async function sendApproverWelcomeEmail(input: ApproverNotificationInput) {
  const config = getSmtpConfig();
  const smtpStatus = getSmtpStatus();
  if (!smtpStatus.configured) {
    return {
      sent: false,
      configured: false,
      reason: `SMTP is not configured. Missing: ${smtpStatus.missing.join(", ") || "SMTP settings"}.`,
    };
  }

  const portalUrl = input.portalUrl || process.env["APP_BASE_URL"] || process.env["VITE_APP_URL"] || "http://localhost:3000";
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
  });

  const subject = "You have been added as an approver";
  const text = [
    `Hello ${input.fullName || "there"},`,
    "",
    "You have been added as an approver in the Sanlam Document Hub.",
    `Department: ${input.department || "Not specified"}`,
    `Portal: ${portalUrl}`,
    "",
    "Please sign in to review and approve pending documents.",
    "",
    "Kind regards,",
    "Sanlam Document Hub",
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6;">
      <h2 style="margin-bottom: 12px;">You have been added as an approver</h2>
      <p>Hello ${input.fullName || "there"},</p>
      <p>You have been added as an approver in the Sanlam Document Hub.</p>
      <ul>
        <li><strong>Department:</strong> ${input.department || "Not specified"}</li>
        <li><strong>Portal:</strong> <a href="${portalUrl}">${portalUrl}</a></li>
      </ul>
      <p>Please sign in to review and approve pending documents.</p>
      <p>Kind regards,<br />Sanlam Document Hub</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: config.from,
      to: input.email,
      subject,
      text,
      html,
    });

    return { sent: true, configured: true, reason: "Email sent successfully." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SMTP error.";
    return {
      sent: false,
      configured: true,
      reason: `SMTP delivery failed: ${message}`,
    };
  }
}

async function sendDocumentNotification(input: DocumentNotificationInput, completed: boolean) {
  const config = getSmtpConfig();
  const smtpStatus = getSmtpStatus();
  if (!smtpStatus.configured || !input.email.trim()) {
    return { sent: false, configured: false, reason: `SMTP is not configured. Missing: ${smtpStatus.missing.join(", ") || "recipient email"}.` };
  }
  const baseUrl = process.env["PORTAL_BASE_URL"] || process.env["APP_BASE_URL"] || "http://localhost:3000/document-hub";
  const link = new URL(baseUrl);
  link.searchParams.set("documentId", input.documentId);
  const wording = NOTIFICATION_WORDING[input.kind ?? "requisition"];
  const subject = completed ? `${wording.doneSubject}: ${input.documentTitle}` : `${wording.readySubject}: ${input.documentTitle}`;
  const heading = completed ? wording.done : wording.ready;
  const greeting = input.fullName ? `Hello ${input.fullName},` : "Hello,";
  const action = completed ? `Open ${wording.noun}` : wording.readyAction;
  const instruction = completed ? "" : `\n${wording.readyHint}`;
  const text = `${greeting}\n\n${heading}: ${input.documentTitle}${instruction}\n\n${action}: ${link.toString()}\n\nSanlam Document Hub`;
  const safeTitle = input.documentTitle.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
  const safeLink = link.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const html = `<div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6"><p>${greeting}</p><p>${heading}: <strong>${safeTitle}</strong></p>${completed ? "" : `<p>${wording.readyHint}</p>`}<p style="margin:24px 0"><a href="${safeLink}" style="display:inline-block;padding:12px 20px;background:#153b72;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">${action}</a></p><p>Sanlam Document Hub</p></div>`;
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
  });
  try {
    await transporter.sendMail({ from: config.from, to: input.email, subject, text, html });
    return { sent: true, configured: true, reason: "Email sent successfully." };
  } catch (error) {
    return { sent: false, configured: true, reason: error instanceof Error ? error.message : "Email delivery failed." };
  }
}

export function sendDocumentApprovalEmail(input: DocumentNotificationInput) {
  return sendDocumentNotification(input, false);
}

export function sendDocumentCompletedEmail(input: DocumentNotificationInput) {
  return sendDocumentNotification(input, true);
}

export async function sendDocumentRejectedEmail(input: RejectionNotificationInput) {
  const config = getSmtpConfig();
  const smtpStatus = getSmtpStatus();
  if (!smtpStatus.configured || !input.email.trim()) {
    return { sent: false, configured: false, reason: `SMTP is not configured. Missing: ${smtpStatus.missing.join(", ") || "recipient email"}.` };
  }
  const baseUrl = process.env["PORTAL_BASE_URL"] || process.env["APP_BASE_URL"] || "http://localhost:3000/document-hub";
  const link = new URL(baseUrl);
  link.searchParams.set("documentId", input.documentId);
  const greeting = input.fullName ? `Hello ${input.fullName},` : "Hello,";
  const noun = input.kind === "contract" ? "contract" : "requisition";
  const subject = `${noun === "contract" ? "Contract" : "Requisition"} rejected: ${input.documentTitle}`;
  const text = `${greeting}\n\nYour ${noun} was rejected: ${input.documentTitle}\nReason: ${input.reason}\n\nOpen the ${noun}: ${link.toString()}\n\nSanlam Document Hub`;
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
  const safeLink = link.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const html = `<p>${escapeHtml(greeting)}</p><p>Your ${noun} was rejected: <strong>${escapeHtml(input.documentTitle)}</strong></p><p><strong>Reason:</strong> ${escapeHtml(input.reason)}</p><p><a href="${safeLink}">Open ${noun}</a></p><p>Sanlam Document Hub</p>`;
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
  });
  try {
    await transporter.sendMail({ from: config.from, to: input.email, subject, text, html });
    return { sent: true, configured: true, reason: "Email sent successfully." };
  } catch (error) {
    return { sent: false, configured: true, reason: error instanceof Error ? error.message : "Email delivery failed." };
  }
}
