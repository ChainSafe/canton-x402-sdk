import { useCallback, useEffect, useMemo, useState } from "react";

import {
  GROUPS,
  NEEDS_OTHER,
  TOOLS,
  findTool,
  type Group,
  type Tool,
} from "@chainsafe/x402-example-one-job-catalog";

import { fetchMe, logout, payWithFingerprint, registerPasskey, signInWithGoogle, type Me, type PayResult } from "./gateway.js";
import { SAMPLES } from "./samples.js";

function centsLabel(c: number): string {
  return `${c}¢ CC`;
}

export function App() {
  const [group, setGroup] = useState<Group | "All">("All");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const refreshMe = useCallback(async () => {
    setMe(await fetchMe());
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

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
    return (
      <ToolPage
        tool={tool}
        me={me}
        onBack={() => setSelected(null)}
        onMeChange={() => void refreshMe()}
      />
    );
  }

  return (
    <div className="shell">
      <AuthBar me={me} onMeChange={() => void refreshMe()} />
      <header>
        <h1>One-job APIs</h1>
        <p>Find your tool. Place your finger. Leave with a receipt.</p>
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

function AuthBar({ me, onMeChange }: { me: Me | null; onMeChange: () => void }) {
  const [busy, setBusy] = useState(false);

  if (!me?.signedIn) {
    return (
      <div className="auth-bar">
        <button type="button" className="pay" disabled={busy} onClick={() => signInWithGoogle()}>
          Continue with Google
        </button>
      </div>
    );
  }

  return (
    <div className="auth-bar">
      <div className="auth-meta">
        {me.picture && <img src={me.picture} alt="" className="avatar" />}
        <span>
          {me.name}
          <span className="muted">
            {" "}
            · {me.spentCentsToday ?? 0}¢ / {me.dailyCapCents ?? 500}¢ today
          </span>
        </span>
      </div>
      <div className="auth-actions">
        {!me.hasPasskey && (
          <button
            type="button"
            className="chip on"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void registerPasskey()
                .then(onMeChange)
                .finally(() => setBusy(false));
            }}
          >
            Enable fingerprint
          </button>
        )}
        <button
          type="button"
          className="chip"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void logout()
              .then(onMeChange)
              .finally(() => setBusy(false));
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function ToolPage({
  tool,
  me,
  onBack,
  onMeChange,
}: {
  tool: Tool;
  me: Me | null;
  onBack: () => void;
  onMeChange: () => void;
}) {
  const sample = SAMPLES[tool.tool] ?? { text: "" };
  const [text, setText] = useState(sample.text);
  const [other, setOther] = useState(sample.other ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PayResult["receipt"] | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [trace, setTrace] = useState<Record<string, unknown> | null>(null);

  async function onFinger() {
    setBusy(true);
    setError(null);
    setReceipt(null);
    setResult(null);
    setTrace(null);
    try {
      if (!tool.live) {
        setError("This job is not in this build. Try hash.sha256.");
        return;
      }
      if (!me?.signedIn) {
        setError("Continue with Google first.");
        return;
      }
      if (!me.hasPasskey) {
        setError("Enable fingerprint in the bar above.");
        return;
      }
      const body = NEEDS_OTHER.has(tool.tool) ? { text, other: other.trim() } : { text };
      if (!body.text.trim()) {
        setError("text is required.");
        return;
      }
      if (NEEDS_OTHER.has(tool.tool) && !other.trim()) {
        setError("other is required for this tool.");
        return;
      }
      const { paid } = await payWithFingerprint(tool.tool, body);
      setReceipt(paid.receipt);
      setResult(JSON.stringify(paid.result, null, 2));
      setTrace(paid.trace);
      onMeChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <AuthBar me={me} onMeChange={onMeChange} />
      <a className="back" href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>
        ← All tools
      </a>
      <article className="tool-card">
        <h2>{tool.tool}</h2>
        <p>
          {tool.body} → {tool.result}
        </p>
        {!tool.live && (
          <p className="stand-in">Catalog only in this build. Open hash.sha256 for a live call.</p>
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
          <button type="button" className="pay finger" disabled={busy || !tool.live} onClick={() => void onFinger()}>
            {busy ? "Checking…" : "Place finger"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {receipt && (
          <div className="receipt">
            <p className="receipt-title">Settled</p>
            <p className="receipt-amount">{centsLabel(receipt.cents)}</p>
            <dl className="receipt-meta">
              <div>
                <dt>Payer</dt>
                <dd>{receipt.payer}</dd>
              </div>
              <div>
                <dt>Receipt</dt>
                <dd>{receipt.transaction}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>{receipt.network}</dd>
              </div>
            </dl>
            {receipt.demo && <p className="demo-footnote">Demo settlement: fingerprint is real; ledger uses demo tokens until DevNet keys are wired.</p>}
          </div>
        )}
        {result && (
          <>
            <h3>Result</h3>
            <pre className="result">{result}</pre>
          </>
        )}
        <details className="trace">
          <summary>What happened</summary>
          <div className="trace-body">
            {!trace && <p className="stand-in">Run once to see the x402 exchange for developers.</p>}
            {trace && (
              <pre className="trace-json">{JSON.stringify(trace, null, 2)}</pre>
            )}
          </div>
        </details>
      </article>
    </div>
  );
}