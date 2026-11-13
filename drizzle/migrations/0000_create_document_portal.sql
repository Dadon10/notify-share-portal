CREATE TYPE public.app_role AS ENUM ('admin', 'approver', 'employee');
CREATE TYPE public.document_status AS ENUM ('draft', 'pending_review', 'approved', 'returned', 'rejected');
CREATE TYPE public.approval_status AS ENUM ('pending', 'approved', 'returned', 'rejected');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  full_name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  department text NOT NULL DEFAULT '',
  job_title text NOT NULL DEFAULT '',
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view colleagues" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create their profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY "Users can update their profile" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL DEFAULT 'employee',
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their roles" ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;

CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  document_type text NOT NULL CHECK (char_length(document_type) BETWEEN 1 AND 80),
  category text NOT NULL CHECK (category IN ('Finance','HR','Legal','Compliance','Operations','Custom')),
  department text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  supplier text,
  amount numeric(14,2),
  currency text NOT NULL DEFAULT 'ZMW',
  due_date date,
  status public.document_status NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;
GRANT ALL ON public.documents TO service_role;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners can create documents" ON public.documents FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Owners can manage documents" ON public.documents FOR ALL TO authenticated USING (owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin')) WITH CHECK (owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.document_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  approver_id uuid NOT NULL,
  sequence_no integer NOT NULL DEFAULT 1 CHECK (sequence_no > 0),
  status public.approval_status NOT NULL DEFAULT 'pending',
  comment text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 1200),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, approver_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_approvals TO authenticated;
GRANT ALL ON public.document_approvals TO service_role;
ALTER TABLE public.document_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Participants can view approvals" ON public.document_approvals FOR SELECT TO authenticated USING (approver_id = auth.uid() OR EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND (d.owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))));
CREATE POLICY "Owners can assign approvers" ON public.document_approvals FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.owner_id = auth.uid()));
CREATE POLICY "Approvers can decide" ON public.document_approvals FOR UPDATE TO authenticated USING (approver_id = auth.uid() OR public.has_role(auth.uid(), 'admin')) WITH CHECK (approver_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Owners can remove draft approvals" ON public.document_approvals FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.owner_id = auth.uid() AND d.status = 'draft'));

CREATE POLICY "Participants can view documents" ON public.documents FOR SELECT TO authenticated USING (owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin') OR EXISTS (SELECT 1 FROM public.document_approvals a WHERE a.document_id = id AND a.approver_id = auth.uid()));

CREATE TABLE public.document_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  storage_path text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.document_attachments TO authenticated;
GRANT ALL ON public.document_attachments TO service_role;
ALTER TABLE public.document_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Participants can view attachments" ON public.document_attachments FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND (d.owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin') OR EXISTS (SELECT 1 FROM public.document_approvals a WHERE a.document_id = d.id AND a.approver_id = auth.uid()))));
CREATE POLICY "Owners can add attachments" ON public.document_attachments FOR INSERT TO authenticated WITH CHECK (uploaded_by = auth.uid() AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.owner_id = auth.uid()));
CREATE POLICY "Owners can remove draft attachments" ON public.document_attachments FOR DELETE TO authenticated USING (uploaded_by = auth.uid() AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.status = 'draft'));

CREATE TABLE public.document_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  author_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1200),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.document_comments TO authenticated;
GRANT ALL ON public.document_comments TO service_role;
ALTER TABLE public.document_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Participants can view comments" ON public.document_comments FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND (d.owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin') OR EXISTS (SELECT 1 FROM public.document_approvals a WHERE a.document_id = d.id AND a.approver_id = auth.uid()))));
CREATE POLICY "Participants can comment" ON public.document_comments FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid() AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND (d.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.document_approvals a WHERE a.document_id = d.id AND a.approver_id = auth.uid()))));

CREATE TABLE public.document_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.document_activity TO authenticated;
GRANT ALL ON public.document_activity TO service_role;
ALTER TABLE public.document_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Participants can view activity" ON public.document_activity FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND (d.owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin') OR EXISTS (SELECT 1 FROM public.document_approvals a WHERE a.document_id = d.id AND a.approver_id = auth.uid()))));
CREATE POLICY "Participants can create activity" ON public.document_activity FOR INSERT TO authenticated WITH CHECK (actor_id = auth.uid() AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND (d.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.document_approvals a WHERE a.document_id = d.id AND a.approver_id = auth.uid()))));

CREATE TABLE public.document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  document_type text NOT NULL,
  category text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_templates TO authenticated;
GRANT ALL ON public.document_templates TO service_role;
ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view templates" ON public.document_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create templates" ON public.document_templates FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Owners can manage templates" ON public.document_templates FOR UPDATE TO authenticated USING (owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin')) WITH CHECK (owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Owners can delete templates" ON public.document_templates FOR DELETE TO authenticated USING (owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.notification_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL,
  notification_type text NOT NULL CHECK (notification_type IN ('submission','status_change','due_reminder')),
  scheduled_for timestamptz NOT NULL,
  sent_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, recipient_id, notification_type, scheduled_for)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_schedule TO authenticated;
GRANT ALL ON public.notification_schedule TO service_role;
ALTER TABLE public.notification_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Participants can view notifications" ON public.notification_schedule FOR SELECT TO authenticated USING (recipient_id = auth.uid() OR EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.owner_id = auth.uid()));
CREATE POLICY "Owners can schedule notifications" ON public.notification_schedule FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.owner_id = auth.uid()));
CREATE POLICY "Owners can manage notifications" ON public.notification_schedule FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.owner_id = auth.uid())) WITH CHECK (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.owner_id = auth.uid()));
CREATE POLICY "Owners can delete notifications" ON public.notification_schedule FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.owner_id = auth.uid()));

CREATE INDEX documents_owner_idx ON public.documents(owner_id);
CREATE INDEX documents_status_due_idx ON public.documents(status, due_date);
CREATE INDEX approvals_approver_idx ON public.document_approvals(approver_id, status);
CREATE INDEX approvals_document_idx ON public.document_approvals(document_id);
CREATE INDEX attachments_document_idx ON public.document_attachments(document_id);
CREATE INDEX activity_document_idx ON public.document_activity(document_id, created_at DESC);
CREATE INDEX notifications_due_idx ON public.notification_schedule(scheduled_for) WHERE sent_at IS NULL AND cancelled_at IS NULL;

CREATE POLICY "Users can upload their document files" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Participants can read document files" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'documents' AND EXISTS (SELECT 1 FROM public.document_attachments da JOIN public.documents d ON d.id = da.document_id WHERE da.storage_path = name AND (d.owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin') OR EXISTS (SELECT 1 FROM public.document_approvals a WHERE a.document_id = d.id AND a.approver_id = auth.uid()))));
CREATE POLICY "Owners can delete draft document files" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text AND EXISTS (SELECT 1 FROM public.document_attachments da JOIN public.documents d ON d.id = da.document_id WHERE da.storage_path = name AND d.owner_id = auth.uid() AND d.status = 'draft'));
