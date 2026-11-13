/**
 * Invoice auto-fill regression test.
 *
 * Runs the invoice reader over every PDF listed in cases.json and compares each field with the
 * known-correct value. Run it after any change to src/lib/invoice-pr.server.ts:
 *
 *   npm run test:invoices
 *
 * A field is reported as:
 *   ok       correct value
 *   FLAGGED  wrong or missing, but highlighted for the user to check (acceptable, but worth improving)
 *   WRONG    wrong and NOT highlighted: the user would likely submit it unnoticed (fails the run)
 * Fields listed in "mustFlag" must also be highlighted, even when correct.
 *
 * To add an invoice: copy the PDF into fixtures/ and add an entry with the correct values.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { suggestInvoiceFields, type InvoiceSuggestion } from "../../src/lib/invoice-pr.server";

type Field = "invoiceNumber" | "invoiceDate" | "billingPeriod" | "accountId" | "payee" | "amount" | "currency" | "paymentPurpose";
type Case = { file: string; notes?: string; expect: Partial<Record<Field, string>>; mustFlag?: Field[]; expectTaxIds?: string[] };

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8")) as Case[];

let failures = 0;
let flagged = 0;
let missingFixtures = 0;

for (const testCase of cases) {
  const path = join(here, "fixtures", testCase.file);
  console.log(`\n${testCase.file}`);
  if (!existsSync(path)) {
    console.log("  SKIPPED  fixture PDF not found in tests/invoice-extraction/fixtures/");
    missingFixtures += 1;
    continue;
  }
  let result: InvoiceSuggestion;
  try {
    result = await suggestInvoiceFields(readFileSync(path), testCase.file);
  } catch (error) {
    console.log(`  WRONG    reader crashed: ${error instanceof Error ? error.message : String(error)}`);
    failures += 1;
    continue;
  }
  for (const [field, expected] of Object.entries(testCase.expect) as [Field, string][]) {
    const actual = String(result[field] ?? "");
    const isFlagged = result.uncertainFields.includes(field);
    const correct = normalise(field, actual) === normalise(field, expected);
    const mustFlag = testCase.mustFlag?.includes(field) ?? false;
    if (correct && (!mustFlag || isFlagged)) {
      console.log(`  ok       ${field.padEnd(15)} ${actual || "(blank)"}${isFlagged ? "  [highlighted]" : ""}`);
    } else if (correct) {
      console.log(`  WRONG    ${field.padEnd(15)} correct value but should be highlighted for checking`);
      failures += 1;
    } else if (isFlagged) {
      console.log(`  FLAGGED  ${field.padEnd(15)} got "${actual}", expected "${expected}" (highlighted)`);
      flagged += 1;
    } else {
      console.log(`  WRONG    ${field.padEnd(15)} got "${actual}", expected "${expected}" and it is NOT highlighted`);
      failures += 1;
    }
  }
  if (testCase.expectTaxIds) {
    // Supplier TPINs identify returning suppliers, so the customer's (Sanlam's) TPIN must never appear here.
    const got = [...result.taxIds].sort().join(", ");
    const want = [...testCase.expectTaxIds].sort().join(", ");
    if (got === want) console.log(`  ok       ${"supplier TPIN".padEnd(15)} ${got || "(none)"}`);
    else {
      console.log(`  WRONG    ${"supplier TPIN".padEnd(15)} got "${got}", expected "${want}"`);
      failures += 1;
    }
  }
}

console.log(`\n${cases.length} invoices · ${failures} wrong · ${flagged} wrong-but-highlighted · ${missingFixtures} skipped`);
process.exit(failures ? 1 : 0);

function normalise(field: Field, value: string) {
  if (field === "amount") {
    const amount = Number(value.replaceAll(",", ""));
    return Number.isFinite(amount) && value.trim() ? amount.toFixed(2) : "";
  }
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
