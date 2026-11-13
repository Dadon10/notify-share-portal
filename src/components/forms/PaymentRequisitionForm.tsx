import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ArrowLeft, FilePlus2, Paperclip, PencilLine, ScanText, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DrawSignatureButton } from "@/components/SignaturePad";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createPortalDocumentFn,
  getCrmDirectoryUsersFn,
  getMySignatureFn,
  getPortalDataFn,
  previewPaymentRequisitionFn,
  saveMySignatureFn,
  suggestInvoiceFieldsFn,
} from "@/lib/portal.functions";

export type Profile = {
  id: string;
  full_name: string;
  email: string;
  department: string;
  finance_role: "" | "preparer" | "approver";
  is_admin: boolean;
  role?: string;
  has_signature?: boolean;
};
type LocalUser = { id: string; full_name?: string };
type EntryMode = "auto" | "manual";
type FieldOrigin = "read" | "remembered" | "none";
type AutofillSnapshot = {
  suggested: Partial<Record<keyof ManualInvoiceFields, string>>;
  origins: Partial<Record<keyof ManualInvoiceFields, FieldOrigin>>;
};
const MANUAL_ATTACHMENT_TYPES = ["application/pdf", "image/png", "image/jpeg"];
const MAX_UPLOAD_BYTES = 20971520;
type ManualInvoiceFields = {
  invoiceNumber: string;
  invoiceDate: string;
  billingPeriod: string;
  accountId: string;
  payee: string;
  amount: string;
  currency: string;
  expenditureItem: string;
  budgeted: "Y" | "N";
  businessMotivation: string;
  paymentPurpose: string;
};

const categories = {
  Finance: ["Payment requisition", "Invoice", "Purchase order", "Expense claim", "Receipt"],
  IT: ["Payment requisition", "Invoice", "Purchase order", "Service request"],
  HR: ["Leave request", "Employment contract", "Onboarding record", "Employee request"],
  Legal: ["Agreement", "Legal opinion", "Contract review"],
  Compliance: ["Policy", "Audit evidence", "Risk assessment"],
  Operations: ["Service request", "Incident report", "Project document"],
  Contracts: ["Contract"],
  Custom: ["Custom document"],
};

/**
 * Rendered inside the dashboard (embedded) or on its own page. The parent decides what happens after submit or
 * cancel, so the dashboard can switch tabs instead of loading a new page.
 */
export function PaymentRequisitionForm({
  user,
  profiles,
  embedded = false,
  onDone,
  onCancel,
  onOpenContract,
}: {
  user: LocalUser;
  profiles: Profile[];
  embedded?: boolean;
  onDone: () => void;
  onCancel: () => void;
  onOpenContract: () => void;
}) {
  const empty = useMemo<ManualInvoiceFields>(
    () => ({
      invoiceNumber: "",
      invoiceDate: "",
      billingPeriod: "",
      accountId: "",
      payee: "",
      amount: "",
      currency: "",
      expenditureItem: "",
      budgeted: "Y",
      businessMotivation: "",
      paymentPurpose: "",
    }),
    [],
  );
  const [category, setCategory] = useState<keyof typeof categories>("Finance");
  const [entryMode, setEntryMode] = useState<EntryMode>("auto");
  const isManual = entryMode === "manual";
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [queuedInvoices, setQueuedInvoices] = useState<File[]>([]);
  const addInvoicesInputRef = useRef<HTMLInputElement>(null);
  const [crmDirectoryUsers, setCrmDirectoryUsers] = useState<Profile[] | null>(null);
  const [completedInvoices, setCompletedInvoices] = useState(0);
  const [fileData, setFileData] = useState("");
  const [loadingInvoice, setLoadingInvoice] = useState(false);
  const [previewingPr, setPreviewingPr] = useState(false);
  const [prPreviewUrl, setPrPreviewUrl] = useState("");
  const [submitterSignature, setSubmitterSignature] = useState<{
    mimeType: string;
    fileData: string;
  } | null>(null);
  const [loadingSignature, setLoadingSignature] = useState(false);
  const [savingSignature, setSavingSignature] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState<ManualInvoiceFields>(empty);
  const [uncertain, setUncertain] = useState<string[]>([]);
  const [extractionWarnings, setExtractionWarnings] = useState<string[]>([]);
  const [fieldSources, setFieldSources] = useState<Partial<Record<string, string>>>({});
  const [fieldOrigins, setFieldOrigins] = useState<Partial<Record<string, FieldOrigin>>>({});
  const [rememberedSupplier, setRememberedSupplier] = useState<{
    payee: string;
    useCount: number;
  } | null>(null);
  const [autofillSnapshot, setAutofillSnapshot] = useState<AutofillSnapshot | null>(null);
  const eligibleProfiles = useMemo(() => {
    const financeOrAdminIds = new Set(
      profiles.filter((profile) => profile.finance_role).map((profile) => profile.id),
    );
    return (
      crmDirectoryUsers?.filter(
        (profile) =>
          profile.id !== user.id && !profile.finance_role && !financeOrAdminIds.has(profile.id),
      ) ?? []
    );
  }, [crmDirectoryUsers, profiles, user.id]);
  const financePreparers = useMemo(
    () => profiles.filter((profile) => profile.finance_role === "preparer"),
    [profiles],
  );
  const financeApprovers = useMemo(
    () => profiles.filter((profile) => profile.finance_role === "approver"),
    [profiles],
  );
  const [approverId, setApproverId] = useState("");
  const [preparedById, setPreparedById] = useState(financePreparers[0]?.id ?? "");
  const [financeApproverId, setFinanceApproverId] = useState(financeApprovers[0]?.id ?? "");
  const [modeOfPayment, setModeOfPayment] = useState<"Cash" | "Cheque" | "EFT" | "TT" | "Mobile">(
    "EFT",
  );
  useEffect(
    () => () => {
      if (prPreviewUrl) URL.revokeObjectURL(prPreviewUrl);
    },
    [prPreviewUrl],
  );
  useEffect(() => {
    let cancelled = false;
    setCrmDirectoryUsers(null);
    void getCrmDirectoryUsersFn()
      .then((users) => {
        if (cancelled) return;
        const directoryUsers = users.map((identity) => ({
          id: identity.id,
          full_name: identity.full_name,
          email: identity.email,
          department: identity.department,
          finance_role: "" as const,
          is_admin: identity.role.toLowerCase() === "admin",
          role: identity.role,
        }));
        setCrmDirectoryUsers(directoryUsers);
        setApproverId("");
      })
      .catch((caught) => {
        if (!cancelled) {
          setCrmDirectoryUsers([]);
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load CRM users for the approval order.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);
  useEffect(() => {
    let cancelled = false;
    setPreparedById(financePreparers[0]?.id ?? "");
    setFinanceApproverId(financeApprovers[0]?.id ?? "");
    setLoadingSignature(true);
    void getMySignatureFn()
      .then((signature) => {
        if (!cancelled) setSubmitterSignature(signature);
      })
      .catch((caught) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : "Could not load your signature.");
      })
      .finally(() => {
        if (!cancelled) setLoadingSignature(false);
      });
    return () => {
      cancelled = true;
    };
  }, [financeApprovers, financePreparers, user.id]);
  function changeCategory(value: keyof typeof categories) {
    // Contracts need signature places marked on the PDF, which happens on the contract page.
    if (value === "Contracts") {
      onOpenContract();
      return;
    }
    setCategory(value);
  }
  async function encodeFile(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  }
  async function savePersonalSignature(file?: File) {
    if (!file) return;
    setError("");
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setError("Choose a PNG or JPEG signature image.");
      return;
    }
    if (file.size > 2097152) {
      setError("Signature images must be 2 MB or smaller.");
      return;
    }
    setSavingSignature(true);
    try {
      const signature = await saveMySignatureFn({
        data: { mimeType: file.type, fileData: await encodeFile(file) },
      });
      setSubmitterSignature(signature);
      setPrPreviewUrl("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save your signature.");
    } finally {
      setSavingSignature(false);
    }
  }
  function changeEntryMode(mode: EntryMode) {
    if (mode === entryMode) return;
    setEntryMode(mode);
    setSelectedFile(null);
    setFileData("");
    setQueuedInvoices([]);
    setCompletedInvoices(0);
    setManual(empty);
    setUncertain([]);
    setExtractionWarnings([]);
    resetAutofillContext();
    setPrPreviewUrl("");
    setError("");
  }
  function resetAutofillContext() {
    setFieldSources({});
    setFieldOrigins({});
    setRememberedSupplier(null);
    setAutofillSnapshot(null);
  }
  async function selectManualAttachment(file?: File) {
    if (!file) return;
    setError("");
    const lowerName = file.name.toLowerCase();
    const allowed =
      MANUAL_ATTACHMENT_TYPES.includes(file.type) || /\.(pdf|png|jpe?g)$/.test(lowerName);
    if (!allowed) {
      setError("Attach a PDF, PNG or JPEG file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("Attachments must be 20 MB or smaller.");
      return;
    }
    setLoadingInvoice(true);
    try {
      // Keep whatever the user has already typed; only the attachment changes.
      setFileData(await encodeFile(file));
      setSelectedFile(file);
      setPrPreviewUrl("");
    } catch {
      setError("Could not read the attachment. Try choosing it again.");
    } finally {
      setLoadingInvoice(false);
    }
  }
  function attachmentMimeType(file: File) {
    if (file.type) return file.type;
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".png")) return "image/png";
    if (/\.jpe?g$/.test(lowerName)) return "image/jpeg";
    return "application/pdf";
  }
  async function selectInvoice(file?: File) {
    if (!file) return;
    setError("");
    setSelectedFile(file);
    setManual(empty);
    setUncertain([]);
    setExtractionWarnings([]);
    resetAutofillContext();
    setLoadingInvoice(true);
    setFileData("");
    setPrPreviewUrl("");
    if (file.size > 20971520) {
      setError("Invoices must be 20 MB or smaller.");
      setLoadingInvoice(false);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Choose a PDF invoice.");
      setLoadingInvoice(false);
      return;
    }
    try {
      const encoded = await encodeFile(file);
      setFileData(encoded);
      const suggestion = await suggestInvoiceFieldsFn({
        data: { fileName: file.name, fileData: encoded },
      });
      const suggestedFields: ManualInvoiceFields = {
        invoiceNumber: suggestion.invoiceNumber,
        invoiceDate: suggestion.invoiceDate,
        billingPeriod: suggestion.billingPeriod,
        accountId: suggestion.accountId,
        payee: suggestion.payee,
        amount: suggestion.amount,
        currency: suggestion.currency,
        expenditureItem: suggestion.expenditureItem,
        budgeted: suggestion.budgeted,
        businessMotivation: "",
        paymentPurpose: suggestion.paymentPurpose,
      };
      setManual(suggestedFields);
      if (suggestion.modeOfPayment) setModeOfPayment(suggestion.modeOfPayment);
      setUncertain(suggestion.uncertainFields);
      setExtractionWarnings(suggestion.extractionWarnings);
      setFieldSources(suggestion.sources);
      setFieldOrigins(suggestion.origins);
      setRememberedSupplier(suggestion.rememberedSupplier);
      // Snapshot of what auto-fill offered, compared with the submitted values to measure accuracy.
      const { businessMotivation: _unused, ...tracked } = suggestedFields;
      setAutofillSnapshot({ suggested: tracked, origins: suggestion.origins });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not read this invoice. Enter the PR details below.",
      );
      setUncertain(Object.keys(empty));
      setExtractionWarnings([]);
    } finally {
      setLoadingInvoice(false);
    }
  }
  async function selectInvoices(files: FileList | File[] | undefined) {
    const incoming = Array.from(files ?? []);
    if (!incoming.length) return;
    const pdfs = incoming.filter((file) => file.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) {
      setError("Choose one or more PDF invoices.");
      return;
    }
    if (pdfs.length !== incoming.length)
      setError("Non-PDF files were skipped. Reading the selected PDF invoices.");
    setQueuedInvoices(pdfs.slice(1));
    setCompletedInvoices(0);
    await selectInvoice(pdfs[0]);
  }
  function appendInvoices(files: FileList | File[] | undefined) {
    const incoming = Array.from(files ?? []);
    if (!incoming.length) return;
    const pdfs = incoming.filter(
      (file) => file.name.toLowerCase().endsWith(".pdf") && file.size <= 20971520,
    );
    const skipped = incoming.length - pdfs.length;
    if (!pdfs.length) {
      setError("Choose PDF invoices no larger than 20 MB each.");
      return;
    }
    setQueuedInvoices((queue) => [...queue, ...pdfs]);
    setError(skipped ? "Some files were skipped. Only PDF invoices up to 20 MB can be added." : "");
  }
  async function selectBatchInvoice(index: number) {
    if (index === 0 || !selectedFile) return;
    const nextQueue = [...queuedInvoices];
    const [nextFile] = nextQueue.splice(index - 1, 1);
    if (!nextFile) return;
    nextQueue.unshift(selectedFile);
    setQueuedInvoices(nextQueue);
    await selectInvoice(nextFile);
  }
  function currentInvoiceOverrides() {
    const budgeted: "Y" | "N" = manual.budgeted === "N" ? "N" : "Y";
    return {
      invoiceNumber: manual.invoiceNumber || undefined,
      invoiceDate: manual.invoiceDate || undefined,
      billingPeriod: manual.billingPeriod || undefined,
      accountId: manual.accountId || undefined,
      payee: manual.payee || undefined,
      amount: manual.amount ? Number(manual.amount.replaceAll(",", "")) : undefined,
      currency: manual.currency || undefined,
      expenditureItem: manual.expenditureItem.trim() || undefined,
      budgeted,
      businessMotivation: manual.businessMotivation.trim() || undefined,
      paymentPurpose: manual.paymentPurpose.trim() || undefined,
      modeOfPayment,
    };
  }
  async function previewPr() {
    if (!selectedFile || !fileData) {
      setError(isManual ? "Attach the supporting document first." : "Choose an invoice first.");
      return;
    }
    if (!preparedById) {
      setError("Choose a Finance Preparer configured in Settings.");
      return;
    }
    if (!financeApproverId) {
      setError("Choose a Finance Approver configured in Settings.");
      return;
    }
    if (!approverId) {
      setError("Choose an approver.");
      return;
    }
    if (!submitterSignature) {
      setError("Save your signature before previewing the requisition.");
      return;
    }
    setPreviewingPr(true);
    setError("");
    try {
      const file = await previewPaymentRequisitionFn({
        data: {
          fileName: selectedFile.name,
          fileData,
          mimeType: attachmentMimeType(selectedFile),
          manualEntry: isManual,
          invoiceOverrides: currentInvoiceOverrides(),
          financeApproverId,
          financePreparerId: preparedById,
          approvedByName:
            eligibleProfiles.find((profile) => profile.id === approverId)?.full_name ||
            financeApprovers.find((profile) => profile.id === financeApproverId)?.full_name ||
            "Approver",
        },
      });
      const bytes = Uint8Array.from(atob(file.fileData), (character) => character.charCodeAt(0));
      setPrPreviewUrl(URL.createObjectURL(new Blob([bytes], { type: file.mimeType })));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not generate the requisition preview.",
      );
    } finally {
      setPreviewingPr(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    if (!selectedFile || !fileData) {
      setError(isManual ? "Attach the supporting document first." : "Choose an invoice first.");
      setSaving(false);
      return;
    }
    const form = new FormData(event.currentTarget);
    const requiredKeys: [keyof ManualInvoiceFields, string][] = [
      ["invoiceNumber", "invoice number"],
      ["invoiceDate", "invoice date"],
      ["billingPeriod", "billing period"],
      ["payee", "supplier"],
      ["amount", "invoice amount"],
      ["currency", "currency"],
      ["expenditureItem", "expenditure item"],
      ["paymentPurpose", "being payment for"],
    ];
    const missing = requiredKeys.find(([key]) => !manual[key].trim());
    if (missing) {
      setError(`Enter the ${missing[1]} before submitting.`);
      setSaving(false);
      return;
    }
    if (manual.budgeted === "N" && !manual.businessMotivation.trim()) {
      setError("Enter the business motivation before submitting.");
      setSaving(false);
      return;
    }
    if (!approverId) {
      setError("Choose an approver.");
      setSaving(false);
      return;
    }
    if (!preparedById) {
      setError("Choose a Finance Preparer configured in Settings.");
      setSaving(false);
      return;
    }
    if (!financeApproverId) {
      setError("Choose a Finance Approver configured in Settings.");
      setSaving(false);
      return;
    }
    if (!submitterSignature) {
      setError("Save your signature before submitting the requisition.");
      setSaving(false);
      return;
    }
    if (!prPreviewUrl) {
      setError("Preview the payment requisition before submitting it.");
      setSaving(false);
      return;
    }
    try {
      await createPortalDocumentFn({
        data: {
          title: isManual ? "Manual payment requisition" : "Invoice payment requisition",
          documentType: String(form.get("type")),
          category,
          department: String(form.get("department") || category),
          dueDate: String(form.get("due") || "") || null,
          fileName: selectedFile.name,
          mimeType: attachmentMimeType(selectedFile),
          fileData,
          approverId,
          approverIds: [approverId],
          financeApproverId,
          financePreparerId: preparedById,
          invoiceOverrides: currentInvoiceOverrides(),
          manualEntry: isManual,
          autofill: !isManual && autofillSnapshot ? autofillSnapshot : undefined,
        },
      });
      const nextQueue = queuedInvoices;
      setCompletedInvoices((count) => count + 1);
      setPrPreviewUrl("");
      if (nextQueue.length) {
        setQueuedInvoices(nextQueue.slice(1));
        await selectInvoice(nextQueue[0]);
      } else {
        setQueuedInvoices([]);
        onDone();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not prepare the requisition.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div
      className={
        embedded
          ? "mx-auto max-w-[1500px] p-4 md:p-8"
          : "min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8"
      }
    >
      <div className={embedded ? "" : "mx-auto max-w-screen-2xl"}>
        <header className="mb-8">
          {embedded ? (
            <p className="mb-1 text-sm font-semibold text-primary">DOCUMENT CONTROL</p>
          ) : (
            <button
              type="button"
              onClick={onCancel}
              className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Document Hub
            </button>
          )}
          <h1
            className={
              embedded
                ? "text-3xl font-bold tracking-normal md:text-4xl"
                : "text-3xl font-bold tracking-tight"
            }
          >
            New payment requisition
          </h1>
          <p className="mt-2 text-muted-foreground">
            {isManual
              ? "Type the requisition details yourself and attach the supporting document. It will be attached behind the PR."
              : "Choose a category and document type, then upload the invoice. We’ll fill the requisition for you to review."}
          </p>
        </header>
        <form
          onSubmit={submit}
          className="grid gap-5 rounded-lg border bg-card p-5 shadow-sm sm:grid-cols-2 sm:p-8 xl:grid-cols-3"
        >
          <fieldset className="sm:col-span-2 xl:col-span-3">
            <legend className="mb-2 text-sm font-semibold">
              How do you want to create this PR?
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    mode: "auto",
                    icon: ScanText,
                    title: "Auto-fill from invoice",
                    text: "Upload PDF invoices and we read the details for you to confirm.",
                  },
                  {
                    mode: "manual",
                    icon: PencilLine,
                    title: "Enter manually",
                    text: "Type every detail yourself and attach any PDF or image, for invoices we can’t read.",
                  },
                ] as const
              ).map((option) => {
                const active = entryMode === option.mode;
                const Icon = option.icon;
                return (
                  <button
                    key={option.mode}
                    type="button"
                    aria-pressed={active}
                    disabled={saving || loadingInvoice}
                    onClick={() => changeEntryMode(option.mode)}
                    className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                      active
                        ? "border-primary bg-accent ring-1 ring-primary"
                        : "bg-background hover:border-primary/50 hover:bg-muted/40"
                    }`}
                  >
                    <span
                      className={`grid h-10 w-10 shrink-0 place-items-center rounded-md ${active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold">{option.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {option.text}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="block text-sm font-semibold">
            Category
            <select
              value={category}
              onChange={(event) => changeCategory(event.target.value as keyof typeof categories)}
              className="form-select mt-2"
            >
              {Object.keys(categories).map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold">
            Document type
            <select name="type" className="form-select mt-2">
              {categories[category].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          {isManual && (
            <label
              className="upload-zone sm:col-span-2 xl:col-span-3"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void selectManualAttachment(event.dataTransfer.files[0]);
              }}
            >
              <Paperclip className="h-7 w-7 text-primary" />
              <span className="font-semibold">
                {selectedFile?.name || "Drop the supporting document here or choose a file"}
              </span>
              <span className="text-xs text-muted-foreground">
                PDF, PNG or JPG · up to 20 MB · attached behind the PR just like an invoice
              </span>
              <input
                type="file"
                className="sr-only"
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                onChange={(event) => {
                  void selectManualAttachment(event.target.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          )}
          {!isManual && (
            <label
              className="upload-zone sm:col-span-2 xl:col-span-3"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void selectInvoices(event.dataTransfer.files);
              }}
            >
              <UploadCloud className="h-7 w-7 text-primary" />
              <span className="font-semibold">
                {selectedFile?.name || "Drop invoice PDFs here or choose files"}
              </span>
              <span className="text-xs text-muted-foreground">
                Select multiple PDF invoices · up to 20 MB each · read and submit one requisition at
                a time
              </span>
              <input
                name="file"
                type="file"
                multiple
                className="sr-only"
                accept=".pdf,application/pdf"
                onChange={(event) => {
                  void selectInvoices(event.target.files ?? undefined);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          )}
          {selectedFile && !isManual && (
            <div className="sm:col-span-2 xl:col-span-3">
              <input
                ref={addInvoicesInputRef}
                type="file"
                multiple
                accept=".pdf,application/pdf"
                className="sr-only"
                aria-label="Add invoice files"
                onChange={(event) => {
                  appendInvoices(event.target.files ?? undefined);
                  event.currentTarget.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={saving || loadingInvoice}
                onClick={() => addInvoicesInputRef.current?.click()}
              >
                <FilePlus2 className="h-4 w-4" />
                Add more invoices
              </Button>
            </div>
          )}
          {loadingInvoice && (
            <p className="text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">
              {isManual ? "Loading attachment…" : "Reading invoice…"}
            </p>
          )}
          {(isManual || (selectedFile && !loadingInvoice)) && (
            <ManualInvoiceFields
              mode={entryMode}
              sources={isManual ? {} : fieldSources}
              origins={isManual ? {} : fieldOrigins}
              rememberedSupplier={isManual ? null : rememberedSupplier}
              value={manual}
              onChange={(value) => {
                setManual(value);
                setPrPreviewUrl("");
              }}
              uncertain={uncertain}
              warnings={extractionWarnings}
            />
          )}
          {(queuedInvoices.length > 0 || completedInvoices > 0) && (
            <p className="text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">
              Batch progress: {completedInvoices} submitted
              {queuedInvoices.length
                ? `, ${queuedInvoices.length + 1} invoice${queuedInvoices.length === 0 ? "" : "s"} remaining including this one`
                : ". All selected invoices are submitted."}
            </p>
          )}
          {selectedFile && queuedInvoices.length > 0 && (
            <label className="block text-sm font-semibold sm:col-span-2 xl:col-span-3">
              Invoice to preview
              <select
                aria-label="Choose invoice to preview"
                value="0"
                onChange={(event) => void selectBatchInvoice(Number(event.target.value))}
                disabled={loadingInvoice || saving}
                className="form-select mt-2"
              >
                {[selectedFile, ...queuedInvoices].map((file, index) => (
                  <option key={`${file.name}-${index}`} value={index}>
                    {index === 0 ? "Currently selected: " : "Select: "}
                    {file.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm font-semibold sm:col-span-2 xl:col-span-3">
            Approval
            {crmDirectoryUsers === null && (
              <p className="mt-2 text-xs text-muted-foreground">Loading users from CRM…</p>
            )}
            {crmDirectoryUsers !== null && eligibleProfiles.length === 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                No eligible CRM users are available.
              </p>
            )}
            <select
              aria-label="Approval"
              value={approverId}
              onChange={(event) => {
                setApproverId(event.target.value);
                setPrPreviewUrl("");
              }}
              disabled={crmDirectoryUsers === null}
              className="form-select mt-2"
              required
            >
              <option value="">
                {crmDirectoryUsers === null ? "Loading CRM users…" : "Choose an approver"}
              </option>
              {eligibleProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.full_name || profile.email}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold">
            Finance Approver
            <select
              name="financeApprover"
              value={financeApproverId}
              onChange={(event) => {
                setFinanceApproverId(event.target.value);
                setPrPreviewUrl("");
              }}
              className="form-select mt-2"
              required
            >
              <option value="">Choose Finance Approver</option>
              {financeApprovers.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.full_name || profile.email}
                </option>
              ))}
            </select>
            {financeApprovers.find((profile) => profile.id === financeApproverId)?.has_signature ===
              false && (
              <span className="mt-1 block text-xs font-normal text-amber-700">
                No saved signature is on file. The line will stay blank until this approver signs.
              </span>
            )}
          </label>
          <label className="block text-sm font-semibold">
            Finance Preparer
            <select
              name="financePreparer"
              value={preparedById}
              onChange={(event) => {
                setPreparedById(event.target.value);
                setPrPreviewUrl("");
              }}
              className="form-select mt-2"
              required
            >
              <option value="">Choose Finance Preparer</option>
              {financePreparers.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.full_name || profile.email}
                </option>
              ))}
            </select>
            {financePreparers.find((profile) => profile.id === preparedById)?.has_signature ===
              false && (
              <span className="mt-1 block text-xs font-normal text-amber-700">
                No saved signature is on file. The line will stay blank until this preparer signs.
              </span>
            )}
            <span className="mt-1 block text-xs font-normal text-muted-foreground">
              Requester: {user.full_name || "Your CRM account"}
            </span>
          </label>
          <label className="block text-sm font-semibold">
            Mode of Payment
            <select
              name="modeOfPayment"
              value={modeOfPayment}
              onChange={(event) => {
                setModeOfPayment(event.target.value as typeof modeOfPayment);
                setPrPreviewUrl("");
              }}
              className="form-select mt-2"
            >
              <option>Cash</option>
              <option>Cheque</option>
              <option>EFT</option>
              <option>TT</option>
              <option>Mobile</option>
            </select>
          </label>
          <div className="rounded-md border bg-muted/20 p-3 text-sm sm:col-span-2 xl:col-span-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="grid h-14 min-w-32 place-items-center rounded border bg-white px-3">
                {loadingSignature ? (
                  <span className="text-xs text-muted-foreground">Loading signature…</span>
                ) : submitterSignature ? (
                  <img
                    src={`data:${submitterSignature.mimeType};base64,${submitterSignature.fileData}`}
                    alt="Your signature"
                    className="max-h-12 max-w-40 object-contain"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">Signature required</span>
                )}
              </div>
              <label className="cursor-pointer font-semibold text-primary">
                {savingSignature
                  ? "Saving…"
                  : submitterSignature
                    ? "Replace your signature"
                    : "Save your signature to sign and submit"}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  className="sr-only"
                  disabled={savingSignature || loadingSignature}
                  onChange={(event) => {
                    void savePersonalSignature(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <DrawSignatureButton
                onDrawn={(file) => savePersonalSignature(file)}
                disabled={savingSignature || loadingSignature}
                label="or draw it"
              />
              <span className="text-xs text-muted-foreground">
                Use a clear signature on a plain background (PNG or JPG). We remove the background
                and place it neatly on the PR; screenshots and photos are rejected.
              </span>
            </div>
          </div>
          {selectedFile && !loadingInvoice && (
            <div className="sm:col-span-2 xl:col-span-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => void previewPr()}
                disabled={previewingPr || loadingSignature}
              >
                {previewingPr ? "Preparing preview…" : "Preview PR"}
              </Button>
              {prPreviewUrl && (
                <iframe
                  src={prPreviewUrl}
                  title="Payment requisition preview"
                  className="mt-3 h-[55vh] min-h-[420px] w-full rounded-md border bg-white"
                />
              )}
            </div>
          )}
          {error && (
            <p className="text-sm font-medium text-destructive sm:col-span-2 xl:col-span-3">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3 sm:col-span-2 xl:col-span-3">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            {selectedFile && (
              <Button type="submit" disabled={saving || loadingInvoice}>
                {saving ? "Preparing…" : "Submit requisition"}
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function ManualInvoiceFields({
  mode,
  sources,
  origins,
  rememberedSupplier,
  value,
  onChange,
  uncertain,
  warnings,
}: {
  mode: EntryMode;
  sources: Partial<Record<string, string>>;
  origins: Partial<Record<string, FieldOrigin>>;
  rememberedSupplier: { payee: string; useCount: number } | null;
  value: ManualInvoiceFields;
  onChange: (value: ManualInvoiceFields) => void;
  uncertain: string[];
  warnings: string[];
}) {
  const [amountFocused, setAmountFocused] = useState(false);
  const update =
    (key: keyof ManualInvoiceFields) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      onChange({ ...value, [key]: event.target.value });
  const labels: Record<keyof ManualInvoiceFields, string> = {
    invoiceNumber: "Invoice number",
    invoiceDate: "Invoice date",
    billingPeriod: "Billing period",
    accountId: "Account ID",
    payee: "Supplier",
    amount: "Invoice amount",
    currency: "Currency",
    expenditureItem: "Expenditure Item",
    budgeted: "Budgeted (Y/N)",
    businessMotivation: "Business Motivation",
    paymentPurpose: "Being payment for",
  };
  return (
    <section
      className={`grid gap-3 rounded-md border p-4 sm:col-span-2 xl:col-span-3 xl:grid-cols-3 ${mode === "manual" ? "bg-muted/20" : "border-amber-300 bg-amber-50"}`}
    >
      <h3 className="text-sm font-semibold sm:col-span-2 xl:col-span-3">
        {mode === "manual" ? "Requisition details" : "Confirm the invoice details"}
      </h3>
      <p className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-3">
        {mode === "manual"
          ? "Enter the details exactly as they should appear on the PR. Account ID is optional."
          : "Review the extracted details and correct any highlighted fields."}
      </p>
      {rememberedSupplier && (
        <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 sm:col-span-2 xl:col-span-3">
          Recognised <span className="font-semibold">{rememberedSupplier.payee}</span> from{" "}
          {rememberedSupplier.useCount === 1
            ? "a previous PR"
            : `${rememberedSupplier.useCount} previous PRs`}
          . Fields marked “Remembered” were filled from the last one; check they still apply.
        </p>
      )}
      {(Object.keys(labels) as (keyof ManualInvoiceFields)[]).map((key) => {
        const isWide = key === "businessMotivation" || key === "paymentPurpose";
        const fieldClass = `mt-1 w-full rounded-md border bg-background px-3 text-sm ${uncertain.includes(key) ? "border-amber-500 bg-amber-100 focus-visible:ring-amber-400" : ""}`;
        return (
          <label
            key={key}
            className={`text-sm font-semibold ${isWide ? "sm:col-span-2 xl:col-span-3" : ""}`}
          >
            {labels[key]}
            {key === "budgeted" ? (
              <select
                value={value.budgeted}
                onChange={update("budgeted")}
                className={`${fieldClass} h-10`}
              >
                <option value="Y">Y</option>
                <option value="N">N</option>
              </select>
            ) : key === "currency" ? (
              <select
                value={value.currency}
                onChange={update(key)}
                className={`${fieldClass} h-10`}
              >
                <option value="">Choose ISO currency</option>
                <option value="ZMW">ZMW</option>
                <option value="USD">USD</option>
              </select>
            ) : key === "businessMotivation" ? (
              <Textarea
                value={value.businessMotivation}
                onChange={update(key)}
                required={value.budgeted === "N"}
                className={`${fieldClass} min-h-24`}
                placeholder="Explain why this expenditure is not budgeted."
              />
            ) : key === "invoiceDate" && mode === "manual" ? (
              <Input
                type="date"
                value={value.invoiceDate}
                onChange={update(key)}
                className={`${fieldClass} h-10`}
              />
            ) : key === "amount" ? (
              <Input
                type="text"
                inputMode="decimal"
                value={
                  amountFocused
                    ? value.amount.replaceAll(",", "")
                    : formatInvoiceAmount(value.amount)
                }
                onFocus={() => setAmountFocused(true)}
                onBlur={() => {
                  setAmountFocused(false);
                  onChange({ ...value, amount: formatInvoiceAmount(value.amount) });
                }}
                onChange={update(key)}
                className={`${fieldClass} h-10`}
                placeholder="0.00"
              />
            ) : (
              <Input
                value={value[key]}
                onChange={update(key)}
                className={`${fieldClass} h-10`}
                placeholder={
                  key === "expenditureItem"
                    ? "e.g. Telephone"
                    : key === "billingPeriod"
                      ? "e.g. October 2026"
                      : key === "payee"
                        ? "Supplier name"
                        : undefined
                }
              />
            )}
            {sources[key] && (
              <span
                className={`mt-1 block text-[0.7rem] font-normal ${origins[key] === "remembered" ? "text-sky-700" : "text-muted-foreground"}`}
              >
                {sources[key]}
              </span>
            )}
          </label>
        );
      })}
      {warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-amber-900 sm:col-span-2 xl:col-span-3">
          {warnings.map((warning, index) => (
            <li key={`${index}-${warning}`}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatInvoiceAmount(value: string) {
  const normalized = value.replaceAll(",", "").trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(normalized);
  if (!match) return value;
  const integer = (match[2] || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${match[1]}${integer}${match[3] === undefined ? "" : `.${match[3]}`}`;
}
