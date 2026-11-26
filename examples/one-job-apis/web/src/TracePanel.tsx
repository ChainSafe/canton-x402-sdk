import { useState } from "react";

function stringifyBlock(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function TracePanel({ trace }: { trace: Record<string, unknown> | null }) {
  const [showRaw, setShowRaw] = useState(false);

  if (!trace) {
    return (
      <p className="trace-empty">Run a live call once — protocol steps appear here for developers.</p>
    );
  }

  const blocks: Array<{ id: string; title: string; value: unknown }> = [
    { id: "req", title: "Request body", value: trace.requestBody },
    { id: "402", title: "402 · PAYMENT-REQUIRED", value: trace.paymentRequired },
    { id: "settle", title: "PAYMENT-RESPONSE", value: trace.paymentResponse },
    { id: "srv", title: "Merchant trace", value: trace.serverTrace },
  ];

  return (
    <div className="trace-console">
      <div className="trace-tabs" role="tablist" aria-label="Protocol trace sections">
        {blocks.map((b) => (
          <a key={b.id} className="trace-tab" href={`#trace-${b.id}`}>
            {b.title}
          </a>
        ))}
      </div>
      <div className="trace-blocks">
        {blocks.map((b) => (
          <section key={b.id} id={`trace-${b.id}`} className="trace-block">
            <h4 className="trace-block-title">{b.title}</h4>
            <pre className="trace-block-pre">{stringifyBlock(b.value)}</pre>
          </section>
        ))}
      </div>
      <button type="button" className="trace-raw-toggle" onClick={() => setShowRaw((v) => !v)}>
        {showRaw ? "Hide raw JSON" : "Show raw JSON"}
      </button>
      {showRaw && <pre className="trace-json-raw">{JSON.stringify(trace, null, 2)}</pre>}
    </div>
  );
}