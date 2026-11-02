import {
  Activity,
  ArrowLeft,
  Grid2X2,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  SquareTerminal,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";

export function IconButton({
  icon: Icon,
  label,
  ...props
}: {
  icon: LucideIcon;
  label: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`icon-button ${props.className || ""}`}
      type={props.type || "button"}
      aria-label={label}
      title={label}
    >
      <Icon size={20} aria-hidden="true" />
    </button>
  );
}

export function MobilePage({
  title,
  subtitle,
  back,
  action,
  children,
  footer,
  hideNav = false,
  className = "",
}: {
  title: string;
  subtitle?: string;
  back?: string;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  hideNav?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  return (
    <div className="app-stage">
      <section className={`mobile-shell ${className}`}>
        <header className="app-header">
          <div className="header-side">
            {back ? (
              <button className="back-button" type="button" onClick={() => navigate(-1)}>
                <ArrowLeft size={19} aria-hidden="true" />
                <span>{back}</span>
              </button>
            ) : null}
          </div>
          <div className="header-title">
            <strong>{title}</strong>
            {subtitle ? <small>{subtitle}</small> : null}
          </div>
          <div className="header-side end">{action}</div>
        </header>
        <main className="app-content">{children}</main>
        {footer}
        {!hideNav ? <BottomNav /> : null}
      </section>
    </div>
  );
}

function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname;
  const active = path.startsWith("/chat") || path === "/chats"
    ? "chats"
    : path.startsWith("/work") || path.startsWith("/run") || path.startsWith("/scheduler")
      ? "work"
      : path.startsWith("/terminal")
        ? "terminals"
        : "more";
  const items: Array<{
    key: string;
    label: string;
    path: string;
    icon: LucideIcon;
  }> = [
    { key: "chats", label: "对话", path: "/chats", icon: MessageSquare },
    { key: "work", label: "工作", path: "/work", icon: Activity },
    { key: "terminals", label: "终端", path: "/terminals", icon: SquareTerminal },
    { key: "more", label: "更多", path: "/more", icon: Grid2X2 },
  ];
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            className={active === item.key ? "is-active" : ""}
            type="button"
            key={item.key}
            onClick={() => navigate(item.path)}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="state-view">
      <LoaderCircle className="spin" size={24} aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div className="state-view error">
      <span className="state-icon"><WifiOff size={23} /></span>
      <h2>无法加载</h2>
      <p>{error instanceof Error ? error.message : String(error || "未知错误")}</p>
      {onRetry ? (
        <button className="button" type="button" onClick={onRetry}>
          <RefreshCw size={16} />重试
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-view">
      <span className="state-icon"><Icon size={23} /></span>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "green" | "amber" | "red";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="section-label">{children}</h2>;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented-control" role="tablist">
      {options.map((option) => (
        <button
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? "is-active" : ""}
          key={option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count != null ? <span>{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "";
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "刚刚";
  if (delta < 60 * 60_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟`;
  if (delta < 24 * 60 * 60_000) return `${Math.max(1, Math.floor(delta / 3_600_000))} 小时`;
  return new Date(timestamp).toLocaleDateString();
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (
      part && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text || "")
        : ""
    ))
    .filter(Boolean)
    .join("\n");
}
