import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { getPortalDataFn } from "@/lib/portal.functions";
import { ContractForm, type Profile } from "@/components/forms/ContractForm";

const CRM_USER_ID = "00000000-0000-4000-8000-000000000001";
const CRM_SIGN_IN_REQUIRED_MESSAGE =
  "Your Document Hub session is not active. Sign in to the CRM and then return here to continue.";

function isCrmSignInError(error: unknown) {
  return (
    error instanceof Error &&
    /^(Sign in through the CRM to open Document Hub\.|Your CRM sign-in has expired or is invalid\. Reopen Document Hub from the CRM\.)$/.test(
      error.message,
    )
  );
}

export const Route = createFileRoute("/contract")({
  head: () => ({ meta: [{ title: "New contract | Sanlam Document Hub" }] }),
  loader: async () => {
    try {
      const data = await getPortalDataFn();
      return {
        user: {
          id: data.currentUser.id,
          full_name: data.currentUser.full_name,
          department: data.currentUser.department,
        },
        profiles: data.profiles.filter((profile) => profile.id !== CRM_USER_ID) as Profile[],
        error: "",
      };
    } catch (error) {
      return {
        user: null,
        profiles: [] as Profile[],
        error: isCrmSignInError(error)
          ? CRM_SIGN_IN_REQUIRED_MESSAGE
          : error instanceof Error
            ? error.message
            : "The contract form could not be loaded.",
      };
    }
  },
  component: NewContractPage,
});

function NewContractPage() {
  const { user, profiles, error } = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  if (!user) {
    const needsCrmSignIn = error === CRM_SIGN_IN_REQUIRED_MESSAGE;
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
        <section className="w-full max-w-xl rounded-lg border bg-card p-8 text-center shadow-sm">
          <h1 className="text-2xl font-bold">
            {needsCrmSignIn ? "Sign in to continue" : "Could not load the contract form"}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">{error}</p>
          <div className="mt-6 flex justify-center gap-3">
            <Button variant="outline" onClick={() => void navigate({ to: "/" })}>
              Back to Document Hub
            </Button>
            <Button
              onClick={() =>
                needsCrmSignIn
                  ? window.location.assign("http://172.29.4.43/")
                  : void router.invalidate()
              }
            >
              {needsCrmSignIn ? "Sign in to CRM" : "Try again"}
            </Button>
          </div>
        </section>
      </main>
    );
  }
  return (
    <ContractForm
      user={user}
      profiles={profiles}
      onDone={() => void navigate({ to: "/" })}
      onCancel={() => void navigate({ to: "/" })}
    />
  );
}
