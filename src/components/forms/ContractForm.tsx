import { useMemo, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CalendarDays,
  FileSignature,
  MousePointerClick,
  PenLine,
  Stamp,
  Type,
  UploadCloud,
  UserPlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContractPdfPages } from "@/components/contract/ContractPdfPages";
import {
  EditableFieldLayer,
  FIELD_DRAG_TYPE,
  newField,
  signerColor,
  type EditableField,
} from "@/components/contract/ContractFieldLayer";
import { createContractFn, getPortalDataFn } from "@/lib/portal.functions";
import {
  CONTRACT_DOCUMENT_TYPES,
  CONTRACT_FIELD_LABELS,
  type ContractFieldKind,
} from "@/lib/contract-types";

export type Profile = {
  id: string;
  full_name: string;
  email: string;
  department: string;
  is_admin: boolean;
  is_notary: boolean;
};

const MAX_UPLOAD_BYTES = 20971520;
const departments = [
  "Legal",
  "Human Resources",
  "Finance",
  "Compliance",
  "Operations",
  "IT",
  "Procurement",
  "Administration",
  "General",
];
const FIELD_ICONS: Record<ContractFieldKind, typeof PenLine> = {
  signature: PenLine,
  initials: FileSignature,
  date: CalendarDays,
  name: Type,
};

/**
 * Rendered inside the dashboard (embedded) or on its own page. The parent decides what happens after submit or
 * cancel, so the dashboard can switch tabs instead of loading a new page.
 */
export function ContractForm({
  user,
  profiles,
  embedded = false,
  onDone,
  onCancel,
}: {
  user: { id: string; full_name: string; department: string };
  profiles: Profile[];
  embedded?: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [documentType, setDocumentType] = useState<string>(CONTRACT_DOCUMENT_TYPES[0]);
  const [department, setDepartment] = useState(
    departments.includes(user.department) ? user.department : "Legal",
  );
  const [dueDate, setDueDate] = useState("");
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [signerIds, setSignerIds] = useState<string[]>([]);
  const [candidateId, setCandidateId] = useState("");
  const [activeSignerId, setActiveSignerId] = useState<string | null>(null);
  const [fields, setFields] = useState<EditableField[]>([]);
  const [armed, setArmed] = useState<ContractFieldKind | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notarize, setNotarize] = useState(false);
  const [notaryId, setNotaryId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const profileById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles],
  );
  const nameOf = (id: string) =>
    id === user.id
      ? `${user.full_name} (you)`
      : profileById.get(id)?.full_name || profileById.get(id)?.email || "Unknown";
  const signerIndex = (id: string) => Math.max(0, signerIds.indexOf(id));
  const notaries = profiles.filter(
    (profile) => profile.is_notary && profile.id !== user.id && !signerIds.includes(profile.id),
  );
  const candidates = [
    ...(signerIds.includes(user.id) ? [] : [{ id: user.id, label: `${user.full_name} (you)` }]),
    ...profiles
      .filter(
        (profile) =>
          profile.id !== user.id && !signerIds.includes(profile.id) && profile.id !== notaryId,
      )
      .map((profile) => ({
        id: profile.id,
        label: `${profile.full_name || profile.email}${profile.department ? ` · ${profile.department}` : ""}`,
      })),
  ];
  const missingSignature = signerIds.filter(
    (id) => !fields.some((field) => field.signerId === id && field.kind === "signature"),
  );

  async function chooseFile(next?: File) {
    setError("");
    if (!next) return;
    if (next.type !== "application/pdf" && !/\.pdf$/i.test(next.name))
      return setError("Contracts must be PDF files. Save Word contracts as PDF first.");
    if (next.size > MAX_UPLOAD_BYTES) return setError("The contract must be 20 MB or smaller.");
    if (
      fields.length &&
      !window.confirm("Replace the contract? Signature places you marked will be removed.")
    )
      return;
    setFields([]);
    setPageCount(0);
    setFile({ name: next.name, bytes: new Uint8Array(await next.arrayBuffer()) });
    if (!title.trim())
      setTitle(
        next.name
          .replace(/\.pdf$/i, "")
          .replace(/[_-]+/g, " ")
          .trim()
          .slice(0, 160),
      );
  }

  function addSigner(id: string) {
    if (!id || signerIds.includes(id)) return;
    setSignerIds((current) => [...current, id]);
    setActiveSignerId(id);
    setCandidateId("");
  }

  function removeSigner(id: string) {
    const placed = fields.filter((field) => field.signerId === id).length;
    if (
      placed &&
      !window.confirm(
        `Remove ${nameOf(id)}? Their ${placed} signature ${placed === 1 ? "place" : "places"} will be removed too.`,
      )
    )
      return;
    setSignerIds((current) => current.filter((signerId) => signerId !== id));
    setFields((current) => current.filter((field) => field.signerId !== id));
    if (activeSignerId === id)
      setActiveSignerId(signerIds.find((signerId) => signerId !== id) ?? null);
  }

  function moveSigner(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= signerIds.length) return;
    setSignerIds((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function place(kind: ContractFieldKind, page: number, x: number, y: number) {
    if (!activeSignerId) {
      setError("Add a signer and pick who you are placing boxes for.");
      return;
    }
    const field = newField(kind, activeSignerId, page, x, y);
    setFields((current) => [...current, field]);
    setSelectedKey(field.key);
    setArmed(null);
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!file) return setError("Upload the contract PDF.");
    if (!title.trim()) return setError("Give the contract a title.");
    if (!signerIds.length) return setError("Add at least one signer.");
    if (missingSignature.length)
      return setError(`Place a signature box for ${missingSignature.map(nameOf).join(", ")}.`);
    if (notarize && !notaryId) return setError("Choose the notary, or untick notarization.");
    setSaving(true);
    try {
      let binary = "";
      for (let offset = 0; offset < file.bytes.length; offset += 0x8000)
        binary += String.fromCharCode(...file.bytes.subarray(offset, offset + 0x8000));
      await createContractFn({
        data: {
          title: title.trim(),
          documentType,
          department,
          dueDate: dueDate || null,
          fileName: file.name,
          fileData: btoa(binary),
          signerIds,
          fields: fields.map(({ key: _key, ...field }) => field),
          notarize,
          notaryId: notarize ? notaryId : null,
        },
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the contract.");
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
        <header className="mb-6">
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
            New contract
          </h1>
          <p className="mt-2 text-muted-foreground">
            Upload the contract, choose who signs and in what order, then mark where each person
            signs. Add a notary if it must be notarized.
          </p>
        </header>
        <form
          onSubmit={submit}
          className="grid items-start gap-6 lg:grid-cols-[380px_minmax(0,1fr)]"
        >
          <div className="space-y-5 lg:sticky lg:top-6">
            <section className="space-y-4 rounded-lg border bg-card p-5 shadow-sm">
              <h2 className="font-bold">1. Contract</h2>
              <label
                className="upload-zone !min-h-28"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void chooseFile(event.dataTransfer.files[0]);
                }}
              >
                <UploadCloud className="h-6 w-6 text-primary" />
                <span className="text-sm font-semibold break-all">
                  {file?.name || "Drop the contract PDF here or choose a file"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {file
                    ? `${pageCount || "…"} ${pageCount === 1 ? "page" : "pages"} · click to replace`
                    : "PDF up to 20 MB"}
                </span>
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  className="sr-only"
                  onChange={(event) => {
                    void chooseFile(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <label className="block text-sm font-semibold">
                Title
                <Input
                  required
                  maxLength={160}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="mt-2 h-11"
                  placeholder="e.g. Office lease – Cairo Road"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-semibold">
                  Type
                  <select
                    value={documentType}
                    onChange={(event) => setDocumentType(event.target.value)}
                    className="form-select mt-2"
                  >
                    {CONTRACT_DOCUMENT_TYPES.map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-semibold">
                  Department
                  <select
                    value={department}
                    onChange={(event) => setDepartment(event.target.value)}
                    className="form-select mt-2"
                  >
                    {departments.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block text-sm font-semibold">
                Sign by (optional)
                <Input
                  type="date"
                  min={today}
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  className="mt-2 h-11"
                />
              </label>
            </section>

            <section className="space-y-3 rounded-lg border bg-card p-5 shadow-sm">
              <div>
                <h2 className="font-bold">2. Signers</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  People sign one after another in this order. Each gets an email when it's their
                  turn.
                </p>
              </div>
              {signerIds.length > 0 && (
                <ol className="space-y-2">
                  {signerIds.map((id, index) => {
                    const count = fields.filter((field) => field.signerId === id).length;
                    const active = id === activeSignerId;
                    return (
                      <li
                        key={id}
                        className={`flex items-center gap-2 rounded-md border p-2 ${active ? "ring-2" : ""}`}
                        style={
                          active ? { ["--tw-ring-color" as string]: signerColor(index) } : undefined
                        }
                      >
                        <button
                          type="button"
                          onClick={() => setActiveSignerId(id)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          aria-pressed={active}
                          title="Place boxes for this signer"
                        >
                          <span
                            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white"
                            style={{ background: signerColor(index) }}
                          >
                            {index + 1}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{nameOf(id)}</span>
                            <span
                              className={`block text-[11px] ${missingSignature.includes(id) ? "text-destructive" : "text-muted-foreground"}`}
                            >
                              {count
                                ? `${count} ${count === 1 ? "place" : "places"}`
                                : "No places yet"}
                              {missingSignature.includes(id) && count
                                ? " · needs a signature box"
                                : ""}
                            </span>
                          </span>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={`Move ${nameOf(id)} up`}
                          disabled={index === 0}
                          onClick={() => moveSigner(index, -1)}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={`Move ${nameOf(id)} down`}
                          disabled={index === signerIds.length - 1}
                          onClick={() => moveSigner(index, 1)}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={`Remove ${nameOf(id)}`}
                          onClick={() => removeSigner(id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </li>
                    );
                  })}
                </ol>
              )}
              <div className="flex gap-2">
                <select
                  aria-label="Add signer"
                  value={candidateId}
                  onChange={(event) => setCandidateId(event.target.value)}
                  className="form-select"
                >
                  <option value="">Choose a person from the CRM…</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!candidateId}
                  onClick={() => addSigner(candidateId)}
                >
                  <UserPlus className="h-4 w-4" />
                  Add
                </Button>
              </div>
            </section>

            <section className="space-y-3 rounded-lg border bg-card p-5 shadow-sm">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={notarize}
                  onChange={(event) => setNotarize(event.target.checked)}
                  className="mt-1 h-4 w-4 accent-[var(--color-primary)]"
                />
                <span>
                  <span className="flex items-center gap-2 font-bold">
                    <Stamp className="h-4 w-4 text-primary" />
                    3. Notarize this contract
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    After every party signs, the notary verifies identities and adds their
                    signature, seal and a notarial certificate.
                  </span>
                </span>
              </label>
              {notarize &&
                (notaries.length ? (
                  <label className="block text-sm font-semibold">
                    Notary
                    <select
                      value={notaryId}
                      onChange={(event) => setNotaryId(event.target.value)}
                      className="form-select mt-2"
                      required
                    >
                      <option value="">Choose a notary…</option>
                      {notaries.map((notary) => (
                        <option key={notary.id} value={notary.id}>
                          {notary.full_name}
                          {notary.department ? ` · ${notary.department}` : ""}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block text-xs font-normal text-muted-foreground">
                      A notary can't also be a signer or the sender.
                    </span>
                  </label>
                ) : (
                  <p className="rounded-md bg-warning-soft p-3 text-sm">
                    No notaries are available. An administrator can mark someone as a notary in
                    Settings.
                  </p>
                ))}
            </section>

            {error && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !file}>
                {saving
                  ? "Sending…"
                  : notarize
                    ? "Send for signature & notarization"
                    : "Send for signature"}
              </Button>
            </div>
          </div>

          <section className="min-w-0 rounded-lg border bg-muted/30 shadow-sm">
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-lg border-b bg-card/95 p-3 backdrop-blur">
              <span className="mr-1 text-sm font-semibold">4. Mark places for</span>
              <select
                aria-label="Signer to place boxes for"
                value={activeSignerId ?? ""}
                onChange={(event) => setActiveSignerId(event.target.value || null)}
                className="form-select !h-9 !w-auto max-w-56"
                disabled={!signerIds.length}
              >
                {!signerIds.length && <option value="">Add a signer first</option>}
                {signerIds.map((id) => (
                  <option key={id} value={id}>
                    {nameOf(id)}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(CONTRACT_FIELD_LABELS) as ContractFieldKind[]).map((kind) => {
                  const Icon = FIELD_ICONS[kind];
                  const color = activeSignerId
                    ? signerColor(signerIndex(activeSignerId))
                    : undefined;
                  return (
                    <button
                      key={kind}
                      type="button"
                      draggable={Boolean(activeSignerId && file)}
                      disabled={!activeSignerId || !file}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(FIELD_DRAG_TYPE, kind);
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => setArmed((current) => (current === kind ? null : kind))}
                      aria-pressed={armed === kind}
                      className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${armed === kind ? "text-white" : "bg-background hover:bg-muted"}`}
                      style={
                        armed === kind
                          ? { background: color, borderColor: color }
                          : color
                            ? { borderColor: `${color}88`, color }
                            : undefined
                      }
                    >
                      <Icon className="h-4 w-4" />
                      {CONTRACT_FIELD_LABELS[kind]}
                    </button>
                  );
                })}
              </div>
              <p className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
                <MousePointerClick className="h-3.5 w-3.5" />
                {armed
                  ? `Click on the page where the ${CONTRACT_FIELD_LABELS[armed].toLowerCase()} goes.`
                  : "Drag a box onto the page, or click a box type then click the page. Drag boxes to move them; use the corner to resize."}
              </p>
            </div>
            <div className="max-h-[calc(100vh-8rem)] overflow-auto p-4">
              {file ? (
                <ContractPdfPages
                  data={file.bytes}
                  onPageCount={setPageCount}
                  className="mx-auto max-w-[900px]"
                  overlay={(page, size) => (
                    <EditableFieldLayer
                      page={page}
                      size={size}
                      fields={fields.filter((field) => field.page === page)}
                      signerIndex={signerIndex}
                      signerName={nameOf}
                      armed={armed}
                      selectedKey={selectedKey}
                      onSelect={setSelectedKey}
                      onChange={(key, patch) =>
                        setFields((current) =>
                          current.map((field) =>
                            field.key === key ? { ...field, ...patch } : field,
                          ),
                        )
                      }
                      onPlace={place}
                      onRemove={(key) =>
                        setFields((current) => current.filter((field) => field.key !== key))
                      }
                    />
                  )}
                />
              ) : (
                <div className="grid min-h-[50vh] place-items-center text-center text-sm text-muted-foreground">
                  <div>
                    <FileSignature className="mx-auto mb-3 h-10 w-10" />
                    Upload the contract to start marking signature places.
                  </div>
                </div>
              )}
            </div>
          </section>
        </form>
      </div>
    </div>
  );
}
