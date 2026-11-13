/** Types and constants shared by the contract pages (browser) and the contract server code. */

export const CONTRACT_CATEGORY = "Contracts";

export const CONTRACT_DOCUMENT_TYPES = [
  "Contract",
  "Service agreement",
  "Employment contract",
  "Non-disclosure agreement",
  "Lease agreement",
  "Memorandum of understanding",
  "Affidavit",
  "Power of attorney",
] as const;

/** "Kennedy Malama" -> "KM", written the way people initial a page. */
export function initialsOf(fullName: string) {
  return fullName
    .split(/[\s-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export type ContractFieldKind = "signature" | "initials" | "date" | "name";

export const CONTRACT_FIELD_LABELS: Record<ContractFieldKind, string> = {
  signature: "Signature",
  initials: "Initials",
  date: "Date signed",
  name: "Full name",
};

/** Default box size as a share of the page width/height, roughly matching a printed signature line. */
export const CONTRACT_FIELD_DEFAULT_SIZE: Record<
  ContractFieldKind,
  { width: number; height: number }
> = {
  signature: { width: 0.26, height: 0.06 },
  initials: { width: 0.09, height: 0.045 },
  date: { width: 0.18, height: 0.03 },
  name: { width: 0.26, height: 0.03 },
};

/**
 * A place on the contract where one signer must sign or fill something in.
 * Coordinates are fractions (0–1) of the page as it is displayed (after any page rotation), measured from the
 * top-left corner, so they do not depend on the zoom level the box was drawn at.
 */
export type ContractFieldInput = {
  signerId: string;
  kind: ContractFieldKind;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ContractField = ContractFieldInput & {
  id: string;
  completedAt: string | null;
};

export type ContractSummary = {
  documentId: string;
  pageCount: number;
  notarize: boolean;
  notary: { id: string; full_name: string; commission: string; jurisdiction: string } | null;
  originalSha256: string;
  finalSha256: string | null;
  notarizedAt: string | null;
  notarialAct: string | null;
  signers: {
    id: string;
    full_name: string;
    email: string;
    sequence_no: number;
    status: string;
    decided_at: string | null;
  }[];
  fields: (ContractField & { signerName: string })[];
};
