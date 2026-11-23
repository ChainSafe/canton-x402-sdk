import { useMemo, useState } from "react";

import {
  GROUPS,
  NEEDS_OTHER,
  TOOLS,
  findTool,
  type Group,
  type Tool,
} from "@chainsafe/x402-example-one-job-catalog";

import { type CallTrace, fetchSource, runPaidCall } from "./api.js";
import { SAMPLES } from "./samples.js";

function centsLabel(c: number): string {
  return `${c}¢`;
}

export function App() {
  const [group, setGroup] = useState<Group | "All">("All");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const list = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return TOOLS.filter((t) => {
      if (group !== "All" && t.group !== group) return false;
      if (!needle) return true;
      return (
        t.tool.includes(needle) ||
        t.group.toLowerCase().includes(needle) ||
        t.body.toLowerCase().includes(needle)
      );
    });
  }, [group, query]);

  if (selected) {
    const tool = findTool(selected);
    if (!tool) {
      setSelected(null);
      return null;
    }
    return <ToolPage tool={tool} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="shell">
      <header>
        <h1>One-job APIs</h1>
        <p>One request, one price, one result. Expand What happened to see the x402 exchange.</p>
      </header>
      <div className="filters">
        <button type="button" className={`chip ${group === "All" ? "on" : ""}`} onClick={() => setGroup("All")}>
          All
        </button>
        {GROUPS.map((g) => (
          <button key={g} type="button" className={`chip ${group === g ? "on" : ""}`} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
      </div>
      <input
        className="search"
        type="search"
        placeholder="Filter tools"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="tool-list">
        {list.map((tool) => (
          <li key={tool.tool}>
            <button type="button" onClick={() => setSelected(tool.tool)}>
              <strong>{tool.tool}</strong>
              <div className="tool-meta">
                <span>{tool.group}</span>
                <span className={tool.live ? "badge" : "badge off"}>
                  {tool.live ? "live" : "catalog only"}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolPage({ tool, onBack }: { tool: Tool; onBack: () => void }) {
  const sample = SAMPLES[tool.tool] ?? { text: "" };
  const [text, setText] = useState(sample.text);
  const [other, setOther] = useState(sample.other ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [trace, setTrace] = useState<CallTrace | null>(null);
  const [previewSource, setPreviewSource] = useState<string | null>(null);

  async function loadSource() {
    const data = await fetchSource(tool.tool);
    setPreviewSource(data.source);
  }

  function onOpenTrace() {
    if (!previewSource) void loadSource();
  }

  async function onPay() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (!tool.live) {
        setError("This job is not in this build. Try hash.sha256.");
        return;
      }
      const body =
        NEEDS_OTHER.has(tool.tool) ? { text, other: other.trim() } : { text };
      if (!body.text.trim()) {
        setError("text is required.");
        return;
      }
      if (NEEDS_OTHER.has(tool.tool) && !other.trim()) {
        setError("other is required for this tool.");
        return;
      }
      const call = await runPaidCall(tool, body);
      setTrace(call);
      if (call.paidStatus !== 200) {
        setError(JSON.stringify(call.paidBody, null, 2));
        return;
      }
      setResult(JSON.stringify((call.paidBody as { result?: unknown }).result ?? call.paidBody, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The call failed.");
    } finally {
      setBusy(false);
    }
  }

  const source = trace?.handlerSource ?? previewSource;

  return (
    <div className="shell">
      <a className="back" href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>
        ← All tools
      </a>
      <article className="tool-card">
        <h2>{tool.tool}</h2>
        <p>
          {tool.body} → {tool.result}
        </p>
        {!tool.live && (
          <p className="stand-in">
            Catalog only in this build. Open hash.sha256 and pay once to watch a live exchange.
          </p>
        )}
        <label htmlFor="text">text</label>
        <textarea id="text" value={text} onChange={(e) => setText(e.target.value)} />
        {NEEDS_OTHER.has(tool.tool) && (
          <>
            <label htmlFor="other">other</label>
            <textarea id="other" value={other} onChange={(e) => setOther(e.target.value)} />
          </>
        )}
        <div className="pay-row">
          <span className="price">{centsLabel(tool.cents)}</span>
          <button type="button" className="pay" disabled={busy || !tool.live} onClick={() => void onPay()}>
            {busy ? "Paying…" : "Pay"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {result && (
          <>
            <h3>Result</h3>
            <pre className="result">{result}</pre>
          </>
        )}
        <details className="trace" onToggle={(e) => e.currentTarget.open && onOpenTrace()}>
          <summary>What happened</summary>
          <div className="trace-body">
            {!trace && (
              <p className="stand-in">Run Pay once. This panel shows that call, not an editor.</p>
            )}
            {trace?.standInNote && <p className="stand-in">{trace.standInNote}</p>}
            {trace && (
              <>
                <TraceSection title="1 · Request" value={trace.requestBody} />
                <TraceSection title="2 · 402 body" value={{ status: trace.unpaidStatus, body: trace.unpaidBody }} />
                <TraceSection title="3 · PAYMENT-REQUIRED" value={trace.paymentRequiredDecoded} />
                <TraceSection
                  title="4 · PAYMENT-SIGNATURE (stand-in)"
                  value={trace.paymentSignature?.slice(0, 80) + "…"}
                />
                <TraceSection title="5 · verify + settle (server)" value={trace.serverTrace} />
                <TraceSection title="6 · 200 + PAYMENT-RESPONSE" value={trace.paymentResponseDecoded} />
                <TraceSection title="7 · Handler" value={source ?? "loading…"} raw />
              </>
            )}
            {!trace && source && <TraceSection title="Handler (preview)" value={source} raw />}
          </div>
        </details>
      </article>
    </div>
  );
}

function TraceSection({ title, value, raw }: { title: string; value: unknown; raw?: boolean }) {
  const text =
    raw && typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="trace-section">
      <h3>{title}</h3>
      <pre>{text}</pre>
    </div>
  );
}