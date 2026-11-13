import { useEffect, useState } from "react";
import { BadgeCheck, Download, Fingerprint, PenLine, Stamp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ContractPdfPages } from "./ContractPdfPages";
import { ReadonlyFieldLayer } from "./ContractFieldLayer";
import {
  getContractFn,
  getContractOriginalFn,
  getDocumentFileFn,
  getMySignatureFn,
  notarizeContractFn,
  saveMySignatureFn,
  signContractFn,
} from "@/lib/portal.functions";
import { CONTRACT_FIELD_LABELS, initialsOf, type ContractSummary } from "@/lib/contract-types";

type Signature = { mimeType: string; fileData: string };

function decode(base64: string) {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function download(file: { fileName: string; mimeType: string; fileData: string }) {
  const url = URL.createObjectURL(new Blob([decode(file.fileData)], { type: file.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function useContract(documentId: string, version: string) {
  const [summary, setSummary] = useState<ContractSummary | null>(null);
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setError("");
    void Promise.all([
      getContractFn({ data: { documentId } }),
      getDocumentFileFn({ data: { documentId, mode: "preview" } }),
    ])
      .then(([loadedSummary, file]) => {
        if (cancelled) return;
        setSummary(loadedSummary);
        setPdf(decode(file.fileData));
      })
      .catch((caught) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : "Could not load the contract.");
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, version]);
  return { summary, pdf, error };
}

function useMySignature() {
  const [signature, setSignature] = useState<Signature | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void getMySignatureFn()
      .then((saved) => {
        if (!cancelled) setSignature(saved);
      })
      .catch((caught) => {
        if (!cancelled)
          setError(
            caught instanceof Error ? caught.message : "Could not load your saved signature.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function save(file?: File) {
    if (!file) return;
    setError("");
    if (file.size > 2097152 || !["image/png", "image/jpeg"].includes(file.type)) {
      setError("Choose a PNG or JPEG signature image up to 2 MB.");
      return;
    }
    setSaving(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      setSignature(
        await saveMySignatureFn({ data: { mimeType: file.type, fileData: btoa(binary) } }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save your signature.");
    } finally {
      setSaving(false);
    }
  }
  return { signature, loading, saving, error, save };
}

function SignatureOnFile({ state }: { state: ReturnType<typeof useMySignature> }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="grid h-14 min-w-32 place-items-center rounded border bg-white px-3">
        {state.loading ? (
          <span className="text-xs text-muted-foreground">Loading…</span>
        ) : state.signature ? (
          <img
            src={`data:${state.signature.mimeType};base64,${state.signature.fileData}`}
            alt="Your saved signature"
            className="max-h-12 max-w-40 object-contain"
          />
        ) : (
          <span className="text-xs text-muted-foreground">No signature saved</span>
        )}
      </div>
      <label className="cursor-pointer text-sm font-semibold text-primary">
        {state.saving ? "Saving…" : state.signature ? "Replace signature" : "Upload your signature"}
        <input
          type="file"
          accept="image/png,image/jpeg"
          className="sr-only"
          disabled={state.saving || state.loading}
          onChange={(event) => {
            void state.save(event.target.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {state.error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}

function signerIndexOf(summary: ContractSummary) {
  return (id: string) =>
    Math.max(
      0,
      summary.signers.findIndex((signer) => signer.id === id),
    );
}

/** The Approvals view of a contract: the pages with the viewer's places highlighted, and sign / notarize / reject. */
export function ContractReviewCard({
  documentId,
  status,
  currentUserId,
  role,
  onDecision,
  onDone,
}: {
  documentId: string;
  status: string;
  currentUserId: string;
  role: "signer" | "notary";
  onDecision: (id: string, comment?: string) => Promise<void>;
  onDone: () => Promise<void>;
}) {
  const { summary, pdf, error: loadError } = useContract(documentId, status);
  const signature = useMySignature();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const myFields =
    summary?.fields.filter((field) => field.signerId === currentUserId && !field.completedAt) ?? [];
  const pages = [...new Set(myFields.map((field) => field.page + 1))];

  async function sign() {
    if (!signature.signature) return setError("Save your signature first.");
    setBusy(true);
    setError("");
    try {
      await signContractFn({
        data: {
          documentId,
          mimeType: signature.signature.mimeType,
          fileData: signature.signature.fileData,
        },
      });
      await onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign the contract.");
    } finally {
      setBusy(false);
    }
  }

  async function notarize() {
    setBusy(true);
    setError("");
    try {
      await notarizeContractFn({
        data: { documentId, identityConfirmed: confirmed },
      });
      await onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not notarize the contract.");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    setError("");
    try {
      await onDecision(documentId, reason);
      setReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reject the contract.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError)
    return (
      <p role="alert" className="mx-5 mb-4 rounded-md bg-warning-soft p-4 text-sm">
        {loadError}
      </p>
    );
  if (!summary || !pdf)
    return <p className="px-5 pb-4 text-sm text-muted-foreground">Loading contract…</p>;

  return (
    <div className="grid gap-5 px-5 pb-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="max-h-[78vh] overflow-auto rounded-md border bg-muted/30 p-3">
        <ContractPdfPages
          data={pdf}
          overlay={(page) => (
            <ReadonlyFieldLayer
              fields={summary.fields.filter((field) => field.page === page)}
              signerIndex={signerIndexOf(summary)}
              highlightSignerId={role === "signer" ? currentUserId : null}
            />
          )}
        />
      </div>
      <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
        {role === "signer" ? (
          <section className="space-y-3 rounded-md border p-4">
            <h3 className="flex items-center gap-2 font-semibold">
              <PenLine className="h-4 w-4 text-primary" />
              Your signature
            </h3>
            <p className="text-sm text-muted-foreground">
              {myFields.length
                ? `${myFields.length} ${myFields.length === 1 ? "place is" : "places are"} marked for you on ${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")}: ${[...new Set(myFields.map((field) => CONTRACT_FIELD_LABELS[field.kind].toLowerCase()))].join(", ")}.`
                : "No places are marked for you."}
            </p>
            <SignatureOnFile state={signature} />
            <p className="text-xs text-muted-foreground">
              By signing you agree that your saved signature, name, initials and today's date are
              applied to every highlighted place.
            </p>
            <Button
              type="button"
              className="w-full"
              onClick={() => void sign()}
              disabled={busy || signature.loading || !signature.signature || !myFields.length}
            >
              {busy ? "Signing…" : "Sign contract"}
            </Button>
          </section>
        ) : (
          <section className="space-y-3 rounded-md border p-4">
            <h3 className="flex items-center gap-2 font-semibold">
              <Stamp className="h-4 w-4 text-primary" />
              Notarize
            </h3>
            <p className="text-sm text-muted-foreground">
              All {summary.signers.length}{" "}
              {summary.signers.length === 1 ? "party has" : "parties have"} signed. Your initials
              will be written in the bottom-right corner of every page:
            </p>
            <div className="flex h-20 items-center justify-end rounded border bg-white px-6">
              <span
                className="-rotate-[4deg] text-3xl text-[#142a5c]"
                style={{ fontFamily: "'Homemade Apple', cursive" }}
              >
                {initialsOf(summary.notary?.full_name ?? "")}
              </span>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-1 h-4 w-4"
              />
              <span>
                I verified the identity of{" "}
                {summary.signers.map((signer) => signer.full_name).join(", ")} and they confirmed
                their signatures to me.
              </span>
            </label>
            <Button
              type="button"
              className="w-full"
              onClick={() => void notarize()}
              disabled={busy || !confirmed}
            >
              {busy ? "Notarizing…" : "Notarize contract"}
            </Button>
          </section>
        )}
        <section className="space-y-2 rounded-md border p-4">
          <label className="block text-sm font-semibold">
            Reject reason
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              className="mt-2 min-h-16"
              placeholder="Explain what needs to change."
            />
          </label>
          <Button
            type="button"
            variant="destructive"
            className="w-full"
            onClick={() => void reject()}
            disabled={busy || !reason.trim()}
          >
            Reject
          </Button>
        </section>
        {error && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}
      </aside>
    </div>
  );
}

/** Contract facts in the Documents list: signing progress, notarization and fingerprints. */
export function ContractInfoPanel({ documentId, status }: { documentId: string; status: string }) {
  const [summary, setSummary] = useState<ContractSummary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void getContractFn({ data: { documentId } })
      .then((loaded) => {
        if (!cancelled) setSummary(loaded);
      })
      .catch((caught) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : "Could not load contract details.");
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, status]);
  if (error) return <p className="px-5 pb-4 text-sm text-destructive">{error}</p>;
  if (!summary) return null;
  const signedCount = summary.signers.filter((signer) => signer.status === "approved").length;
  return (
    <div className="px-5 pb-4">
      <div className="space-y-3 rounded-md border bg-muted/20 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span>
            <span className="font-semibold">
              {signedCount} of {summary.signers.length}
            </span>{" "}
            signed · {summary.fields.length} signature{" "}
            {summary.fields.length === 1 ? "place" : "places"} · {summary.pageCount}{" "}
            {summary.pageCount === 1 ? "page" : "pages"}
          </span>
          {summary.notarize && (
            <span className="inline-flex items-center gap-1.5">
              {summary.notarizedAt ? (
                <BadgeCheck className="h-4 w-4 text-success" />
              ) : (
                <Stamp className="h-4 w-4 text-muted-foreground" />
              )}
              {summary.notarizedAt
                ? `Notarized by ${summary.notary?.full_name} (initials ${initialsOf(summary.notary?.full_name ?? "")})`
                : `To be notarized by ${summary.notary?.full_name ?? "a notary"}`}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() =>
              void getContractOriginalFn({ data: { documentId } })
                .then(download)
                .catch((caught) =>
                  setError(
                    caught instanceof Error ? caught.message : "Could not download the original.",
                  ),
                )
            }
          >
            <Download className="h-4 w-4" />
            Original upload
          </Button>
        </div>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <span className="flex items-start gap-1.5 break-all">
            <Fingerprint className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Original SHA-256: <code>{summary.originalSha256}</code>
          </span>
          {summary.finalSha256 && (
            <span className="flex items-start gap-1.5 break-all">
              <Fingerprint className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Final SHA-256: <code>{summary.finalSha256}</code>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function ContractDownloadButton({ documentId }: { documentId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void getDocumentFileFn({ data: { documentId, mode: "download" } })
          .then(download)
          .finally(() => setBusy(false));
      }}
    >
      <Download className="h-4 w-4" />
      {busy ? "Preparing…" : "Download signed PDF"}
    </Button>
  );
}
