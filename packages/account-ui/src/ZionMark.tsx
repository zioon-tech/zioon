import type { SVGProps } from "react";

export function ZionMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect width="32" height="32" rx="7" fill="var(--zion-mark-bg, #171a1d)" />
      <path
        d="M8.5 9.5h15"
        stroke="var(--zion-mark-fg, #f4f6f8)"
        strokeWidth="3.25"
        strokeLinecap="round"
      />
      <path
        d="m23.5 9.5-15 13"
        stroke="var(--zion-mark-accent, #67d3b5)"
        strokeWidth="3.25"
        strokeLinecap="round"
      />
      <path
        d="M8.5 22.5h15"
        stroke="var(--zion-mark-fg, #f4f6f8)"
        strokeWidth="3.25"
        strokeLinecap="round"
      />
    </svg>
  );
}
