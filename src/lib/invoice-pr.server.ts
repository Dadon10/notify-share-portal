import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import JSZip from "jszip";
import { PDFParse } from "pdf-parse";
import { getData as getPdfWorkerData } from "pdf-parse/worker";
import { PDFDocument } from "pdf-lib";

PDFParse.setWorker(getPdfWorkerData());

type InvoiceFields = {
  invoiceNumber: string;
  invoiceDate: string;
  billingPeriod: string;
  accountId: string | null;
  amount: number;
  currency: string;
  payee: string;
  service: string;
  department: string;
  expenditureItem: string;
  budgeted: "Y" | "N";
  businessMotivation: string;
  paymentPurpose: string;
  modeOfPayment: "Cash" | "Cheque" | "EFT" | "TT" | "Mobile";
  preparedByName: string;
  approvedByName: string;
  financePreparerName: string;
  financeApproverName: string;
  /** Departmental approvers in signing order; one signature block is laid out for each. */
  approverNames: string[];
  uncertainFields: string[];
  extractionWarnings: string[];
  /** Supplier tax numbers (TPIN / VAT reg) found outside the customer block; used to recognise returning suppliers. */
  taxIds: string[];
  /** Short, user-facing note per field saying where the value was found. */
  sources: Partial<Record<string, string>>;
};

/** The final field values a requisition is generated from (after the user's edits). */
export type RequisitionFields = InvoiceFields;

/** Re-dates a remembered description, e.g. "Bulk SMS (August '26)" -> "Bulk SMS (September '26)". */
export function retargetPaymentPurpose(purpose: string, billingPeriod: string) {
  const base = purpose.replace(/\s*\([A-Z][a-z]+ '\d{2}\)\s*$/, "").trim();
  const month = monthLabelFromPeriod(billingPeriod);
  return month ? `${base} (${month})` : base;
}

type Template = { fileName: string; accountId?: string; payee: string; service: string };
type SignatureImage = { mimeType: string; bytes: Buffer } | null;
type RequisitionSignatures = { submitter: SignatureImage };

const templates: Template[] = [
  { fileName: "PR Form - Airtel [Bulk SMS] 20260817.docx", accountId: "PE0518675293", payee: "Airtel Networks Zambia PLC", service: "Bulk SMS" },
  { fileName: "PR Form - Infratel Corporation [Azure] 20260916.docx", payee: "Infratel Corporation Limited", service: "Azure" },
];

export type InvoiceOverrides = {
  invoiceNumber?: string | undefined;
  invoiceDate?: string | undefined;
  billingPeriod?: string | undefined;
  accountId?: string | undefined;
  amount?: number | undefined;
  currency?: string | undefined;
  payee?: string | undefined;
  department?: string | undefined;
  expenditureItem?: string | undefined;
  budgeted?: "Y" | "N" | undefined;
  businessMotivation?: string | undefined;
  paymentPurpose?: string | undefined;
  modeOfPayment?: "Cash" | "Cheque" | "EFT" | "TT" | "Mobile" | undefined;
  preparedByName?: string | undefined;
  approvedByName?: string | undefined;
  financePreparerName?: string | undefined;
  financeApproverName?: string | undefined;
  approvedByNames?: string[] | undefined;
};

export type InvoiceSuggestion = {
  invoiceNumber: string;
  invoiceDate: string;
  billingPeriod: string;
  accountId: string;
  payee: string;
  amount: string;
  currency: string;
  paymentPurpose: string;
  uncertainFields: string[];
  extractionWarnings: string[];
  taxIds: string[];
  sources: Partial<Record<string, string>>;
};

export async function suggestInvoiceFields(pdfBytes: Buffer, fileName: string): Promise<InvoiceSuggestion> {
  const fields = await readInvoice(pdfBytes, fileName, {});
  const values = {
    invoiceNumber: fields.invoiceNumber,
    invoiceDate: fields.invoiceDate,
    billingPeriod: fields.billingPeriod,
    accountId: fields.accountId ?? "",
    payee: fields.payee,
    amount: Number.isFinite(fields.amount) ? fields.amount.toFixed(2) : "",
    currency: fields.currency,
    paymentPurpose: fields.paymentPurpose,
  };
  const uncertainFields = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  uncertainFields.push(...fields.uncertainFields);
  return {
    ...values,
    uncertainFields: [...new Set(uncertainFields)],
    extractionWarnings: fields.extractionWarnings,
    taxIds: fields.taxIds,
    sources: fields.sources,
  };
}

export type RequisitionSource = {
  /** Manual PRs skip invoice parsing: every field comes from the user's entries. */
  manual?: boolean | undefined;
  mimeType?: string | undefined;
};

export async function buildPaymentRequisition(
  pdfBytes: Buffer,
  fileName: string,
  overrides: InvoiceOverrides = {},
  signatures: RequisitionSignatures = { submitter: null },
  source: RequisitionSource = {},
) {
  const attachmentPdf = source.manual ? await attachmentToPdf(pdfBytes, fileName, source.mimeType ?? "") : pdfBytes;
  const fields = source.manual ? manualInvoiceFields(overrides, fileName) : await readInvoice(pdfBytes, fileName, overrides);
  const missing = [
    ["invoice number", fields.invoiceNumber],
    ["invoice date", fields.invoiceDate],
    ["supplier", fields.payee],
    ["currency", fields.currency],
    ["expenditure item", fields.expenditureItem],
    ["payment details", fields.paymentPurpose],
  ].find(([, value]) => !value);
  if (missing) throw new Error(`Complete the ${missing[0]} before generating the payment requisition.`);
  if (!Number.isFinite(fields.amount)) throw new Error("Enter a valid invoice amount before generating the payment requisition.");
  if (fields.budgeted === "N" && !fields.businessMotivation) throw new Error("Enter the business motivation before generating the payment requisition.");
  const template = findTemplate(fields);
  const templateBytes = readFileSync(join(process.cwd(), "public", "templates", template.fileName));
  const dateStamp = fields.invoiceDate.split("/").reverse().join("");
  const manualSupplier = fields.payee.replace(/[^a-zA-Z0-9 &.-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  // "PR Form" prefix is required: signing locates the requisition files by that name.
  const generatedName = source.manual
    ? `PR Form - ${manualSupplier || "Supplier"} ${dateStamp}.docx`
    : `PR Form - Supplier ${template.service || "Payment"} ${dateStamp}.docx`;
  const docxFileData = await editTemplate(templateBytes, template, fields, signatures);
  const requisitionPdf = Buffer.from(createPdfPreview(generatedName, Buffer.from(docxFileData, "base64")), "base64");
  const previewPdf = (await appendInvoiceToRequisitionPdf(requisitionPdf, attachmentPdf)).toString("base64");
  return {
    fileName: generatedName,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileData: docxFileData,
    previewFileName: generatedName.replace(/\.docx$/i, ".pdf"),
    previewMimeType: "application/pdf",
    previewFileData: previewPdf,
    attachmentPdf,
    fields,
  };
}

/** Accepts a PDF or a PNG/JPEG image and returns PDF bytes that can be appended behind the PR. */
export async function attachmentToPdf(bytes: Buffer, fileName: string, mimeType: string) {
  const lowerName = fileName.toLowerCase();
  const isPdf = mimeType === "application/pdf" || lowerName.endsWith(".pdf");
  const isPng = mimeType === "image/png" || lowerName.endsWith(".png");
  const isJpeg = mimeType === "image/jpeg" || /\.jpe?g$/.test(lowerName);
  if (isPdf) {
    try {
      await PDFDocument.load(bytes);
    } catch {
      throw new Error("The attached PDF could not be opened. Check that it is not password-protected or damaged.");
    }
    return bytes;
  }
  if (!isPng && !isJpeg) throw new Error("Attach a PDF, PNG or JPEG file to the requisition.");
  const pdf = await PDFDocument.create();
  let image;
  try {
    image = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  } catch {
    throw new Error("The attached image could not be read. Try saving it again as PNG or JPEG.");
  }
  // A4 portrait, or landscape for wide images, with the image fitted inside a margin.
  const landscape = image.width > image.height;
  const [pageWidth, pageHeight] = landscape ? [841.89, 595.28] : [595.28, 841.89];
  const margin = 36;
  const scale = Math.min((pageWidth - margin * 2) / image.width, (pageHeight - margin * 2) / image.height, 1);
  const width = image.width * scale;
  const height = image.height * scale;
  const page = pdf.addPage([pageWidth, pageHeight]);
  page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
  return Buffer.from(await pdf.save());
}

function manualInvoiceFields(overrides: InvoiceOverrides, fileName: string): InvoiceFields {
  const invoiceDate = overrides.invoiceDate ? normalizeInvoiceDate(overrides.invoiceDate) : "";
  if (overrides.invoiceDate && !invoiceDate) throw new Error("Enter the invoice date as DD/MM/YYYY.");
  const payee = overrides.payee?.trim() ?? "";
  const paymentPurpose = overrides.paymentPurpose?.trim() ?? "";
  return {
    invoiceNumber: overrides.invoiceNumber?.trim() ?? "",
    invoiceDate,
    billingPeriod: overrides.billingPeriod?.trim() ?? "",
    accountId: overrides.accountId?.trim() || null,
    amount: overrides.amount ?? Number.NaN,
    currency: overrides.currency?.trim().toUpperCase() ?? "",
    payee,
    service: inferService(`${payee} ${paymentPurpose}`, fileName),
    department: overrides.department?.trim() || "",
    expenditureItem: overrides.expenditureItem?.trim() || "",
    budgeted: overrides.budgeted === "N" ? "N" : "Y",
    businessMotivation: overrides.businessMotivation?.trim() || "",
    paymentPurpose,
    modeOfPayment: overrides.modeOfPayment ?? "EFT",
    preparedByName: overrides.preparedByName?.trim() || "CRM workspace",
    approvedByName: overrides.approvedByName?.trim() || "Approver",
    financePreparerName: overrides.financePreparerName?.trim() || "",
    financeApproverName: overrides.financeApproverName?.trim() || "",
    approverNames: approverNamesFrom(overrides),
    uncertainFields: [],
    extractionWarnings: [],
    taxIds: [],
    sources: {},
  };
}

export async function appendInvoiceToRequisitionPdf(requisitionPdf: Buffer, invoicePdf: Buffer) {
  const [requisition, invoice] = await Promise.all([
    PDFDocument.load(requisitionPdf),
    PDFDocument.load(invoicePdf),
  ]);
  const combined = await PDFDocument.create();
  const requisitionPages = await combined.copyPages(requisition, requisition.getPageIndices());
  const invoicePages = await combined.copyPages(invoice, invoice.getPageIndices());
  for (const page of [...requisitionPages, ...invoicePages]) combined.addPage(page);
  return Buffer.from(await combined.save());
}

function createPdfPreview(docxFileName: string, docxBytes: Buffer) {
  return convertRequisitionDocxToPdf(docxBytes, docxFileName).toString("base64");
}

async function readInvoice(bytes: Buffer, fileName: string, overrides: InvoiceOverrides): Promise<InvoiceFields> {
  const parser = new PDFParse({ data: bytes });
  let result: Awaited<ReturnType<typeof parser.getText>>;
  let tableResult: Awaited<ReturnType<typeof parser.getTable>> | undefined;
  let tableExtractionFailed = false;
  try {
    result = await parser.getText();
    try {
      tableResult = await parser.getTable();
    } catch {
      tableExtractionFailed = true;
    }
  } finally {
    await parser.destroy();
  }
  const tableRows = tableResult?.pages.flatMap((page) => page.tables.flat()) ?? [];
  const pages = result.pages.map((page) => page.text);
  const text = pages.join("\n").replace(/\r/g, "").replace(/[ \t]+/g, " ");
  // Supplier references and dates belong to the invoice header. Stop before
  // Sold To / ZRA fiscal data so SDC receipt identifiers can never win.
  const textForLabels = text.replace(/\s+/g, " ");
  const header = textForLabels.split(/\b(?:Sold\s*To|ZRA\s+Receipt\s+No\.?|SDC\s+Info)\b/i)[0] ?? "";
  const invoiceRow = extractInvoiceHeaderRow(tableRows);
  const detectedInvoiceNumber = invoiceRow?.invoiceNumber ?? first(header, [
    /\b(?:Tax\s+)?Invoice\s*(?:Number|No\.?|#|ID)\s*:?\s*([A-Z0-9][A-Z0-9./_-]*)/i,
    /\b(?:Document|Doc|Bill)\s*(?:Number|No\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9./_-]*)/i,
  ]) ?? first(textForLabels, [/\b(RC\d{8,})\b/i]);
  const invoiceNumber = overrides.invoiceNumber ?? (detectedInvoiceNumber && !isZraFiscalInvoiceNumber(detectedInvoiceNumber) ? detectedInvoiceNumber : null);
  const rawDate = overrides.invoiceDate ?? invoiceRow?.invoiceDate ?? extractInvoiceDate(text, tableRows);
  const amountMatch = findInvoiceTotal(text, tableRows);
  const payee = overrides.payee ?? inferPayee(text, fileName) ?? supplierFromHeader(text);
  const accountId = overrides.accountId ?? invoiceRow?.accountId ?? extractCustomerAccountId(text, tableRows) ?? null;
  const inferredPeriod = inferInvoicePeriod(text, fileName);
  const billingPeriod = overrides.billingPeriod ?? inferredPeriod.value ?? "";
  const extractedAmount = amountMatch ? parseInvoiceAmount(amountMatch.amount) : Number.NaN;
  const amount = overrides.amount !== undefined ? overrides.amount : extractedAmount;
  const currency = overrides.currency?.toUpperCase() || extractInvoiceCurrency(text, tableRows, amountMatch, invoiceRow);
  const invoiceDate = rawDate ? normalizeInvoiceDate(rawDate) : "";
  const inferredPurpose = inferPaymentPurpose(text, fileName, pages, billingPeriod);
  // Never offer junk such as "48.30 Office, 2" as the payment description; leave it blank for the user instead.
  const paymentPurpose = overrides.paymentPurpose?.trim() || (looksLikeDescription(inferredPurpose) ? inferredPurpose : "");
  const sources: Partial<Record<string, string>> = {};
  if (!overrides.invoiceNumber && invoiceNumber) {
    sources["invoiceNumber"] = invoiceRow?.invoiceNumber
      ? "From the invoice header table"
      : /^RC\d{8,}$/i.test(invoiceNumber)
        ? "Taken from the ZRA receipt number (RC…)"
        : "Found next to the invoice number label";
  }
  if (!overrides.invoiceDate && invoiceDate) sources["invoiceDate"] = invoiceRow?.invoiceDate ? "From the invoice header table" : "Found next to the invoice date label";
  if (!overrides.accountId && accountId) sources["accountId"] = invoiceRow?.accountId ? "From the invoice header table" : "Found next to the customer account label";
  if (!overrides.payee && payee) sources["payee"] = "From the supplier details at the top of the invoice";
  if (overrides.amount === undefined && amountMatch) {
    sources["amount"] = amountMatch.detached
      ? "Worked out from the totals block (the figure equal to subtotal + VAT)"
      : `Found next to "${amountMatch.label ?? "Total"}"`;
  }
  if (!overrides.currency && currency) sources["currency"] = "From the currency shown on the invoice";
  if (!overrides.billingPeriod && billingPeriod) {
    sources["billingPeriod"] = inferredPeriod.source === "line-items"
      ? "From the service dates on the invoice lines"
      : inferredPeriod.source === "title"
        ? "Assumed to be the whole month named on the invoice"
        : "Found next to the billing period label";
  }
  if (!overrides.paymentPurpose && paymentPurpose) sources["paymentPurpose"] = "Built from the services listed on the invoice";
  const extractionWarnings: string[] = [];
  const uncertainFields: string[] = [];
  const warn = (field: string, message: string) => {
    extractionWarnings.push(message);
    uncertainFields.push(field);
  };
  if (tableExtractionFailed) extractionWarnings.push("Invoice tables could not be read; text-based extraction was used instead.");
  if (!text.trim()) extractionWarnings.push("This PDF has no selectable text. Enter the invoice details manually.");
  if (!invoiceNumber && !detectedInvoiceNumber) warn("invoiceNumber", "Invoice number could not be read from the supplier invoice header.");
  if (!invoiceNumber && detectedInvoiceNumber && isZraFiscalInvoiceNumber(detectedInvoiceNumber)) {
    warn("invoiceNumber", "The detected number is a ZRA fiscal receipt identifier, not the supplier invoice number.");
  }
  if (invoiceNumber && isZraFiscalInvoiceNumber(invoiceNumber)) warn("invoiceNumber", "The detected invoice number matches a ZRA fiscal receipt pattern.");
  if (!invoiceDate) warn("invoiceDate", "Invoice date could not be read.");
  if (!billingPeriod) warn("billingPeriod", "Billing period could not be found in the invoice or its title.");
  else if (inferredPeriod.inferred && !overrides.billingPeriod) {
    warn("billingPeriod", inferredPeriod.source === "line-items"
      ? "Billing period taken from the service dates on the invoice lines; please confirm."
      : "Billing period inferred from the invoice title; please confirm.");
  }
  if (!accountId) warn("accountId", "Account or Customer No. could not be read.");
  if (!payee) warn("payee", "Supplier name could not be identified in the invoice issuer block.");
  if (!Number.isFinite(extractedAmount)) warn("amount", "Final grand total could not be read from an explicit total-amount label.");
  else if (!amountMatch || !textForLabels.includes(amountMatch.amount)) warn("amount", "The selected total does not appear verbatim in the extracted invoice text.");
  else if (extractedAmount <= 0) warn("amount", `The total was read as ${extractedAmount.toFixed(2)}, which cannot be the amount due. Enter the invoice total.`);
  else if (amountMatch.detached) warn("amount", "In this PDF the total's label and value are separated, so the amount was matched from nearby figures. Please confirm it.");
  if (amountMatch?.subtotal !== undefined && Number.isFinite(extractedAmount) && extractedAmount > 0 && extractedAmount + 0.05 < amountMatch.subtotal) {
    warn("amount", `The total (${extractedAmount.toFixed(2)}) is smaller than the subtotal (${amountMatch.subtotal.toFixed(2)}).`);
  }
  if (amountMatch) {
    const subtotal = amountMatch.subtotal ?? extractLabeledAmount(textForLabels, /\b(?:VAT\s+Exclusive\s+Amount|Subtotal)\b/i);
    const vat = amountMatch.vat ?? extractLabeledAmount(textForLabels, /\bVAT\s*(?:@\s*)?(?:\d+(?:\.\d+)?\s*%)?\s+(?!Inclusive|Exclusive)(?:ZMW|USD)?\s*([\d,]+\.\d{2})/i, true);
    if (subtotal !== null && vat !== null && Math.abs(subtotal + vat - extractedAmount) > 0.05) {
      warn("amount", `Subtotal plus VAT (${(subtotal + vat).toFixed(2)}) does not reconcile to the grand total (${extractedAmount.toFixed(2)}).`);
    }
  }
  if (!currency) warn("currency", "ISO currency code could not be read.");
  if (!paymentPurpose) warn("paymentPurpose", "What the payment is for could not be worked out from the invoice lines.");
  return {
    invoiceNumber: invoiceNumber ?? "",
    invoiceDate,
    billingPeriod,
    accountId,
    amount,
    currency,
    payee: payee?.trim() ?? "",
    service: inferService(text, fileName),
    department: overrides.department?.trim() || "",
    expenditureItem: overrides.expenditureItem?.trim() || "",
    budgeted: overrides.budgeted === "N" ? "N" : "Y",
    businessMotivation: overrides.businessMotivation?.trim() || "",
    paymentPurpose,
    modeOfPayment: overrides.modeOfPayment ?? "EFT",
    preparedByName: overrides.preparedByName?.trim() || "CRM workspace",
    approvedByName: overrides.approvedByName?.trim() || "Approver",
    financePreparerName: overrides.financePreparerName?.trim() || "",
    financeApproverName: overrides.financeApproverName?.trim() || "",
    approverNames: approverNamesFrom(overrides),
    uncertainFields: [...new Set(uncertainFields)],
    extractionWarnings,
    taxIds: extractSupplierTaxIds(text),
    sources,
  };
}

/**
 * Supplier TPIN / VAT registration numbers. Numbers in the customer ("Sold To" / "Bill To") block,
 * or labelled as the customer's, belong to Sanlam and are skipped.
 */
function extractSupplierTaxIds(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const ids: string[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /\b(?:TPIN|VAT\s*Reg(?:istration)?\.?\s*(?:No\.?|Number)?|Tax\s*(?:Payer\s*)?(?:ID|No\.?|Number))\s*[:.#-]?\s*([0-9][0-9/ -]{5,}[0-9])/i.exec(line);
    const value = match?.[1]?.replace(/[\s-]/g, "");
    if (!value) continue;
    if (/customer|client|buyer|purchaser/i.test(line)) continue;
    const recent = lines.slice(Math.max(0, index - 12), index).join(" ");
    if (/\b(?:sold\s*to|bill(?:ed)?\s*to|invoice\s*to|ship\s*to|customer\s+details)\b|sanlam/i.test(recent)) continue;
    if (!ids.includes(value)) ids.push(value);
  }
  return ids;
}

function findTemplate(fields: InvoiceFields) {
  const normalizedPayee = normalize(fields.payee);
  const normalizedService = normalize(fields.service);
  const accountMatch = fields.accountId && templates.find((template) => template.accountId === fields.accountId);
  if (accountMatch) return accountMatch;

  const scoredTemplates = templates.map((template) => {
    const templatePayee = normalize(template.payee);
    const templateService = normalize(template.service);
    const payeeScore = invoiceMatchScore(normalizedPayee, templatePayee);
    const serviceScore = invoiceMatchScore(normalizedService, templateService);
    const accountScore = fields.accountId && template.accountId && fields.accountId === template.accountId ? 100 : 0;
    const total = accountScore + payeeScore + serviceScore;
    return { template, total };
  });

  const bestMatch = scoredTemplates.sort((a, b) => b.total - a.total)[0];
  if (bestMatch && bestMatch.total >= 25) return bestMatch.template;

  // Approved supplier files share the Sanlam requisition layout. Keep one as
  // the standard form and replace its supplier-specific sample values below.
  const standard = templates.find((template) => template.fileName.includes("Infratel"))!;
  return standard;
}

function invoiceMatchScore(invoiceValue: string, templateValue: string) {
  if (!invoiceValue || !templateValue) return 0;
  if (invoiceValue.includes(templateValue) || templateValue.includes(invoiceValue)) return 60;

  const invoiceTokens = new Set(wordTokens(invoiceValue));
  const templateTokens = new Set(wordTokens(templateValue));
  const overlap = [...invoiceTokens].filter((token) => templateTokens.has(token)).length;
  if (overlap > 0) return Math.min(40, overlap * 12);
  return 0;
}

function wordTokens(value: string) {
  return (value.match(/[a-z0-9]+/gi) ?? []).map((token) => token.toLowerCase());
}

async function editTemplate(templateBytes: Buffer, template: Template, fields: InvoiceFields, signatures: RequisitionSignatures) {
  const zip = await JSZip.loadAsync(templateBytes);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error(`Template ${template.fileName} is missing word/document.xml.`);
  let xml = await entry.async("string");
  xml = replaceLabeledParagraphValue(xml, "Department", fields.department);
  xml = replaceLabeledParagraphValue(xml, "Expenditure Item", fields.expenditureItem);
  xml = replaceLabeledParagraphValue(xml, "Budgeted (Y/N)", fields.budgeted);
  xml = replaceLabeledParagraphValue(xml, "Business Motivation (if not budgeted for)", fields.budgeted === "N" ? fields.businessMotivation : "");
  xml = replaceInvoiceTable(xml, fields);
  xml = replaceLabeledParagraphValue(xml, "Amount in words:", amountInWords(fields.amount, fields.currency));
  xml = replaceModeOfPayment(xml, fields.modeOfPayment);
  const submitterRun = signatures.submitter
    ? await embedSignatureImage(zip, xml, fields.preparedByName, (await cleanSignatureImage(signatures.submitter.bytes)).png, "preparer")
    : null;
  const unsigned = (name: string) => ({ name, signatureRun: null, date: null });
  xml = layoutSignatureBlocks(xml, [
    {
      slot: "requisition-preparer",
      entries: [{ name: fields.preparedByName, signatureRun: submitterRun, date: submitterRun ? formatSignatureDate(new Date()) : null }],
    },
    { slot: "requisition-approver", entries: fields.approverNames.map(unsigned) },
    { slot: "payment-preparer", entries: [unsigned(fields.financePreparerName)] },
    { slot: "payment-approver", entries: [unsigned(fields.financeApproverName)] },
  ]);
  zip.file("word/document.xml", xml);
  return await zip.generateAsync({ type: "base64" });
}

export async function addSignatureToRequisition(
  docxBytes: Buffer,
  signerName: string,
  mimeType: string,
  signatureBytes: Buffer,
  target: "approval" | "finance-preparer" | "finance-approver" = "approval",
  signedAt: Date = new Date(),
) {
  const zip = await JSZip.loadAsync(docxBytes);
  const document = zip.file("word/document.xml");
  if (!document) throw new Error("The payment requisition is missing its Word document body.");
  const xml = await document.async("string");
  if (findSignatureBlocks(xml).length) {
    const cleaned = await cleanSignatureImage(signatureBytes);
    const role = target === "finance-preparer" ? "preparer" : "approver";
    const run = await embedSignatureImage(zip, xml, signerName, cleaned.png, role);
    zip.file("word/document.xml", signSignatureBlock(xml, signerName, target, run, formatSignatureDate(signedAt)));
    return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
  }
  // PRs generated before the signature-block layout keep their original signing behaviour.
  if (target === "approval") {
    const updated = await insertSignature(
      zip,
      xml,
      signerName,
      { mimeType, bytes: signatureBytes },
      "approver",
      "Requisition Approved By:",
    );
    zip.file("word/document.xml", updated);
    return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
  }
  const financePreparer = target === "finance-preparer";
  const heading = financePreparer ? "Payment Prepared By:" : "Payment Approved By:";
  const field = findSignatureFieldParagraph(xml, heading);
  if (!field || !field.paragraph.includes(xmlEncode(signerName))) {
    throw new Error(`Could not find ${signerName}'s finance signature field in the requisition.`);
  }
  const drawing = await createSignatureImage(
    zip,
    xml,
    signerName,
    { mimeType, bytes: signatureBytes },
    financePreparer ? "preparer" : "approver",
  );
  const updated = `${xml.slice(0, field.start)}${renderFinanceApprovalParagraph(field.paragraph, signerName, drawing, !financePreparer)}${xml.slice(field.start + field.paragraph.length)}`;
  zip.file("word/document.xml", updated);
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

export function convertRequisitionDocxToPdf(docxBytes: Buffer, docxFileName: string) {
  const tempDirectory = mkdtempSync(join(tmpdir(), "sanlam-pr-preview-"));
  try {
    const docxPath = join(tempDirectory, docxFileName);
    const profileDirectory = join(tempDirectory, "libreoffice-profile");
    const cacheDirectory = join(tempDirectory, "cache");
    const configDirectory = join(tempDirectory, "config");
    writeFileSync(docxPath, docxBytes);
    const conversion = spawnSync(
      "libreoffice",
      [`-env:UserInstallation=${pathToFileURL(profileDirectory).href}`, "--headless", "--convert-to", "pdf", "--outdir", tempDirectory, docxPath],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: tempDirectory,
          XDG_CACHE_HOME: cacheDirectory,
          XDG_CONFIG_HOME: configDirectory,
        },
      },
    );
    if (conversion.error) throw new Error(`Could not start LibreOffice: ${conversion.error.message}`, { cause: conversion.error });
    if (conversion.status !== 0) {
      throw new Error(`LibreOffice could not convert the requisition to PDF: ${conversion.stderr.trim() || conversion.stdout.trim() || `exit code ${conversion.status}`}`);
    }
    const pdfPath = join(tempDirectory, docxFileName.replace(/\.docx$/i, ".pdf"));
    try {
      return readFileSync(pdfPath);
    } catch (error) {
      throw new Error(`LibreOffice did not produce the requisition PDF: ${conversion.stderr.trim() || conversion.stdout.trim() || "no conversion output"}`, { cause: error });
    }
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function insertSignature(
  zip: JSZip,
  xml: string,
  signerName: string,
  signature: { mimeType: string; bytes: Buffer },
  role: "preparer" | "approver",
  sectionHeading: string,
) {
  const field = findSignatureFieldParagraph(xml, sectionHeading);
  if (!field || !field.paragraph.includes(xmlEncode(signerName))) {
    throw new Error(`Could not find ${signerName}'s signature field in the requisition template.`);
  }
  const drawingRun = await createSignatureImage(zip, xml, signerName, signature, role);
  const nameIndex = field.paragraph.indexOf(xmlEncode(signerName));
  const labelIndex = field.paragraph.indexOf(">Signature", nameIndex);
  if (labelIndex < 0) throw new Error(`Could not find the ${role} signature line in the approved requisition template.`);
  const nameRunStart = findWordRunStart(field.paragraph, nameIndex);
  if (nameRunStart < 0) throw new Error(`Could not find the ${role} name field in the approved requisition template.`);
  const nameRunEnd = field.paragraph.indexOf("</w:r>", nameRunStart);
  if (nameRunEnd < 0) throw new Error(`Could not find the end of the ${role} name field.`);
  const runStart = findWordRunStart(field.paragraph, labelIndex);
  if (runStart < 0) throw new Error(`Could not find the ${role} signature slot in the approved requisition template.`);
  const runEnd = field.paragraph.indexOf("</w:r>", runStart);
  if (runEnd < 0) throw new Error(`Could not find the end of the ${role} signature label.`);
  if (nameRunEnd > runStart) throw new Error(`The ${role} signature label appears before its name field.`);
  const separator = `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/></w:rPr><w:t>${"…".repeat(5)}</w:t></w:r>`;
  const updatedParagraph = `${field.paragraph.slice(0, nameRunEnd + "</w:r>".length)}${separator}${field.paragraph.slice(runStart, runEnd + "</w:r>".length)}${drawingRun}${field.paragraph.slice(runEnd + "</w:r>".length)}`;
  return `${xml.slice(0, field.start)}${updatedParagraph}${xml.slice(field.start + field.paragraph.length)}`;
}

function findSignatureFieldParagraph(xml: string, sectionHeading: string) {
  let awaitingField = false;
  for (const match of xml.matchAll(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const paragraph = match[0];
    const text = paragraphText(paragraph);
    if (text.includes(sectionHeading)) {
      awaitingField = true;
      continue;
    }
    if (awaitingField && text.includes("Name") && text.includes("Signature")) {
      return { paragraph, start: match.index ?? 0 };
    }
  }
  return null;
}

async function createSignatureImage(
  zip: JSZip,
  xml: string,
  signerName: string,
  signature: { mimeType: string; bytes: Buffer },
  role: "preparer" | "approver",
) {
  // Older PRs keep their dotted layout but still get the cleaned signature (no background, navy ink).
  const signedImage = await addSignatureUnderline((await cleanSignatureImage(signature.bytes)).png);
  const image = await loadImage(signedImage);
  const mediaName = `${role}-signature-${crypto.randomUUID()}.png`;
  const relationshipPath = "word/_rels/document.xml.rels";
  const contentTypesPath = "[Content_Types].xml";
  const relationshipsFile = zip.file(relationshipPath);
  const contentTypesFile = zip.file(contentTypesPath);
  if (!relationshipsFile || !contentTypesFile) throw new Error("The approved requisition template is missing image relationship metadata.");
  const relationships = await relationshipsFile.async("string");
  const contentTypes = await contentTypesFile.async("string");
  const relationshipIds = [...relationships.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]));
  const relationshipId = `rId${Math.max(0, ...relationshipIds) + 1}`;
  const relationship = `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaName}"/>`;
  zip.file(relationshipPath, relationships.replace("</Relationships>", `${relationship}</Relationships>`));
  if (!/<Default\s+Extension="png"/i.test(contentTypes)) {
    zip.file(contentTypesPath, contentTypes.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>'));
  }
  zip.file(`word/media/${mediaName}`, signedImage);
  return `<w:r>${signatureDrawing(xml, relationshipId, mediaName, signerName, role, image.width, image.height)}</w:r>`;
}

function underlineSignaturePlaceholders(xml: string) {
  let updatedCount = 0;
  const updated = xml.replace(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const signatureLabelEnd = paragraph.indexOf(">Signature</w:t>");
    if (signatureLabelEnd < 0 || paragraph.replace(/<[^>]+>/g, "").includes("Date")) return paragraph;
    const signatureRunStart = findWordRunStart(paragraph, signatureLabelEnd);
    const signatureRunEnd = signatureRunStart >= 0 ? paragraph.indexOf("</w:r>", signatureRunStart) : -1;
    const paragraphEnd = paragraph.lastIndexOf("</w:p>");
    if (signatureRunEnd < 0 || paragraphEnd <= signatureRunEnd) {
      throw new Error("Could not identify a departmental signature field in the requisition template.");
    }

    updatedCount += 1;
    const signatureLine = `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">  ________________</w:t></w:r>`;
    return `${paragraph.slice(0, signatureRunEnd + "</w:r>".length)}${signatureLine}</w:p>`;
  });

  if (updatedCount !== 2) {
    throw new Error(`Expected to format two departmental signature fields, but found ${updatedCount}.`);
  }
  return updated;
}

async function addSignatureUnderline(signatureBytes: Buffer) {
  const image = await loadImage(signatureBytes);
  const lineHeight = 22;
  const canvas = createCanvas(image.width, image.height + lineHeight);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  context.beginPath();
  context.strokeStyle = "#000000";
  context.lineWidth = 2;
  context.moveTo(0, image.height + lineHeight - 2);
  context.lineTo(image.width, image.height + lineHeight - 2);
  context.stroke();
  return canvas.toBuffer("image/png");
}

function signatureDrawing(
  xml: string,
  relationshipId: string,
  mediaName: string,
  signerName: string,
  role: "preparer" | "approver" | "approval",
  imageWidth: number,
  imageHeight: number,
  box: { width: number; height: number } = { width: 1200000, height: 333000 },
) {
  const templateDrawing = /<w:drawing>[\s\S]*?<\/w:drawing>/.exec(xml)?.[0];
  if (!templateDrawing) throw new Error("The approved requisition template has no valid image drawing to use for the signature.");
  const maxWidth = box.width;
  const maxHeight = box.height;
  const scale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight);
  const imageDimension = {
    width: String(Math.round(imageWidth * scale)),
    height: String(Math.round(imageHeight * scale)),
  };
  const pictureId = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  const signatureName = `${role === "approval" ? "Approval" : role === "preparer" ? "Preparer" : "Approver"} signature`;
  const relationshipNumber = Number(relationshipId.slice(3));
  if (!Number.isSafeInteger(relationshipNumber)) throw new Error("Could not assign an image relationship to the requisition signature.");
  return templateDrawing
    .replace(/wp14:anchorId="[^"]+"/, `wp14:anchorId="${pictureId}"`)
    .replace(/wp14:editId="[^"]+"/, `wp14:editId="${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}"`)
    .replace(/<wp:extent cx="\d+" cy="\d+"\/>/, `<wp:extent cx="${imageDimension.width}" cy="${imageDimension.height}"/>`)
    .replace(/<a:ext cx="\d+" cy="\d+"\/>/, `<a:ext cx="${imageDimension.width}" cy="${imageDimension.height}"/>`)
    .replace(/<wp:docPr\b[^>]*\/>/, `<wp:docPr id="${9000 + relationshipNumber}" name="${xmlEncode(`${signerName} ${signatureName}`)}"/>`)
    .replace(/<pic:cNvPr\b[^>]*\/>/, `<pic:cNvPr id="0" name="${xmlEncode(mediaName)}"/>`)
    .replace(/r:embed="[^"]+"/, `r:embed="${relationshipId}"`);
}

// ---------------------------------------------------------------------------
// Signature blocks
//
// Each sign-off line on the PR is a borderless three-column table: Name | Signature | Date, each value
// sitting on a thin rule with a small caption underneath. Tables are tagged with a caption
// ("PR signature: <slot>") and the expected signer's name so signing can find the right block later.
// ---------------------------------------------------------------------------

type SignatureSlot = "requisition-preparer" | "requisition-approver" | "payment-preparer" | "payment-approver";
const SIGNATURE_SLOT_HEADINGS: Record<SignatureSlot, string> = {
  "requisition-preparer": "Requisition Prepared By:",
  "requisition-approver": "Requisition Approved By:",
  "payment-preparer": "Payment Prepared By:",
  "payment-approver": "Payment Approved By:",
};
const SIGNATURE_BLOCK_CAPTION = "PR signature";
const SIGNATURE_INK = { r: 27, g: 42, b: 74 }; // dark navy, like a signing pen
const SIGNATURE_BOX_EMU = { width: 1828800, height: 365760 }; // 2.0in x 0.4in
const SIGNATURE_COLUMNS = { name: 3100, signature: 3626, date: 2300 }; // twips; 9026 = A4 text width

function approverNamesFrom(overrides: InvoiceOverrides) {
  const names = (overrides.approvedByNames ?? []).map((name) => name.trim()).filter(Boolean);
  return names.length ? names : [overrides.approvedByName?.trim() || "Approver"];
}

export function formatSignatureDate(date: Date) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lusaka" }).format(date);
}

function signatureBlock(slot: SignatureSlot, name: string, signatureRun: string | null, date: string | null) {
  const font = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>';
  const value = (text: string) =>
    `<w:r><w:rPr>${font}<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${xmlEncode(text)}</w:t></w:r>`;
  const awaiting = `<w:r><w:rPr>${font}<w:i/><w:iCs/><w:color w:val="9CA3AF"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t>Awaiting signature</w:t></w:r>`;
  const ruled = (runs: string) =>
    `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="4B5563"/></w:pBdr><w:spacing w:before="0" w:beforeAutospacing="0" w:after="0" w:afterAutospacing="0" w:line="240" w:lineRule="auto"/></w:pPr>${runs}</w:p>`;
  const caption = (text: string) =>
    `<w:p><w:pPr><w:spacing w:before="20" w:beforeAutospacing="0" w:after="100" w:afterAutospacing="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr>${font}<w:caps/><w:color w:val="6B7280"/><w:spacing w:val="10"/><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
  const cell = (width: number, content: string) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="bottom"/></w:tcPr>${content}</w:tc>`;
  const none = (side: string) => `<w:${side} w:val="nil"/>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${SIGNATURE_COLUMNS.name + SIGNATURE_COLUMNS.signature + SIGNATURE_COLUMNS.date}" w:type="dxa"/>`
    + `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(none).join("")}</w:tblBorders>`
    + `<w:tblLayout w:type="fixed"/>`
    + `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="284" w:type="dxa"/></w:tblCellMar>`
    + `<w:tblCaption w:val="${SIGNATURE_BLOCK_CAPTION}: ${slot}"/><w:tblDescription w:val="${xmlEncode(name)}"/></w:tblPr>`
    + `<w:tblGrid><w:gridCol w:w="${SIGNATURE_COLUMNS.name}"/><w:gridCol w:w="${SIGNATURE_COLUMNS.signature}"/><w:gridCol w:w="${SIGNATURE_COLUMNS.date}"/></w:tblGrid>`
    + `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="560" w:hRule="atLeast"/></w:trPr>`
    + cell(SIGNATURE_COLUMNS.name, ruled(value(name)) + caption("Name"))
    + cell(SIGNATURE_COLUMNS.signature, ruled(signatureRun ?? awaiting) + caption("Signature"))
    + cell(SIGNATURE_COLUMNS.date, ruled(date ? value(date) : "") + caption("Date"))
    + `</w:tr></w:tbl>`;
}

// Keeps consecutive signature tables (several approvers) from merging into one table.
const SIGNATURE_BLOCK_SPACER = '<w:p><w:pPr><w:spacing w:before="0" w:beforeAutospacing="0" w:after="0" w:afterAutospacing="0" w:line="80" w:lineRule="exact"/></w:pPr></w:p>';

type SignatureBlockEntry = { name: string; signatureRun: string | null; date: string | null };

/** Replaces each "Name……Signature……" template line with signature blocks (several for multiple approvers). */
function layoutSignatureBlocks(xml: string, sections: { slot: SignatureSlot; entries: SignatureBlockEntry[] }[]) {
  let updated = xml;
  for (const { slot, entries } of sections) {
    const field = findSignatureFieldParagraph(updated, SIGNATURE_SLOT_HEADINGS[slot]);
    if (!field) throw new Error(`Could not find the "${SIGNATURE_SLOT_HEADINGS[slot]}" signature line in the requisition template.`);
    const blocks = entries.map((entry) => signatureBlock(slot, entry.name, entry.signatureRun, entry.date)).join(SIGNATURE_BLOCK_SPACER);
    updated = `${updated.slice(0, field.start)}${blocks}${updated.slice(field.start + field.paragraph.length)}`;
  }
  // Never leave a heading stranded at the bottom of a page apart from the signature lines it introduces:
  // keep each section heading, any blank spacer paragraphs and the slot heading together with the first block.
  const sectionHeadings = ["Departmental/Business Approvals", "Finance Approvals"];
  const slotHeadings = Object.values(SIGNATURE_SLOT_HEADINGS);
  let chaining = false;
  let inApprovals = false;
  return updated.replace(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const text = paragraphText(paragraph);
    if (sectionHeadings.some((heading) => text.includes(heading))) {
      chaining = true;
      inApprovals = true;
    }
    // The template's blank lines in the approvals area were spacing for the old dotted layout; shrink them
    // to a small gap (the blocks carry their own spacing) so a standard PR still fits on one page.
    if (inApprovals && !text.trim() && !/<w:drawing>|<w:pBdr>|<w:sectPr/.test(paragraph)) {
      return chaining ? keepWithNext(SIGNATURE_BLOCK_SPACER) : SIGNATURE_BLOCK_SPACER;
    }
    const isSectionHeading = sectionHeadings.some((heading) => text.includes(heading));
    const isSlotHeading = slotHeadings.some((heading) => text.includes(heading));
    let result = paragraph;
    if (isSectionHeading) result = setParagraphSpacing(result, 120, 40);
    if (isSlotHeading) result = setParagraphSpacing(result, 80, 40);
    const keep = chaining || isSlotHeading;
    if (isSlotHeading) chaining = false;
    return keep ? keepWithNext(result) : result;
  });
}

/** Sets explicit spacing (in twips) and turns off the template's automatic paragraph spacing. */
function setParagraphSpacing(paragraph: string, before: number, after: number) {
  const spacing = `<w:spacing w:before="${before}" w:beforeAutospacing="0" w:after="${after}" w:afterAutospacing="0" w:line="240" w:lineRule="auto"/>`;
  if (/<w:pPr>[\s\S]*?<w:spacing\b[^>]*\/>[\s\S]*?<\/w:pPr>/.test(paragraph)) {
    return paragraph.replace(/(<w:pPr>[\s\S]*?)<w:spacing\b[^>]*\/>/, `$1${spacing}`);
  }
  if (!paragraph.includes("<w:pPr>")) return paragraph.replace(/^(<w:p(?: [^>]*)?>)/, `$1<w:pPr>${spacing}</w:pPr>`);
  // Schema order: spacing comes before ind/jc/rPr inside pPr.
  return paragraph.replace(/(<w:pPr>[\s\S]*?)(<w:ind\b|<w:jc\b|<w:rPr>|<\/w:pPr>)/, `$1${spacing}$2`);
}

function keepWithNext(paragraph: string) {
  if (paragraph.includes("<w:keepNext/>")) return paragraph;
  if (/<w:pPr>/.test(paragraph)) {
    // keepNext must follow pStyle when present (schema order).
    return /<w:pPr><w:pStyle [^>]*\/>/.test(paragraph)
      ? paragraph.replace(/(<w:pPr><w:pStyle [^>]*\/>)/, "$1<w:keepNext/>")
      : paragraph.replace("<w:pPr>", "<w:pPr><w:keepNext/>");
  }
  return paragraph.replace(/^(<w:p(?: [^>]*)?>)/, "$1<w:pPr><w:keepNext/></w:pPr>");
}

function findSignatureBlocks(xml: string) {
  return [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].flatMap((match) => {
    const table = match[0];
    const slot = new RegExp(`<w:tblCaption w:val="${SIGNATURE_BLOCK_CAPTION}: ([a-z-]+)"/>`).exec(table)?.[1] as SignatureSlot | undefined;
    if (!slot || !(slot in SIGNATURE_SLOT_HEADINGS)) return [];
    const name = /<w:tblDescription w:val="([^"]*)"\/>/.exec(table)?.[1] ?? "";
    return [{ table, start: match.index ?? 0, slot, name: xmlDecode(name), signed: table.includes("<w:drawing>") }];
  });
}

/**
 * Signs the right block: the first unsigned block (in approval order) bearing the signer's name. If the
 * chain was edited and no block carries their name, an extra approver block is added (departmental), or
 * the finance block for their role is used.
 */
function signSignatureBlock(
  xml: string,
  signerName: string,
  target: "approval" | "finance-preparer" | "finance-approver",
  signatureRun: string,
  date: string,
) {
  const blocks = findSignatureBlocks(xml);
  const order: SignatureSlot[] = ["requisition-approver", "payment-approver", "payment-preparer"];
  const sameName = (name: string) => name.trim().toLowerCase() === signerName.trim().toLowerCase();
  const open = blocks.filter((block) => !block.signed && block.slot !== "requisition-preparer");
  const byName = order.map((slot) => open.find((block) => block.slot === slot && sameName(block.name))).find(Boolean);
  const replaceBlock = (block: (typeof blocks)[number]) =>
    `${xml.slice(0, block.start)}${signatureBlock(block.slot, signerName, signatureRun, date)}${xml.slice(block.start + block.table.length)}`;
  if (byName) return replaceBlock(byName);
  if (target !== "approval") {
    const slot: SignatureSlot = target === "finance-preparer" ? "payment-preparer" : "payment-approver";
    const financeBlock = open.find((block) => block.slot === slot);
    if (financeBlock) return replaceBlock(financeBlock);
    throw new Error(`The ${target === "finance-preparer" ? "Payment Prepared By" : "Payment Approved By"} line has already been signed.`);
  }
  const lastApprover = blocks.filter((block) => block.slot === "requisition-approver").at(-1);
  if (!lastApprover) throw new Error(`There is no signature line for ${signerName} on this requisition.`);
  const insertAt = lastApprover.start + lastApprover.table.length;
  return `${xml.slice(0, insertAt)}${SIGNATURE_BLOCK_SPACER}${signatureBlock("requisition-approver", signerName, signatureRun, date)}${xml.slice(insertAt)}`;
}

function xmlDecode(value: string) {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** Adds an already-cleaned signature PNG to the .docx package and returns an inline drawing run, sized to the signature box. */
async function embedSignatureImage(zip: JSZip, xml: string, signerName: string, png: Buffer, role: "preparer" | "approver") {
  const image = await loadImage(png);
  const mediaName = `${role}-signature-${crypto.randomUUID()}.png`;
  const relationshipPath = "word/_rels/document.xml.rels";
  const contentTypesPath = "[Content_Types].xml";
  const relationshipsFile = zip.file(relationshipPath);
  const contentTypesFile = zip.file(contentTypesPath);
  if (!relationshipsFile || !contentTypesFile) throw new Error("The requisition is missing image relationship metadata.");
  const relationships = await relationshipsFile.async("string");
  const contentTypes = await contentTypesFile.async("string");
  const relationshipIds = [...relationships.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]));
  const relationshipId = `rId${Math.max(0, ...relationshipIds) + 1}`;
  zip.file(relationshipPath, relationships.replace("</Relationships>", `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaName}"/></Relationships>`));
  if (!/<Default\s+Extension="png"/i.test(contentTypes)) {
    zip.file(contentTypesPath, contentTypes.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>'));
  }
  zip.file(`word/media/${mediaName}`, png);
  return `<w:r>${signatureDrawing(xml, relationshipId, mediaName, signerName, role, image.width, image.height, SIGNATURE_BOX_EMU)}</w:r>`;
}

export type CleanedSignature = {
  png: Buffer;
  inkPixels: number;
  inkCoverage: number;
  width: number;
  height: number;
  /** Share of the original picture's width and height that the detected "ink" spans. */
  frameFill: number;
};

/**
 * Turns any signature picture into clean "ink": removes the background (white paper, dark screen or
 * transparency), crops to the strokes, and redraws them in one navy ink colour with soft edges.
 */
export async function cleanSignatureImage(bytes: Buffer): Promise<CleanedSignature> {
  let image;
  try {
    image = await loadImage(bytes);
  } catch {
    throw new Error("The signature image could not be read. Save it again as PNG or JPEG.");
  }
  const scale = Math.min(1, 1600 / image.width, 1600 / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const source = createCanvas(width, height);
  const sourceContext = source.getContext("2d");
  sourceContext.drawImage(image, 0, 0, width, height);
  const pixels = sourceContext.getImageData(0, 0, width, height).data;
  const total = width * height;

  let transparent = 0;
  for (let index = 3; index < pixels.length; index += 4) if ((pixels[index] ?? 255) < 16) transparent += 1;
  const usesTransparency = transparent / total > 0.2;

  // Background colour = median of the border pixels (composited over white).
  const channel = (index: number) => {
    const alpha = (pixels[index + 3] ?? 255) / 255;
    return [0, 1, 2].map((offset) => (pixels[index + offset] ?? 255) * alpha + 255 * (1 - alpha)) as [number, number, number];
  };
  const border: [number, number, number][] = [];
  const step = Math.max(1, Math.floor(Math.max(width, height) / 400));
  for (let x = 0; x < width; x += step) border.push(channel(x * 4), channel(((height - 1) * width + x) * 4));
  for (let y = 0; y < height; y += step) border.push(channel(y * width * 4), channel((y * width + width - 1) * 4));
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 255;
  const background = [0, 1, 2].map((offset) => median(border.map((pixel) => pixel[offset] ?? 255)));

  const strength = new Float32Array(total);
  let minX = width, minY = height, maxX = -1, maxY = -1, inkPixels = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    const index = pixel * 4;
    let value: number;
    if (usesTransparency) {
      value = (pixels[index + 3] ?? 0) / 255;
    } else {
      const [r, g, b] = channel(index);
      const distance = Math.max(Math.abs(r - (background[0] ?? 255)), Math.abs(g - (background[1] ?? 255)), Math.abs(b - (background[2] ?? 255)));
      value = Math.min(1, Math.max(0, (distance - 28) / 90)); // ignore paper texture / JPEG noise
    }
    strength[pixel] = value;
    if (value >= 0.25) {
      inkPixels += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("No signature could be found in this image. Use a clear signature on a plain background.");

  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04) + 2;
  const cropX = Math.max(0, minX - pad);
  const cropY = Math.max(0, minY - pad);
  const cropWidth = Math.min(width, maxX + pad + 1) - cropX;
  const cropHeight = Math.min(height, maxY + pad + 1) - cropY;
  const output = createCanvas(cropWidth, cropHeight);
  const outputContext = output.getContext("2d");
  const ink = outputContext.createImageData(cropWidth, cropHeight);
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const target = (y * cropWidth + x) * 4;
      ink.data[target] = SIGNATURE_INK.r;
      ink.data[target + 1] = SIGNATURE_INK.g;
      ink.data[target + 2] = SIGNATURE_INK.b;
      ink.data[target + 3] = Math.round((strength[(cropY + y) * width + cropX + x] ?? 0) * 255);
    }
  }
  outputContext.putImageData(ink, 0, 0);
  return {
    png: output.toBuffer("image/png"),
    inkPixels,
    inkCoverage: inkPixels / Math.max(1, (maxX - minX + 1) * (maxY - minY + 1)),
    width: cropWidth,
    height: cropHeight,
    frameFill: Math.min((maxX - minX + 1) / width, (maxY - minY + 1) / height),
  };
}

/** Cleans a signature and rejects pictures that are clearly not a signature (photos, screenshots, blank images). */
export async function prepareSignatureImage(bytes: Buffer) {
  const cleaned = await cleanSignatureImage(bytes);
  if (cleaned.inkPixels < 120) {
    throw new Error("The signature in this image is too small or faint. Use a clear signature on a plain background.");
  }
  // Screenshots and photos fill the whole frame with "ink" or are portrait-shaped; signatures are wide strokes.
  const portrait = cleaned.height > cleaned.width * 1.6;
  const fillsFrame = cleaned.frameFill > 0.95 && cleaned.inkCoverage > 0.12;
  if (cleaned.inkCoverage > 0.32 || portrait || fillsFrame) {
    throw new Error("This image looks like a photo or screenshot rather than a signature. Use just your signature on a plain background.");
  }
  return cleaned;
}

function findWordRunStart(xml: string, beforeIndex: number) {
  return [...xml.slice(0, beforeIndex).matchAll(/<w:r(?:\s[^>]*)?>/g)].at(-1)?.index ?? -1;
}

function replaceText(xml: string, from: string, to: string) {
  const escapedFrom = escapeRegExp(xmlEncode(from));
  const textTag = /<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g;
  const matches = [...xml.matchAll(textTag)];
  const combined = matches.map((match) => match[1] ?? "").join("");
  const index = combined.indexOf(xmlEncode(from));
  if (index < 0) return xml;
  let cursor = 0;
  let result = xml;
  let inserted = false;
  for (const match of matches) {
    const fullMatch = match[0];
    const value = match[1] ?? "";
    const start = cursor;
    const end = cursor + value.length;
    const overlapStart = Math.max(index, start);
    const overlapEnd = Math.min(index + xmlEncode(from).length, end);
    if (overlapStart < overlapEnd) {
      const replacement = !inserted ? xmlEncode(to) : "";
      result = result.replace(fullMatch, fullMatch.replace(value, replacement));
      inserted = true;
    }
    cursor = end;
  }
  return result.replace(new RegExp(escapedFrom, "g"), xmlEncode(to));
}

function replaceLabeledParagraphValue(xml: string, label: string, value: string, separator = " ") {
  let replaced = false;
  const updated = xml.replace(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (replaced) return paragraph;
    const text = paragraphText(paragraph);
    const labelIndex = text.indexOf(xmlEncode(label));
    if (labelIndex < 0) return paragraph;
    replaced = true;
    const afterLabel = labelIndex + xmlEncode(label).length;
    const remainder = text.slice(afterLabel);
    const valueOffset = /[^.…\s]/.exec(remainder)?.index;
    if (valueOffset !== undefined) {
      const valueStart = afterLabel + valueOffset;
      const trailingLeaders = /[.…]{4,}/g;
      trailingLeaders.lastIndex = valueStart;
      const trailingMatch = trailingLeaders.exec(text);
      const valueEnd = trailingMatch?.index ?? text.length;
      return replaceParagraphTextRange(paragraph, valueStart, valueEnd, xmlEncode(value));
    }
    if (!value) return paragraph;
    const leaders = /[.…]{4,}/.exec(remainder);
    if (!leaders || leaders.index === undefined) throw new Error(`Template paragraph "${label}" has no value line.`);
    const insertionPoint = afterLabel + leaders.index + Math.min(6, leaders[0].length);
    return replaceParagraphTextRange(paragraph, insertionPoint, insertionPoint, `${separator}${xmlEncode(value)}`);
  });
  if (!replaced) throw new Error(`Template is missing the "${label}" field.`);
  return updated;
}

function replaceParagraphTextRange(paragraph: string, start: number, end: number, replacement: string) {
  const textTags = [...paragraph.matchAll(/<w:t(?: [^>]*)?>[\s\S]*?<\/w:t>/g)];
  let textPosition = 0;
  let sourcePosition = 0;
  let inserted = false;
  let updated = "";
  for (const match of textTags) {
    const fullTag = match[0];
    const tagIndex = match.index ?? 0;
    const textValue = /<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/.exec(fullTag)?.[1] ?? "";
    const tagStart = textPosition;
    const tagEnd = tagStart + textValue.length;
    let updatedText = textValue;
    if (start === end && !inserted && tagStart <= start && start <= tagEnd) {
      const offset = start - tagStart;
      updatedText = `${textValue.slice(0, offset)}${replacement}${textValue.slice(offset)}`;
      inserted = true;
    } else if (start < end && tagStart < end && tagEnd > start) {
      const overlapStart = Math.max(0, start - tagStart);
      const overlapEnd = Math.min(textValue.length, end - tagStart);
      updatedText = inserted
        ? textValue.slice(overlapEnd)
        : `${textValue.slice(0, overlapStart)}${replacement}${textValue.slice(overlapEnd)}`;
      inserted = true;
    }
    updated += paragraph.slice(sourcePosition, tagIndex);
    updated += replaceTextTag(fullTag, updatedText);
    sourcePosition = tagIndex + fullTag.length;
    textPosition = tagEnd;
  }
  if (!inserted) throw new Error("Could not find the template value to replace.");
  return `${updated}${paragraph.slice(sourcePosition)}`;
}

function replaceInvoiceTable(xml: string, fields: InvoiceFields) {
  let updatedXml = xml;
  let tableReplaced = false;
  updatedXml = updatedXml.replace(/<w:tbl(?: [^>]*)?>[\s\S]*?<\/w:tbl>/g, (table) => {
    if (tableReplaced) return table;
    const rows = [...table.matchAll(/<w:tr(?: [^>]*)?>[\s\S]*?<\/w:tr>/g)];
    const headerIndex = rows.findIndex((row) => {
      const labels = [...(row[0] ?? "").matchAll(/<w:tc(?: [^>]*)?>[\s\S]*?<\/w:tc>/g)].map((cell) => normalize(paragraphText(cell[0] ?? "")));
      return labels.some((label) => label.includes("date")) &&
        labels.some((label) => label.includes("invoiceno")) &&
        labels.some((label) => label.includes("paymentdetails")) &&
        labels.some((label) => label.includes("payee")) &&
        labels.some((label) => label.includes("amount"));
    });
    if (headerIndex < 0) return table;
    const headerRow = rows[headerIndex]?.[0] ?? "";
    const headers = [...headerRow.matchAll(/<w:tc(?: [^>]*)?>[\s\S]*?<\/w:tc>/g)].map((cell) => normalize(paragraphText(cell[0] ?? "")));
    const dataRowIndex = headerIndex + 1;
    const dataRow = rows[dataRowIndex]?.[0];
    if (!dataRow) throw new Error(`Template ${fields.service || "payment"} is missing the invoice detail row.`);
    const data = new Map<number, string>([
      [headers.findIndex((header) => header.includes("date")), formatPrDate(fields.invoiceDate)],
      [headers.findIndex((header) => header.includes("invoiceno")), fields.invoiceNumber],
      [headers.findIndex((header) => header.includes("paymentdetails")), paymentDetails(fields.paymentPurpose)],
      [headers.findIndex((header) => header.includes("payee")), fields.payee],
      [headers.findIndex((header) => header.includes("amount")), formatAmount(fields.amount, fields.currency)],
    ]);
    const amountColumn = headers.findIndex((header) => header.includes("amount"));
    const replaceRowCells = (row: string, replacements: Map<number, string>) => {
      let cellIndex = 0;
      return row.replace(/<w:tc(?: [^>]*)?>[\s\S]*?<\/w:tc>/g, (cell) => {
        const currentCellIndex = cellIndex++;
        const replacement = replacements.get(currentCellIndex);
        if (replacement === undefined) return cell;
        const updatedCell = replaceCellText(cell, replacement);
        return currentCellIndex === amountColumn ? centerCellText(updatedCell) : updatedCell;
      });
    };
    let replacedTable = table.replace(dataRow, replaceRowCells(dataRow, data));
    const totalRow = rows.find((row) => /Total\s+Amount/i.test(paragraphText(row[0] ?? "")))?.[0];
    if (totalRow) {
      const cells = [...totalRow.matchAll(/<w:tc(?: [^>]*)?>[\s\S]*?<\/w:tc>/g)];
      const totalCellIndex = cells.findIndex((cell) => /Total\s+Amount/i.test(paragraphText(cell[0] ?? "")));
      if (totalCellIndex >= 0 && cells[totalCellIndex + 1]) {
        const amountCell = cells[totalCellIndex + 1]?.[0];
        if (amountCell) {
          replacedTable = replacedTable.replace(
            amountCell,
            centerCellText(replaceCellText(amountCell, formatAmount(fields.amount, fields.currency))),
          );
        }
      }
    }
    tableReplaced = true;
    return replacedTable;
  });
  if (!tableReplaced) throw new Error(`Template ${fields.service || "payment"} is missing its invoice table.`);
  return updatedXml;
}

function replaceCellText(cell: string, value: string) {
  let inserted = false;
  let updated = cell.replace(/(<w:t(?: [^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (_tag, start: string, current: string, end: string) => {
    if (inserted) return `${start}${end}`;
    inserted = true;
    return `${start}${xmlEncode(value)}${end}`;
  });
  if (/^(?:K|\$)[\d,]+\.\d{2}$/.test(value)) {
    updated = updated.replace(/<w:tcMar(?: [^>]*)?>[\s\S]*?<\/w:tcMar>/, (margins) =>
      margins
        .replace(/<w:left w:w="\d+" w:type="dxa"\s*\/>/, '<w:left w:w="0" w:type="dxa"/>')
        .replace(/<w:right w:w="\d+" w:type="dxa"\s*\/>/, '<w:right w:w="0" w:type="dxa"/>'),
    );
    const runProperties = /<w:rPr(?: [^>]*)?>[\s\S]*?<\/w:rPr>/.exec(updated)?.[0];
    if (runProperties) {
      const resized = /<w:sz w:val="\d+"\s*\/>/.test(runProperties)
        ? runProperties.replace(/<w:sz w:val="\d+"\s*\/>/, '<w:sz w:val="18"/>')
        : runProperties.replace("</w:rPr>", '<w:sz w:val="18"/></w:rPr>');
      updated = updated.replace(runProperties, resized);
    }
  }
  return updated;
}

function centerCellText(cell: string) {
  return cell.replace(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const paragraphProperties = /<w:pPr(?: [^>]*)?>[\s\S]*?<\/w:pPr>/.exec(paragraph)?.[0];
    if (paragraphProperties) {
      const centeredProperties = /<w:jc(?: [^>]*)?\/>/.test(paragraphProperties)
        ? paragraphProperties.replace(/<w:jc(?: [^>]*)?\/>/, '<w:jc w:val="center"/>')
        : paragraphProperties.replace("</w:pPr>", '<w:jc w:val="center"/></w:pPr>');
      return paragraph.replace(paragraphProperties, centeredProperties);
    }
    return paragraph.replace(/(<w:p(?: [^>]*)?>)/, '$1<w:pPr><w:jc w:val="center"/></w:pPr>');
  });
}

function replaceFinanceApprovalFields(xml: string, preparerName: string, approverName: string) {
  let nextField: { name: string; includeDate: boolean } | null = null;
  const targets: { paragraph: string; start: number; field: NonNullable<typeof nextField> }[] = [];
  for (const match of xml.matchAll(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const paragraph = match[0];
    const text = paragraphText(paragraph);
    if (text.includes("Payment Prepared By:")) {
      nextField = { name: preparerName, includeDate: false };
    } else if (text.includes("Payment Approved By:")) {
      nextField = { name: approverName, includeDate: true };
    } else if (nextField && text.includes("Name") && text.includes("Signature")) {
      targets.push({ paragraph, start: match.index ?? 0, field: nextField });
      nextField = null;
    }
  }
  if (targets.length !== 2) throw new Error(`Expected two finance approval name fields, but found ${targets.length}.`);

  const replacements = targets.map(({ paragraph, field }) =>
    renderFinanceApprovalParagraph(paragraph, field.name, financeSignatureLine(), field.includeDate),
  );
  return targets.reduceRight((updated, target, index) => {
    const replacement = replacements[index];
    if (replacement === undefined) throw new Error("Could not format a finance approval signature field.");
    return `${updated.slice(0, target.start)}${replacement}${updated.slice(target.start + target.paragraph.length)}`;
  }, xml);
}

function renderFinanceApprovalParagraph(paragraph: string, name: string, signature: string, includeDate: boolean) {
  const paragraphStart = /^<w:p(?: [^>]*)?>/.exec(paragraph)?.[0];
  if (!paragraphStart) throw new Error("Could not identify a finance approval paragraph in the requisition template.");
  let properties = /<w:pPr(?: [^>]*)?>[\s\S]*?<\/w:pPr>/.exec(paragraph)?.[0] ?? "<w:pPr></w:pPr>";
  const tabs = `<w:tabs><w:tab w:val="left" w:pos="3600"/>${includeDate ? '<w:tab w:val="left" w:pos="7200"/>' : ""}</w:tabs>`;
  properties = /<w:tabs(?: [^>]*)?>[\s\S]*?<\/w:tabs>/.test(properties)
    ? properties.replace(/<w:tabs(?: [^>]*)?>[\s\S]*?<\/w:tabs>/, tabs)
    : properties.replace(/(<w:pPr(?: [^>]*)?>)/, `$1${tabs}`);
  const bold = `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:bCs/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>`;
  const regular = `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>`;
  const textRun = (text: string, isBold: boolean) =>
    `<w:r>${isBold ? bold : regular}<w:t xml:space="preserve">${xmlEncode(text)}</w:t></w:r>`;
  const tabRun = "<w:r><w:tab/></w:r>";
  const date = includeDate ? `${tabRun}${textRun("Date ............", true)}` : "";
  const contents = `${textRun("Name ", true)}${textRun(name, false)}${tabRun}${textRun("Signature ", true)}${signature}${date}`;
  return `${paragraphStart}${properties}${contents}</w:p>`;
}

function financeSignatureLine() {
  return '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">  ________________</w:t></w:r>';
}

function replaceTextTag(tag: string, value: string) {
  return tag.replace(/^(<w:t(?: [^>]*)?>)[\s\S]*?(<\/w:t>)$/, (_full, originalStart: string, end: string) => {
    const start = /^\s|\s$/.test(value) && !/xml:space=/.test(originalStart)
      ? originalStart.replace(/>$/, ' xml:space="preserve">')
      : originalStart;
    return `${start}${value}${end}`;
  });
}

function replaceModeOfPayment(xml: string, selected: InvoiceFields["modeOfPayment"]) {
  return xml.replace(/<w:tc(?: [^>]*)?>[\s\S]*?<\/w:tc>/g, (cell) => {
    const option = /^(Cash|Cheque|EFT|TT|Mobile)$/i.exec(paragraphText(cell).trim())?.[1];
    if (!option) return cell;
    const isSelected = option.toLowerCase() === selected.toLowerCase();
    return replaceCellText(cell, `${isSelected ? "☒" : "☐"} ${option}`);
  });
}

function paymentDetails(value: string) {
  return /^being\s+payment\s+for\b/i.test(value.trim()) ? value.trim() : `Being payment for ${value.trim()}`;
}

function formatPrDate(value: string) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return value;
  return `${Number(match[1])}/${match[2].padStart(2, "0")}/${match[3]}`;
}

function formatAmount(amount: number, currency: string) {
  const formatted = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (currency === "ZMW") return `K${formatted}`;
  if (currency === "USD") return `$${formatted}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function paragraphText(paragraph: string) {
  return [...paragraph.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => match[1] ?? "").join("");
}

function first(text: string, patterns: RegExp[]) { for (const pattern of patterns) { const match = text.match(pattern); if (match?.[1]) return match[1].trim(); } return null; }

function extractInvoiceDate(text: string, rows: string[][]) {
  const month = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;
  const date = String.raw`(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+${month}\s+\d{2,4}|${month}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4})`;
  const issueLabels = /\b(?:tax\s+)?invoice\s+date\b|\bdate\s+of\s+(?:issue|invoice)\b|\bdate\s+issued\b|\bissued\s+date\b|\bissue\s+date\b|\bissued\s+on\b/i;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row) continue;
    for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
      const cell = row[cellIndex] ?? "";
      const label = issueLabels.exec(cell);
      if (!label || label.index === undefined) continue;
      const value = cell.slice(label.index + label[0].length);
      let parsed = new RegExp(date, "i").exec(value)?.[0];
      if (!parsed) {
        for (let nextIndex = rowIndex + 1; nextIndex < Math.min(rows.length, rowIndex + 4); nextIndex += 1) {
          const nextValue = rows[nextIndex]?.[cellIndex] ?? "";
          parsed = new RegExp(date, "i").exec(nextValue)?.[0];
          if (parsed) break;
        }
      }
      if (parsed && normalizeInvoiceDate(parsed)) return parsed;
    }
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const label of [issueLabels, /\bdate\b/i]) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      const match = label.exec(line);
      if (!match || match.index === undefined) continue;
      if (/\b(?:due|payment|delivery|dispatch|order|created|paid|receipt|posting)\s*$/i.test(line.slice(0, match.index))) continue;
      const followingText = [line.slice(match.index + match[0].length), lines[index + 1], lines[index + 2]]
        .filter(Boolean)
        .join(" ");
      const parsed = new RegExp(date, "i").exec(followingText)?.[0];
      if (parsed && normalizeInvoiceDate(parsed)) return parsed;
    }
  }
  return null;
}

function normalizeInvoiceDate(value: string) {
  const normalized = value.trim().replace(/(\d)(st|nd|rd|th)\b/i, "$1");
  const isoDate = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(normalized);
  if (isoDate?.[1] && isoDate[2] && isoDate[3]) {
    return `${isoDate[3].padStart(2, "0")}/${isoDate[2].padStart(2, "0")}/${isoDate[1]}`;
  }
  const numericDate = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(normalized);
  if (numericDate?.[1] && numericDate[2] && numericDate[3]) {
    return normalizeDate(`${numericDate[1]}/${numericDate[2]}/${numericDate[3]}`);
  }
  const namedDate = normalizeNamedDate(normalized);
  return /^\d{2}\/\d{2}\/\d{4}$/.test(namedDate) ? namedDate : "";
}

function extractInvoiceHeaderRow(rows: string[][]) {
  const row = rows.find((cells) =>
    Boolean(currencyCode(cells[0] ?? "")) &&
    Boolean(cells[2]?.trim()) &&
    Boolean(normalizeInvoiceDate(cells[3]?.trim() ?? "")) &&
    Boolean(cells[4]?.trim()) &&
    !isZraFiscalInvoiceNumber(cells[4] ?? ""),
  );
  if (!row?.[0] || !row[2] || !row[3] || !row[4]) return null;
  return { currency: currencyCode(row[0]) ?? "", accountId: row[2].trim(), invoiceDate: row[3].trim(), invoiceNumber: row[4].trim() };
}

function extractCustomerAccountId(text: string, rows: string[][]) {
  const accountHeader = /^(?:customer\s*(?:account\s*)?(?:no\.?|number|#|id)|account(?:\s*(?:no\.?|number|#|id))?)$/i;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
      const cell = row[cellIndex]?.trim() ?? "";
      const inline = /^(?:customer\s*(?:account\s*)?(?:no\.?|number|#|id)|account(?:\s*(?:no\.?|number|#|id))?)\s*[:#-]\s*(\S+)/i.exec(cell)?.[1];
      if (inline && isAccountIdentifier(inline)) return inline;
      if (!accountHeader.test(cell)) continue;
      for (let nextIndex = index + 1; nextIndex < Math.min(rows.length, index + 4); nextIndex += 1) {
        const value = rows[nextIndex]?.[cellIndex]?.trim() ?? "";
        if (isAccountIdentifier(value)) return value;
      }
    }
  }

  // The supplier's own bank account details are never the customer account.
  const lines = withoutBankDetails(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const label = /\b(?:customer\s*(?:account\s*)?(?:no\.?|number|#|id)|account\s*(?:no\.?|number|#|id))\b/i;
  for (let index = 0; index < lines.length && index < 100; index += 1) {
    const line = lines[index];
    if (!line || /\b(?:bank|payment|beneficiary)\s+account\b/i.test(line)) continue;
    const match = label.exec(line);
    if (!match || match.index === undefined) continue;
    const tail = line.slice(match.index + match[0].length).replace(/^[\s.:#-]*/, "");
    const inline = /^([A-Z0-9][A-Z0-9./_-]{2,})\b/i.exec(tail)?.[1];
    if (inline && isAccountIdentifier(inline)) return inline;
    for (const candidate of lines.slice(index + 1, index + 4)) {
      const value = /^([A-Z0-9][A-Z0-9./_-]{2,})\b/i.exec(candidate)?.[1];
      if (value && isAccountIdentifier(value)) return value;
      if (/\b(?:date|invoice|customer|account|payment|reference|TPIN)\b/i.test(candidate)) break;
    }
  }
  return null;
}

function isAccountIdentifier(value: string) {
  // Real account IDs contain at least one digit; this rejects label words such as "Branch" or "Name".
  return /^[A-Z0-9][A-Z0-9./_-]{2,}$/i.test(value) && /\d/.test(value) && !/^0+$/.test(value) && !/^(?:INVOICE|NUMBER|CUSTOMER|ACCOUNT|REFERENCE|TPIN|TOTAL)$/i.test(value);
}

const BANK_SECTION_HEADING = /^(?:bank(?:ing)?\s+(?:account\s+)?details|payment\s+details|remittance\s+(?:details|advice|information)|banking\s+information|bank\s+account)\b/i;
const NON_BANK_CONTENT = /\b(?:invoice|total|amount\s+due|description|qty|quantity|subtotal|vat)\b/i;

/** Drops the supplier's bank/payment details block so its account numbers and labels are not mistaken for invoice data. */
function withoutBankDetails(lines: string[]) {
  const kept: string[] = [];
  let skipping = 0;
  for (const line of lines) {
    if (BANK_SECTION_HEADING.test(line)) {
      skipping = 12;
      continue;
    }
    if (skipping > 0) {
      if (NON_BANK_CONTENT.test(line)) skipping = 0;
      else {
        skipping -= 1;
        continue;
      }
    }
    kept.push(line);
  }
  return kept;
}

function isZraFiscalInvoiceNumber(value: string) {
  return /^INV-\d{6,}\/\d{4,}$/i.test(value.trim());
}

type InvoiceTotal = { amount: string; currency?: string; subtotal?: number; vat?: number; detached?: boolean; label?: string };

// "Discount Total", "Sub Total", "Total Tax" etc. are never the amount due.
const NOT_GRAND_TOTAL = /\b(?:sub\s*total|(?:discount|tax|vat|qty|quantity|items?|line)\s+total|total\s+(?:tax|discount|quantity|items?|vat\b(?!\s+incl)))\b/i;
const MONEY_TOKEN = /\(?-?\d{1,3}(?:[,' ’]\d{3})*[.,]\d{2}\)?(?![\d%])|\(?-?\d+[.,]\d{2}\)?(?![\d%])/g;

function findInvoiceTotal(text: string, rows: string[][]): InvoiceTotal | null {
  const totalLabels = [
    /\b(?:VAT\s+Inclusive\s+Amount|Total\s+Amount\s+Due|Grand\s+Total|Invoice\s+Total|Total\s+Payable|Amount\s+Payable|Payable\s+Amount|Amount\s+to\s+Pay|Balance\s+Due|Total\s+Due|Amount\s+Due)\b/i,
    /\bTotal\b/i,
  ];
  for (const labelPattern of totalLabels) {
    const totalRow = rows.find((row) => {
      const label = row[0]?.trim() ?? "";
      return labelPattern.test(label) && !NOT_GRAND_TOTAL.test(label);
    });
    if (!totalRow) continue;
    const amount = totalRow.slice(1).map((cell) => cell.trim()).find((cell) => Number.isFinite(parseInvoiceAmount(cell)));
    if (amount) {
      const currency = totalRow.map(currencyCode).find(Boolean);
      const subtotal = findStructuredAmount(rows, /^(?:VAT\s+Exclusive\s+Amount|Subtotal)$/i);
      const vat = findStructuredAmount(rows, /^VAT(?:\s|$)/i);
      return {
        amount,
        label: totalRow[0]?.trim().replace(/\s+/g, " ") ?? "Total",
        ...(currency ? { currency } : {}),
        ...(subtotal === null ? {} : { subtotal }),
        ...(vat === null ? {} : { vat }),
      };
    }
  }

  const lines = withoutBankDetails(text.split(/\n/).map((line) => line.trim()).filter(Boolean));
  for (const [tier, label] of totalLabels.entries()) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line || !label.test(line)) continue;
      const labelMatch = label.exec(line);
      if (!labelMatch || labelMatch.index === undefined) continue;
      // A weak "Total" match must not be part of "Discount Total", "Sub Total", etc.
      if (tier > 0 && NOT_GRAND_TOTAL.test(line)) continue;
      const sameLine = line.slice(labelMatch.index + labelMatch[0].length);
      // Following lines only count when they are just a figure (optionally with a currency code),
      // so an address such as "Stand 4648" on the next page can never become the total.
      const followingFigure = [lines[index + 1], lines[index + 2]]
        .find((next) => next && /^(?:[A-Z]{3}\s*)?[-(]?[\d.,' ’]+\)?(?:\s*[A-Z]{3})?$/.test(next));
      const amount = firstAmount(sameLine) ?? (followingFigure ? firstAmount(followingFigure) : null);
      if (amount) {
        const currency = currencyCode([line, followingFigure ?? ""].join(" "));
        return { amount, label: labelMatch[0].replace(/\s+/g, " "), ...(currency ? { currency } : {}) };
      }
      if (tier === 0) {
        const detached = summaryBlockTotal(lines, index);
        if (detached) return detached;
      }
    }
  }
  return null;
}

/**
 * Some PDFs (e.g. Liquid Telecom) emit the totals block's figures before or apart from their labels.
 * Look at the figures around the grand-total label and pick the one that equals subtotal + VAT.
 */
function summaryBlockTotal(lines: string[], labelIndex: number): InvoiceTotal | null {
  const window = lines.slice(Math.max(0, labelIndex - 10), labelIndex + 3);
  const figures = window.flatMap((line) =>
    [...line.matchAll(MONEY_TOKEN)].map((match) => ({ raw: match[0].trim(), value: parseInvoiceAmount(match[0]) })),
  ).filter((figure) => Number.isFinite(figure.value) && figure.value > 0);
  let best: { total: (typeof figures)[number]; subtotal: number; vat: number } | null = null;
  for (const total of figures) {
    for (const [i, a] of figures.entries()) {
      for (const b of figures.slice(i + 1)) {
        if (a === total || b === total) continue;
        if (Math.abs(a.value + b.value - total.value) <= 0.05 && (!best || total.value > best.total.value)) {
          best = { total, subtotal: Math.max(a.value, b.value), vat: Math.min(a.value, b.value) };
        }
      }
    }
  }
  if (!best) return null;
  const currency = window.map(currencyCode).find(Boolean);
  return { amount: best.total.raw, subtotal: best.subtotal, vat: best.vat, detached: true, ...(currency ? { currency } : {}) };
}

function firstAmount(text: string) {
  return [...text.matchAll(/-?\(?\d[\d.,'’ ]*\d\)?|-?\d/g)]
    .map((match) => match[0]?.trim() ?? "")
    .find((candidate) => candidate && Number.isFinite(parseInvoiceAmount(candidate))) ?? null;
}

function parseInvoiceAmount(value: string) {
  let numeric = value.trim().replace(/[^\d.,'’()-]/g, "").replace(/['’ ]/g, "");
  const negative = numeric.startsWith("(") && numeric.endsWith(")") || numeric.startsWith("-");
  numeric = numeric.replace(/[()-]/g, "");
  const lastComma = numeric.lastIndexOf(",");
  const lastDot = numeric.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);
  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = decimalIndex === lastComma ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    numeric = numeric.replaceAll(thousandsSeparator, "").replace(decimalSeparator, ".");
  } else if (decimalIndex >= 0) {
    const digitsAfterSeparator = numeric.length - decimalIndex - 1;
    const separator = numeric[decimalIndex];
    if (digitsAfterSeparator === 1 || digitsAfterSeparator === 2) {
      numeric = numeric.slice(0, decimalIndex).replaceAll(separator ?? "", "") + `.${numeric.slice(decimalIndex + 1)}`;
    } else {
      numeric = numeric.replaceAll(separator ?? "", "");
    }
  }
  const amount = Number(numeric);
  return Number.isFinite(amount) ? (negative ? -amount : amount) : Number.NaN;
}

function currencyCode(value: string) {
  const text = value.trim();
  const code = /\b(AED|ARS|AUD|BHD|BND|BRL|BWP|CAD|CHF|CLP|CNY|COP|CZK|DKK|DZD|EGP|EUR|FJD|GBP|GHS|HKD|HUF|IDR|ILS|INR|IQD|JOD|JPY|KES|KWD|KZT|LBP|LKR|MAD|MUR|MXN|MYR|NGN|NOK|NPR|NZD|OMR|PEN|PHP|PKR|PLN|QAR|RON|RSD|RUB|RWF|SAR|SEK|SGD|THB|TND|TRY|TWD|TZS|UAH|UGX|USD|UYU|VND|XAF|XOF|ZAR|ZMW|ZWL)\b/i.exec(text)?.[1];
  if (code) return code.toUpperCase();
  if (/\b(?:Zambian\s+Kwacha|Kwacha)\b/i.test(text) || /(?:^|\s)K(?=\s?\d)/i.test(text)) return "ZMW";
  if (/\b(?:US\s+Dollars?|United\s+States\s+Dollars?)\b/i.test(text) || text.includes("$")) return "USD";
  if (/\bPounds?\b/i.test(text) || text.includes("£")) return "GBP";
  if (/\bEuros?\b/i.test(text) || text.includes("€")) return "EUR";
  if (/\bSouth\s+African\s+Rand\b/i.test(text) || /(?:^|\s)R(?=\s?\d)/i.test(text)) return "ZAR";
  return undefined;
}

function findStructuredAmount(rows: string[][], label: RegExp) {
  const row = rows.find((cells) => label.test(cells[0]?.trim() ?? ""));
  const amount = row?.slice(1).map((cell) => cell.trim()).find((cell) => Number.isFinite(parseInvoiceAmount(cell)));
  return amount ? parseInvoiceAmount(amount) : null;
}

function extractInvoiceCurrency(
  text: string,
  rows: string[][],
  amountMatch: { currency?: string } | null,
  invoiceRow: { currency: string } | null,
) {
  const directCurrency = amountMatch?.currency || invoiceRow?.currency;
  if (directCurrency) return directCurrency.toUpperCase();

  const totalRow = rows.find((row) => /\b(?:total|amount\s+due|payable)\b/i.test(row[0]?.trim() ?? ""));
  const totalCurrency = totalRow?.map(currencyCode).find(Boolean);
  if (totalCurrency) return totalCurrency.toUpperCase();

  const currencyLabel = /\bCurrency\s*:?\s*([A-Z]{3}|Zambian\s+Kwacha|Kwacha|US\s+Dollars?|United\s+States\s+Dollars?|South\s+African\s+Rand|Pounds?|Euros?)\b/i.exec(text)?.[1];
  if (currencyLabel) return currencyCode(currencyLabel) ?? "";

  for (const row of rows) {
    for (const cell of row) {
      const amountCurrency = /\bAmount(?:\s+Due)?[\s():-]*([A-Z]{3})\b|\b([A-Z]{3})[\s():-]*Amount(?:\s+Due)?\b/i.exec(cell);
      const currency = amountCurrency?.[1] ?? amountCurrency?.[2];
      if (currency) return currency.toUpperCase();
    }
  }

  const amountLine = text.split(/\n/).reverse().find((line) => /\b(?:grand\s+total|invoice\s+total|total\s+due|amount\s+due|balance\s+due|total)\b/i.test(line));
  if (amountLine) {
    const currency = currencyCode(amountLine);
    if (currency) return currency;
  }
  return "";
}

function extractLabeledAmount(text: string, label: RegExp, includeLabelCapture = false) {
  const match = label.exec(text);
  if (!match) return null;
  const capturedAmount = includeLabelCapture ? match[1] : undefined;
  const start = match.index + (includeLabelCapture ? 0 : match[0].length);
  const afterLabel = text.slice(start, start + 120);
  const amount = capturedAmount ?? firstAmount(afterLabel);
  return amount ? parseInvoiceAmount(amount) : null;
}

function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function normalizeDate(value: string) {
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(value.trim());
  if (!match?.[1] || !match[2] || !match[3]) return value.trim();
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}/${year}`;
}
function supplierFromHeader(text: string) {
  const allLines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const recipientIndex = allLines.findIndex((line) => /\b(?:bill\s*to|sold\s*to|ship\s*to|invoice\s*to|customer\s+details)\b/i.test(line));
  const lines = allLines.slice(0, recipientIndex < 0 ? 30 : Math.min(recipientIndex, 30));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const labeledSupplier = /^(?:(?:invoice\s+)?from|supplier(?:\s+(?:name|details))?|vendor(?:\s+name)?|seller(?:\s+name)?|sold\s+by|service\s+provider|issued\s+by|billed\s+by|company\s+name)\s*:?\s*(.*)$/i.exec(line);
    if (labeledSupplier) {
      const explicitName = labeledSupplier[1]?.trim() || lines.slice(index + 1, index + 4).find((candidate) => isSupplierName(candidate));
      if (explicitName && isSupplierName(explicitName)) return cleanSupplierName(explicitName);
    }
    if (/sanlam|tax invoice|sold to|bill to|bill-to|ship to|customer|attn:|t\/a\b|tpin|vat|invoice|due date|terms\b/i.test(line)) continue;
    const candidate = /^([A-Z][A-Za-z0-9&.,'() -]*?(?:Limited|Ltd\.?|PLC|Inc\.?|Incorporated|Corporation|Corp\.?|LLC|LLP|GmbH|S\.?A\.?|Pty\.?|Company|Co\.?|Group|Services|Technologies|Telecom|Telecommunications)(?:\s*\(Pty\)\s*Ltd\.?)?)$/i.exec(line)?.[1];
    if (candidate) return cleanSupplierName(candidate);
    if (isSupplierName(line) && /^[A-Z][A-Za-z0-9&.'()-]*(?:\s+[A-Z][A-Za-z0-9&.'()-]*){1,5}$/.test(line)) return cleanSupplierName(line);
  }
  return null;
}
function isSupplierName(value: string) {
  return value.length <= 100 &&
    /[A-Za-z]/.test(value) &&
    !/\d{3,}|@|https?:|www\./i.test(value) &&
    !/^(?:invoice|tax invoice|bill to|sold to|ship to|customer|date|due|terms|payment|description|from|supplier|vendor|seller|invoice number|invoice no)$/i.test(value);
}
function cleanSupplierName(value: string) {
  return value.replace(/\s{2,}/g, " ").replace(/\s*\(Pty\)\s*Ltd\.?/i, " (Pty) Ltd").trim().replace(/[,:;]+$/, "");
}
function inferPayee(text: string, fileName: string) {
  const namedSupplier = first(text, [/\b(Airtel Networks Zambia PLC|Infratel Corporation Limited|Liquid Telecommunications Zambia Limited\s*\(Pty\)\s*Ltd)\b/i]);
  if (namedSupplier && !/sanlam/i.test(namedSupplier)) return namedSupplier.replace(/\s*\(Pty\)\s*Ltd\.?/i, " (Pty) Ltd");
  const fromFile = first(fileName, [/\b(Airtel|Infratel)\b/i]);
  return fromFile === "Airtel" ? "Airtel Networks Zambia PLC" : fromFile === "Infratel" ? "Infratel Corporation Limited" : null;
}
function inferPeriod(text: string, fileName: string) {
  const monthDate = String.raw`(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4})`;
  const numericDate = String.raw`(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})`;
  const separator = String.raw`(?:\s+to\s+|\s*[-–—]\s*)`;
  const rangePattern = new RegExp(`(${monthDate}|${numericDate})${separator}(${monthDate}|${numericDate})`, "i");
  const explicitPeriod = /\b(?:billing|service|supply)\s+period\b\s*:?\s*([^\n]+)/i.exec(text)?.[1] ?? "";
  const range = rangePattern.exec(explicitPeriod) ?? rangePattern.exec(fileName.replaceAll("_", " "));
  if (range?.[1] && range[2]) return { value: `${normalizePeriodDate(range[1])} to ${normalizePeriodDate(range[2])}`, inferred: false };
  const monthYearPattern = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+['’]?(\d{2,4})\b/i;
  const monthYear = monthYearPattern.exec(explicitPeriod) ?? monthYearPattern.exec(fileName.replaceAll("_", " "));
  const monthName = monthYear?.[1];
  const yearValue = monthYear?.[2];
  const month = monthName ? new Date(`${monthName} 1, 2000`).getMonth() + 1 : 0;
  if (!month || !yearValue) return { value: null, inferred: false };
  const year = Number(yearValue.length === 2 ? `20${yearValue}` : yearValue);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { value: `01/${String(month).padStart(2, "0")}/${year} to ${String(lastDay).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`, inferred: true };
}
function inferInvoicePeriod(text: string, fileName: string): { value: string | null; inferred: boolean; source?: "label" | "line-items" | "title" } {
  const existing = inferPeriod(text, fileName);
  if (existing.value) return { ...existing, source: existing.inferred ? "title" : "label" };
  const fromLines = lineItemPeriod(text);
  if (fromLines) return { value: fromLines, inferred: true, source: "line-items" };

  const monthName = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const periodLine = lines.find((line) =>
    /\b(?:billing|service|supply|statement|usage|coverage)\s+(?:billing\s+)?period\b|\bperiod\s+covered\b|\bfor\s+the\s+period\b/i.test(line),
  ) ?? "";
  const invoiceTitle = lines.find((line) =>
    /\binvoice\b/i.test(line) && new RegExp(monthName, "i").test(line),
  ) ?? "";
  const normalizedFileName = fileName.replace(/[-_]+/g, " ");
  const periodSource = periodLine || invoiceTitle || normalizedFileName;
  const monthYear = new RegExp(String.raw`\b(${monthName})[\s,./-]+['’]?(\d{2,4})\b`, "i").exec(periodSource);
  const monthNameValue = monthYear?.[1];
  const yearValue = monthYear?.[2];
  const month = monthNameValue ? new Date(`${monthNameValue} 1, 2000`).getMonth() + 1 : 0;
  if (!month || !yearValue) return { value: null, inferred: false };
  const year = Number(yearValue.length === 2 ? `20${yearValue}` : yearValue);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    value: `01/${String(month).padStart(2, "0")}/${year} to ${String(lastDay).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`,
    inferred: true,
    source: "title",
  };
}

/** Finds service date ranges on invoice lines ("2026-07-18 to 2026-08-18") and returns the one that starts first. */
function lineItemPeriod(text: string) {
  const date = String.raw`(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{4})`;
  const rangePattern = new RegExp(`(${date})\\s*(?:to|until|[-–—])\\s*(${date})`, "gi");
  const ranges = [...text.matchAll(rangePattern)].flatMap((match) => {
    const start = normalizePeriodDate((match[1] ?? "").replaceAll(".", "/"));
    const end = normalizePeriodDate((match[2] ?? "").replaceAll(".", "/"));
    const startTime = periodDateTime(start);
    const endTime = periodDateTime(end);
    // Ignore anything that is not a plausible service period (end before start, or longer than ~13 months).
    if (!startTime || !endTime || endTime < startTime || endTime - startTime > 400 * 86400000) return [];
    return [{ start, end, startTime }];
  });
  ranges.push(...namedDateRanges(text));
  const earliest = ranges.sort((a, b) => a.startTime - b.startTime)[0];
  return earliest ? `${earliest.start} to ${earliest.end}` : null;
}

const MONTH_NAME = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;

/** "18 Jul – 18 Aug 2026", "18 July 2026 to 18 August 2026", "Jul 18 - Aug 18, 2026". The start may omit its year. */
function namedDateRanges(text: string) {
  const dayFirst = String.raw`(\d{1,2})\s+(${MONTH_NAME})\.?(?:,?\s+(\d{4}))?`;
  const monthFirst = String.raw`(${MONTH_NAME})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?`;
  const separator = String.raw`\s*(?:to|until|[-–—])\s*`;
  const patterns = [
    { regex: new RegExp(String.raw`\b${dayFirst}${separator}${dayFirst}\b`, "gi"), dayFirst: true },
    { regex: new RegExp(String.raw`\b${monthFirst}${separator}${monthFirst}\b`, "gi"), dayFirst: false },
  ];
  const ranges: { start: string; end: string; startTime: number }[] = [];
  for (const { regex, dayFirst: isDayFirst } of patterns) {
    for (const match of text.matchAll(regex)) {
      const [startDay, startMonthName, startYearText, endDay, endMonthName, endYearText] = isDayFirst
        ? [match[1], match[2], match[3], match[4], match[5], match[6]]
        : [match[2], match[1], match[3], match[5], match[4], match[6]];
      if (!endYearText || !startDay || !endDay || !startMonthName || !endMonthName) continue;
      const startMonth = new Date(`${startMonthName} 1, 2000`).getMonth() + 1;
      const endMonth = new Date(`${endMonthName} 1, 2000`).getMonth() + 1;
      const endYear = Number(endYearText);
      // "18 Dec – 17 Jan 2027" starts in the previous year.
      const startYear = startYearText ? Number(startYearText) : startMonth > endMonth ? endYear - 1 : endYear;
      const start = `${startDay.padStart(2, "0")}/${String(startMonth).padStart(2, "0")}/${startYear}`;
      const end = `${endDay.padStart(2, "0")}/${String(endMonth).padStart(2, "0")}/${endYear}`;
      const startTime = periodDateTime(start);
      const endTime = periodDateTime(end);
      if (!startTime || !endTime || endTime < startTime || endTime - startTime > 400 * 86400000) continue;
      ranges.push({ start, end, startTime });
    }
  }
  return ranges;
}

function periodDateTime(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return 0;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  return check.getUTCDate() === day && check.getUTCMonth() === month - 1 ? time : 0;
}

function normalizePeriodDate(value: string) {
  if (/^\d{4}-/.test(value)) {
    const [year, month, day] = value.split("-");
    if (!year || !month || !day) return value;
    return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
  }
  if (/\d[/-]/.test(value)) {
    const [day, month, year] = value.replaceAll("-", "/").split("/");
    if (!day || !month || !year) return value;
    return normalizeDate(`${day}/${month}/${year}`);
  }
  return normalizeNamedDate(value);
}
function normalizeNamedDate(value: string) {
  const match = value.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{2,4})|(\d{1,2})\s+([A-Za-z]+)\s+(\d{2,4})/);
  const monthName = match?.[1] ?? match?.[5];
  const day = match?.[2] ?? match?.[4];
  const year = match?.[3] ?? match?.[6];
  const month = monthName && year ? new Date(`${monthName} 1, ${year}`).getMonth() + 1 : 0;
  const fullYear = year?.length === 2 ? `20${year}` : year;
  return day && fullYear && month ? `${day.padStart(2, "0")}/${String(month).padStart(2, "0")}/${fullYear}` : value;
}
function inferService(text: string, fileName: string) {
  if (/azure|infratel/i.test(`${text} ${fileName}`)) return "Azure";
  if (/airtel|bulk\s*sms/i.test(`${text} ${fileName}`)) return "Bulk SMS";
  return first(text, [/\b(Dedicated Internet Access|National L2 VPN|National Leased Lines|Network_Managed Network Services)\b/i]) ?? "";
}
function inferPaymentPurpose(text: string, fileName: string, pages: string[], billingPeriod: string) {
  const allText = `${text} ${pages.join("\n")} ${fileName}`;
  const month = monthLabelFromPeriod(billingPeriod);
  const monthSuffix = month ? ` (${month})` : "";
  if (/azure\s+windows\s+vm/i.test(allText) && /active\s+storage/i.test(allText)) {
    return `Azure Windows VM hosting services and additional active storage${monthSuffix}`;
  }
  const serviceTypes = [
    { pattern: /dedicated internet access|internet access/i, label: "Internet" },
    { pattern: /national l2 vpn|mpls/i, label: "MPLS/VPN" },
    { pattern: /managed network|network_managed/i, label: "managed network services" },
    { pattern: /national leased lines/i, label: "leased line services" },
  ].filter(({ pattern }) => pattern.test(allText)).map(({ label }) => label);
  if (serviceTypes.length >= 2) return `${serviceTypes.slice(0, 3).join(", ").replace(/, ([^,]+)$/, " and $1")}${monthSuffix}`;
  if (serviceTypes.length === 1) return `${serviceTypes[0]} services${monthSuffix}`;
  // Use the raw page text: the normalised text has tabs collapsed, which hides "amount<TAB>description" layouts.
  const itemDescriptions = extractInvoiceItemDescriptions(pages.join("\n"));
  if (itemDescriptions.length) return `${itemDescriptions.join(", ")}${monthSuffix}`;
  return inferService(allText, fileName);
}

function extractInvoiceItemDescriptions(text: string) {
  const rawLines = text.split(/\r?\n/).filter((line) => line.trim());
  const lines = rawLines.map((line) => line.replace(/\s+/g, " ").trim());
  const rawHeadingIndex = lines.findIndex((line) =>
    /\b(?:description|discription|descripton|descrption|desription|item|product|service)\b/i.test(line) &&
    /\b(?:qty|quantity|unit|price|amount|rate)\b/i.test(line),
  );
  if (rawHeadingIndex < 0) return [];

  const descriptions: string[] = [];
  const isoOrNumericDate = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\b/;
  for (const rawLine of rawLines.slice(rawHeadingIndex + 1)) {
    if (BANK_SECTION_HEADING.test(rawLine.trim())) break;
    if (/^(?:sub\s*total|grand\s*total|total\b|vat\b|tax\b|amount\s+due|balance\s+due)\b/i.test(rawLine.trim())) break;
    // Some layouts put the line amount first, separated by a tab: "48.30<TAB>Office 365 E3 Monthly 2026-07-18 to".
    const leadingAmount = /^\s*-?[\d.,]+\t+(.+)$/.exec(rawLine) ?? /^\s*-?\d[\d,]*\.\d{2}\s+([A-Za-z].+)$/.exec(rawLine);
    const line = (leadingAmount?.[1] ?? rawLine).replace(/\s+/g, " ").trim();
    // A line item carries money (or had its amount split off); fragments like "Direct_Microsoft 365" do not.
    if (!leadingAmount && !/\d[.,]\d{2}\b/.test(line)) continue;
    let description = line;
    const dateMatch = isoOrNumericDate.exec(description);
    if (dateMatch && dateMatch.index > 0) description = description.slice(0, dateMatch.index);
    else {
      const firstNumber = /\s+\d+(?:[.,]\d+)?(?:\s|$)/.exec(description);
      if (firstNumber && firstNumber.index > 0) description = description.slice(0, firstNumber.index);
    }
    description = description
      .replace(/\b(?:monthly|annual(?:ly)?|yearly|quarterly)\b\s*$/i, "")
      .trim()
      .replace(/[\s:|-]+$/, "");
    if (!looksLikeDescription(description)) continue;
    if (!descriptions.includes(description)) descriptions.push(description);
    if (descriptions.length === 5) break;
  }
  return descriptions;
}

/** True for human-readable text such as "Office 365 E3", false for junk like "2", "48.30 Office" or "SID:af04…". */
function looksLikeDescription(value: string) {
  const text = value.trim();
  if (!/[A-Za-z]{3,}/.test(text)) return false;
  if (/^[\d.,]+\s/.test(text)) return false;
  const visible = text.replace(/\s/g, "");
  const letters = (visible.match(/[A-Za-z]/g) ?? []).length;
  return letters / visible.length >= 0.5 && !/^SID:/i.test(text);
}

function monthLabelFromPeriod(period: string) {
  const match = /\d{2}\/(\d{2})\/(\d{4})/.exec(period);
  if (!match?.[1] || !match[2]) return "";
  const month = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(match[2]), Number(match[1]) - 1, 1)));
  return `${month} '${match[2].slice(-2)}`;
}
function xmlEncode(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function amountInWords(amount: number, currency: string) {
  const whole = Math.floor(amount);
  const fractional = Math.round((amount - whole) * 100);
  const currencyUnits: Record<string, [string, string]> = {
    BWP: ["pula", "thebe"],
    EUR: ["euros", "cents"],
    GBP: ["pounds", "pence"],
    INR: ["rupees", "paise"],
    KES: ["shillings", "cents"],
    MWK: ["kwacha", "tambala"],
    TZS: ["shillings", "cents"],
    UGX: ["shillings", "cents"],
    USD: ["dollars", "cents"],
    ZAR: ["rand", "cents"],
    ZMW: ["Kwacha", "ngwee"],
  };
  const [major, minor] = currencyUnits[currency] ?? [currency, "minor units"];
  const phrase = `${numberWords(whole)} ${major}${fractional ? ` and ${numberWords(fractional)} ${minor}` : ""}`;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
function numberWords(value: number): string {
  const ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (value < 20) return ones[value] ?? String(value);
  if (value < 100) return (tens[Math.floor(value / 10)] ?? "") + (value % 10 ? `-${ones[value % 10] ?? ""}` : "");
  if (value < 1000) return `${ones[Math.floor(value / 100)] ?? ""} hundred${value % 100 ? ` ${numberWords(value % 100)}` : ""}`;
  if (value < 1_000_000) return `${numberWords(Math.floor(value / 1000))} thousand${value % 1000 ? `, ${numberWords(value % 1000)}` : ""}`;
  return `${numberWords(Math.floor(value / 1_000_000))} million${value % 1_000_000 ? `, ${numberWords(value % 1_000_000)}` : ""}`;
}
