import { LoaderCircle, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  clearPairingFragment,
  exchangePairing,
  getAccessSession,
  getHealth,
  pairingFromLocation,
} from "./api";
import type { AccessSession, RuntimeHealth } from "./types";
import { AccountPanel } from "../../../packages/account-ui/src/AccountPanel";
import { accountRequest, pendingInvitation, setAccountSession, type AccountSession } from "../../../packages/account-ui/src/client";
import { runtimeBaseUrl } from "./api";

type GateState =
  | { kind: "checking" }
  | { kind: "ready"; health: RuntimeHealth; access: AccessSession | null }
  | { kind: "pairing"; health: RuntimeHealth; error?: string }
  | { kind: "account"; health: RuntimeHealth }
  | { kind: "offline"; error: string };

export function AuthBoundary({
  children,
  onLogin
}: {
  children: ReactNode;
  onLogin?: (url: string) => void;
}) {
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const bootstrap = async () => {
    setState({ kind: "checking" });
    try {
      const health = await getHealth();
      if (!health.authRequired) {
        setState({ kind: "ready", health, access: null });
        return;
      }
      if ((health.authMode || health.accessControl) === "accounts-v1") {
        const invitation = pendingInvitation();
        const account = await accountRequest<AccountSession>(runtimeBaseUrl, "me").catch(() => null);
        if (account) setAccountSession(account);
        if (account?.membership?.status === "active" && !invitation) {
          setState({ kind: "ready", health, access: account });
        } else setState({ kind: "account", health });
        return;
      }
      const existing = await getAccessSession().catch(() => null);
      if (existing) {
        setState({ kind: "ready", health, access: existing });
        return;
      }
      const pairing = pairingFromLocation();
      if (pairing) {
        try {
          const access = await exchangePairing(pairing);
          clearPairingFragment();
          setState({ kind: "ready", health, access });
          return;
        } catch (error) {
          clearPairingFragment();
          setState({
            kind: "pairing",
            health,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      setState({ kind: "pairing", health });
    } catch (error) {
      setState({
        kind: "offline",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (state.kind !== "ready" || state.access?.mode !== "accounts-v1") return;
    const timer = window.setInterval(() => {
      void accountRequest<AccountSession>(runtimeBaseUrl, "me").then(next => {
        if (next.membership?.status !== "active"
          || next.space.id !== state.access?.space?.id
          || next.scopes.join() !== state.access?.scopes?.join()) {
          location.reload();
        }
      }).catch((error) => { if (error.status === 401) location.reload(); });
    }, 15_000);
    return () => clearInterval(timer);
  }, [state]);

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== "pairing" || !code.trim()) return;
    setSubmitting(true);
    try {
      const access = await exchangePairing({ userCode: code.trim() });
      setState({ kind: "ready", health: state.health, access });
      setCode("");
    } catch (error) {
      setState({
        ...state,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (state.kind === "ready") return children;
  if (state.kind === "account") return <AccountPanel baseUrl={runtimeBaseUrl}
    variant="gate"
    onLogin={onLogin}
    onContinue={account => {
      setAccountSession(account);
      setState({ kind: "ready", health: state.health, access: account });
    }} />;

  if (state.kind === "checking") {
    return (
      <main className="gate-screen">
        <LoaderCircle className="spin" size={28} aria-hidden="true" />
        <p>正在连接 Runtime</p>
      </main>
    );
  }

  if (state.kind === "offline") {
    return (
      <main className="gate-screen">
        <span className="gate-icon error"><WifiOff size={25} /></span>
        <h1>Runtime 不可用</h1>
        <p>{state.error}</p>
        <button className="button primary" type="button" onClick={() => void bootstrap()}>
          <RefreshCw size={17} />重试
        </button>
      </main>
    );
  }

  return (
    <main className="gate-screen">
      <span className="gate-icon"><ShieldCheck size={25} /></span>
      <h1>连接 Zion</h1>
      <p>输入 Owner 设备生成的一次性 Client 配对码。</p>
      <form className="pairing-form" onSubmit={pair}>
        <label htmlFor="pairingCode">配对码</label>
        <input
          id="pairingCode"
          value={code}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          placeholder="XXXX-XXXX-XXXX"
          onChange={(event) => setCode(event.target.value.toUpperCase())}
        />
        {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
        <button className="button primary" type="submit" disabled={submitting || !code.trim()}>
          {submitting ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
          连接
        </button>
      </form>
    </main>
  );
}
