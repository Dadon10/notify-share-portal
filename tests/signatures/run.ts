/**
 * Signature placement test (no real signatures or invoices needed; everything here is generated).
 *
 *   npm run test:signatures
 *
 * Checks that signature images are cleaned or rejected correctly, and that a PR can be generated and
 * signed through the whole chain with every signature landing on the right line.
 */
import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addSignatureToRequisition,
  buildPaymentRequisition,
  convertRequisitionDocxToPdf,
  prepareSignatureImage,
} from "../../src/lib/invoice-pr.server";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

function drawSignature(options: { background: string | null; ink: string; width?: number; height?: number }) {
  const width = options.width ?? 600;
  const height = options.height ?? 200;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, width, height);
  }
  context.strokeStyle = options.ink;
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(width * 0.1, height * 0.7);
  for (let x = 0; x <= 40; x += 1) context.lineTo(width * (0.1 + x * 0.018), height * (0.5 + Math.sin(x / 2.5) * 0.25));
  context.stroke();
  return canvas.toBuffer("image/png");
}

function drawScreenshot() {
  const canvas = createCanvas(540, 1170);
  const context = canvas.getContext("2d");
  context.fillStyle = "#0b141a";
  context.fillRect(0, 0, 540, 1170);
  for (let row = 0; row < 18; row += 1) {
    context.fillStyle = row % 2 ? "#005c4b" : "#202c33";
    context.fillRect(row % 2 ? 160 : 20, 40 + row * 62, 360, 48);
  }
  return canvas.toBuffer("image/png");
}

async function accepts(bytes: Buffer) {
  try {
    await prepareSignatureImage(bytes);
    return true;
  } catch {
    return false;
  }
}

console.log("Signature images");
check("dark ink on white paper is accepted", await accepts(drawSignature({ background: "#ffffff", ink: "#111111" })));
check("white ink on a dark background is accepted", await accepts(drawSignature({ background: "#2a2a2a", ink: "#f5f5f5" })));
check("transparent PNG signature is accepted", await accepts(drawSignature({ background: null, ink: "#000000" })));
check("phone screenshot is rejected", !(await accepts(drawScreenshot())));
check("blank image is rejected", !(await accepts(createCanvas(400, 150).toBuffer("image/png"))));

console.log("Signing a PR through the whole chain");
const here = dirname(fileURLToPath(import.meta.url));
const invoice = readFileSync(join(here, "..", "invoice-extraction", "fixtures", "Synthetic_Kafue_Office_Supplies.pdf"));
const signature = drawSignature({ background: "#ffffff", ink: "#1a1a1a" });
const people = { preparer: "Test Preparer", approverA: "First Approver", approverB: "Second Approver", financePreparer: "Finance Preparer", financeApprover: "Finance Approver" };

async function signatureTables(docx: Buffer) {
  const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string");
  return [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)]
    .map((match) => match[0])
    .filter((table) => table.includes('w:tblCaption w:val="PR signature:'))
    .map((table) => ({
      slot: /PR signature: ([a-z-]+)/.exec(table)?.[1] ?? "",
      name: /<w:tblDescription w:val="([^"]*)"/.exec(table)?.[1] ?? "",
      signed: table.includes("<w:drawing>"),
    }));
}

for (const approvers of [[people.approverA], [people.approverA, people.approverB]]) {
  const built = await buildPaymentRequisition(invoice, "invoice.pdf", {
    expenditureItem: "Stationery",
    preparedByName: people.preparer,
    approvedByName: approvers[0],
    approvedByNames: approvers,
    financePreparerName: people.financePreparer,
    financeApproverName: people.financeApprover,
  }, { submitter: { mimeType: "image/png", bytes: signature } });
  let docx = Buffer.from(built.fileData, "base64");
  let tables = await signatureTables(docx);
  check(`${approvers.length} approver(s): one signature line per person`, tables.length === 3 + approvers.length, tables.map((t) => t.name).join(", "));
  check(`${approvers.length} approver(s): only the preparer has signed at submission`, tables.filter((t) => t.signed).map((t) => t.slot).join() === "requisition-preparer");
  const chain: [string, "approval" | "finance-approver" | "finance-preparer"][] = [
    ...approvers.map((name) => [name, "approval"] as [string, "approval"]),
    [people.financeApprover, "finance-approver"],
    [people.financePreparer, "finance-preparer"],
  ];
  for (const [name, target] of chain) docx = await addSignatureToRequisition(docx, name, "image/png", signature, target);
  tables = await signatureTables(docx);
  check(`${approvers.length} approver(s): every line signed after the chain`, tables.every((t) => t.signed) && tables.length === 3 + approvers.length);
  let refused = false;
  try {
    await addSignatureToRequisition(docx, people.financePreparer, "image/png", signature, "finance-preparer");
  } catch {
    refused = true;
  }
  check(`${approvers.length} approver(s): a second finance signature is refused`, refused);
  if (approvers.length === 1) {
    const pages = (await PDFDocument.load(convertRequisitionDocxToPdf(docx, "signed.docx"))).getPageCount();
    check("single approver: signed PR fits on one page", pages === 1, `${pages} page(s)`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll signature checks passed");
process.exit(failures ? 1 : 0);
