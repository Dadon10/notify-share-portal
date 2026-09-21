CREATE OR REPLACE FUNCTION public.can_view_document(_document_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.documents d
    WHERE d.id = _document_id
      AND (
        d.owner_id = _user_id
        OR public.has_role(_user_id, 'admin')
        OR EXISTS (
          SELECT 1
          FROM public.document_approvals a
          WHERE a.document_id = d.id
            AND a.approver_id = _user_id
        )
      )
  )
$$;

GRANT EXECUTE ON FUNCTION public.can_view_document(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS "Participants can view documents" ON public.documents;
CREATE POLICY "Participants can view documents"
ON public.documents FOR SELECT TO authenticated
USING (public.can_view_document(id, auth.uid()));

DROP POLICY IF EXISTS "Participants can view approvals" ON public.document_approvals;
CREATE POLICY "Participants can view approvals"
ON public.document_approvals FOR SELECT TO authenticated
USING (public.can_view_document(document_id, auth.uid()));