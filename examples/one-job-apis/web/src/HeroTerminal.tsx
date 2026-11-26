export function HeroTerminal() {
  return (
    <aside className="hero-terminal" aria-label="Example x402 exchange">
      <div className="terminal-chrome">
        <span className="terminal-dot" />
        <span className="terminal-dot" />
        <span className="terminal-dot" />
        <span className="terminal-title">merchant</span>
      </div>
      <pre className="terminal-body">
        <code>
          <span className="t-dim">$</span> curl -X POST /v1/hash.sha256{"\n"}
          <span className="t-amber">← 402</span> Payment Required{"\n"}
          <span className="t-dim">  PAYMENT-REQUIRED:</span> …{"\n"}
          <span className="t-dim">→</span> PAYMENT-SIGNATURE + retry{"\n"}
          <span className="t-ok">← 200</span>{" "}
          {`{"digest":"2cf24dba…"}`}
          <span className="terminal-caret" aria-hidden />
        </code>
      </pre>
    </aside>
  );
}