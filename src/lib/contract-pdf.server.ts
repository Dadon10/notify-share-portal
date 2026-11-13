/**
 * PDF work for contracts: placing signatures/initials/dates in the boxes the sender drew, the notary's seal and
 * notarial certificate, and the certificate of completion. Pure functions over PDF bytes so they can be tested
 * without the database.
 */
import { createHash } from "node:crypto";
import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import type { ContractFieldInput, ContractFieldKind } from "./contract-types";

const INK = rgb(0.08, 0.16, 0.36);
const SEAL = rgb(0.55, 0.08, 0.12);
const MUTED = rgb(0.38, 0.4, 0.45);
const TEXT = rgb(0.12, 0.13, 0.16);
const RULE = rgb(0.82, 0.84, 0.87);
const TIME_ZONE = "Africa/Lusaka";

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function formatContractDate(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(date);
}

export function formatContractDateTime(date: Date) {
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: TIME_ZONE,
  }).format(date)} (CAT)`;
}

export function initialsOf(fullName: string) {
  return fullName
    .split(/[\s-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase())
    .join(".")
    .concat(".");
}

/** Loads a contract and rejects files that cannot be signed (not a PDF, encrypted, empty). */
export async function inspectContractPdf(bytes: Uint8Array) {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/encrypt/i.test(message))
      throw new Error(
        "This PDF is password-protected. Upload an unprotected copy of the contract.",
      );
    throw new Error("The contract could not be read. Upload a valid PDF file.");
  }
  if (pdf.isEncrypted)
    throw new Error("This PDF is password-protected. Upload an unprotected copy of the contract.");
  const pageCount = pdf.getPageCount();
  if (!pageCount) throw new Error("The contract PDF has no pages.");
  if (pageCount > 200) throw new Error("Contracts can have at most 200 pages.");
  return { pageCount };
}

/**
 * Converts a box measured on the page as displayed (fractions of the displayed page, top-left origin) into PDF user
 * space, including the rotation needed for content to read upright on rotated pages.
 */
export function placeOnPage(
  page: PDFPage,
  box: { x: number; y: number; width: number; height: number },
) {
  const crop = page.getCropBox();
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const sideways = rotation === 90 || rotation === 270;
  const viewWidth = sideways ? crop.height : crop.width;
  const viewHeight = sideways ? crop.width : crop.height;
  const toPdf = (px: number, py: number) => {
    switch (rotation) {
      case 90:
        return { x: crop.x + py, y: crop.y + px };
      case 180:
        return { x: crop.x + crop.width - px, y: crop.y + py };
      case 270:
        return { x: crop.x + crop.width - py, y: crop.y + crop.height - px };
      default:
        return { x: crop.x + px, y: crop.y + crop.height - py };
    }
  };
  const width = box.width * viewWidth;
  const height = box.height * viewHeight;
  // Anchor = the box's bottom-left corner as seen on screen; content is rotated counter-clockwise around it.
  const anchor = toPdf(box.x * viewWidth, (box.y + box.height) * viewHeight);
  // Moves a point inside the box, given as offsets from the anchor along the displayed right/up directions.
  const offset = (right: number, up: number) => {
    switch (rotation) {
      case 90:
        return { x: anchor.x - up, y: anchor.y + right };
      case 180:
        return { x: anchor.x - right, y: anchor.y - up };
      case 270:
        return { x: anchor.x + up, y: anchor.y - right };
      default:
        return { x: anchor.x + right, y: anchor.y + up };
    }
  };
  return { width, height, rotate: degrees(rotation), offset, viewWidth, viewHeight };
}

/** Standard PDF fonts only cover Latin-1; replace anything else so a name like "Ŝtefan" never breaks signing. */
function encodable(font: PDFFont, text: string) {
  let result = "";
  for (const character of text.normalize("NFC")) {
    try {
      font.encodeText(character);
      result += character;
    } catch {
      const stripped = character.normalize("NFD").replace(/[̀-ͯ]/g, "");
      try {
        font.encodeText(stripped);
        result += stripped;
      } catch {
        result += "?";
      }
    }
  }
  return result;
}

function drawFittedText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  box: { x: number; y: number; width: number; height: number },
  color = INK,
) {
  const place = placeOnPage(page, box);
  const value = encodable(font, text);
  let size = Math.min(place.height * 0.72, 14);
  while (size > 4 && font.widthOfTextAtSize(value, size) > place.width * 0.96) size -= 0.25;
  const descent = Math.abs(
    font.heightAtSize(size, { descender: true }) - font.heightAtSize(size, { descender: false }),
  );
  const baseline = Math.max(descent, (place.height - size) / 2 + descent * 0.5);
  page.drawText(value, {
    ...place.offset(place.width * 0.02, baseline),
    size,
    font,
    color,
    rotate: place.rotate,
  });
}

function drawFittedImage(
  page: PDFPage,
  image: PDFImage,
  box: { x: number; y: number; width: number; height: number },
) {
  const place = placeOnPage(page, box);
  const scale = Math.min(place.width / image.width, place.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  // Bottom-aligned and left-aligned so the signature sits on the line like a real one.
  page.drawImage(image, { ...place.offset(0, 0), width, height, rotate: place.rotate });
}

export type StampSigner = {
  fullName: string;
  signaturePng: Uint8Array;
  signedAt: Date;
};

/** Fills every box that belongs to one signer. Boxes for other signers are left untouched. */
export async function stampContractFields(
  pdfBytes: Uint8Array,
  fields: Pick<ContractFieldInput, "kind" | "page" | "x" | "y" | "width" | "height">[],
  signer: StampSigner,
) {
  const pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const pages = pdf.getPages();
  const signature = await pdf.embedPng(signer.signaturePng);
  const script = await pdf.embedFont(StandardFonts.TimesRomanBoldItalic);
  const plain = await pdf.embedFont(StandardFonts.Helvetica);
  const values: Record<Exclude<ContractFieldKind, "signature">, { font: PDFFont; text: string }> = {
    initials: { font: script, text: initialsOf(signer.fullName) },
    date: { font: plain, text: formatContractDate(signer.signedAt) },
    name: { font: plain, text: signer.fullName },
  };
  for (const field of fields) {
    const page = pages[field.page];
    if (!page) throw new Error(`The contract no longer has page ${field.page + 1}.`);
    if (field.kind === "signature") drawFittedImage(page, signature, field);
    else drawFittedText(page, values[field.kind].font, values[field.kind].text, field);
  }
  return Buffer.from(await pdf.save());
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of encodable(font, text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A simple top-to-bottom writer for the certificate pages. Adds pages when the content runs long. */
class CertificateWriter {
  page: PDFPage;
  y: number;
  readonly margin = 56;
  readonly width = 595.28;
  readonly height = 841.89;
  constructor(
    private pdf: PDFDocument,
    private fonts: { regular: PDFFont; bold: PDFFont; mono: PDFFont },
    private title: string,
  ) {
    this.page = pdf.addPage([this.width, this.height]);
    this.y = this.height - this.margin;
    this.header();
  }
  private header() {
    this.page.drawText(encodable(this.fonts.bold, this.title), {
      x: this.margin,
      y: this.y - 18,
      size: 18,
      font: this.fonts.bold,
      color: TEXT,
    });
    this.y -= 30;
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.width - this.margin, y: this.y },
      thickness: 1,
      color: RULE,
    });
    this.y -= 18;
  }
  ensure(space: number) {
    if (this.y - space >= this.margin) return;
    this.page = this.pdf.addPage([this.width, this.height]);
    this.y = this.height - this.margin;
    this.header();
  }
  text(
    value: string,
    options: {
      size?: number;
      bold?: boolean;
      mono?: boolean;
      color?: ReturnType<typeof rgb>;
      indent?: number;
      gap?: number;
    } = {},
  ) {
    const size = options.size ?? 10;
    const font = options.mono
      ? this.fonts.mono
      : options.bold
        ? this.fonts.bold
        : this.fonts.regular;
    const indent = options.indent ?? 0;
    for (const line of wrap(font, value, size, this.width - this.margin * 2 - indent)) {
      this.ensure(size + 4);
      this.page.drawText(line, {
        x: this.margin + indent,
        y: this.y - size,
        size,
        font,
        color: options.color ?? TEXT,
      });
      this.y -= size + 4;
    }
    this.y -= options.gap ?? 4;
  }
  pair(label: string, value: string, mono = false) {
    this.ensure(28);
    this.text(label.toUpperCase(), { size: 7.5, bold: true, color: MUTED, gap: 0 });
    this.text(value, { size: mono ? 8.5 : 10, mono, gap: 8 });
  }
  rule() {
    this.ensure(14);
    this.y -= 4;
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.width - this.margin, y: this.y },
      thickness: 0.6,
      color: RULE,
    });
    this.y -= 12;
  }
}

async function certificateFonts(pdf: PDFDocument) {
  return {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
}

export type CompletionSigner = {
  fullName: string;
  email: string;
  signedAt: Date;
  fieldCount: number;
};

/** Appends the certificate of completion: who signed, when, and the fingerprint of the original upload. */
export async function appendCompletionCertificate(
  pdfBytes: Uint8Array,
  input: {
    documentId: string;
    title: string;
    senderName: string;
    sentAt: Date;
    originalSha256: string;
    signers: CompletionSigner[];
    notarized: { notaryName: string; commission: string; notarizedAt: Date } | null;
    completedAt: Date;
  },
) {
  const pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const writer = new CertificateWriter(
    pdf,
    await certificateFonts(pdf),
    "Certificate of completion",
  );
  writer.pair("Document", input.title);
  writer.pair("Reference", input.documentId, true);
  writer.pair("Sent by", `${input.senderName} on ${formatContractDateTime(input.sentAt)}`);
  writer.pair("Completed", formatContractDateTime(input.completedAt));
  writer.pair("Original document fingerprint (SHA-256)", input.originalSha256, true);
  writer.rule();
  writer.text("Signers", { bold: true, size: 12, gap: 6 });
  input.signers.forEach((signer, index) => {
    writer.text(`${index + 1}. ${signer.fullName}${signer.email ? ` <${signer.email}>` : ""}`, {
      bold: true,
      gap: 0,
    });
    writer.text(
      `Signed ${formatContractDateTime(signer.signedAt)} · ${signer.fieldCount} ${signer.fieldCount === 1 ? "field" : "fields"} completed · authenticated through CRM sign-in`,
      { indent: 14, color: MUTED, size: 9, gap: 8 },
    );
  });
  if (input.notarized) {
    writer.rule();
    writer.text("Notarization", { bold: true, size: 12, gap: 6 });
    writer.text(
      `Notarized by ${input.notarized.notaryName} (commission no. ${input.notarized.commission}) on ${formatContractDateTime(input.notarized.notarizedAt)}. See the notarial certificate.`,
      { gap: 8 },
    );
  }
  writer.rule();
  writer.text(
    "Each signature was applied in Sanlam Document Hub by the signer named above after signing in through the CRM. The portal keeps the original upload and a full activity log for this reference.",
    { size: 8.5, color: MUTED },
  );
  return Buffer.from(await pdf.save());
}

function drawSeal(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  center: { x: number; y: number },
  notary: { fullName: string; commission: string; jurisdiction: string },
) {
  const outer = 58;
  page.drawCircle({ x: center.x, y: center.y, size: outer, borderColor: SEAL, borderWidth: 2.4 });
  page.drawCircle({
    x: center.x,
    y: center.y,
    size: outer - 6,
    borderColor: SEAL,
    borderWidth: 0.8,
  });
  page.drawCircle({
    x: center.x,
    y: center.y,
    size: outer - 21,
    borderColor: SEAL,
    borderWidth: 0.8,
  });
  const ringText = (text: string, startAngle: number, clockwise: boolean) => {
    const value = encodable(fonts.bold, text.toUpperCase());
    const size = 7.2;
    const radius = outer - 15.5;
    const tracking = 0.8;
    const totalWidth = fonts.bold.widthOfTextAtSize(value, size) + tracking * value.length;
    const sweep = totalWidth / radius;
    // Top text runs clockwise with letter tops outward; bottom text runs anticlockwise with tops inward.
    const baseRadius = clockwise ? radius - size * 0.35 : radius + size * 0.35;
    let angle = clockwise ? startAngle + sweep / 2 : startAngle - sweep / 2;
    for (const character of value) {
      const charWidth = fonts.bold.widthOfTextAtSize(character, size);
      const step = (charWidth + tracking) / radius;
      const mid = clockwise ? angle - step / 2 : angle + step / 2;
      const rotation = clockwise ? mid - Math.PI / 2 : mid + Math.PI / 2;
      // Glyphs are drawn from their left baseline point; step back half a width so each is centred on the arc.
      const x = center.x + baseRadius * Math.cos(mid) - (charWidth / 2) * Math.cos(rotation);
      const y = center.y + baseRadius * Math.sin(mid) - (charWidth / 2) * Math.sin(rotation);
      page.drawText(character, {
        x,
        y,
        size,
        font: fonts.bold,
        color: SEAL,
        rotate: degrees((rotation * 180) / Math.PI),
      });
      angle = clockwise ? angle - step : angle + step;
    }
  };
  ringText(notary.jurisdiction || "Notary Public", Math.PI / 2, true);
  ringText(`Commission No. ${notary.commission}`, -Math.PI / 2, false);
  const centered = (text: string, font: PDFFont, size: number, dy: number) => {
    const value = encodable(font, text);
    let fitted = size;
    while (fitted > 4 && font.widthOfTextAtSize(value, fitted) > (outer - 24) * 2) fitted -= 0.25;
    page.drawText(value, {
      x: center.x - font.widthOfTextAtSize(value, fitted) / 2,
      y: center.y + dy,
      size: fitted,
      font,
      color: SEAL,
    });
  };
  centered("NOTARY", fonts.bold, 9, 9);
  centered(notary.fullName, fonts.bold, 8, -2);
  centered("PUBLIC", fonts.bold, 9, -14);
}

export type NotarizationInput = {
  documentId: string;
  title: string;
  notary: {
    fullName: string;
    commission: string;
    jurisdiction: string;
    commissionExpires: string;
    signaturePng: Uint8Array;
  };
  act: string;
  venue: string;
  idMethod: string;
  notes: string;
  signers: { fullName: string; signedAt: Date }[];
  signedSha256: string;
  notarizedAt: Date;
};

/** Adds a "notarized" footer to every contract page and appends the sealed notarial certificate. */
export async function appendNotarialCertificate(pdfBytes: Uint8Array, input: NotarizationInput) {
  const pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const fonts = await certificateFonts(pdf);
  const footer = `Notarized by ${input.notary.fullName}, Notary Public, commission no. ${input.notary.commission}, on ${formatContractDate(input.notarizedAt)}. Ref ${input.documentId.slice(0, 8).toUpperCase()}. See notarial certificate.`;
  for (const page of pdf.getPages()) {
    const place = placeOnPage(page, { x: 0.04, y: 0.972, width: 0.92, height: 0.018 });
    const size = Math.max(5, Math.min(7, place.viewWidth / 90));
    let value = encodable(fonts.regular, footer);
    while (value.length > 10 && fonts.regular.widthOfTextAtSize(value, size) > place.width)
      value = `${value.slice(0, -4)}…`;
    page.drawText(value, {
      ...place.offset(0, 2),
      size,
      font: fonts.regular,
      color: SEAL,
      rotate: place.rotate,
    });
  }

  const writer = new CertificateWriter(pdf, fonts, "Notarial certificate");
  writer.pair("Notarial act", input.act);
  writer.pair("Venue", input.venue);
  writer.pair("Document", input.title);
  writer.pair("Reference", input.documentId, true);
  writer.rule();
  const names = input.signers.map((signer) => signer.fullName);
  const listed =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  const statement =
    input.act.startsWith("Jurat") || input.act.startsWith("Oath")
      ? `Subscribed and sworn to (or affirmed) before me on ${formatContractDate(input.notarizedAt)} by ${listed}, whose identity was established by: ${input.idMethod}.`
      : input.act.startsWith("Copy")
        ? `I certify that the attached document, bearing the signatures of ${listed}, is a true, exact, complete and unaltered copy of the document presented to me on ${formatContractDate(input.notarizedAt)}.`
        : `On ${formatContractDate(input.notarizedAt)}, before me, the undersigned notary public, ${listed} acknowledged that they signed the attached document voluntarily and for the purposes stated in it. Identity was established by: ${input.idMethod}.`;
  writer.text(statement, { size: 11, gap: 10 });
  if (input.notes.trim()) writer.pair("Notary's notes", input.notes.trim());
  writer.text("Signatures witnessed", { bold: true, gap: 4 });
  for (const signer of input.signers)
    writer.text(`${signer.fullName} — signed ${formatContractDateTime(signer.signedAt)}`, {
      indent: 14,
      size: 9,
      color: MUTED,
      gap: 2,
    });
  writer.y -= 6;
  writer.pair("Fingerprint of the signed document notarized (SHA-256)", input.signedSha256, true);

  writer.ensure(170);
  const top = writer.y;
  const signature = await pdf.embedPng(input.notary.signaturePng);
  const scale = Math.min(190 / signature.width, 54 / signature.height);
  writer.page.drawImage(signature, {
    x: writer.margin,
    y: top - 62,
    width: signature.width * scale,
    height: signature.height * scale,
  });
  writer.page.drawLine({
    start: { x: writer.margin, y: top - 66 },
    end: { x: writer.margin + 220, y: top - 66 },
    thickness: 0.8,
    color: TEXT,
  });
  const lines = [
    [input.notary.fullName, fonts.bold],
    ["Notary Public", fonts.regular],
    [`Commission no. ${input.notary.commission}`, fonts.regular],
    [input.notary.jurisdiction ? `Jurisdiction: ${input.notary.jurisdiction}` : "", fonts.regular],
    [
      input.notary.commissionExpires
        ? `Commission expires ${formatContractDate(new Date(`${input.notary.commissionExpires}T12:00:00Z`))}`
        : "",
      fonts.regular,
    ],
    [`Notarized ${formatContractDateTime(input.notarizedAt)}`, fonts.regular],
  ] as const;
  let lineY = top - 80;
  for (const [value, font] of lines) {
    if (!value) continue;
    writer.page.drawText(encodable(font, value), {
      x: writer.margin,
      y: lineY,
      size: 9,
      font,
      color: TEXT,
    });
    lineY -= 13;
  }
  drawSeal(writer.page, fonts, { x: writer.width - writer.margin - 70, y: top - 74 }, input.notary);
  writer.y = Math.min(lineY, top - 150) - 10;
  return Buffer.from(await pdf.save());
}
