import type { Via } from "@chainsafe/x402-example-one-job-catalog";

import { AgentGlyph, PersonGlyph } from "./Wire.js";

export function centsLabel(c: number): string {
  return `${c}¢`;
}

export const VIA_LABEL: Record<Via, string> = {
  Call: "Agents",
  Finger: "People",
  Both: "Both",
};

export const VIA_LINE: Record<Via, string> = {
  Call: "Mostly bought by agents and scripts.",
  Finger: "Mostly bought by a person on a phone.",
  Both: "Bought by people and agents alike.",
};

export function ViaMark({ via }: { via: Via }) {
  return (
    <span className={`via via-${via.toLowerCase()}`} title={VIA_LINE[via]}>
      {via !== "Finger" && <AgentGlyph />}
      {via !== "Call" && <PersonGlyph />}
      <span className="sr-only">{VIA_LABEL[via]}</span>
    </span>
  );
}

export function GridGlyph({ className = "agent-glyph" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden focusable="false">
      <rect x="2" y="2" width="5" height="5" rx="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1.5" />
    </svg>
  );
}

export function TillGlyph({ className = "agent-glyph" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden focusable="false">
      <rect x="2" y="6" width="12" height="8" rx="2" />
      <path d="M5 6V3.5h6V6" />
      <path d="M5 10h2M9 10h2" />
    </svg>
  );
}
