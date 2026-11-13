import { createServerFn } from "@tanstack/react-start";
import {
  createPortalDocument,
  deletePortalDocument,
  deleteApproverProfile,
  getDocumentActivity,
  getDocumentFile,
  getInvoiceDuplicateWarning,
  getPortalData,
  getFinanceApprover,
  getFinancePreparer,
  getUserSignature,
  signPortalDocument,
  saveUserSignature,
  upsertApproverProfile,
  updateDocumentStatus,
  upsertCrmProfile,
  updatePortalDocument,
} from "./local-db.server";
import { buildPaymentRequisition, suggestInvoiceFields, type InvoiceOverrides } from "./invoice-pr.server";
import { fetchCrmDirectoryUsers, getCurrentCrmIdentity } from "./crm-sso.server";
import {
  applySupplierMemory,
  getAutofillStats,
  recordAutofillFeedback,
  rememberSupplier,
  type AutofillSnapshot,
} from "./autofill-memory.server";

export const suggestInvoiceFieldsFn = createServerFn({ method: "POST" })
  .validator((input: { fileName: string; fileData: string }) => input)
  .handler(async ({ data }) => {
    getCurrentCrmIdentity();
    const suggestion = await suggestInvoiceFields(Buffer.from(data.fileData, "base64"), data.fileName);
    const duplicateWarning = getInvoiceDuplicateWarning(suggestion.payee, suggestion.invoiceNumber);
    if (duplicateWarning) {
      suggestion.extractionWarnings.push(duplicateWarning);
      suggestion.uncertainFields.push("invoiceNumber");
    }
    return applySupplierMemory(suggestion);
  });

export const getAutofillStatsFn = createServerFn({ method: "GET" }).handler(() => {
  const currentUser = getCurrentCrmIdentity();
  if (currentUser.role.toLowerCase() !== "admin") throw new Error("Only administrators can view auto-fill accuracy.");
  return getAutofillStats();
});

export const previewPaymentRequisitionFn = createServerFn({ method: "POST" })
  .validator((input: { fileName: string; fileData: string; mimeType?: string | undefined; manualEntry?: boolean | undefined; invoiceOverrides: InvoiceOverrides; approvedByName: string; financeApproverId: string; financePreparerId: string }) => input)
  .handler(async ({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    const submitterSignature = getUserSignature(currentUser.id);
    if (!submitterSignature) throw new Error("Save your signature before previewing the requisition.");
    const financeApprover = getFinanceApprover(data.financeApproverId);
    const financePreparer = getFinancePreparer(data.financePreparerId);
    const generated = await buildPaymentRequisition(Buffer.from(data.fileData, "base64"), data.fileName, {
      ...data.invoiceOverrides,
      department: currentUser.department,
      preparedByName: currentUser.full_name,
      approvedByName: data.approvedByName,
      financePreparerName: financePreparer.full_name,
      financeApproverName: financeApprover.full_name,
    }, {
      submitter: { mimeType: submitterSignature.mimeType, bytes: Buffer.from(submitterSignature.fileData, "base64") },
    }, { manual: data.manualEntry, mimeType: data.mimeType });
    return { fileName: generated.previewFileName, mimeType: generated.previewMimeType, fileData: generated.previewFileData };
  });

export const getPortalDataFn = createServerFn({ method: "GET" }).handler(() => {
  const currentUser = getCurrentCrmIdentity();
  upsertCrmProfile(currentUser);
  return { ...getPortalData(currentUser.id, currentUser.role.toLowerCase() === "admin"), currentUser };
});

export const getCrmDirectoryUsersFn = createServerFn({ method: "GET" }).handler(() => {
  getCurrentCrmIdentity();
  return fetchCrmDirectoryUsers();
});

export const syncCrmDirectoryUsersFn = createServerFn({ method: "POST" }).handler(() => {
  const currentUser = getCurrentCrmIdentity();
  if (currentUser.role.toLowerCase() !== "admin") throw new Error("Only CRM administrators can sync CRM users.");
  return fetchCrmDirectoryUsers();
});

export const getDocumentActivityFn = createServerFn({ method: "GET" })
  .validator((input: { documentId: string }) => input)
  .handler(({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    return getDocumentActivity(data.documentId, currentUser.id, currentUser.role.toLowerCase() === "admin");
  });

export const getDocumentFileFn = createServerFn({ method: "GET" })
  .validator((input: { documentId: string; mode?: "preview" | "download" }) => input)
  .handler(({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    return getDocumentFile(data.documentId, data.mode ?? "preview", currentUser.id, currentUser.role.toLowerCase() === "admin");
  });

export const getMySignatureFn = createServerFn({ method: "GET" }).handler(() => {
  const currentUser = getCurrentCrmIdentity();
  return getUserSignature(currentUser.id);
});

export const saveMySignatureFn = createServerFn({ method: "POST" })
  .validator((input: { mimeType: string; fileData: string }) => input)
  .handler(async ({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    return await saveUserSignature({ ...data, userId: currentUser.id });
  });

export const createPortalDocumentFn = createServerFn({ method: "POST" })
  .validator((input: {
    title: string;
    documentType: string;
    category: string;
    department: string;
    dueDate: string | null;
    fileName: string;
    mimeType: string;
    fileData: string;
    approverId: string | null;
    approverIds?: string[] | undefined;
    financeApproverId?: string | undefined;
    financePreparerId?: string | undefined;
    preparedByName?: string | undefined;
    approvedByName?: string | undefined;
    invoiceOverrides?: InvoiceOverrides | undefined;
    manualEntry?: boolean | undefined;
    autofill?: AutofillSnapshot | undefined;
  }) => input)
  .handler(async ({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    upsertCrmProfile(currentUser);
    const { autofill, ...documentInput } = data;
    const { generatedFields, ...document } = await createPortalDocument({
      ...documentInput,
      ownerId: currentUser.id,
    });
    if (generatedFields) {
      // Learning must never block a submission that has already succeeded.
      try {
        rememberSupplier(generatedFields, data.invoiceOverrides?.modeOfPayment ?? "EFT");
        if (!data.manualEntry && autofill) recordAutofillFeedback(document.id, generatedFields, autofill);
      } catch (error) {
        console.error("Could not update auto-fill memory", error);
      }
    }
    return document;
  });

export const updateDocumentStatusFn = createServerFn({ method: "POST" })
  .validator((input: { id: string; status: "rejected"; approverId?: string; comment?: string }) => input)
  .handler(({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    return updateDocumentStatus(data.id, data.status, currentUser.id, data.comment ?? "");
  });

export const updatePortalDocumentFn = createServerFn({ method: "POST" })
  .validator((input: {
    id: string;
    title: string;
    documentType: string;
    category: string;
    department: string;
    dueDate: string | null;
    approverIds: string[];
    financeApproverId: string;
    financePreparerId: string;
  }) => input)
  .handler(({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    return updatePortalDocument({
      ...data,
      actorId: currentUser.id,
      isAdmin: currentUser.role.toLowerCase() === "admin",
    });
  });

export const deletePortalDocumentFn = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    return deletePortalDocument(data.id, currentUser.id, currentUser.role.toLowerCase() === "admin");
  });

export const signDocumentFn = createServerFn({ method: "POST" })
  .validator((input: { documentId: string; signerId?: string; fileName: string; mimeType: string; fileData: string }) => input)
  .handler(({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    return signPortalDocument({ ...data, signerId: currentUser.id });
  });

export const upsertApproverProfileFn = createServerFn({ method: "POST" })
  .validator((input: { id?: string; full_name: string; email: string; department: string; finance_role?: "" | "preparer" | "approver"; is_admin?: boolean }) => input)
  .handler(({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    if (currentUser.role.toLowerCase() !== "admin") throw new Error("Only CRM administrators can manage approvers.");
    return upsertApproverProfile(data);
  });

export const deleteApproverProfileFn = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(({ data }) => {
    const currentUser = getCurrentCrmIdentity();
    if (currentUser.role.toLowerCase() !== "admin") throw new Error("Only CRM administrators can manage approvers.");
    return deleteApproverProfile(data.id);
  });
