import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Bell, Check, CheckCircle2, ChevronDown, Clock3, FileCheck2, FilePlus2,
  Files, FolderOpen, LayoutDashboard, LogOut, Menu, Search, Settings,
  ShieldCheck, UploadCloud, Users, X, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import logo from "@/assets/sanlam-logo.jpg.asset.json";
import type { User } from "@supabase/supabase-js";

type DocStatus = "draft" | "pending_review" | "approved" | "returned" | "rejected";
type PortalDocument = {
  id: string; title: string; document_type: string; category: string; department: string;
  status: DocStatus; due_date: string | null; created_at: string; owner_id: string;
};
type Profile = { id: string; full_name: string; email: string; department: string };

const categories = {
  Finance: ["Payment requisition", "Invoice", "Purchase order", "Expense claim", "Receipt"],
  HR: ["Leave request", "Employment contract", "Onboarding record", "Employee request"],
  Legal: ["Agreement", "Legal opinion", "Contract review"],
  Compliance: ["Policy", "Audit evidence", "Risk assessment"],
  Operations: ["Service request", "Incident report", "Project document"],
  Custom: ["Custom document"],
};

const sampleDocs: PortalDocument[] = [
  { id: "demo-1", title: "Airtel Bulk SMS — August 2026", document_type: "Payment requisition", category: "Finance", department: "Finance", status: "pending_review", due_date: "2026-09-24", created_at: "2026-09-20T09:15:00Z", owner_id: "demo" },
  { id: "demo-2", title: "Information Security Policy 2026", document_type: "Policy", category: "Compliance", department: "Risk & Compliance", status: "approved", due_date: "2026-09-30", created_at: "2026-09-18T12:00:00Z", owner_id: "demo" },
  { id: "demo-3", title: "New starter — Benefits enrolment", document_type: "Onboarding record", category: "HR", department: "People & Culture", status: "returned", due_date: "2026-09-22", created_at: "2026-09-17T08:30:00Z", owner_id: "demo" },
  { id: "demo-4", title: "Branch facilities service agreement", document_type: "Agreement", category: "Legal", department: "Legal", status: "draft", due_date: "2026-10-02", created_at: "2026-09-16T11:45:00Z", owner_id: "demo" },
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
  component: Portal,
});

function Portal() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authError, setAuthError] = useState("");
  const [active, setActive] = useState("Overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [documents, setDocuments] = useState<PortalDocument[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (mounted) { setUser(data.user ?? null); setLoading(false); }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => { mounted = false; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!user) return;
    const fullName = String(user.user_metadata?.full_name ?? user.email?.split("@")[0] ?? "Team member");
    void supabase.from("profiles").upsert({ id: user.id, full_name: fullName, email: user.email ?? "" }, { onConflict: "id" });
    void loadData();
  }, [user]);

  async function loadData() {
    const [{ data: docs }, { data: people }] = await Promise.all([
      supabase.from("documents").select("id,title,document_type,category,department,status,due_date,created_at,owner_id").order("created_at", { ascending: false }),
      supabase.from("profiles").select("id,full_name,email,department").order("full_name"),
    ]);
    setDocuments((docs as PortalDocument[] | null) ?? []);
    setProfiles((people as Profile[] | null) ?? []);
  }

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!email || password.length < 8) { setAuthError("Enter a valid email and a password of at least 8 characters."); return; }
    if (authMode === "signup") {
      const fullName = String(form.get("name") ?? "").trim();
      if (!fullName) { setAuthError("Enter your full name."); return; }
      const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName }, emailRedirectTo: window.location.origin } });
      if (error) setAuthError(error.message); else if (!data.session) setNotice("Check your email to confirm your account.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setAuthError(error.message);
    }
  }

  async function googleSignIn() {
    const result = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (result.error) setAuthError(result.error.message);
  }

  const visible = useMemo(() => {
    const list = documents.length ? documents : sampleDocs;
    const q = search.toLowerCase();
    return list.filter((d) => !q || `${d.title} ${d.document_type} ${d.category}`.toLowerCase().includes(q));
  }, [documents, search]);

  if (loading) return <div className="grid min-h-screen place-items-center bg-background"><div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" /></div>;
  if (!user) return <AuthScreen mode={authMode} setMode={setAuthMode} onSubmit={handleAuth} onGoogle={googleSignIn} error={authError} notice={notice} />;

  const counts = {
    all: visible.length,
    pending: visible.filter((d) => d.status === "pending_review").length,
    approved: visible.filter((d) => d.status === "approved").length,
    attention: visible.filter((d) => d.status === "returned" || d.status === "rejected").length,
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className={`fixed inset-y-0 left-0 z-40 w-64 border-r border-sidebar-border bg-sidebar transition-transform lg:translate-x-0 ${mobileNav ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-20 items-center justify-between border-b border-sidebar-border px-6">
          <img src={logo.url} alt="Sanlam" className="h-10 w-auto rounded-sm" />
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
            <div className="grid h-9 w-9 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{(user.email?.[0] ?? "U").toUpperCase()}</div>
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{user.user_metadata?.full_name ?? "Team member"}</p><p className="truncate text-xs text-muted-foreground">{user.email}</p></div>
            <Button variant="ghost" size="icon" onClick={() => supabase.auth.signOut()} aria-label="Sign out"><LogOut /></Button>
          </div>
        </div>
      </aside>

      <main className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-20 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur lg:px-8">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu /></Button>
          <div className="relative max-w-xl flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/><Input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="Search documents, people or reference…" className="h-11 bg-muted/60 pl-10 shadow-none" /></div>
          <Button variant="ghost" size="icon" aria-label="Notifications"><Bell /></Button>
          <Button variant="default" className="hidden sm:inline-flex" onClick={() => setCreateOpen(true)}><FilePlus2 />New document</Button>
          <Button variant="default" size="icon" className="sm:hidden" onClick={() => setCreateOpen(true)} aria-label="New document"><FilePlus2 /></Button>
        </header>

        <div className="mx-auto max-w-[1500px] p-4 md:p-8">
          <div className="mb-8 flex items-end justify-between gap-4">
            <div><p className="mb-1 text-sm font-semibold text-primary">DOCUMENT CONTROL</p><h1 className="text-3xl font-bold tracking-normal md:text-4xl">{active}</h1><p className="mt-2 text-muted-foreground">Track submissions, reviews and decisions across your organisation.</p></div>
            <p className="hidden text-sm text-muted-foreground md:block">Sunday, 20 September 2026</p>
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
                <div className="hidden grid-cols-[1fr_150px_130px_110px] gap-4 border-b bg-muted/50 px-5 py-3 text-xs font-semibold uppercase text-muted-foreground md:grid"><span>Document</span><span>Department</span><span>Status</span><span>Due date</span></div>
                {visible.map((doc) => <DocumentRow key={doc.id} doc={doc} canApprove={doc.owner_id !== user.id && doc.id !== "demo-1"} onDecision={async(status) => { if(doc.id.startsWith("demo")) { setDocuments(sampleDocs.map(d=>d.id===doc.id?{...d,status}:d)); return; } await supabase.from("document_approvals").update({status, decided_at:new Date().toISOString()}).eq("document_id",doc.id).eq("approver_id",user.id); await loadData(); }} />)}
                {!visible.length && <div className="px-6 py-16 text-center"><FolderOpen className="mx-auto mb-3 h-9 w-9 text-muted-foreground"/><p className="font-semibold">No documents found</p><p className="mt-1 text-sm text-muted-foreground">Create a document or adjust your search.</p></div>}
              </div>
            </div>
            <aside className="space-y-6">
              <div className="rounded-lg bg-primary p-6 text-primary-foreground shadow-brand">
                <div className="mb-6 flex items-start justify-between"><div className="rounded-md bg-primary-foreground/15 p-2.5"><UploadCloud className="h-5 w-5"/></div><span className="text-xs font-semibold opacity-75">QUICK START</span></div>
                <h2 className="text-xl font-bold">Submit a new document</h2><p className="mt-2 text-sm leading-6 opacity-80">Upload files, select reviewers and follow every decision in one place.</p>
                <Button variant="onPrimary" className="mt-5 w-full" onClick={() => setCreateOpen(true)}>Start submission</Button>
              </div>
              <div className="rounded-lg border bg-card p-5">
                <div className="flex items-center justify-between"><h2 className="font-bold">Review queue</h2><span className="text-xs font-semibold text-primary">{counts.pending} OPEN</span></div>
                <div className="mt-4 space-y-4">{visible.filter(d=>d.status==="pending_review").slice(0,3).map(d=><div key={d.id} className="flex gap-3"><div className="mt-1 h-2 w-2 rounded-full bg-warning"/><div className="min-w-0"><p className="truncate text-sm font-semibold">{d.title}</p><p className="text-xs text-muted-foreground">Due {formatDate(d.due_date)}</p></div></div>)}</div>
              </div>
            </aside>
          </section>
        </div>
      </main>
      <NewDocumentDialog open={createOpen} onOpenChange={setCreateOpen} user={user} profiles={profiles} onCreated={async()=>{await loadData();setNotice("Document submitted successfully.")}} />
      {notice && <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-md bg-success px-4 py-3 text-sm font-semibold text-success-foreground shadow-xl"><Check className="h-4 w-4"/>{notice}<button onClick={()=>setNotice("")} aria-label="Dismiss"><X className="h-4 w-4"/></button></div>}
    </div>
  );
}

function AuthScreen({ mode, setMode, onSubmit, onGoogle, error, notice }:{mode:"signin"|"signup";setMode:(m:"signin"|"signup")=>void;onSubmit:(e:FormEvent<HTMLFormElement>)=>void;onGoogle:()=>void;error:string;notice:string}) {
  return <main className="grid min-h-screen bg-background lg:grid-cols-[1.05fr_.95fr]">
    <section className="relative hidden overflow-hidden bg-primary p-12 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
      <img src={logo.url} alt="Sanlam — Live with confidence" className="w-60 rounded-sm" />
      <div className="max-w-xl"><div className="mb-6 h-1 w-14 bg-primary-foreground"/><h1 className="text-5xl font-bold leading-tight tracking-normal">One secure place for every important document.</h1><p className="mt-5 max-w-lg text-lg leading-8 opacity-80">Submit, review and approve company documents with a clear record of every decision.</p></div>
      <div className="flex gap-8 text-sm opacity-80"><span>Secure files</span><span>Clear approvals</span><span>Email updates</span></div>
    </section>
    <section className="flex items-center justify-center px-5 py-12"><div className="w-full max-w-md">
      <img src={logo.url} alt="Sanlam" className="mb-10 w-44 rounded-sm lg:hidden" />
      <p className="text-sm font-bold text-primary">SANLAM DOCUMENT HUB</p><h2 className="mt-2 text-3xl font-bold tracking-normal">{mode==="signin"?"Welcome back":"Create your account"}</h2><p className="mt-2 text-muted-foreground">{mode==="signin"?"Sign in to continue to your workspace.":"Use your company details to get started."}</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">{mode==="signup"&&<label className="block text-sm font-semibold">Full name<Input name="name" className="mt-2 h-11" autoComplete="name"/></label>}<label className="block text-sm font-semibold">Work email<Input name="email" type="email" className="mt-2 h-11" autoComplete="email"/></label><label className="block text-sm font-semibold">Password<Input name="password" type="password" className="mt-2 h-11" autoComplete={mode==="signin"?"current-password":"new-password"}/></label>{error&&<p className="text-sm font-medium text-destructive">{error}</p>}{notice&&<p className="text-sm font-medium text-success">{notice}</p>}<Button type="submit" className="h-11 w-full">{mode==="signin"?"Sign in":"Create account"}</Button></form>
      <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border"/>OR<span className="h-px flex-1 bg-border"/></div><Button variant="outline" className="h-11 w-full" onClick={onGoogle}>Continue with Google</Button>
      <p className="mt-7 text-center text-sm text-muted-foreground">{mode==="signin"?"New to the portal? ":"Already have an account? "}<button className="font-semibold text-primary" onClick={()=>setMode(mode==="signin"?"signup":"signin")}>{mode==="signin"?"Create account":"Sign in"}</button></p>
    </div></section>
  </main>;
}

function Metric({label,value,icon:Icon,tone}:{label:string;value:number;icon:typeof Files;tone:string}) { return <div className="rounded-lg border bg-card p-5"><div className="flex items-start justify-between"><div><p className="text-sm font-medium text-muted-foreground">{label}</p><p className="mt-3 text-3xl font-bold">{String(value).padStart(2,"0")}</p></div><div className={`metric-icon metric-${tone}`}><Icon/></div></div><p className="mt-4 text-xs text-muted-foreground">Updated just now</p></div> }

function Status({status}:{status:DocStatus}) { const labels={draft:"Draft",pending_review:"Pending review",approved:"Approved",returned:"Returned",rejected:"Rejected"}; return <span className={`status status-${status}`}>{labels[status]}</span> }

function DocumentRow({doc,canApprove,onDecision}:{doc:PortalDocument;canApprove:boolean;onDecision:(s:"approved"|"returned"|"rejected")=>void}) { return <div className="grid gap-3 border-b px-5 py-4 last:border-0 md:grid-cols-[1fr_150px_130px_110px] md:items-center"><div className="flex min-w-0 items-center gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-accent text-primary"><Files className="h-5 w-5"/></div><div className="min-w-0"><p className="truncate text-sm font-semibold">{doc.title}</p><p className="truncate text-xs text-muted-foreground">{doc.document_type} · {doc.category}</p></div></div><span className="text-sm text-muted-foreground">{doc.department || "General"}</span><Status status={doc.status}/><div className="flex items-center justify-between gap-2"><span className="text-sm text-muted-foreground">{formatDate(doc.due_date)}</span>{canApprove&&<div className="flex"><Button variant="ghost" size="icon" onClick={()=>onDecision("approved")} aria-label="Approve"><Check className="text-success"/></Button><Button variant="ghost" size="icon" onClick={()=>onDecision("returned")} aria-label="Return"><XCircle className="text-warning"/></Button></div>}</div></div> }

function NewDocumentDialog({open,onOpenChange,user,profiles,onCreated}:{open:boolean;onOpenChange:(v:boolean)=>void;user:User;profiles:Profile[];onCreated:()=>void}) {
  const [category,setCategory]=useState<keyof typeof categories>("Finance"); const [saving,setSaving]=useState(false); const [error,setError]=useState("");
  async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setSaving(true);setError("");const f=new FormData(e.currentTarget);const file=f.get("file");const approver=String(f.get("approver")??"");
    const title=String(f.get("title")??"").trim(); if(!title||!(file instanceof File)||!file.size){setError("Add a title and at least one file.");setSaving(false);return;} if(file.size>20971520){setError("Files must be 20 MB or smaller.");setSaving(false);return;}
    const {data:doc,error:docErr}=await supabase.from("documents").insert({owner_id:user.id,title,document_type:String(f.get("type")),category,department:String(f.get("department")??""),description:String(f.get("description")??""),due_date:String(f.get("due")??"")||null,status:"pending_review",submitted_at:new Date().toISOString()}).select().single();
    if(docErr||!doc){setError(docErr?.message??"Could not create the document.");setSaving(false);return;} const path=`${user.id}/${doc.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,"-")}`; const {error:upErr}=await supabase.storage.from("documents").upload(path,file); if(upErr){setError(upErr.message);setSaving(false);return;}
    await supabase.from("document_attachments").insert({document_id:doc.id,uploaded_by:user.id,file_name:file.name,storage_path:path,mime_type:file.type||"application/octet-stream",size_bytes:file.size});
    await supabase.from("document_activity").insert({document_id:doc.id,actor_id:user.id,action:"submitted",details:"Document submitted for review"});
    if(approver){await supabase.from("document_approvals").insert({document_id:doc.id,approver_id:approver}); await supabase.from("notification_schedule").insert({document_id:doc.id,recipient_id:approver,notification_type:"submission",scheduled_for:new Date().toISOString()});}
    if(doc.due_date&&approver){const reminder=new Date(doc.due_date); reminder.setDate(reminder.getDate()-2); await supabase.from("notification_schedule").insert({document_id:doc.id,recipient_id:approver,notification_type:"due_reminder",scheduled_for:reminder.toISOString()});}
    setSaving(false);onOpenChange(false);onCreated();
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle className="text-2xl">Submit a document</DialogTitle><DialogDescription>Add the document details and choose who should review it.</DialogDescription></DialogHeader><form onSubmit={submit} className="mt-2 grid gap-5 sm:grid-cols-2"><label className="block text-sm font-semibold sm:col-span-2">Document title<Input name="title" maxLength={160} className="mt-2 h-11" placeholder="e.g. September supplier payment"/></label><label className="block text-sm font-semibold">Category<select value={category} onChange={e=>setCategory(e.target.value as keyof typeof categories)} className="form-select mt-2"><>{Object.keys(categories).map(c=><option key={c}>{c}</option>)}</></select></label><label className="block text-sm font-semibold">Document type<select name="type" className="form-select mt-2">{categories[category].map(t=><option key={t}>{t}</option>)}</select></label><label className="block text-sm font-semibold">Department<Input name="department" maxLength={100} className="mt-2 h-11" placeholder="Finance"/></label><label className="block text-sm font-semibold">Due date<Input name="due" type="date" className="mt-2 h-11"/></label><label className="block text-sm font-semibold sm:col-span-2">Selected approver<select name="approver" className="form-select mt-2"><option value="">Choose an approver</option>{profiles.filter(p=>p.id!==user.id).map(p=><option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</select></label><label className="block text-sm font-semibold sm:col-span-2">Description<Textarea name="description" maxLength={2000} className="mt-2 min-h-24" placeholder="Add context for the reviewer…"/></label><label className="upload-zone sm:col-span-2"><UploadCloud className="h-7 w-7 text-primary"/><span className="font-semibold">Choose a document to upload</span><span className="text-xs text-muted-foreground">PDF, Word, Excel, images and supporting files up to 20 MB</span><input name="file" type="file" className="sr-only" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.txt,.zip"/></label>{error&&<p className="text-sm font-medium text-destructive sm:col-span-2">{error}</p>}<div className="flex justify-end gap-3 sm:col-span-2"><Button type="button" variant="outline" onClick={()=>onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving?"Submitting…":"Submit for review"}</Button></div></form></DialogContent></Dialog>
}

function formatDate(value:string|null){if(!value)return "No due date";return new Intl.DateTimeFormat("en-ZM",{day:"2-digit",month:"short"}).format(new Date(`${value}T12:00:00`));}
