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
    readyHint:
      "Confirm the signers' identities and review the contract before notarizing or rejecting it.",
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
    from:
      process.env["SMTP_FROM"]?.trim() || process.env["SMTP_USER"]?.trim() || "noreply@localhost",
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

export type DeliveryResult = {
  sent: boolean;
  configured: boolean;
  reason: string;
  /** True when the mail server was temporarily unavailable and the email will be retried in the background. */
  queued?: boolean;
};

type OutgoingMessage = { to: string; subject: string; text: string; html: string };

/** Waits between background retries: 30 s, 2 min, 5 min, 15 min, 30 min (about 52 minutes in total). */
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000, 900_000, 1_800_000];

/**
 * 4xx replies ("try again later", e.g. Exchange Online's "452 4.3.1 Insufficient system resources") and dropped or
 * timed-out connections are temporary. 5xx replies (bad address, relay refused) are permanent and are not retried.
 */
function isTemporaryFailure(error: unknown) {
  const details = error as { responseCode?: number; response?: string; code?: string } | null;
  const code =
    details?.responseCode ?? Number(String(details?.response ?? "").match(/^([45]\d\d)/)?.[1]);
  if (code >= 400 && code < 500) return true;
  if (code >= 500) return false;
  return ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "EDNS"].includes(
    details?.code ?? "",
  );
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : "Unknown SMTP error.";
}

async function sendOnce(message: OutgoingMessage) {
  const config = getSmtpConfig();
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
  });
  await transporter.sendMail({ from: config.from, ...message });
}

function retryLater(message: OutgoingMessage, attempt: number) {
  const delay = RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    console.error(
      `[email] Gave up sending "${message.subject}" to ${message.to} after ${RETRY_DELAYS_MS.length + 1} attempts.`,
    );
    return;
  }
  const timer = setTimeout(() => {
    sendOnce(message)
      .then(() =>
        console.info(`[email] Sent "${message.subject}" to ${message.to} on retry ${attempt + 1}.`),
      )
      .catch((error: unknown) => {
        if (!isTemporaryFailure(error)) {
          console.error(
            `[email] Could not send "${message.subject}" to ${message.to}: ${describe(error)}`,
          );
          return;
        }
        console.warn(
          `[email] Retry ${attempt + 1} for ${message.to} failed (${describe(error)}); trying again later.`,
        );
        retryLater(message, attempt + 1);
      });
  }, delay);
  // Retries must never keep the process alive on shutdown.
  timer.unref();
}

/** Sends now; if the mail server is only temporarily unavailable, keeps retrying in the background. */
async function deliver(message: OutgoingMessage): Promise<DeliveryResult> {
  try {
    await sendOnce(message);
    return { sent: true, configured: true, reason: "Email sent successfully." };
  } catch (error) {
    if (isTemporaryFailure(error)) {
      console.warn(
        `[email] Mail server busy for ${message.to} (${describe(error)}); retrying in the background.`,
      );
      retryLater(message, 0);
      return {
        sent: false,
        configured: true,
        queued: true,
        reason: `The mail server was busy, so the email to ${message.to} will be retried automatically over the next hour. (${describe(error)})`,
      };
    }
    return { sent: false, configured: true, reason: `SMTP delivery failed: ${describe(error)}` };
  }
}

export async function sendApproverWelcomeEmail(input: ApproverNotificationInput) {
  const smtpStatus = getSmtpStatus();
  if (!smtpStatus.configured) {
    return {
      sent: false,
      configured: false,
      reason: `SMTP is not configured. Missing: ${smtpStatus.missing.join(", ") || "SMTP settings"}.`,
    };
  }

  const portalUrl =
    input.portalUrl ||
    process.env["APP_BASE_URL"] ||
    process.env["VITE_APP_URL"] ||
    "http://localhost:3000";
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

  return await deliver({ to: input.email, subject, text, html });
}

async function sendDocumentNotification(input: DocumentNotificationInput, completed: boolean) {
  const smtpStatus = getSmtpStatus();
  if (!smtpStatus.configured || !input.email.trim()) {
    return {
      sent: false,
      configured: false,
      reason: `SMTP is not configured. Missing: ${smtpStatus.missing.join(", ") || "recipient email"}.`,
    };
  }
  const baseUrl =
    process.env["PORTAL_BASE_URL"] ||
    process.env["APP_BASE_URL"] ||
    "http://localhost:3000/document-hub";
  const link = new URL(baseUrl);
  link.searchParams.set("documentId", input.documentId);
  const wording = NOTIFICATION_WORDING[input.kind ?? "requisition"];
  const subject = completed
    ? `${wording.doneSubject}: ${input.documentTitle}`
    : `${wording.readySubject}: ${input.documentTitle}`;
  const heading = completed ? wording.done : wording.ready;
  const greeting = input.fullName ? `Hello ${input.fullName},` : "Hello,";
  const action = completed ? `Open ${wording.noun}` : wording.readyAction;
  const instruction = completed ? "" : `\n${wording.readyHint}`;
  const text = `${greeting}\n\n${heading}: ${input.documentTitle}${instruction}\n\n${action}: ${link.toString()}\n\nSanlam Document Hub`;
  const safeTitle = input.documentTitle.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ||
      character,
  );
  const safeLink = link.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const html = `<div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6"><p>${greeting}</p><p>${heading}: <strong>${safeTitle}</strong></p>${completed ? "" : `<p>${wording.readyHint}</p>`}<p style="margin:24px 0"><a href="${safeLink}" style="display:inline-block;padding:12px 20px;background:#153b72;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">${action}</a></p><p>Sanlam Document Hub</p></div>`;
  return await deliver({ to: input.email, subject, text, html });
}

export function sendDocumentApprovalEmail(input: DocumentNotificationInput) {
  return sendDocumentNotification(input, false);
}

export function sendDocumentCompletedEmail(input: DocumentNotificationInput) {
  return sendDocumentNotification(input, true);
}

export async function sendDocumentRejectedEmail(input: RejectionNotificationInput) {
  const smtpStatus = getSmtpStatus();
  if (!smtpStatus.configured || !input.email.trim()) {
    return {
      sent: false,
      configured: false,
      reason: `SMTP is not configured. Missing: ${smtpStatus.missing.join(", ") || "recipient email"}.`,
    };
  }
  const baseUrl =
    process.env["PORTAL_BASE_URL"] ||
    process.env["APP_BASE_URL"] ||
    "http://localhost:3000/document-hub";
  const link = new URL(baseUrl);
  link.searchParams.set("documentId", input.documentId);
  const greeting = input.fullName ? `Hello ${input.fullName},` : "Hello,";
  const noun = input.kind === "contract" ? "contract" : "requisition";
  const subject = `${noun === "contract" ? "Contract" : "Requisition"} rejected: ${input.documentTitle}`;
  const text = `${greeting}\n\nYour ${noun} was rejected: ${input.documentTitle}\nReason: ${input.reason}\n\nOpen the ${noun}: ${link.toString()}\n\nSanlam Document Hub`;
  const escapeHtml = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ||
        character,
    );
  const safeLink = link.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const html = `<p>${escapeHtml(greeting)}</p><p>Your ${noun} was rejected: <strong>${escapeHtml(input.documentTitle)}</strong></p><p><strong>Reason:</strong> ${escapeHtml(input.reason)}</p><p><a href="${safeLink}">Open ${noun}</a></p><p>Sanlam Document Hub</p>`;
  return await deliver({ to: input.email, subject, text, html });
}
