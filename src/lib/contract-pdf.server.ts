/**
 * PDF work for contracts: placing signatures/initials/dates in the boxes the sender drew, the notary's handwritten
 * initials, and the certificate of completion. Pure functions over PDF bytes so they can be tested without the
 * database.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import { initialsOf, type ContractFieldInput, type ContractFieldKind } from "./contract-types";

export { initialsOf };

const INK = rgb(0.08, 0.16, 0.36);
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

// Homemade Apple (Apache 2.0, see public/fonts) gives initials a pen-on-paper look.
const HANDWRITING_FONT_PATH = join(process.cwd(), "public", "fonts", "HomemadeApple-Regular.woff");
let handwritingFontBytes: Buffer | null = null;

async function embedHandwritingFont(pdf: PDFDocument) {
  handwritingFontBytes ??= readFileSync(HANDWRITING_FONT_PATH);
  pdf.registerFontkit(fontkit);
  return await pdf.embedFont(handwritingFontBytes, { subset: true });
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
  const script = await embedHandwritingFont(pdf);
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
      `Notarized by ${input.notarized.notaryName} (commission no. ${input.notarized.commission}) on ${formatContractDateTime(input.notarized.notarizedAt)}, who initialled every page (${initialsOf(input.notarized.notaryName)}).`,
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

/**
 * Notarizes by writing the notary's initials (e.g. "KM") in handwriting-style ink in the bottom-right corner of
 * every page of the contract. Call it before the certificate of completion is added, so that page stays clean.
 */
type PageBox = { page: number; x: number; y: number; width: number; height: number };

/**
 * Where the notary's initials go on one page: the bottom-right corner, moved up (then left) when a signer's box
 * already sits there, e.g. an "Initials: ____" line in the corner.
 */
export function notaryCornerBox(page: number, occupied: PageBox[]) {
  const size = { width: 0.15, height: 0.06 };
  const taken = occupied.filter((box) => box.page === page);
  const overlaps = (x: number, y: number) =>
    taken.some(
      (box) =>
        x < box.x + box.width + 0.01 &&
        x + size.width > box.x - 0.01 &&
        y < box.y + box.height + 0.01 &&
        y + size.height > box.y - 0.01,
    );
  const candidates: { x: number; y: number }[] = [];
  for (let step = 0; step < 6; step += 1) candidates.push({ x: 0.8, y: 0.905 - step * 0.07 });
  for (let step = 1; step < 4; step += 1) candidates.push({ x: 0.8 - step * 0.17, y: 0.905 });
  const spot = candidates.find(({ x, y }) => !overlaps(x, y)) ?? candidates[0]!;
  return { ...spot, ...size };
}

export async function stampNotaryInitials(
  pdfBytes: Uint8Array,
  notaryName: string,
  occupied: PageBox[] = [],
) {
  const pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const font = await embedHandwritingFont(pdf);
  const initials = encodable(font, initialsOf(notaryName));
  pdf.getPages().forEach((page, index) => {
    const place = placeOnPage(page, notaryCornerBox(index, occupied));
    // About 6 mm tall on an A4 page, never wider than the corner box.
    let size = Math.min(place.viewWidth * 0.038, place.height);
    while (size > 6 && font.widthOfTextAtSize(initials, size) > place.width) size -= 0.5;
    const width = font.widthOfTextAtSize(initials, size);
    page.drawText(initials, {
      // Right-aligned in the corner box, with a slight upward slant like a quick pen mark.
      ...place.offset(place.width - width, place.height * 0.2),
      size,
      font,
      color: INK,
      rotate: degrees(place.rotate.angle + 4),
    });
  });
  return Buffer.from(await pdf.save());
}
