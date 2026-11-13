/**
 * Generates fictitious invoices that exercise tricky layouts. Safe to commit (no real supplier data).
 *   npx tsx tests/invoice-extraction/tools/make-synthetic.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

async function makeInvoice(fileName: string, lines: [number, number, string][]) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [x, y, text] of lines) page.drawText(text, { x, y, size: 10, font });
  writeFileSync(join(out, fileName), await pdf.save());
}

// Named-month service period on the line items, bank details with an account number,
// "Discount Total 0.00" above the real "Amount Due".
await makeInvoice("Synthetic_Kafue_Office_Supplies.pdf", [
  [40, 800, "Kafue Office Supplies Ltd"],
  [40, 786, "Plot 12, Cairo Road, Lusaka"],
  [40, 772, "TPIN: 1009988776"],
  [400, 800, "TAX INVOICE"],
  [400, 786, "Invoice No: KOS-2026-0417"],
  [400, 772, "Invoice Date: 03/11/2026"],
  [400, 758, "Customer No: KOS-4471"],
  [40, 730, "Bill To:"],
  [40, 716, "Sanlam Life Insurance Zambia"],
  [40, 702, "TPIN: 1018813907"],
  [40, 660, "Description"], [330, 660, "Qty"], [380, 660, "Unit Price"], [480, 660, "Amount"],
  [40, 644, "Printer lease 1 Oct - 31 Oct 2026"], [330, 644, "1"], [380, 644, "2,500.00"], [480, 644, "2,500.00"],
  [40, 628, "Toner cartridges"], [330, 628, "4"], [380, 628, "125.00"], [480, 628, "500.00"],
  [380, 600, "Subtotal"], [480, 600, "3,000.00"],
  [380, 586, "Discount Total"], [480, 586, "0.00"],
  [380, 572, "VAT 16%"], [480, 572, "480.00"],
  [380, 558, "Amount Due ZMW"], [480, 558, "3,480.00"],
  [40, 500, "Bank Details"],
  [40, 486, "Bank: Example Bank Zambia"],
  [40, 472, "Account Name: Kafue Office Supplies Ltd"],
  [40, 458, "Account Number: 0123456789"],
  [40, 444, "Branch: Lusaka Main"],
]);
console.log("Synthetic invoices written to", out);
