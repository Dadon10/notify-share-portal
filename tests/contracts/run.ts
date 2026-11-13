/**
 * Contract signing test (everything is generated; no real contracts or signatures needed).
 *
 *   npm run test:contracts
 *
 * Checks that signature/initials/date/name boxes land where they were drawn (also on rotated pages), and that the
 * notarial certificate and certificate of completion are appended.
 */
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendCompletionCertificate,
  appendNotarialCertificate,
  formatContractDate,
  initialsOf,
  inspectContractPdf,
  placeOnPage,
  sha256,
  stampContractFields,
} from "../../src/lib/contract-pdf.server";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

function signaturePng() {
  const canvas = createCanvas(500, 160);
  const context = canvas.getContext("2d");
  context.strokeStyle = "#14285c";
  context.lineWidth = 6;
  context.beginPath();
  context.moveTo(30, 120);
  context.bezierCurveTo(120, 10, 200, 150, 300, 60);
  context.bezierCurveTo(360, 20, 420, 140, 470, 80);
  context.stroke();
  return canvas.toBuffer("image/png");
}

async function makeContract() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const rotation of [0, 90, 180, 270]) {
    const page = pdf.addPage([595, 842]);
    page.setRotation(degrees(rotation));
    page.drawText(`Page rotated ${rotation}`, { x: 60, y: 760, size: 14, font });
  }
  return Buffer.from(await pdf.save());
}

async function textOf(bytes: Uint8Array) {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

async function main() {
  const outDir = join(process.cwd(), "tests", "contracts", "output");
  mkdirSync(outDir, { recursive: true });

  console.log("Placement maths");
  const geometry = await PDFDocument.create();
  for (const rotation of [0, 90, 180, 270]) {
    const page = geometry.addPage([600, 800]);
    page.setRotation(degrees(rotation));
    const box = placeOnPage(page, { x: 0, y: 0, width: 0.5, height: 0.25 });
    const sideways = rotation % 180 !== 0;
    check(
      `rotation ${rotation}: displayed size`,
      box.viewWidth === (sideways ? 800 : 600) && box.viewHeight === (sideways ? 600 : 800),
    );
    // The box's top-left corner as displayed must map to the matching corner of the unrotated page.
    const topLeft = box.offset(0, box.height);
    const expected = {
      0: { x: 0, y: 800 },
      90: { x: 0, y: 0 },
      180: { x: 600, y: 0 },
      270: { x: 600, y: 800 },
    }[rotation as 0 | 90 | 180 | 270];
    check(
      `rotation ${rotation}: top-left corner`,
      Math.abs(topLeft.x - expected.x) < 0.01 && Math.abs(topLeft.y - expected.y) < 0.01,
      JSON.stringify(topLeft),
    );
  }

  console.log("Validation");
  const contract = await makeContract();
  check("reads page count", (await inspectContractPdf(contract)).pageCount === 4);
  let rejected = false;
  try {
    await inspectContractPdf(Buffer.from("not a pdf"));
  } catch {
    rejected = true;
  }
  check("rejects a file that is not a PDF", rejected);

  console.log("Stamping");
  const signedAt = new Date("2026-11-13T09:30:00Z");
  const fields = [0, 1, 2, 3].flatMap((page) => [
    { kind: "signature" as const, page, x: 0.1, y: 0.7, width: 0.3, height: 0.07 },
    { kind: "name" as const, page, x: 0.1, y: 0.78, width: 0.3, height: 0.03 },
    { kind: "date" as const, page, x: 0.55, y: 0.78, width: 0.25, height: 0.03 },
    { kind: "initials" as const, page, x: 0.85, y: 0.92, width: 0.08, height: 0.04 },
  ]);
  const stamped = await stampContractFields(contract, fields, {
    fullName: "Chanda Mwila-Banda",
    signaturePng: signaturePng(),
    signedAt,
  });
  const stampedText = await textOf(stamped);
  check(
    "name written on every page",
    (stampedText.match(/Chanda Mwila-Banda/g) ?? []).length === 4,
  );
  check(
    "date written",
    stampedText.includes(formatContractDate(signedAt)),
    formatContractDate(signedAt),
  );
  check(
    "initials written",
    stampedText.includes(initialsOf("Chanda Mwila-Banda")),
    initialsOf("Chanda Mwila-Banda"),
  );
  check("page count unchanged by signing", (await inspectContractPdf(stamped)).pageCount === 4);
  const unicode = await stampContractFields(contract, fields.slice(1, 2), {
    fullName: "Ŝtefan Ñúñez",
    signaturePng: signaturePng(),
    signedAt,
  });
  check("names outside Latin-1 do not break signing", unicode.length > 0);
  writeFileSync(join(outDir, "stamped.pdf"), stamped);

  console.log("Notarization and completion");
  const notarized = await appendNotarialCertificate(stamped, {
    documentId: "6f1c2b9e-0000-4000-8000-000000000000",
    title: "Office lease agreement",
    notary: {
      fullName: "Mutale Phiri",
      commission: "NP-2291",
      jurisdiction: "Republic of Zambia",
      commissionExpires: "2028-03-31",
      signaturePng: signaturePng(),
    },
    act: "Acknowledgment",
    venue: "Lusaka, Zambia",
    idMethod: "National registration card",
    notes: "",
    signers: [{ fullName: "Chanda Mwila-Banda", signedAt }],
    signedSha256: sha256(stamped),
    notarizedAt: signedAt,
  });
  const completed = await appendCompletionCertificate(notarized, {
    documentId: "6f1c2b9e-0000-4000-8000-000000000000",
    title: "Office lease agreement",
    senderName: "Legal team",
    sentAt: signedAt,
    originalSha256: sha256(contract),
    signers: [
      { fullName: "Chanda Mwila-Banda", email: "chanda@example.com", signedAt, fieldCount: 16 },
    ],
    notarized: { notaryName: "Mutale Phiri", commission: "NP-2291", notarizedAt: signedAt },
    completedAt: signedAt,
  });
  const completedText = await textOf(completed);
  check("notarial certificate page added", completedText.includes("Notarial certificate"));
  check("acknowledgment wording", /acknowledged that they signed/.test(completedText));
  check(
    "notarized footer on contract pages",
    (completedText.match(/Notarized by Mutale Phiri/g) ?? []).length >= 4,
  );
  check("completion certificate page added", completedText.includes("Certificate of completion"));
  check(
    "original fingerprint recorded",
    completedText.replace(/\s/g, "").includes(sha256(contract)),
  );
  check("two certificate pages appended", (await inspectContractPdf(completed)).pageCount === 6);
  writeFileSync(join(outDir, "completed.pdf"), completed);

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll contract checks passed.");
  console.log(`Generated PDFs: ${outDir}`);
  if (failures) process.exit(1);
}

void main();
