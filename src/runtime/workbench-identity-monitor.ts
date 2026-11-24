import { accountRequest, setAccountSession, type AccountSession } from "../../packages/account-ui/src/client";

export function createWorkbenchIdentityMonitor(baseUrl: string, initial: AccountSession, onLost: () => void) {
  let identity = initial, pending: Promise<void> | null = null, lost = false, checkedAt = -Infinity;
  const apply = (next: AccountSession) => {
    if (next.user.id !== initial.user.id || next.space.id !== initial.space.id
      || next.membership?.status !== "active" || !next.scopes.includes("runtime.read")) {
      lost = true; onLost(); return;
    }
    // Same-account permissions can change live, including switching to read-only.
    // The server remains authoritative for every write and existing Run.
    if (JSON.stringify(next) !== JSON.stringify(identity)) {
      identity = next; setAccountSession(next);
    }
  };
  return () => {
    if (lost || pending || performance.now() - checkedAt < 3000) return pending;
    const read = () => accountRequest<AccountSession>(baseUrl, "me", undefined, "GET", {
      signal: AbortSignal.timeout(8000)
    });
    pending = (async () => {
      try { apply(await read()); }
      catch (error: any) {
        if (![401, 403, 404].includes(error.status)) return;
        // Confirm an isolated denial before locking the entire page. A failed
        // confirmation due to service/network availability is not revocation.
        try { apply(await read()); }
        catch (confirmation: any) {
          if ([401, 403, 404].includes(confirmation.status)) { lost = true; onLost(); }
        }
      }
    })().finally(() => { checkedAt = performance.now(); pending = null; });
    return pending;
  };
}
