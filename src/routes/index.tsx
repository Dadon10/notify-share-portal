import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  Bell, Check, CheckCircle2, ChevronDown, Clock3, FileCheck2, FilePlus2, FileSignature,
  Files, FolderOpen, LayoutDashboard, Menu, PenLine, Pencil, Search, Settings, ArrowDown, ArrowUp,
  ShieldCheck, Trash2, UploadCloud, Users, X, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRangeFilter, type DateFilter } from "@/components/DateRangeFilter";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  createPortalDocumentFn,
  deletePortalDocumentFn,
  deleteApproverProfileFn,
  getDocumentActivityFn,
  getDocumentFileFn,
  getAutofillStatsFn,
  getCrmDirectoryUsersFn,
  getMySignatureFn,
  getPortalDataFn,
  previewPaymentRequisitionFn,
  saveMySignatureFn,
  signDocumentFn,
  suggestInvoiceFieldsFn,
  syncCrmDirectoryUsersFn,
  upsertApproverProfileFn,
  updateDocumentStatusFn,
  updatePortalDocumentFn,
} from "@/lib/portal.functions";
import { CONTRACT_DOCUMENT_TYPES } from "@/lib/contract-types";
import { ContractDownloadButton, ContractInfoPanel, ContractReviewCard } from "@/components/contract/ContractPanels";

type DocStatus = string;
type PortalDocument = {
  id: string; title: string; document_type: string; category: string; department: string;
  status: DocStatus; due_date: string | null; created_at: string; worked_at: string; owner_id: string;
  is_contract?: boolean;
  approver_ids?: string[];
  active_approver_id?: string | null;
  approval_steps?: { approver_id: string; full_name: string; email: string; sequence_no: number; status: string; decided_at: string | null; role_label?: string }[];
};
type Profile = { id: string; full_name: string; email: string; department: string; finance_role: "" | "preparer" | "approver"; is_admin: boolean; role?: string; is_notary?: boolean; notary_commission?: string; notary_jurisdiction?: string; notary_commission_expires?: string };
type LocalUser = { id: string; full_name?: string };
type PortalRole = "admin" | "approver" | "submitter";
type ManualInvoiceFields = { invoiceNumber: string; invoiceDate: string; billingPeriod: string; accountId: string; payee: string; amount: string; currency: string; expenditureItem: string; budgeted: "Y" | "N"; businessMotivation: string; paymentPurpose: string };
const CRM_USER_ID = "00000000-0000-4000-8000-000000000001";
const CRM_SIGN_IN_REQUIRED_MESSAGE = "Your Document Hub session is not active. Sign in to the CRM and then return here to continue.";

function isCrmSignInError(error: unknown) {
  return error instanceof Error && /^(Sign in through the CRM to open Document Hub\.|Your CRM sign-in has expired or is invalid\. Reopen Document Hub from the CRM\.)$/.test(error.message);
}

function getEffectiveRole(isAdmin: boolean, hasLocalOverride: boolean): PortalRole {
  if (isAdmin || hasLocalOverride) return "admin";
  return "submitter";
}

const categories = {
  Finance: ["Payment requisition", "Invoice", "Purchase order", "Expense claim", "Receipt"],
  IT: ["Payment requisition", "Invoice", "Purchase order", "Service request"],
  HR: ["Leave request", "Employment contract", "Onboarding record", "Employee request"],
  Legal: ["Agreement", "Legal opinion", "Contract review"],
  Compliance: ["Policy", "Audit evidence", "Risk assessment"],
  Operations: ["Service request", "Incident report", "Project document"],
  Contracts: [...CONTRACT_DOCUMENT_TYPES] as string[],
  Custom: ["Custom document"],
};

const departments = [
  "Finance",
  "Human Resources",
  "Legal",
  "Compliance",
  "Operations",
  "IT",
  "Procurement",
  "Administration",
  "General",
];

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Document Hub | Sanlam" },
      { name: "description", content: "Secure document submission, approvals, and tracking for Sanlam teams." },
      { property: "og:title", content: "Sanlam Document Hub" },
      { property: "og:description", content: "A secure workspace for company documents, approvals, and status updates." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  loader: async () => {
    try {
      return { data: await getPortalDataFn(), error: "" };
    } catch (error) {
      if (isCrmSignInError(error)) return { data: null, error: CRM_SIGN_IN_REQUIRED_MESSAGE };
      return {
        data: null,
        error: error instanceof Error ? error.message : "The portal data could not be loaded.",
      };
    }
  },
  component: Portal,
});

function Portal() {
  const initial = Route.useLoaderData();
  const navigate = useNavigate();
  const [active, setActive] = useState("Overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [search, setSearch] = useState("");
  const [documents, setDocuments] = useState<PortalDocument[]>(() => initial.data?.documents as PortalDocument[] ?? []);
  const [profiles, setProfiles] = useState<Profile[]>(() => initial.data?.profiles as Profile[] ?? []);
  const [currentUser, setCurrentUser] = useState<Profile | null>(() => {
    const user = initial.data?.currentUser;
    return user ? {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      department: user.department,
      finance_role: "",
      role: user.role,
      is_admin: user.role.toLowerCase() === "admin",
    } : null;
  });
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState(initial.error);
  const [approvalDocumentId, setApprovalDocumentId] = useState<string | null>(null);
  const activeUser = currentUser ?? { id: CRM_USER_ID, full_name: "CRM account", email: "", department: "", finance_role: "" as const, role: "", is_admin: false };
  const isAdmin = Boolean(activeUser.is_admin);
  const effectiveRole = getEffectiveRole(isAdmin, false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkedDocumentId = params.get("documentId");
    if (linkedDocumentId) {
      setApprovalDocumentId(linkedDocumentId);
      setActive("Approvals");
    }
    const refreshWhenReturning = () => {
      if (document.visibilityState === "visible") void loadData();
    };
    window.addEventListener("focus", refreshWhenReturning);
    window.addEventListener("pageshow", refreshWhenReturning);
    return () => {
      window.removeEventListener("focus", refreshWhenReturning);
      window.removeEventListener("pageshow", refreshWhenReturning);
    };
  }, []);

  async function loadData() {
    try {
      setLoadError("");
      const data = await getPortalDataFn();
      setDocuments(data.documents as PortalDocument[]);
      setProfiles(data.profiles as Profile[]);
      const crmUser = data.currentUser;
      setCurrentUser({
        id: crmUser.id,
        full_name: crmUser.full_name,
        email: crmUser.email,
        department: crmUser.department,
        finance_role: "",
        role: crmUser.role,
        is_admin: crmUser.role.toLowerCase() === "admin",
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The portal data could not be loaded.";
      console.error(caught);
      setLoadError(message);
    }
  }

  const visible = useMemo(() => {
    const list = documents;
    const q = search.toLowerCase();
    return list.filter((d) => !q || `${d.title} ${d.document_type} ${d.category}`.toLowerCase().includes(q));
  }, [documents, search]);

  const counts = {
    all: visible.length,
    pending: visible.filter((d) => isPendingStatus(d.status)).length,
    approved: visible.filter((d) => d.status === "Completed" || d.status === "approved" || d.status === "signed").length,
    attention: visible.filter((d) => d.status === "Rejected" || d.status === "rejected" || d.status === "returned").length,
  };

  if (loadError) {
    const needsCrmSignIn = loadError === CRM_SIGN_IN_REQUIRED_MESSAGE;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-8 text-center shadow-sm sm:p-10">
          <img src="/sanlam-logo.png" alt="Sanlam" className="mx-auto mb-8 h-auto w-36" />
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">Portal access</p>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">Sign in to continue</h1>
          <p className="mt-4 text-base text-muted-foreground">
            {needsCrmSignIn
              ? "Your Document Hub session is not active. Sign in to the CRM and then return here to continue."
              : loadError}
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
            {needsCrmSignIn ? (
              <Button className="w-full sm:w-auto" onClick={() => window.location.assign("http://172.29.4.43/")}>
                Sign in to CRM
              </Button>
            ) : (
              <Button className="w-full sm:w-auto" onClick={() => void loadData()}>
                Try again
              </Button>
            )}
            {!needsCrmSignIn && (
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => window.location.assign("http://172.29.4.43/")}>
                Open CRM
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className={`fixed inset-y-0 left-0 z-40 w-64 border-r border-sidebar-border bg-sidebar transition-transform lg:translate-x-0 ${mobileNav ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-20 items-center justify-between border-b border-sidebar-border px-6">
          <img src="/sanlam-logo.png" alt="Sanlam" className="h-8 w-auto rounded-sm" />
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X /></Button>
        </div>
        <nav className="space-y-1 p-4" aria-label="Main navigation">
          {[{n:"Overview",i:LayoutDashboard},{n:"Documents",i:Files},{n:"Approvals",i:FileCheck2},{n:"Templates",i:FolderOpen}].map(({n,i:Icon}) => (
            <Button key={n} variant={active === n ? "navActive" : "nav"} className="w-full justify-start" onClick={() => {setActive(n);setMobileNav(false)}}><Icon />{n}{n === "Approvals" && <span className="ml-auto rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-bold text-warning">{counts.pending}</span>}</Button>
          ))}
        </nav>
        <div className="absolute bottom-0 w-full border-t border-sidebar-border p-4">
          <Button variant="nav" className="w-full justify-start" onClick={() => setActive("Settings")}><Settings />Settings</Button>
          <div className="mt-3 flex items-center gap-3 rounded-md bg-sidebar-accent p-3">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{(activeUser.full_name || "C").charAt(0).toUpperCase()}</div>
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{activeUser.full_name}</p><p className="truncate text-xs text-muted-foreground">{activeUser.role || effectiveRole}</p></div>
          </div>
        </div>
      </aside>

      <main className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-20 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur lg:px-8">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu /></Button>
          <div className="relative max-w-xl flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/><Input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="Search documents, people or reference…" className="h-11 bg-muted/60 pl-10 shadow-none" /></div>
          <Button variant="ghost" size="icon" aria-label="Notifications"><Bell /></Button>
          <Button
            variant="outline"
            className="hidden sm:inline-flex"
            onClick={() => void navigate({ to: "/contract" })}
          >
            <FileSignature />
            New contract
          </Button>
          <Button
            variant="default"
            className="hidden sm:inline-flex"
            onClick={() => void navigate({ to: "/payment-requisition" })}
          >
            <FilePlus2 />
            New document
          </Button>
          <Button
            variant="default"
            size="icon"
            className="sm:hidden"
            onClick={() => void navigate({ to: "/payment-requisition" })}
            aria-label="New document"
          >
            <FilePlus2 />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="sm:hidden"
            onClick={() => void navigate({ to: "/contract" })}
            aria-label="New contract"
          >
            <FileSignature />
          </Button>
        </header>

          <div className={`mx-auto max-w-[1500px] p-4 md:p-8 ${active !== "Overview" ? "hidden" : ""}`}>
          <div className="mb-8 flex items-end justify-between gap-4">
            <div><p className="mb-1 text-sm font-semibold text-primary">DOCUMENT CONTROL</p><h1 className="text-3xl font-bold tracking-normal md:text-4xl">{active}</h1><p className="mt-2 text-muted-foreground">Track submissions, reviews and decisions across your organisation.</p></div>
            <p className="hidden text-sm text-muted-foreground md:block">{formatToday()}</p>
          </div>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Document summary">
            <Metric label="Total documents" value={counts.all} icon={Files} tone="blue" />
            <Metric label="Pending review" value={counts.pending} icon={Clock3} tone="amber" />
            <Metric label="Approved" value={counts.approved} icon={CheckCircle2} tone="green" />
            <Metric label="Needs attention" value={counts.attention} icon={ShieldCheck} tone="red" />
          </section>

          <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div>
              <div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-bold">Recent documents</h2><p className="text-sm text-muted-foreground">Latest activity across your accessible records</p></div><Button variant="outline" size="sm" onClick={() => setActive("Documents")}>View all</Button></div>
              <div className="overflow-hidden rounded-lg border bg-card">
                <div className="hidden grid-cols-[minmax(0,1fr)_150px_130px_110px] gap-4 border-b bg-muted/50 px-5 py-3 text-xs font-semibold uppercase text-muted-foreground md:grid"><span>Document</span><span>Department</span><span>Status</span><span>Due date</span></div>
                {visible.map((doc) => <DocumentRow key={doc.id} doc={doc} />)}
                {!visible.length && <div className="px-6 py-16 text-center"><FolderOpen className="mx-auto mb-3 h-9 w-9 text-muted-foreground"/><p className="font-semibold">No documents found</p><p className="mt-1 text-sm text-muted-foreground">Create a document or adjust your search.</p></div>}
              </div>
            </div>
            <aside className="space-y-6">
              <div className="rounded-lg bg-primary p-6 text-primary-foreground shadow-brand">
                <div className="mb-6 flex items-start justify-between"><div className="rounded-md bg-primary-foreground/15 p-2.5"><UploadCloud className="h-5 w-5"/></div><span className="text-xs font-semibold opacity-75">QUICK START</span></div>
                <h2 className="text-xl font-bold">Submit a new document</h2><p className="mt-2 text-sm leading-6 opacity-80">Upload files, select reviewers and follow every decision in one place.</p>
                <Button
                  variant="onPrimary"
                  className="mt-5 w-full"
                  onClick={() => void navigate({ to: "/payment-requisition" })}
                >
                  Start submission
                </Button>
                <button
                  type="button"
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 text-sm font-semibold opacity-90 hover:underline"
                  onClick={() => void navigate({ to: "/contract" })}
                >
                  <FileSignature className="h-4 w-4" />
                  Send a contract for signature
                </button>
              </div>
              <div className="rounded-lg border bg-card p-5">
                <div className="flex items-center justify-between"><h2 className="font-bold">Review queue</h2><span className="text-xs font-semibold text-primary">{counts.pending} OPEN</span></div>
                <div className="mt-4 space-y-4">{visible.filter(d=>isPendingStatus(d.status)).slice(0,3).map(d=><div key={d.id} className="flex gap-3"><div className="mt-1 h-2 w-2 rounded-full bg-warning"/><div className="min-w-0"><p className="truncate text-sm font-semibold">{d.title}</p><p className="text-xs text-muted-foreground">Due {formatDate(d.due_date)}</p></div></div>)}</div>
              </div>
            </aside>
          </section>
        </div>
        {active === "Templates" && <TemplateLibrary />}
        {active === "Settings" && isAdmin && <SettingsWorkspace profiles={profiles} onSaved={loadData} onDeleted={loadData} />}
        {!isAdmin && active === "Settings" && <div className="mx-auto max-w-[1500px] p-4 md:p-8"><div className="rounded-lg border border-dashed bg-card p-10 text-center"><p className="text-lg font-bold">Administrator access required</p><p className="mt-2 text-sm text-muted-foreground">Sign in with a CRM administrator account to manage portal settings.</p></div></div>}
        {(active === "Documents" || active === "Approvals") && <DocumentWorkspace active={active} documents={documents} profiles={profiles} currentUserId={activeUser.id} isAdmin={isAdmin} focusedDocumentId={approvalDocumentId} search={search} onDecision={async (id, comment) => { await updateDocumentStatusFn({ data: { id, status: "rejected", comment: comment ?? "" } }); await loadData(); }} onSigned={loadData} />}
      </main>
      {notice && <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-md bg-success px-4 py-3 text-sm font-semibold text-success-foreground shadow-xl"><Check className="h-4 w-4"/>{notice}<button onClick={()=>setNotice("")} aria-label="Dismiss"><X className="h-4 w-4"/></button></div>}
    </div>
  );
}

const templates = [
  { name: "PR Form - Airtel [Bulk SMS]", file: "PR Form - Airtel [Bulk SMS] 20260817.docx", category: "Finance" },
  { name: "PR Form - Infratel Corporation [Azure]", file: "PR Form - Infratel Corporation [Azure] 20260916.docx", category: "Finance" },
];

function TemplateLibrary() {
  return <div className="mx-auto max-w-[1500px] p-4 md:p-8"><div className="mb-8"><p className="mb-1 text-sm font-semibold text-primary">DOCUMENT CONTROL</p><h1 className="text-3xl font-bold tracking-normal md:text-4xl">Templates</h1><p className="mt-2 text-muted-foreground">Download approved templates for new document submissions.</p></div><div className="grid gap-4 md:grid-cols-2">{templates.map((template) => <div key={template.file} className="flex items-center gap-4 rounded-lg border bg-card p-5"><div className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-accent text-primary"><Files className="h-5 w-5" /></div><div className="min-w-0 flex-1"><p className="truncate font-semibold">{template.name}</p><p className="mt-1 text-sm text-muted-foreground">{template.category} · DOCX template</p></div><a href={`/templates/${encodeURIComponent(template.file)}`} download={template.file} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-semibold hover:bg-muted"><UploadCloud className="h-4 w-4 rotate-180" />Download</a></div>)}</div></div>;
}

function DocumentWorkspace({active,documents,profiles,currentUserId,isAdmin,focusedDocumentId,search,onDecision,onSigned}:{active:"Documents"|"Approvals";documents:PortalDocument[];profiles:Profile[];currentUserId:string;isAdmin:boolean;focusedDocumentId:string|null;search:string;onDecision:(id:string,comment?:string)=>Promise<void>;onSigned:()=>Promise<void>}) {
  const [dateRange,setDateRange]=useState<DateFilter>(null);
  const [datePreset,setDatePreset]=useState("all");
  const [expandedIds,setExpandedIds]=useState<Set<string>>(()=>new Set());
  const isDocuments=active==="Documents";
  const pending=documents.filter(document=>isPendingStatus(document.status));
  const waitingForMe=pending.filter(document=>document.active_approver_id===currentUserId);
  const items=active==="Approvals"?(focusedDocumentId?waitingForMe.filter(document=>document.id===focusedDocumentId):waitingForMe):documents;
  const query=search.trim().toLowerCase();
  const dated=useMemo(()=>items.map(document=>{const value=getDateInputValue(document.worked_at);return {document,y:value.slice(0,4),m:value.slice(5,7),d:value.slice(8,10)};}),[items]);
  const filtered=dated.filter(({document})=>{
    const matchesSearch=!query||`${document.title} ${document.document_type} ${document.category} ${document.department}`.toLowerCase().includes(query);
    const workedTime=document.worked_at?new Date(document.worked_at).getTime():NaN;
    const matchesDate=!isDocuments||!dateRange||(workedTime>=dateRange.from.getTime()&&workedTime<=dateRange.to.getTime());
    return matchesSearch&&matchesDate;
  }).sort((a,b)=>isDocuments?(b.document.worked_at??"").localeCompare(a.document.worked_at??""):0);
  const groups:{key:string;label:string;entries:typeof filtered}[]=[];
  for(const entry of filtered){
    const key=isDocuments&&entry.y?`${entry.y}-${entry.m}`:"all";
    let group=groups[groups.length-1];
    if(!group||group.key!==key){group={key,label:key==="all"?"":`${MONTH_NAMES[Number(entry.m)-1]} ${entry.y}`,entries:[]};groups.push(group);}
    group.entries.push(entry);
  }
  function toggleExpanded(id:string){setExpandedIds(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});}
  function clearDates(){setDateRange(null);setDatePreset("all");}
  const hasDateFilters=Boolean(dateRange);
  const hasFilters=Boolean(search.trim()||hasDateFilters);
  return <div className="mx-auto max-w-[1500px] p-4 md:p-8">
    <div className="mb-8"><p className="mb-1 text-sm font-semibold text-primary">DOCUMENT CONTROL</p><h1 className="text-3xl font-bold tracking-normal md:text-4xl">{active}</h1><p className="mt-2 text-muted-foreground">{active==="Approvals"?"Preview each requisition or contract before signing, notarizing or rejecting it.":"Browse and manage your accessible documents."}</p></div>
    {isDocuments&&<div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
      <DateRangeFilter presetKey={datePreset} value={dateRange} onChange={(range,key)=>{setDateRange(range);setDatePreset(key);}}/>
      <div className="ml-auto text-right"><p className="text-sm font-semibold">{filtered.length} {filtered.length===1?"document":"documents"}</p><p className="text-xs text-muted-foreground">Dated by latest signature/approval, or submission.</p></div>
    </div>}
    <div className="space-y-6">{groups.map(group=><section key={group.key}>
      {group.label&&<div className="mb-2 flex items-baseline gap-2 px-1"><h2 className="text-sm font-bold uppercase tracking-wide text-foreground">{group.label}</h2><span className="text-xs text-muted-foreground">{group.entries.length} {group.entries.length===1?"document":"documents"}</span></div>}
      <div className="space-y-3">{group.entries.map(({document})=>{
        const expanded=!isDocuments||expandedIds.has(document.id);
        if(!isDocuments&&document.is_contract){
          const activeStep=document.approval_steps?.find(step=>step.status==="pending");
          return <div key={document.id} className="overflow-hidden rounded-lg border bg-card shadow-sm">
            <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-5"><div className="min-w-0"><h2 className="truncate text-lg font-bold">{document.title}</h2><p className="text-sm text-muted-foreground">{document.document_type} · {document.department||"General"}</p></div><Status status={document.status}/></div>
            <ContractReviewCard documentId={document.id} status={document.status} currentUserId={currentUserId} role={activeStep?.role_label==="Notary"?"notary":"signer"} onDecision={onDecision} onDone={onSigned}/>
            <div className="px-5"><ApprovalProgressTracker document={document}/></div>
            <DocumentActivityTimeline key={`${document.id}:${document.status}`} documentId={document.id}/>
          </div>;
        }
        if(!isDocuments)return <div key={document.id} className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <ApprovalReviewCard document={document} onDecision={onDecision} onSigned={onSigned}/>
          <DocumentRow doc={document}/>
          <DocumentDetailPanel document={document}/>
          <DocumentActivityTimeline key={`${document.id}:${document.status}`} documentId={document.id}/>
        </div>;
        return <div key={document.id} className={`overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow ${expanded?"border-primary/40 shadow-md ring-1 ring-primary/20":"hover:border-primary/30 hover:shadow-md"}`}>
          <div role="button" tabIndex={0} aria-expanded={expanded} aria-label={`${expanded?"Collapse":"Expand"} ${document.title}`}
            onClick={()=>toggleExpanded(document.id)}
            onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();toggleExpanded(document.id);}}}
            className="flex cursor-pointer items-center outline-none focus-visible:bg-accent/40 hover:bg-muted/30">
            <div className="min-w-0 flex-1"><DocumentRow doc={document}/></div>
            <ChevronDown className={`mr-4 h-5 w-5 shrink-0 text-muted-foreground transition-transform ${expanded?"rotate-180":""}`}/>
          </div>
          {expanded&&<div className="border-t bg-muted/20">
            <div className="flex flex-wrap items-center gap-2 px-5 pt-4"><DocumentFileButton documentId={document.id} label={document.is_contract?"Open contract":"Preview PR"}/>{document.is_contract&&<ContractDownloadButton documentId={document.id}/>}{document.status==="approved"&&<SignatureDialog documentId={document.id} onSigned={onSigned} />}{(isAdmin||document.owner_id===currentUserId)&&<EditDocumentDialog document={document} profiles={profiles} onSaved={onSigned} />}{(isAdmin||document.owner_id===currentUserId)&&<DeleteDocumentButton document={document} onDeleted={onSigned}/>}</div>
            <DocumentDetailPanel document={document}/>
            {document.is_contract&&<ContractInfoPanel documentId={document.id} status={document.status}/>}
            <ApprovalProgressTracker document={document}/>
            <DocumentActivityTimeline key={`${document.id}:${document.status}`} documentId={document.id}/>
          </div>}
        </div>;
      })}</div>
    </section>)}
    {!filtered.length&&<div className="rounded-lg border bg-card px-6 py-16 text-center"><FolderOpen className="mx-auto mb-3 h-9 w-9 text-muted-foreground"/><p className="font-semibold">{hasFilters?"No documents match these filters":"No documents yet"}</p><p className="mt-1 text-sm text-muted-foreground">{hasFilters?"Try another date range or search term.":active==="Approvals"?"A requisition or contract will appear here when it is your turn.":"Submit a document from the Overview page to get started."}</p>{hasDateFilters&&<Button type="button" variant="outline" size="sm" className="mt-4" onClick={clearDates}>Clear date filters</Button>}</div>}
    </div>
  </div>;
}

const MONTH_NAMES=["January","February","March","April","May","June","July","August","September","October","November","December"];

type AutofillStats = Awaited<ReturnType<typeof getAutofillStatsFn>>;

function AutofillAccuracyPanel() {
  const [stats,setStats]=useState<AutofillStats|null>(null);
  const [error,setError]=useState("");
  useEffect(()=>{
    let cancelled=false;
    void getAutofillStatsFn().then(result=>{if(!cancelled)setStats(result);}).catch(caught=>{if(!cancelled)setError(caught instanceof Error?caught.message:"Could not load auto-fill accuracy.");});
    return ()=>{cancelled=true;};
  },[]);
  const percent=(part:number,total:number)=>total?`${Math.round((part/total)*100)}%`:"–";
  return <section className="mt-6 rounded-lg border bg-card p-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-bold">Auto-fill accuracy</h2><p className="mt-1 text-sm text-muted-foreground">How often people had to correct what the portal filled in from invoices. Manual PRs are not counted.</p></div>
      {stats&&stats.prs>0&&<div className="text-right"><p className="text-2xl font-bold">{percent(stats.filled-stats.corrected,stats.filled)}</p><p className="text-xs text-muted-foreground">of filled-in values kept unchanged · {stats.prs} {stats.prs===1?"PR":"PRs"}</p></div>}
    </div>
    {error&&<p className="mt-4 text-sm text-destructive">{error}</p>}
    {!stats&&!error&&<p className="mt-4 text-sm text-muted-foreground">Loading…</p>}
    {stats&&stats.prs===0&&<p className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">No auto-filled PRs have been submitted since tracking started. Figures appear here after the next invoice PR is submitted.</p>}
    {stats&&stats.prs>0&&<div className="mt-5 grid gap-6 xl:grid-cols-2">
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><th className="py-2 pr-3 font-semibold">Field</th><th className="py-2 pr-3 font-semibold">Read from invoice</th><th className="py-2 pr-3 font-semibold">Remembered</th><th className="py-2 font-semibold">Typed by user</th></tr></thead>
        <tbody>{stats.fields.map(field=>{const worst=field.read.total>0&&field.read.corrected/field.read.total>=0.3;return <tr key={field.field} className="border-b last:border-0"><td className="py-2 pr-3 font-medium">{field.label}</td>
          <td className={`py-2 pr-3 ${worst?"font-semibold text-destructive":""}`}>{field.read.total?`${field.read.corrected} of ${field.read.total} corrected`:"–"}</td>
          <td className="py-2 pr-3">{field.remembered.total?`${field.remembered.corrected} of ${field.remembered.total} corrected`:"–"}</td>
          <td className="py-2">{field.typedByUser||"–"}</td></tr>;})}</tbody></table>
        <p className="mt-2 text-xs text-muted-foreground">“Typed by user” means auto-fill left the field blank. Fields corrected 30% of the time or more are shown in red.</p></div>
      <div className="space-y-5">
        <div><h3 className="text-sm font-semibold">By supplier</h3><ul className="mt-2 divide-y rounded-md border">{stats.suppliers.map(supplier=><li key={supplier.payee} className="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span className="min-w-0 truncate">{supplier.payee||"Unknown supplier"}</span><span className="shrink-0 text-muted-foreground">{supplier.prs} {supplier.prs===1?"PR":"PRs"} · {supplier.corrected} {supplier.corrected===1?"correction":"corrections"}</span></li>)}</ul></div>
        <div><h3 className="text-sm font-semibold">Recent corrections</h3>{stats.recentCorrections.length?<ul className="mt-2 space-y-2">{stats.recentCorrections.map((item,index)=><li key={`${item.created_at}-${item.field}-${index}`} className="rounded-md border px-3 py-2 text-sm"><p className="font-medium">{item.label} <span className="font-normal text-muted-foreground">· {item.payee} · {formatWorkedDate(item.created_at)}{item.origin==="remembered"?" · remembered value":""}</span></p><p className="mt-1 break-words text-xs"><span className="text-muted-foreground line-through">{item.suggested||"(blank)"}</span> → <span className="font-semibold">{item.submitted||"(blank)"}</span></p></li>)}</ul>:<p className="mt-2 text-sm text-muted-foreground">Nothing has been corrected yet.</p>}</div>
      </div>
    </div>}
  </section>;
}

function ApprovalReviewCard({document,onDecision,onSigned}:{document:PortalDocument;onDecision:(id:string,comment?:string)=>Promise<void>;onSigned:()=>Promise<void>}) {
  const [previewed,setPreviewed]=useState(false);
  return <section className="px-5 pt-5">
    <div className="mb-3 flex items-center justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-lg font-bold">{document.title}</h2><p className="text-sm text-muted-foreground">{document.category} · {document.department||"General"}</p></div><Status status={document.status}/></div>
    <ApprovalDocumentPreview documentId={document.id} onPreviewed={()=>setPreviewed(true)}/>
    {!previewed&&<p className="mb-4 text-sm text-muted-foreground">Preview the requisition to enable approval or rejection.</p>}
    <ApprovalProgressTracker document={document}/>
    {previewed&&<ApprovalStepActions documentId={document.id} onDecision={onDecision} onSigned={onSigned}/>}
  </section>;
}

function EditDocumentDialog({document,profiles,onSaved}:{document:PortalDocument;profiles:Profile[];onSaved:()=>Promise<void>}) {
  const [open,setOpen]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [title,setTitle]=useState(document.title);
  const [category,setCategory]=useState(document.category in categories?document.category as keyof typeof categories:"Custom");
  const [documentType,setDocumentType]=useState(document.document_type);
  const [department,setDepartment]=useState(document.department);
  const [dueDate,setDueDate]=useState(document.due_date?.slice(0,10)??"");
  const [approverIds,setApproverIds]=useState(()=>document.approver_ids?.filter(id=>profiles.some(profile=>profile.id===id&&!profile.finance_role&&!profile.is_admin))??[]);
  const [financeApproverId,setFinanceApproverId]=useState(()=>document.approver_ids?.find(id=>profiles.some(profile=>profile.id===id&&profile.finance_role==="approver"))??"");
  const [financePreparerId,setFinancePreparerId]=useState(()=>document.approver_ids?.find(id=>profiles.some(profile=>profile.id===id&&profile.finance_role==="preparer"))??"");
  const [candidateId,setCandidateId]=useState("");
  const activeApprovals=document.approval_steps?.filter(step=>step.sequence_no>0)??[];
  const routingLocked=activeApprovals.some(step=>step.status==="approved"||step.status==="rejected")||!isPendingStatus(document.status);
  const availableApprovers=profiles.filter(profile=>!profile.is_admin&&!profile.finance_role&&profile.id!==document.owner_id);
  const financeApprovers=profiles.filter(profile=>profile.finance_role==="approver");
  const financePreparers=profiles.filter(profile=>!profile.is_admin&&profile.finance_role==="preparer");

  function moveApprover(index:number,direction:-1|1) {
    const target=index+direction;
    if(target<0||target>=approverIds.length)return;
    setApproverIds(current=>{const next=[...current];[next[index],next[target]]=[next[target]!,next[index]!];return next;});
  }

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setSaving(true);setError("");
    try {
      await updatePortalDocumentFn({data:{id:document.id,title,documentType,category,department,dueDate:dueDate||null,approverIds,financeApproverId,financePreparerId}});
      setOpen(false);
      await onSaved();
    } catch(caught) {
      setError(caught instanceof Error?caught.message:"Could not save document changes.");
    } finally {setSaving(false);}
  }

  return <Dialog open={open} onOpenChange={setOpen}><Button type="button" variant="outline" size="sm" onClick={()=>{setError("");setOpen(true);}}><Pencil className="h-4 w-4"/>Edit</Button><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Edit document</DialogTitle><DialogDescription>{document.is_contract?"Update the contract's details.":"Update document details and, before approvals begin, its approval order."}</DialogDescription></DialogHeader><form onSubmit={submit} className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-semibold sm:col-span-2">Document title<Input required maxLength={160} value={title} onChange={event=>setTitle(event.target.value)} className="mt-2 h-11"/></label>{document.is_contract?<><label className="block text-sm font-semibold">Department<Input maxLength={100} value={department} onChange={event=>setDepartment(event.target.value)} className="mt-2 h-11"/></label><label className="block text-sm font-semibold">Sign by<Input type="date" value={dueDate} onChange={event=>setDueDate(event.target.value)} className="mt-2 h-11"/></label><p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground sm:col-span-2">Signers, signature places and notarization are fixed once a contract is sent. To change them, delete this contract and send it again.</p></>:<><label className="block text-sm font-semibold">Category<select value={category} onChange={event=>{const next=event.target.value as keyof typeof categories;setCategory(next);if(!categories[next].includes(documentType))setDocumentType(categories[next][0]??"Custom document");}} className="form-select mt-2">{Object.keys(categories).map(item=><option key={item}>{item}</option>)}</select></label><label className="block text-sm font-semibold">Document type<select value={documentType} onChange={event=>setDocumentType(event.target.value)} className="form-select mt-2">{categories[category].map(item=><option key={item}>{item}</option>)}</select></label><label className="block text-sm font-semibold">Department<Input maxLength={100} value={department} onChange={event=>setDepartment(event.target.value)} className="mt-2 h-11"/></label><label className="block text-sm font-semibold">Due date<Input type="date" value={dueDate} onChange={event=>setDueDate(event.target.value)} className="mt-2 h-11"/></label><section className="space-y-3 sm:col-span-2"><div><h3 className="text-sm font-semibold">Approval order</h3><p className="mt-1 text-xs text-muted-foreground">Finance Approver and Finance Preparer are appended automatically.</p></div>{routingLocked?<p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">Approval routing is locked because a reviewer has already acted or the document is no longer pending. Document details can still be edited.</p>:<><ol className="space-y-2">{approverIds.map((id,index)=>{const profile=profiles.find(item=>item.id===id);return <li key={`${id}-${index}`} className="flex items-center gap-2 rounded-md border p-2"><span className="min-w-0 flex-1 truncate text-sm">{index+1}. {profile?.full_name||profile?.email||"Unavailable approver"}</span><Button type="button" variant="ghost" size="icon" aria-label={`Move ${profile?.full_name||"approver"} up`} disabled={index===0} onClick={()=>moveApprover(index,-1)}><ArrowUp className="h-4 w-4"/></Button><Button type="button" variant="ghost" size="icon" aria-label={`Move ${profile?.full_name||"approver"} down`} disabled={index===approverIds.length-1} onClick={()=>moveApprover(index,1)}><ArrowDown className="h-4 w-4"/></Button><Button type="button" variant="ghost" size="icon" aria-label={`Remove ${profile?.full_name||"approver"}`} onClick={()=>setApproverIds(current=>current.filter((_,itemIndex)=>itemIndex!==index))}><X className="h-4 w-4"/></Button></li>;})}</ol><div className="flex gap-2"><select aria-label="Add approver" value={candidateId} onChange={event=>setCandidateId(event.target.value)} className="form-select"><option value="">Add approver</option>{availableApprovers.filter(profile=>!approverIds.includes(profile.id)).map(profile=><option key={profile.id} value={profile.id}>{profile.full_name||profile.email}</option>)}</select><Button type="button" variant="outline" disabled={!candidateId} onClick={()=>{if(candidateId&&!approverIds.includes(candidateId))setApproverIds(current=>[...current,candidateId]);setCandidateId("");}}>Add</Button></div><label className="block text-sm font-semibold">Finance Approver<select required value={financeApproverId} onChange={event=>setFinanceApproverId(event.target.value)} className="form-select mt-2"><option value="">Choose Finance Approver</option>{financeApprovers.map(profile=><option key={profile.id} value={profile.id}>{profile.full_name||profile.email}</option>)}</select></label><label className="block text-sm font-semibold">Finance Preparer<select required value={financePreparerId} onChange={event=>setFinancePreparerId(event.target.value)} className="form-select mt-2"><option value="">Choose Finance Preparer</option>{financePreparers.map(profile=><option key={profile.id} value={profile.id}>{profile.full_name||profile.email}</option>)}</select></label></>}</section></>}{error&&<p role="alert" className="text-sm font-medium text-destructive sm:col-span-2">{error}</p>}<div className="flex justify-end gap-3 sm:col-span-2"><Button type="button" variant="outline" onClick={()=>setOpen(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving?"Saving…":"Save changes"}</Button></div></form></DialogContent></Dialog>;
}

function DeleteDocumentButton({document,onDeleted}:{document:PortalDocument;onDeleted:()=>Promise<void>}) {
  const [open,setOpen]=useState(false);
  const [deleting,setDeleting]=useState(false);
  const [error,setError]=useState("");
  async function remove() {
    setDeleting(true);setError("");
    try {
      await deletePortalDocumentFn({data:{id:document.id}});
      setOpen(false);
      await onDeleted();
    } catch(caught) {
      setError(caught instanceof Error?caught.message:"Could not delete the document.");
    } finally {setDeleting(false);}
  }
  return <Dialog open={open} onOpenChange={setOpen}><Button type="button" variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={()=>{setError("");setOpen(true);}}><Trash2 className="h-4 w-4"/>Delete</Button><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Delete document?</DialogTitle><DialogDescription>This permanently deletes “{document.title}”, its approval history, signatures, and attached files. This cannot be undone.</DialogDescription></DialogHeader>{error&&<p role="alert" className="text-sm font-medium text-destructive">{error}</p>}<div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={()=>setOpen(false)} disabled={deleting}>Cancel</Button><Button type="button" variant="destructive" onClick={()=>void remove()} disabled={deleting}>{deleting?"Deleting…":"Delete document"}</Button></div></DialogContent></Dialog>;
}

function ApprovalProgressTracker({document}:{document:PortalDocument}) {
  const steps=document.approval_steps??[];
  if(!steps.length)return null;
  return <div className="mb-4 rounded-md border bg-muted/20 p-4"><h3 className="mb-3 text-sm font-semibold">Approval progress</h3><ol className="space-y-2">{steps.map(step=><li key={step.sequence_no} className="flex items-center justify-between gap-3 text-sm"><span className="font-medium">{step.full_name}{step.role_label?` · ${step.role_label}`:""}</span><span className={step.status==="approved"?"text-success":step.status==="pending"?"font-semibold text-primary":"text-muted-foreground"}>{step.status==="approved"?(step.role_label==="Notary"?"Notarized":step.role_label==="Sender"?"Sent":"Signed"):step.status==="pending"?(step.role_label==="Notary"?"Next to notarize":"Next to sign"):step.status==="skipped"?"Stopped":step.status==="rejected"?"Rejected":"Waiting"}</span></li>)}</ol></div>;
}

function ApprovalStepActions({documentId,onDecision,onSigned}:{documentId:string;onDecision:(id:string,comment?:string)=>Promise<void>;onSigned:()=>Promise<void>}) {
  const [reason,setReason]=useState("");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [signature,setSignature]=useState<{mimeType:string;fileData:string}|null>(null);
  const [loadingSignature,setLoadingSignature]=useState(true);
  const [replaceSignature,setReplaceSignature]=useState(false);
  useEffect(()=>{
    let cancelled=false;
    void getMySignatureFn().then(saved=>{
      if(!cancelled)setSignature(saved);
    }).catch(caught=>{
      if(!cancelled)setError(caught instanceof Error?caught.message:"Could not load your saved signature.");
    }).finally(()=>{
      if(!cancelled)setLoadingSignature(false);
    });
    return ()=>{cancelled=true;};
  },[]);
  async function sign(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);setError("");
    try {
      let activeSignature=signature;
      let fileName=`saved-signature.${signature?.mimeType==="image/png"?"png":"jpg"}`;
      if(!signature||replaceSignature){
        const file=new FormData(event.currentTarget).get("signature");
        if(!(file instanceof File)||!file.size){setError("Choose a signature image.");setSaving(false);return;}
        if(file.size>2097152||!["image/png","image/jpeg"].includes(file.type)){setError("Choose a PNG or JPEG signature image up to 2 MB.");setSaving(false);return;}
        const bytes=new Uint8Array(await file.arrayBuffer());
        let binary="";
        for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
        activeSignature=await saveMySignatureFn({data:{mimeType:file.type,fileData:btoa(binary)}});
        setSignature(activeSignature);
        setReplaceSignature(false);
        fileName=file.name;
      }
      if(!activeSignature)throw new Error("Save a signature before approving this request.");
      await signDocumentFn({data:{documentId,fileName,mimeType:activeSignature.mimeType,fileData:activeSignature.fileData}});
      await onSigned();
    } catch(caught) {
      setError(caught instanceof Error?caught.message:"Could not sign the requisition.");
    } finally {setSaving(false);}
  }
  async function reject() {
    setSaving(true);setError("");
    try {await onDecision(documentId,reason);setReason("");}
    catch(caught) {setError(caught instanceof Error?caught.message:"Could not reject the requisition.");}
    finally {setSaving(false);}
  }
  return <div className="mb-5 rounded-md border p-4"><form onSubmit={sign} className="flex flex-wrap items-end gap-3">
    {loadingSignature?<p className="flex-1 text-sm text-muted-foreground">Loading your saved signature…</p>:signature&&!replaceSignature?<div className="min-w-52 flex-1"><p className="mb-2 text-sm font-semibold">Saved signature</p><div className="flex flex-wrap items-center gap-3"><div className="grid h-14 min-w-32 place-items-center rounded border bg-white px-3"><img src={`data:${signature.mimeType};base64,${signature.fileData}`} alt="Your saved signature" className="max-h-12 max-w-40 object-contain"/></div><Button type="button" variant="outline" size="sm" onClick={()=>setReplaceSignature(true)} disabled={saving}>Replace signature</Button></div></div>:<label className="min-w-52 flex-1 text-sm font-semibold">{signature?"Upload replacement signature":"Your signature"}<input name="signature" type="file" accept="image/png,image/jpeg" required className="mt-2 block w-full rounded-md border p-2 text-sm font-normal"/></label>}
    {signature&&replaceSignature&&<Button type="button" variant="outline" onClick={()=>setReplaceSignature(false)} disabled={saving}>Keep saved signature</Button>}
    <Button type="submit" disabled={saving||loadingSignature}>{saving?"Saving…":"Approve and sign"}</Button>
  </form><div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-52 flex-1 text-sm font-semibold">Reject reason<Textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength={2000} className="mt-2 min-h-20" placeholder="Explain why this requisition is rejected."/></label><Button type="button" variant="destructive" onClick={()=>void reject()} disabled={saving||!reason.trim()}>Reject</Button></div>{error&&<p role="alert" className="mt-3 text-sm font-medium text-destructive">{error}</p>}</div>;
}

function ApprovalDocumentPreview({documentId,onPreviewed}:{documentId:string;onPreviewed:()=>void}) {
  const [url,setUrl]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
  async function preview() {
    setLoading(true);
    setError("");
    try {
      const file=await getDocumentFileFn({data:{documentId,mode:"preview"}});
      const bytes=Uint8Array.from(atob(file.fileData),character=>character.charCodeAt(0));
      setUrl(URL.createObjectURL(new Blob([bytes],{type:file.mimeType})));
      onPreviewed();
    } catch(caught) {
      setError(caught instanceof Error?caught.message:"Could not load the requisition preview.");
    } finally {
      setLoading(false);
    }
  }
  return <div className="mb-4">
    {!url&&<Button type="button" onClick={()=>void preview()} disabled={loading}><Files className="h-4 w-4"/>{loading?"Loading preview…":"Preview requisition"}</Button>}
    {error&&<p role="alert" className="mt-3 rounded-md bg-warning-soft p-4 text-sm">{error}</p>}
    {url&&<iframe src={url} title="Payment requisition preview" className="h-[72vh] min-h-[520px] w-full rounded-md border bg-white"/>}
  </div>;
}

function DocumentDetailPanel({ document }: { document: PortalDocument }) {
  return <div className="px-5 pb-4"><div className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-3"><div><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Type</p><p className="mt-1 text-sm font-medium">{document.document_type}</p></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Category</p><p className="mt-1 text-sm font-medium">{document.category}</p></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Department</p><p className="mt-1 text-sm font-medium">{document.department || "General"}</p></div></div></div>;
}

function DocumentActivityTimeline({ documentId }: { documentId: string }) {
  const [items, setItems] = useState<{ action: string; details: string; actor_name:string; created_at: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadActivity() {
      try {
        const activity = await getDocumentActivityFn({ data: { documentId } });
        if (active) {
          setItems(activity as { action: string; details: string; actor_name:string; created_at: string }[]);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadActivity();
    return () => {
      active = false;
    };
  }, [documentId]);

  if (loading) {
    return <div className="px-5 pb-4 text-xs text-muted-foreground">Loading activity…</div>;
  }

  if (!items.length) {
    return <div className="px-5 pb-4 text-xs text-muted-foreground">No activity recorded yet.</div>;
  }

  return <div className="px-5 pb-4"><div className="rounded-md border bg-muted/20 p-3"><p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Activity timeline</p><div className="space-y-2">{items.map((item) => (
    <div key={item.created_at + item.action + item.details} className="flex gap-3 rounded-sm border-l-2 border-primary/60 bg-background/60 px-2 py-1.5">
      <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{item.actor_name} · {item.action.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}</p><p className="text-xs text-muted-foreground">{item.details}</p></div>
      <p className="shrink-0 text-[11px] text-muted-foreground">{formatTimelineDate(item.created_at)}</p>
    </div>
  ))}</div></div></div>;
}

function SettingsWorkspace({ profiles, onSaved, onDeleted }:{ profiles: Profile[]; onSaved:()=>Promise<void>; onDeleted:()=>Promise<void>}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [department, setDepartment] = useState("");
  const [financeRole, setFinanceRole] = useState<Profile["finance_role"]>("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [isNotary, setIsNotary] = useState(false);
  const [notaryCommission, setNotaryCommission] = useState("");
  const [notaryJurisdiction, setNotaryJurisdiction] = useState("");
  const [notaryExpires, setNotaryExpires] = useState("");
  const [editingId, setEditingId] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncingCrmUsers, setSyncingCrmUsers] = useState(false);
  const [crmSyncMessage, setCrmSyncMessage] = useState("");
  const [error, setError] = useState("");
  const [emailStatus, setEmailStatus] = useState<{ tone: "success" | "warning"; message: string } | null>(null);
  const managedProfiles = profiles.filter((profile) => profile.id !== CRM_USER_ID && (!profile.is_admin || profile.finance_role !== "" || profile.is_notary));

  async function syncCrmUsers() {
    setSyncingCrmUsers(true);
    setCrmSyncMessage("");
    try {
      const users = await syncCrmDirectoryUsersFn();
      await onSaved();
      setCrmSyncMessage(`${users.length} CRM user${users.length === 1 ? "" : "s"} fetched.`);
    } catch (caught) {
      setCrmSyncMessage(caught instanceof Error ? caught.message : "Could not fetch users from the CRM.");
    } finally {
      setSyncingCrmUsers(false);
    }
  }

  function resetForm() {
    setFullName("");
    setEmail("");
    setDepartment("");
    setFinanceRole("");
    setIsAdmin(false);
    setIsNotary(false);
    setNotaryCommission("");
    setNotaryJurisdiction("");
    setNotaryExpires("");
    setEditingId("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setEmailStatus(null);
    try {
      const result = await upsertApproverProfileFn({
        data: {
          ...(editingId ? { id: editingId } : {}),
          full_name: fullName,
          email,
          department,
          finance_role: financeRole,
          is_admin: isAdmin,
          is_notary: isNotary,
          notary_commission: notaryCommission,
          notary_jurisdiction: notaryJurisdiction,
          notary_commission_expires: notaryExpires,
        },
      });
      const savedEmail = email;
      resetForm();
      await onSaved();

      if (result?.email_notification) {
        if (result.email_notification.sent) {
          setEmailStatus({ tone: "success", message: `Email notification sent to ${savedEmail}.` });
        } else {
          setEmailStatus({ tone: "warning", message: result.email_notification.reason || "User saved, but the email notification could not be sent." });
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the approver.");
    } finally {
      setSaving(false);
    }
  }

  async function removeApprover(id: string) {
    setError("");
    try {
      await deleteApproverProfileFn({ data: { id } });
      await onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the approver.");
    }
  }

  function startEditing(profile: Profile) {
    setEditingId(profile.id);
    setFullName(profile.full_name);
    setEmail(profile.email);
    setDepartment(profile.department);
    setFinanceRole(profile.finance_role);
    setIsAdmin(profile.is_admin);
    setIsNotary(Boolean(profile.is_notary));
    setNotaryCommission(profile.notary_commission ?? "");
    setNotaryJurisdiction(profile.notary_jurisdiction ?? "");
    setNotaryExpires(profile.notary_commission_expires ?? "");
    setError("");
    setEmailStatus(null);
  }

  const groups: { title: string; roleLabel: string; entries: Profile[] }[] = [
    { title: "Approvers", roleLabel: "Approver", entries: managedProfiles.filter((profile) => !profile.finance_role) },
    { title: "Finance Preparers", roleLabel: "Finance Preparer", entries: managedProfiles.filter((profile) => profile.finance_role === "preparer") },
    { title: "Finance Approvers", roleLabel: "Finance Approver", entries: managedProfiles.filter((profile) => profile.finance_role === "approver") },
    { title: "Notaries", roleLabel: "Notary", entries: managedProfiles.filter((profile) => profile.is_notary) },
  ];
  const today = new Date().toISOString().slice(0, 10);

  return <div className="mx-auto max-w-[1500px] p-4 md:p-8"><div className="mb-8 flex flex-wrap items-center justify-between gap-4"><div><p className="mb-1 text-sm font-semibold text-primary">DOCUMENT CONTROL</p><h1 className="text-3xl font-bold tracking-normal md:text-4xl">Settings</h1><p className="mt-2 text-muted-foreground">Manage approval, finance and notary contacts used to route requisitions and contracts.</p>{crmSyncMessage && <p className="mt-2 text-sm text-muted-foreground" role="status">{crmSyncMessage}</p>}</div><Button type="button" variant="outline" onClick={() => void syncCrmUsers()} disabled={syncingCrmUsers}>{syncingCrmUsers ? "Fetching users…" : "Fetch users from CRM"}</Button></div><div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]"><form onSubmit={submit} className="h-fit rounded-lg border bg-card p-5"><h2 className="text-lg font-bold">{editingId ? "Edit user" : "Add user"}</h2><p className="mt-1 text-sm text-muted-foreground">Maintain the people available in approval and finance routing.</p><div className="mt-5 space-y-4"><label className="block text-sm font-semibold">Name<Input required value={fullName} onChange={(event)=>setFullName(event.target.value)} className="mt-2 h-11" placeholder="e.g. James Ndlovu" /></label><label className="block text-sm font-semibold">Email<Input required type="email" value={email} onChange={(event)=>setEmail(event.target.value)} className="mt-2 h-11" placeholder="james@company.co.za" /></label><label className="block text-sm font-semibold">Role<select value={financeRole} onChange={(event)=>setFinanceRole(event.target.value as Profile["finance_role"])} className="mt-2 h-11 w-full rounded-md border bg-background px-3 text-sm"><option value="">Approver</option><option value="preparer">Finance Preparer</option><option value="approver">Finance Approver</option></select></label><label className="block text-sm font-semibold">Department<Input value={department} onChange={(event)=>setDepartment(event.target.value)} className="mt-2 h-11" placeholder="Finance" /></label><div className="rounded-md border p-3"><label className="flex items-start gap-2 text-sm font-semibold"><input type="checkbox" checked={isNotary} onChange={(event)=>setIsNotary(event.target.checked)} className="mt-0.5 h-4 w-4"/><span>Notary public<span className="block text-xs font-normal text-muted-foreground">Can be chosen to notarize contracts after all parties sign.</span></span></label>{isNotary&&<div className="mt-3 space-y-3"><label className="block text-sm font-semibold">Commission / registration no.<Input required maxLength={80} value={notaryCommission} onChange={(event)=>setNotaryCommission(event.target.value)} className="mt-2 h-10" placeholder="e.g. NP-2291"/></label><label className="block text-sm font-semibold">Jurisdiction<Input maxLength={100} value={notaryJurisdiction} onChange={(event)=>setNotaryJurisdiction(event.target.value)} className="mt-2 h-10" placeholder="e.g. Republic of Zambia"/></label><label className="block text-sm font-semibold">Commission expires<Input type="date" value={notaryExpires} onChange={(event)=>setNotaryExpires(event.target.value)} className="mt-2 h-10"/></label></div>}</div>{error && <p className="text-sm font-medium text-destructive">{error}</p>}{emailStatus&&<p className={`text-sm ${emailStatus.tone==="success"?"text-success":"text-warning"}`}>{emailStatus.message}</p>}<Button type="submit" className="w-full" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Add user"}</Button>{editingId&&<Button type="button" variant="outline" className="w-full" onClick={resetForm}>Cancel edit</Button>}</div></form><div className="space-y-5">{groups.map(group=><section key={group.title} className="rounded-lg border bg-card p-5"><h2 className="text-lg font-bold">{group.title}</h2><div className="mt-4 space-y-3">{group.entries.length ? group.entries.map(profile=><div key={profile.id} className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-3"><div><p className="font-semibold">{profile.full_name || profile.email}</p><p className="text-sm text-muted-foreground">{profile.email} · {group.roleLabel}{profile.is_admin?" · Admin":""}{profile.department?` · ${profile.department}`:""}{group.roleLabel==="Notary"?` · No. ${profile.notary_commission}${profile.notary_commission_expires?` · ${profile.notary_commission_expires<today?"expired":"expires"} ${profile.notary_commission_expires}`:""}`:""}</p></div><div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={()=>startEditing(profile)}>Edit</Button>{!profile.is_admin&&<Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={()=>void removeApprover(profile.id)}>Remove</Button>}</div></div>) : <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No {group.title.toLowerCase()} configured yet.</p>}</div></section>)}</div></div><AutofillAccuracyPanel/></div>;
}

function DocumentFileButton({documentId,label="Preview PR"}:{documentId:string;label?:string}) {
  const [opening,setOpening]=useState(false); const [error,setError]=useState("");
  async function openFile(){setOpening(true);setError("");try{const file=await getDocumentFileFn({data:{documentId,mode:"preview"}});const bytes=Uint8Array.from(atob(file.fileData),character=>character.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:file.mimeType}));const tab=window.open(url,"_blank","noopener,noreferrer");if(!tab){const link=document.createElement("a");link.href=url;link.download=file.fileName;link.click();}setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(caught){setError(caught instanceof Error?caught.message:"Could not open the preview.");}finally{setOpening(false);}}
  return <span><Button variant="outline" size="sm" onClick={()=>void openFile()} disabled={opening}><Files className="h-4 w-4"/>{opening?"Opening…":label}</Button>{error&&<span className="ml-2 text-xs text-destructive">{error}</span>}</span>;
}

function SignatureDialog({documentId,onSigned}:{documentId:string;onSigned:()=>Promise<void>}) {
  const [open,setOpen]=useState(false); const [saving,setSaving]=useState(false); const [previewing,setPreviewing]=useState(false); const [previewUrl,setPreviewUrl]=useState<string | null>(null); const [previewError,setPreviewError]=useState(""); const [error,setError]=useState("");

  async function previewDocument() {
    setPreviewing(true); setPreviewError("");
    try {
      const file = await getDocumentFileFn({ data: { documentId, mode: "preview" } });
      const bytes = Uint8Array.from(atob(file.fileData), (character) => character.charCodeAt(0));
      const mimeType = file.mimeType.toLowerCase();
      const blob = new Blob([bytes], { type: file.mimeType });
      const isBrowserPreviewable = mimeType === "application/pdf" || mimeType.startsWith("image/");

      if (isBrowserPreviewable) {
        const url = URL.createObjectURL(blob);
        setPreviewUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return url;
        });
        return;
      }

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.fileName;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setPreviewUrl(null);
      setPreviewError("This document type cannot be previewed in-browser. It has been opened for download instead.");
    } catch (caught) {
      setPreviewError(caught instanceof Error ? caught.message : "Could not preview the document.");
    } finally {
      setPreviewing(false);
    }
  }

  async function downloadWordDocument() {
    setPreviewError("");
    try {
      const file = await getDocumentFileFn({ data: { documentId, mode: "download" } });
      const bytes = Uint8Array.from(atob(file.fileData), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.fileName;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (caught) {
      setPreviewError(caught instanceof Error ? caught.message : "Could not download the Word document.");
    }
  }

  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setSaving(true);setError("");const file=new FormData(event.currentTarget).get("signature");if(!(file instanceof File)||!file.size){setError("Choose a signature image.");setSaving(false);return;}if(file.size>2097152){setError("Signature images must be 2 MB or smaller.");setSaving(false);return;}if(!["image/png","image/jpeg"].includes(file.type)){setError("Choose a PNG or JPEG signature image.");setSaving(false);return;}const bytes=new Uint8Array(await file.arrayBuffer());let binary="";for(let offset=0;offset<bytes.length;offset+=0x8000){binary += String.fromCharCode(...bytes.subarray(offset,offset+0x8000));}try{await signDocumentFn({data:{documentId,fileName:file.name,mimeType:file.type,fileData:btoa(binary)}});setOpen(false);await onSigned();}catch(caught){setError(caught instanceof Error?caught.message:"Could not sign the document.");}finally{setSaving(false);}}
  return <Dialog open={open} onOpenChange={setOpen}><Button variant="outline" size="sm" onClick={()=>setOpen(true)}><PenLine className="h-4 w-4"/>Sign document</Button><DialogContent className="max-w-4xl"><DialogHeader><DialogTitle>Sign document</DialogTitle><DialogDescription>Preview the document first, then upload your signature.</DialogDescription></DialogHeader><div className="space-y-5"><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={()=>void previewDocument()} disabled={previewing}>{previewing?"Loading preview…":"Preview document"}</Button><Button type="button" variant="outline" size="sm" onClick={()=>void downloadWordDocument()}>Download Word</Button>{previewUrl && <Button type="button" variant="ghost" size="sm" onClick={()=>window.open(previewUrl, "_blank", "noopener,noreferrer")}>Open in new tab</Button>}</div>{previewError && <p className="text-sm font-medium text-destructive">{previewError}</p>}{previewUrl ? <iframe src={previewUrl} title="Document preview" className="h-[420px] w-full rounded-md border bg-background" /> : <div className="grid h-[220px] place-items-center rounded-md border border-dashed bg-muted/20 text-sm text-muted-foreground">Preview will appear here before you sign.</div>}</div><form onSubmit={submit} className="space-y-4"><input name="signature" type="file" accept="image/png,image/jpeg" className="block w-full rounded-md border p-3" />{error&&<p className="text-sm font-medium text-destructive">{error}</p>}<Button type="submit" disabled={saving}>{saving?"Signing…":"Apply signature"}</Button></form></DialogContent></Dialog>;
}

function AuthScreen({ mode, setMode, onSubmit, onGoogle, error, notice }:{mode:"signin"|"signup";setMode:(m:"signin"|"signup")=>void;onSubmit:(e:FormEvent<HTMLFormElement>)=>void;onGoogle:()=>void;error:string;notice:string}) {
  return <main className="grid min-h-screen bg-background lg:grid-cols-[1.05fr_.95fr]">
    <section className="relative hidden overflow-hidden bg-primary p-12 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
      <img src="/sanlam-logo.png" alt="Sanlam — Live with confidence" className="w-48 rounded-sm" />
      <div className="max-w-xl"><div className="mb-6 h-1 w-14 bg-primary-foreground"/><h1 className="text-5xl font-bold leading-tight tracking-normal">One secure place for every important document.</h1><p className="mt-5 max-w-lg text-lg leading-8 opacity-80">Submit, review and approve company documents with a clear record of every decision.</p></div>
      <div className="flex gap-8 text-sm opacity-80"><span>Secure files</span><span>Clear approvals</span><span>Email updates</span></div>
    </section>
    <section className="flex items-center justify-center px-5 py-12"><div className="w-full max-w-md">
      <img src="/sanlam-logo.png" alt="Sanlam" className="mb-8 w-36 rounded-sm lg:hidden" />
      <p className="text-sm font-bold text-primary">SANLAM DOCUMENT HUB</p><h2 className="mt-2 text-3xl font-bold tracking-normal">{mode==="signin"?"Welcome back":"Create your account"}</h2><p className="mt-2 text-muted-foreground">{mode==="signin"?"Sign in to continue to your workspace.":"Use your company details to get started."}</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">{mode==="signup"&&<label className="block text-sm font-semibold">Full name<Input name="name" className="mt-2 h-11" autoComplete="name"/></label>}<label className="block text-sm font-semibold">Work email<Input name="email" type="email" className="mt-2 h-11" autoComplete="email"/></label><label className="block text-sm font-semibold">Password<Input name="password" type="password" className="mt-2 h-11" autoComplete={mode==="signin"?"current-password":"new-password"}/></label>{error&&<p className="text-sm font-medium text-destructive">{error}</p>}{notice&&<p className="text-sm font-medium text-success">{notice}</p>}<Button type="submit" className="h-11 w-full">{mode==="signin"?"Sign in":"Create account"}</Button></form>
      <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border"/>OR<span className="h-px flex-1 bg-border"/></div><Button variant="outline" className="h-11 w-full" onClick={onGoogle}>Continue with Google</Button>
      <p className="mt-7 text-center text-sm text-muted-foreground">{mode==="signin"?"New to the portal? ":"Already have an account? "}<button className="font-semibold text-primary" onClick={()=>setMode(mode==="signin"?"signup":"signin")}>{mode==="signin"?"Create account":"Sign in"}</button></p>
    </div></section>
  </main>;
}

function Metric({label,value,icon:Icon,tone}:{label:string;value:number;icon:typeof Files;tone:string}) { return <div className="rounded-lg border bg-card p-5"><div className="flex items-start justify-between"><div><p className="text-sm font-medium text-muted-foreground">{label}</p><p className="mt-3 text-3xl font-bold">{String(value).padStart(2,"0")}</p></div><div className={`metric-icon metric-${tone}`}><Icon/></div></div><p className="mt-4 text-xs text-muted-foreground">Updated just now</p></div> }

function isPendingStatus(status:string) {
  return status==="pending_review"||status.startsWith("Pending ");
}

function Status({status}:{status:DocStatus}) {
  const knownLabels:Record<string,string>={draft:"Draft",pending_review:"Pending review",approved:"Approved",returned:"Returned",rejected:"Rejected",signed:"Signed",Completed:"Completed",Rejected:"Rejected"};
  const className=isPendingStatus(status)?"pending_review":status==="Completed"?"approved":status==="Rejected"?"rejected":status;
  const label=isPendingStatus(status)&&status!=="pending_review"?"Pending":knownLabels[status]??status;
  return <span title={label} className={`status status-${className} max-w-full`}><span className="min-w-0 truncate">{label}</span></span>;
}

function DocumentRow({doc}:{doc:PortalDocument}) {
  return <div className="grid gap-3 border-b px-5 py-4 last:border-0 md:grid-cols-[minmax(0,1fr)_150px_130px_110px] md:items-center"><div className="flex min-w-0 items-center gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-accent text-primary"><Files className="h-5 w-5"/></div><div className="min-w-0"><p className="truncate text-sm font-semibold">{doc.title}</p><p className="truncate text-xs text-muted-foreground">{doc.document_type} · {doc.category}</p><p className="truncate text-xs text-muted-foreground">Worked {formatWorkedDate(doc.worked_at)}</p></div></div><span className="min-w-0 truncate text-sm text-muted-foreground">{doc.department || "General"}</span><div className="min-w-0"><Status status={doc.status}/></div><div className="flex items-center justify-between gap-2"><span className="whitespace-nowrap text-sm text-muted-foreground">{formatDate(doc.due_date)}</span></div></div>;
}

function LegacyNewDocumentDialog({open,onOpenChange,user,profiles,onCreated}:{open:boolean;onOpenChange:(v:boolean)=>void;user:LocalUser;profiles:Profile[];onCreated:()=>void}) {
  const [category,setCategory]=useState<keyof typeof categories>("Finance"); const [saving,setSaving]=useState(false); const [error,setError]=useState("");
  async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setSaving(true);setError("");const f=new FormData(e.currentTarget);const file=f.get("file");const approver=String(f.get("approver")??"");
    const title=String(f.get("title")??"").trim();
    if(!title){setError("Add a title.");setSaving(false);return;}
    if(!(file instanceof File)||!file.size){setError("Choose a document to upload.");setSaving(false);return;}
    if(file.size>20971520){setError("Files must be 20 MB or smaller.");setSaving(false);return;}
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for(let offset=0;offset<bytes.length;offset+=0x8000){binary += String.fromCharCode(...bytes.subarray(offset, offset+0x8000));}
    try {
      await createPortalDocumentFn({ data: { title, documentType: String(f.get("type")), category, department: String(f.get("department") ?? ""), dueDate: String(f.get("due") ?? "") || null, fileName: file.name, mimeType: file.type, fileData: btoa(binary), approverId: String(f.get("approver") ?? "") || null } });
      setSaving(false);onOpenChange(false);onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not upload the document.");
      setSaving(false);
    }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle className="text-2xl">Submit a document</DialogTitle><DialogDescription>Add the document details and choose who should review it.</DialogDescription></DialogHeader><form onSubmit={submit} className="mt-2 grid gap-5 sm:grid-cols-2"><label className="block text-sm font-semibold sm:col-span-2">Document title<Input name="title" maxLength={160} className="mt-2 h-11" placeholder="e.g. September supplier payment"/></label><label className="block text-sm font-semibold">Category<select value={category} onChange={e=>setCategory(e.target.value as keyof typeof categories)} className="form-select mt-2"><>{Object.keys(categories).map(c=><option key={c}>{c}</option>)}</></select></label><label className="block text-sm font-semibold">Document type<select name="type" className="form-select mt-2">{categories[category].map(t=><option key={t}>{t}</option>)}</select></label><label className="block text-sm font-semibold">Department<Input name="department" maxLength={100} className="mt-2 h-11" placeholder="Finance"/></label><label className="block text-sm font-semibold">Due date<Input name="due" type="date" className="mt-2 h-11"/></label><label className="block text-sm font-semibold sm:col-span-2">Selected approver<select name="approver" className="form-select mt-2"><option value="">Choose an approver</option>{profiles.filter(p=>p.id!==user.id).map(p=><option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</select></label><label className="block text-sm font-semibold sm:col-span-2">Description<Textarea name="description" maxLength={2000} className="mt-2 min-h-24" placeholder="Add context for the reviewer…"/></label><label className="upload-zone sm:col-span-2"><UploadCloud className="h-7 w-7 text-primary"/><span className="font-semibold">Choose a document to upload</span><span className="text-xs text-muted-foreground">PDF, Word, Excel, images and supporting files up to 20 MB</span><input name="file" type="file" className="sr-only" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.txt,.zip"/></label>{error&&<p className="text-sm font-medium text-destructive sm:col-span-2">{error}</p>}<div className="flex justify-end gap-3 sm:col-span-2"><Button type="button" variant="outline" onClick={()=>onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving?"Submitting…":"Submit for review"}</Button></div></form></DialogContent></Dialog>
}

function BrokenNewDocumentDialog({open,onOpenChange,user,profiles,onCreated}:{open:boolean;onOpenChange:(v:boolean)=>void;user:LocalUser;profiles:Profile[];onCreated:()=>void}) {
  const [category,setCategory]=useState<keyof typeof categories>("Finance"); const [saving,setSaving]=useState(false); const [error,setError]=useState("");
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setSaving(true);setError("");const form=new FormData(event.currentTarget);const title=String(form.get("title")??"").trim();const file=form.get("file");if(!title){setError("Add a title.");setSaving(false);return;}if(!(file instanceof File)||!file.size){setError("Choose a document to upload.");setSaving(false);return;}if(file.size>20971520){setError("Files must be 20 MB or smaller.");setSaving(false);return;}const bytes=new Uint8Array(await file.arrayBuffer());let binary="";for(let offset=0;offset<bytes.length;offset+=0x8000){binary += String.fromCharCode(...bytes.subarray(offset,offset+0x8000));}try{await createPortalDocumentFn({data:{title,documentType:String(form.get("type")),category,department:String(form.get("department")??""),dueDate:String(form.get("due")??"")||null,fileName:file.name,mimeType:file.type,fileData:btoa(binary),approverId:String(form.get("approver")??"")||null}});setSaving(false);onOpenChange(false);onCreated();}catch(caught){setError(caught instanceof Error?caught.message:"Could not upload the document.");setSaving(false);}}
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle className="text-2xl">Submit a document</DialogTitle><DialogDescription>Add the document details and choose who should review it.</DialogDescription></DialogHeader><form onSubmit={submit} className="mt-2 grid gap-5 sm:grid-cols-2"><label className="block text-sm font-semibold sm:col-span-2">Document title<Input name="title" maxLength={160} className="mt-2 h-11" placeholder="e.g. September supplier payment"/></label><label className="block text-sm font-semibold">Category<select value={category} onChange={event=>setCategory(event.target.value as keyof typeof categories)} className="form-select mt-2">{Object.keys(categories).map(item=><option key={item}>{item}</option>)}</select></label><label className="block text-sm font-semibold">Document type<select name="type" className="form-select mt-2">{categories[category].map(item=><option key={item}>{item}</option>)}</select></label><label className="block text-sm font-semibold">Department<Input name="department" maxLength={100} className="mt-2 h-11" placeholder="Finance"/></label><label className="block text-sm font-semibold">Due date<Input name="due" type="date" className="mt-2 h-11"/></label><label className="block text-sm font-semibold sm:col-span-2">Selected approver<select name="approver" className="form-select mt-2"><option value="">Choose an approver</option>{profiles.filter(profile=>profile.id!==user.id).map(profile=><option key={profile.id} value={profile.id}>{profile.full_name||profile.email}</option>)}</select></label><label className="upload-zone sm:col-span-2"><UploadCloud className="h-7 w-7 text-primary"/><span className="font-semibold">Choose a document to upload</span><span className="text-xs text-muted-foreground">PDF, Word, Excel, images and supporting files up to 20 MB</span><input name="file" type="file" className="sr-only" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.txt,.zip"/></label>{error&&<p className="text-sm font-medium text-destructive sm:col-span-2">{error}</p>}<div className="flex justify-end gap-3 sm:col-span-2"><Button type="button" variant="outline" onClick={()=>onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving?"Submitting…":"Submit document"}</Button></div></form></DialogContent></Dialog>;
}



function formatDate(value:string|null){if(!value)return "No due date";return new Intl.DateTimeFormat("en-ZM",{day:"2-digit",month:"short"}).format(new Date(`${value}T12:00:00`));}
function getDateInputValue(value:string|null){if(!value)return "";const date=new Date(value);if(Number.isNaN(date.getTime()))return "";return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;}
function formatWorkedDate(value:string|null){if(!value)return "Unknown date";const date=new Date(value);if(Number.isNaN(date.getTime()))return "Unknown date";return new Intl.DateTimeFormat("en-ZM",{day:"2-digit",month:"short",year:"numeric"}).format(date);}
function formatTimelineDate(value:string){return new Intl.DateTimeFormat("en-ZM",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(value));}
function formatToday(){return new Intl.DateTimeFormat("en-ZM",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(new Date());}
