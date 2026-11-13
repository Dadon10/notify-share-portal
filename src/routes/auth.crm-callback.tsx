import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { consumeCrmSsoToken, getSessionCookieName } from "@/lib/crm-sso.server";

async function getTokenFromRequest(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data") && !contentType.includes("application/x-www-form-urlencoded")) {
    return null;
  }

  try {
    const form = await request.clone().formData();
    const token = form.get("token");
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

async function completeCrmSignIn(request: Request) {
  const token = await getTokenFromRequest(request);
  if (!token) {
    // This URL is also sometimes opened directly or saved as a bookmark.
    // A CRM launch token can only be issued by the CRM, so send browser
    // visits back to the portal's existing sign-in guidance instead of
    // showing a raw 400 response. Keep tokenless POSTs explicit for callers.
    if (request.method === "GET") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Cache-Control": "no-store, private",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    return new Response("Missing CRM sign-in token.", { status: 400 });
  }

  try {
    const { sessionToken } = consumeCrmSsoToken(token);
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    const cookie = `${getSessionCookieName()}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure}`;
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": cookie,
        "Cache-Control": "no-store, private",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    console.error("CRM SSO callback failed:", error);
    return new Response("CRM sign-in failed. Reopen Document Hub from the CRM.", {
      status: 401,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
}

function CRMCallbackRoute() {
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      void navigate({ to: "/", replace: true });
      return;
    }

    const form = new FormData();
    form.set("token", token);

    void fetch(window.location.pathname, {
      method: "POST",
      body: form,
      credentials: "same-origin",
    })
      .then((response) => {
        if (!response.ok && response.status !== 303) {
          throw new Error(`CRM callback failed with status ${response.status}`);
        }
        return response;
      })
      .then(() => {
        void navigate({ to: "/", replace: true });
      })
      .catch(() => {
        void navigate({ to: "/", replace: true });
      });
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="text-center">
        <p className="text-sm font-medium text-muted-foreground">Redirecting to the portal…</p>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/auth/crm-callback")({
  component: CRMCallbackRoute,
  server: {
    handlers: {
      GET: async ({ request }) => completeCrmSignIn(request),
      POST: async ({ request }) => completeCrmSignIn(request),
    },
  },
});
