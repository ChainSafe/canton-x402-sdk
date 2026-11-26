import React, { useEffect, useState } from "react";

/**
 * The x402 exchange drawn as three lanes. Each row is one message between two
 * parties. In the hero it loops a sample call; on a tool page it replays the
 * call that just ran, and each row opens to the payload that crossed the wire.
 */

export type Lane = 0 | 1 | 2;
export type Tone = "ask" | "pay" | "ok" | "quiet";

export interface WireStep {
  id: string;
  from: Lane;
  to: Lane;
  label: string;
  note?: string;
  tone: Tone;
  payload?: unknown;
  standIn?: boolean;
}

export type Caller = "person" | "agent";

const LANES = { person: ["You", "Merchant", "Facilitator"], agent: ["Your agent", "Merchant", "Facilitator"] } as const;

export function exchangeSteps(
  tool: string,
  trace: Record<string, unknown> | null,
  caller: Caller = "person",
): WireStep[] {
  const server = (trace?.serverTrace ?? null) as Record<string, unknown> | null;
  const required = (trace?.paymentRequired ?? null) as { accepts?: Array<{ extra?: unknown }> } | null;
  return [
    { id: "post", from: 0, to: 1, label: `POST /v1/${tool}`, note: "No payment attached", tone: "quiet", payload: trace?.requestBody },
    { id: "supported", from: 1, to: 2, label: "GET /v2/supported", note: "Fee payer, synchronizer, instrument admin", tone: "quiet", payload: required?.accepts?.[0]?.extra },
    { id: "402", from: 1, to: 0, label: "402 Payment Required", note: "Terms in PAYMENT-REQUIRED", tone: "ask", payload: trace?.paymentRequired },
    { id: "sign", from: 0, to: 1, label: "Retry with PAYMENT-SIGNATURE", note: caller === "agent" ? "Paid from its budget, no prompt" : "Your passkey approves it", tone: "pay", standIn: true, payload: server ? { standIn: server.standIn, note: server.note } : undefined },
    { id: "verify", from: 1, to: 2, label: "POST /v2/verify", note: "Is the payment valid?", tone: "quiet", payload: server?.verify },
    { id: "settle", from: 1, to: 2, label: "POST /v2/settle", note: "Move the funds", tone: "quiet", payload: server?.settle },
    { id: "200", from: 1, to: 0, label: "200 OK", note: "Result plus PAYMENT-RESPONSE", tone: "ok", payload: trace?.paymentResponse },
  ];
}

function show(value: unknown): string {
  if (value === undefined || value === null) return "Not in this trace.";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** How many rows are lit. Loops in the hero; counts up once on a tool page. */
function useReveal(
  total: number,
  mode: "loop" | "once" | "idle" | "pending",
  key: unknown,
  onLoop?: () => void,
): number {
  const [shown, setShown] = useState(mode === "loop" ? 0 : mode === "once" ? 0 : 0);
  useEffect(() => {
    if (mode === "idle" || mode === "pending") {
      setShown(0);
      return;
    }
    if (prefersReducedMotion()) {
      setShown(total);
      return;
    }
    setShown(0);
    let i = 0;
    let timer: number;
    const tick = () => {
      i += 1;
      if (i <= total) {
        setShown(i);
        timer = window.setTimeout(tick, mode === "loop" ? 900 : 260);
      } else if (mode === "loop") {
        timer = window.setTimeout(() => {
          i = 0;
          setShown(0);
          onLoop?.();
          timer = window.setTimeout(tick, 700);
        }, 2600);
      }
    };
    timer = window.setTimeout(tick, mode === "loop" ? 500 : 120);
    return () => window.clearTimeout(timer);
    // onLoop is read when the loop wraps; it does not restart the animation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, mode, key]);
  return shown;
}

export function Wire({
  steps,
  mode,
  replayKey,
  interactive = false,
  caption,
  caller = "person",
  onLoop,
  toolbar,
}: {
  steps: WireStep[];
  mode: "loop" | "once" | "idle" | "pending";
  replayKey?: unknown;
  interactive?: boolean;
  caption?: string;
  caller?: Caller;
  onLoop?: () => void;
  toolbar?: React.ReactNode;
}) {
  const shown = useReveal(steps.length, mode, replayKey, onLoop);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => setOpen(null), [replayKey]);

  return (
    <figure className={`wire wire--${mode} wire--${caller}`}>
      {toolbar}
      <div className="wire-lanes" aria-hidden>
        {LANES[caller].map((name, i) => (
          <span key={i} className={`wire-lane-name ${i === 0 ? "wire-lane-caller" : ""}`}>
            {i === 0 && caller === "agent" && <AgentGlyph />}
            {name}
          </span>
        ))}
      </div>
      <ol className="wire-rows">
        {steps.map((s, i) => {
          const lit = i < shown;
          const head = i === shown - 1;
          const left = Math.min(s.from, s.to);
          const right = Math.max(s.from, s.to);
          const dir = s.to > s.from ? "dir-fwd" : "dir-back";
          const isOpen = open === s.id;
          const Row = interactive && lit ? "button" : "div";
          return (
            <li
              key={s.id}
              className={`wire-row tone-${s.tone} ${lit ? "lit" : ""} ${head ? "head" : ""} ${isOpen ? "open" : ""}`}
              style={{ ["--from" as string]: left, ["--to" as string]: right }}
            >
              <Row
                className="wire-hit"
                {...(Row === "button"
                  ? { type: "button" as const, "aria-expanded": isOpen, onClick: () => setOpen(isOpen ? null : s.id) }
                  : {})}
              >
                <span className={`wire-line ${dir}`} aria-hidden>
                  <span className="wire-packet" />
                </span>
                <span className="wire-text">
                  <span className="wire-label">{s.label}</span>
                  {s.note && <span className="wire-note">{s.note}</span>}
                  {s.standIn && <span className="wire-standin">stand-in</span>}
                </span>
              </Row>
              {isOpen && <pre className="wire-payload">{show(s.payload)}</pre>}
            </li>
          );
        })}
      </ol>
      {caption && <figcaption className="wire-caption">{caption}</figcaption>}
    </figure>
  );
}

/** A small agent mark: a cursor prompt in a rounded frame. Not a robot. */
export function AgentGlyph({ className = "agent-glyph" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="3" />
      <path d="M5 6.5l2 1.5-2 1.5" />
      <path d="M8.5 10h2.5" />
    </svg>
  );
}

export function PersonGlyph({ className = "agent-glyph" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden focusable="false">
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c.6-2.8 2.6-4.3 5-4.3s4.4 1.5 5 4.3" />
    </svg>
  );
}
