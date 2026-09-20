# Sanlam Document Management Portal

## Goal
Rebuild the uploaded PR Updater as a polished, shared company portal. Preserve its useful payment-requisition workflow while expanding it into a secure document submission, review, approval, and notification system for Finance, HR, Legal, Compliance, Operations, and custom document types.

## Experience
- Use the supplied Sanlam logo and its blue as the primary brand color, with a crisp white, light-grey, and restrained status-color palette.
- Create a professional responsive workspace with a left navigation, compact header, clear document counts, recent activity, approvals requiring attention, and due-date visibility.
- Make “New document” the main action. The guided submission flow will accept PDF, Word, spreadsheet, image, and common supporting files; capture document type, title, description, department, due date, selected approvers, and attachments.
- Provide searchable document records with type, owner, approver, status, due date, and activity history.
- Include dedicated views for dashboard, documents, approvals, templates, and settings without adding marketing pages.

## Workflow
- Users sign in before accessing company documents.
- A submitter creates a document, chooses one or more approvers, uploads files, and submits it.
- Approvers can approve, reject, or return a document with comments.
- Statuses cover Draft, Pending review, Approved, Returned, Rejected, and Overdue.
- Activity records show who created, submitted, reviewed, or changed each document.
- Existing PR-oriented concepts remain represented through Payment Requisition and Invoice types, including supplier and financial details where relevant.

## Email Notifications
- Use branded company-domain app emails for selected approvers on submission.
- Notify the submitter when a document is approved, rejected, or returned.
- Send due-date reminders for pending documents.
- Include document title, type, submitter, due date, current status, and a direct portal action link.
- Configure the sender through Lovable’s managed email delivery rather than exposing mail credentials in the browser. Email sending will activate after the company domain is verified.

## Data and Security
- Enable Lovable Cloud for authentication, persistent document metadata, secure file storage, and approval history.
- Store uploaded files in private storage and restrict access to authenticated users involved in the document workflow.
- Keep approver permissions server-validated; no privileged decisions will rely on browser storage.
- Use separate role assignments for future administrator controls.

## Technical Details
- Implement the portal in the existing TanStack Start app and preserve the project routing conventions.
- Add database tables for profiles, roles, documents, attachments, approval assignments, comments, activity, templates, and notification scheduling, each with explicit grants and row-level access rules.
- Add server functions for document creation, status transitions, signed file access, and fixed-template notification sends.
- Scaffold branded app-email templates and wire each email to its corresponding server-side workflow event.
- Due-date reminders will be represented as scheduled notification records; automated timed dispatch depends on the available hosting scheduler and will be wired using the supported managed mechanism.
- Add route-specific page metadata and a favicon derived from the supplied brand mark.

## Validation
- Verify sign-in protection, upload and submission, selected approver assignment, status actions, activity history, and email-trigger handling.
- Check the main workflows at desktop and mobile sizes, including file controls, long document names, empty states, and overdue states.
