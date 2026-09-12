import { useCallback, useEffect, useMemo, useState } from "react";
import { readWorkbenchRuntimeConfig } from "../runtime/workbench-runtime-config";

type AccessDevice = {
  deviceId: string;
  kind: "owner" | "client" | "resource";
  label: string;
  platform: string;
  scopes: string[];
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
};

type Pairing = {
  pairingId: string;
  userCode: string;
  pairingUrl: string;
  kind: AccessDevice["kind"];
  delivery: "cookie" | "bearer";
  expiresAt: number;
};

type AccessSession = {
  authenticated: boolean;
  expiresAt: number;
  device: AccessDevice;
};

type NodeSummary = {
  nodeId?: string;
  status?: string;
  capabilities?: Array<{ name?: string }>;
  resources?: Array<{ projectId?: string; label?: string }>;
};

type DeviceAccessScope =
  | "workspace"
  | "registered-projects"
  | "selected-roots"
  | "home";

type DeviceAccessRequest = {
  id: string;
  tool: string;
  permission: "read" | "write" | "execute";
  path: string;
  reason: string;
  suggestedRoot: string;
  projectRoot: string;
  createdAt: number;
};

type DeviceAccessState = {
  policy: {
    scope: DeviceAccessScope;
    permissions: {
      read: boolean;
      write: boolean;
      execute: boolean;
    };
    selectedRoots: string[];
    sensitiveExceptions: string[];
    updatedAt: number;
  };
  effectiveRoots: string[];
  sensitiveRoots: string[];
  discoveredProjects: Array<{
    root: string;
    name: string;
    sessionIds: string[];
  }>;
  allowedTerminalSessionIds: string[];
  pendingRequests: DeviceAccessRequest[];
};

function isEnglish(): boolean {
  try {
    return String(
      window.zion?.i18n?.getLocale?.()
      || window.zion?.state?.get?.("ui.locale")
      || ""
    ).startsWith("en");
  } catch {
    return false;
  }
}

function text(zh: string, en: string): string {
  return isEnglish() ? en : zh;
}

function formatTime(value: number): string {
  if (!Number(value)) return "-";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const raw: unknown = await response.json().catch(() => null);
  const body = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  if (!response.ok) {
    const error = new Error(
      String(body.error || `Runtime HTTP ${response.status}`)
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body;
}

export function RemoteAccessSettings() {
  const config = useMemo(() => readWorkbenchRuntimeConfig({
    state: window.zion?.state,
    storage: globalThis.localStorage
  }), []);
  const [session, setSession] = useState<AccessSession | null>(null);
  const [devices, setDevices] = useState<AccessDevice[]>([]);
  const [nodesById, setNodesById] = useState<Record<string, NodeSummary>>({});
  const [pairKind, setPairKind] = useState<"client" | "resource">("client");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [deviceAccess, setDeviceAccess] = useState<DeviceAccessState | null>(null);
  const [accessError, setAccessError] = useState("");
  const [rootDraft, setRootDraft] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const requestHeaders: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      requestHeaders[name] = value;
    });
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...requestHeaders
      }
    });
    return responseJson(response);
  }, [config.baseUrl]);

  const refresh = useCallback(async () => {
    setError("");
    try {
      const nextSession = await request(
        "/v1/access/session"
      ) as unknown as AccessSession;
      setSession(nextSession);
      if (!nextSession.device?.scopes?.includes("device.manage")) {
        setDevices([]);
        setNodesById({});
        setDeviceAccess(null);
        return;
      }
      const [rawDevices, rawNodes] = await Promise.all([
        request("/v1/access/devices"),
        request("/v1/device-nodes").catch(() => ({ nodes: [] }))
      ]);
      const deviceResult = rawDevices as unknown as {
        devices?: AccessDevice[];
      };
      const nodeResult = rawNodes as unknown as {
        nodes?: NodeSummary[];
      };
      setDevices(Array.isArray(deviceResult?.devices) ? deviceResult.devices : []);
      const nodes: Record<string, NodeSummary> = {};
      for (const node of Array.isArray(nodeResult?.nodes) ? nodeResult.nodes : []) {
        const nodeId = String(node?.nodeId || "");
        if (nodeId) nodes[nodeId] = node;
      }
      setNodesById(nodes);
      try {
        const access = await request(
          "/v1/device-services/device-access/policy"
        ) as unknown as DeviceAccessState;
        setDeviceAccess(access);
        setAccessError("");
      } catch (reason) {
        setDeviceAccess(null);
        setAccessError(reason instanceof Error ? reason.message : String(reason));
      }
    } catch (reason) {
      const failure = reason as Error & { status?: number };
      if (failure.status === 404) {
        setSession(null);
        setDevices([]);
        setNodesById({});
        setError(text(
          "当前 Runtime 使用本地模式，未启用远程访问。",
          "This Runtime is in local mode; remote access is disabled."
        ));
      } else {
        setError(failure.message);
      }
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let active = true;
    if (!pairing?.pairingUrl || pairing.kind === "resource") {
      setQrDataUrl("");
      return () => {
        active = false;
      };
    }
    void import("qrcode")
      .then(({ toDataURL }) => toDataURL(pairing.pairingUrl, {
        width: 224,
        margin: 1,
        errorCorrectionLevel: "M",
        color: {
          dark: "#18181b",
          light: "#ffffff"
        }
      }))
      .then((value) => {
        if (active) setQrDataUrl(value);
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      active = false;
    };
  }, [pairing]);

  const createPairing = async () => {
    setBusy("create");
    setMessage("");
    setError("");
    try {
      const result = await request("/v1/access/pairings", {
        method: "POST",
        body: JSON.stringify({
          kind: pairKind,
          delivery: pairKind === "resource" ? "bearer" : "cookie",
          label: pairKind === "resource"
            ? text("工具电脑", "Tool computer")
            : text("浏览器", "Browser")
        })
      });
      setPairing(result as unknown as Pairing);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(text(`已复制${label}`, `${label} copied`));
      window.setTimeout(() => setMessage(""), 1800);
    } catch {
      setError(text("复制失败，请手动选择。", "Copy failed. Select it manually."));
    }
  };

  const revoke = async (device: AccessDevice) => {
    if (!window.confirm(text(
      `吊销 ${device.label || device.deviceId}？`,
      `Revoke ${device.label || device.deviceId}?`
    ))) {
      return;
    }
    setBusy(device.deviceId);
    setError("");
    try {
      await request(
        `/v1/access/devices/${encodeURIComponent(device.deviceId)}/revoke`,
        { method: "POST" }
      );
      setPairing(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const updateDeviceAccess = async (
    patch: Record<string, unknown>,
    successMessage: string
  ) => {
    setBusy("device-access");
    setAccessError("");
    try {
      const result = await request(
        "/v1/device-services/device-access/policy",
        {
          method: "PATCH",
          body: JSON.stringify(patch)
        }
      ) as unknown as DeviceAccessState;
      setDeviceAccess(result);
      setMessage(successMessage);
      window.setTimeout(() => setMessage(""), 1800);
      return true;
    } catch (reason) {
      setAccessError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy("");
    }
  };

  const addSelectedRoot = async () => {
    const root = rootDraft.trim();
    if (!root || !deviceAccess) return;
    const saved = await updateDeviceAccess({
      selectedRoots: [...new Set([
        ...deviceAccess.policy.selectedRoots,
        root
      ])]
    }, text("目录授权已保存", "Directory grant saved"));
    if (saved) setRootDraft("");
  };

  const removeSelectedRoot = async (root: string) => {
    if (!deviceAccess) return;
    await updateDeviceAccess({
      selectedRoots: deviceAccess.policy.selectedRoots.filter(
        (item) => item !== root
      ),
      sensitiveExceptions: deviceAccess.policy.sensitiveExceptions.filter(
        (item) => item !== root
      )
    }, text("目录授权已撤销", "Directory grant revoked"));
  };

  const resolveAccessRequest = async (
    accessRequest: DeviceAccessRequest,
    action: "approve" | "reject",
    scope = "project"
  ) => {
    setBusy(accessRequest.id);
    setAccessError("");
    try {
      const result = await request(
        `/v1/device-services/device-access/requests/${
          encodeURIComponent(accessRequest.id)
        }/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ scope })
        }
      ) as unknown as DeviceAccessState;
      setDeviceAccess(result);
      setMessage(action === "approve"
        ? text("访问请求已批准，请重试工具调用", "Access approved; retry the tool call")
        : text("访问请求已拒绝", "Access request rejected"));
      window.setTimeout(() => setMessage(""), 2200);
    } catch (reason) {
      setAccessError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const isOwner = session?.device?.scopes?.includes("device.manage") === true;
  const connectorCommand = pairing?.kind === "resource"
    ? `npm run device:connect -- --runtime-url ${shellQuote(config.baseUrl)} `
      + `--pairing-code ${shellQuote(pairing.userCode)}`
    : "";

  if (loading) {
    return <div className="zion-access-empty">{text("正在检查连接...", "Checking connection...")}</div>;
  }

  return (
    <div className="zion-access-settings">
      <section className="zion-access-summary">
        <div>
          <div className="zion-access-title">{text("远程访问", "Remote Access")}</div>
          <div className="zion-access-meta">{config.baseUrl}</div>
        </div>
        <div className={`zion-access-state ${session ? "is-online" : "is-offline"}`}>
          <span className="zion-access-state-dot" />
          {session ? text("已连接", "Connected") : text("本地模式", "Local mode")}
        </div>
      </section>

      {session ? (
        <section className="zion-access-current">
          <span>{session.device.label || session.device.deviceId}</span>
          <span>{session.device.kind}</span>
          <span>{formatTime(session.expiresAt)}</span>
        </section>
      ) : null}

      {isOwner ? (
        <>
          <section className="zion-access-policy">
            <div className="zion-access-section-head">
              <div>
                <div className="zion-access-section-title">
                  {text("Agent 项目访问", "Agent Project Access")}
                </div>
                <div className="zion-access-section-meta">
                  {deviceAccess
                    ? text(
                        `${deviceAccess.discoveredProjects.length} 个项目 · ${deviceAccess.allowedTerminalSessionIds.length} 个终端`,
                        `${deviceAccess.discoveredProjects.length} projects · ${deviceAccess.allowedTerminalSessionIds.length} terminals`
                      )
                    : text("等待 Resource Device", "Waiting for Resource Device")}
                </div>
              </div>
              <button
                type="button"
                disabled={busy === "device-access"}
                onClick={() => void refresh()}
              >
                {text("刷新", "Refresh")}
              </button>
            </div>

            {deviceAccess ? (
              <>
                <label className="zion-access-policy-field">
                  <span>{text("访问范围", "Access scope")}</span>
                  <select
                    value={deviceAccess.policy.scope}
                    disabled={busy === "device-access"}
                    onChange={(event) => {
                      const scope = event.currentTarget.value as DeviceAccessScope;
                      if (
                        scope === "home"
                        && !window.confirm(text(
                          "允许访问整个用户目录？敏感目录仍会单独拦截。",
                          "Allow the entire home directory? Sensitive locations remain blocked."
                        ))
                      ) return;
                      void updateDeviceAccess(
                        { scope },
                        text("访问范围已更新", "Access scope updated")
                      );
                    }}
                  >
                    <option value="workspace">{text("当前工作区", "Current workspace")}</option>
                    <option value="registered-projects">{text("所有已登记项目", "All registered projects")}</option>
                    <option value="selected-roots">{text("指定目录", "Selected directories")}</option>
                    <option value="home">{text("整个用户目录", "Entire home directory")}</option>
                  </select>
                </label>

                <div className="zion-access-permissions">
                  {(["read", "write", "execute"] as const).map((permission) => (
                    <label key={permission} className="zion-access-permission">
                      <input
                        type="checkbox"
                        checked={deviceAccess.policy.permissions[permission]}
                        disabled={busy === "device-access"}
                        onChange={(event) => void updateDeviceAccess({
                          permissions: {
                            ...deviceAccess.policy.permissions,
                            [permission]: event.currentTarget.checked
                          }
                        }, text("能力权限已更新", "Capability permissions updated"))}
                      />
                      <span>{permission === "read"
                        ? text("读取", "Read")
                        : permission === "write"
                          ? text("写入", "Write")
                          : text("执行命令", "Execute")}</span>
                    </label>
                  ))}
                </div>

                <form
                  className="zion-access-root-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addSelectedRoot();
                  }}
                >
                  <input
                    type="text"
                    value={rootDraft}
                    placeholder="~/projects"
                    aria-label={text("添加授权目录", "Add allowed directory")}
                    onChange={(event) => setRootDraft(event.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    disabled={!rootDraft.trim() || busy === "device-access"}
                  >
                    {text("添加目录", "Add directory")}
                  </button>
                </form>

                {deviceAccess.policy.selectedRoots.length ? (
                  <div className="zion-access-root-list">
                    {deviceAccess.policy.selectedRoots.map((root) => (
                      <div key={root} className="zion-access-root-row">
                        <code title={root}>{root}</code>
                        <button
                          type="button"
                          aria-label={text(`撤销 ${root}`, `Revoke ${root}`)}
                          disabled={busy === "device-access"}
                          onClick={() => void removeSelectedRoot(root)}
                        >
                          {text("撤销", "Revoke")}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                <details className="zion-access-details">
                  <summary>
                    {text(
                      `当前生效 ${deviceAccess.effectiveRoots.length} 个目录`,
                      `${deviceAccess.effectiveRoots.length} effective roots`
                    )}
                  </summary>
                  <div className="zion-access-path-list">
                    {deviceAccess.effectiveRoots.map((root) => (
                      <code key={root}>{root}</code>
                    ))}
                  </div>
                </details>

                {deviceAccess.policy.scope === "registered-projects" ? (
                  <details className="zion-access-details">
                    <summary>
                      {text(
                        `自动发现 ${deviceAccess.discoveredProjects.length} 个项目`,
                        `${deviceAccess.discoveredProjects.length} discovered projects`
                      )}
                    </summary>
                    <div className="zion-access-path-list">
                      {deviceAccess.discoveredProjects.map((project) => (
                        <code key={project.root} title={project.root}>
                          {project.root}
                        </code>
                      ))}
                    </div>
                  </details>
                ) : null}

                {deviceAccess.pendingRequests.length ? (
                  <div className="zion-access-request-list">
                    <div className="zion-access-section-title">
                      {text("待审批", "Pending approvals")}
                    </div>
                    {deviceAccess.pendingRequests.map((accessRequest) => (
                      <div key={accessRequest.id} className="zion-access-request-row">
                        <span className="zion-access-request-main">
                          <strong>{accessRequest.tool} · {accessRequest.permission}</strong>
                          <code title={accessRequest.path}>{accessRequest.path}</code>
                        </span>
                        <span className="zion-access-actions">
                          <button
                            type="button"
                            disabled={busy === accessRequest.id}
                            onClick={() => void resolveAccessRequest(
                              accessRequest,
                              "approve",
                              "once"
                            )}
                          >
                            {text("仅一次", "Once")}
                          </button>
                          <button
                            type="button"
                            disabled={busy === accessRequest.id}
                            onClick={() => void resolveAccessRequest(
                              accessRequest,
                              "approve",
                              "project"
                            )}
                          >
                            {text("允许项目", "Allow project")}
                          </button>
                          <button
                            type="button"
                            disabled={busy === accessRequest.id}
                            onClick={() => void resolveAccessRequest(
                              accessRequest,
                              "reject"
                            )}
                          >
                            {text("拒绝", "Reject")}
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {accessError ? (
                  <div className="zion-access-error" role="alert">
                    {accessError}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="zion-access-empty">
                {accessError || text(
                  "Resource Device 离线或尚未支持访问策略。",
                  "The Resource Device is offline or does not support access policies yet."
                )}
              </div>
            )}
          </section>

          <section className="zion-access-pairing">
            <div className="zion-access-section-head">
              <div>
                <div className="zion-access-section-title">{text("添加设备", "Add Device")}</div>
                <div className="zion-access-section-meta">
                  {pairKind === "client"
                    ? text("浏览器或手机", "Browser or phone")
                    : text("提供本地工具的电脑", "Computer providing local tools")}
                </div>
              </div>
              <div className="zion-access-segmented" role="group">
                <button
                  type="button"
                  className={pairKind === "client" ? "is-active" : ""}
                  aria-pressed={pairKind === "client"}
                  onClick={() => {
                    setPairKind("client");
                    setPairing(null);
                  }}
                >
                  {text("浏览器", "Browser")}
                </button>
                <button
                  type="button"
                  className={pairKind === "resource" ? "is-active" : ""}
                  aria-pressed={pairKind === "resource"}
                  onClick={() => {
                    setPairKind("resource");
                    setPairing(null);
                  }}
                >
                  {text("工具电脑", "Tool computer")}
                </button>
              </div>
            </div>
            <button
              type="button"
              className="primary zion-access-create"
              disabled={busy === "create"}
              onClick={() => void createPairing()}
            >
              {busy === "create"
                ? text("生成中...", "Creating...")
                : text("生成一次性配对", "Create one-time pairing")}
            </button>

            {pairing ? (
              <div className="zion-access-pairing-result">
                {qrDataUrl ? (
                  <img
                    className="zion-access-qr"
                    src={qrDataUrl}
                    alt={text("浏览器配对二维码", "Browser pairing QR code")}
                  />
                ) : null}
                <div className="zion-access-code-area">
                  <div className="zion-access-code">{pairing.userCode}</div>
                  <div className="zion-access-expiry">
                    {text("有效至", "Expires")} {formatTime(pairing.expiresAt)}
                  </div>
                  {connectorCommand ? (
                    <code
                      className="zion-access-connector-command"
                      tabIndex={0}
                    >
                      {connectorCommand}
                    </code>
                  ) : null}
                  <div className="zion-access-actions">
                    <button
                      type="button"
                      onClick={() => void copy(pairing.userCode, text("配对码", "Pairing code"))}
                    >
                      {text("复制配对码", "Copy code")}
                    </button>
                    {pairing.pairingUrl && pairKind === "client" ? (
                      <button
                        type="button"
                        onClick={() => void copy(pairing.pairingUrl, text("配对链接", "Pairing link"))}
                      >
                        {text("复制链接", "Copy link")}
                      </button>
                    ) : null}
                    {connectorCommand ? (
                      <button
                        type="button"
                        onClick={() => void copy(connectorCommand, text("连接命令", "Connection command"))}
                      >
                        {text("复制连接命令", "Copy connect command")}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <section className="zion-access-devices">
            <div className="zion-access-section-head">
              <div>
                <div className="zion-access-section-title">{text("已绑定设备", "Paired Devices")}</div>
                <div className="zion-access-section-meta">
                  {devices.length} {text("台设备", "devices")}
                </div>
              </div>
              <button type="button" disabled={busy === "refresh"} onClick={() => void refresh()}>
                {text("刷新", "Refresh")}
              </button>
            </div>
            <div className="zion-access-device-list">
              {devices.map((device) => {
                const isCurrent = device.deviceId === session.device.deviceId;
                const node = nodesById[device.deviceId];
                const status = device.revokedAt
                  ? "revoked"
                  : device.kind === "resource"
                    ? String(node?.status || "offline")
                    : "active";
                const statusLabel = status === "online"
                  ? text("在线", "Online")
                  : status === "offline"
                    ? text("离线", "Offline")
                    : status === "revoked"
                      ? text("已吊销", "Revoked")
                      : text("已激活", "Active");
                const capabilityCount = Array.isArray(node?.capabilities)
                  ? node.capabilities.length
                  : 0;
                return (
                  <div key={device.deviceId} className="zion-access-device-row">
                    <span
                      className={`zion-access-device-dot is-${status}`}
                      aria-label={statusLabel}
                      title={statusLabel}
                    />
                    <span className="zion-access-device-main">
                      <span className="zion-access-device-label">
                        {device.label || device.deviceId}
                      </span>
                      <span className="zion-access-device-meta">
                        {device.platform || device.kind}
                        {" · "}
                        {statusLabel}
                        {device.kind === "resource" && capabilityCount
                          ? ` · ${capabilityCount} tools`
                          : ""}
                        {" · "}
                        {formatTime(device.lastSeenAt)}
                      </span>
                    </span>
                    <span className="zion-access-device-kind">
                      {device.kind === "resource" ? statusLabel : device.kind}
                    </span>
                    <button
                      type="button"
                      disabled={isCurrent || !!device.revokedAt || busy === device.deviceId}
                      onClick={() => void revoke(device)}
                    >
                      {isCurrent
                        ? text("当前设备", "Current")
                        : device.revokedAt
                          ? text("已吊销", "Revoked")
                          : text("吊销", "Revoke")}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      ) : null}

      {message ? <div className="zion-access-message">{message}</div> : null}
      {error ? <div className="zion-access-error" role="alert">{error}</div> : null}
    </div>
  );
}

export function registerRemoteAccessSettings() {
  return window.zion?.settings?.registerPage?.({
    id: "services.remote-access",
    title: text("设备与远程访问", "Devices & Remote Access"),
    description: text("连接状态、设备配对与吊销", "Connection, pairing, and revocation"),
    category: "services",
    order: 10,
    keywords: ["remote", "access", "device", "pairing", "设备", "远程", "配对"],
    sections: [{
      id: "services.remote-access.manage",
      title: text("设备", "Devices"),
      settings: [{
        id: "remote-access.manager",
        label: text("设备管理", "Device Management"),
        kind: "custom",
        renderCustom: () => <RemoteAccessSettings />
      }]
    }]
  });
}
