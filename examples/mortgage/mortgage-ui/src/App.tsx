import { useState } from "react";

interface ApplyResult {
  decision: "APPROVED" | "DECLINED";
  reasons: string[];
  ltv: number;
  credit: { subject: string; score: number; band: string; factors: string[]; reportId: string; asOf: string };
  payment: { amountCC: string; updateId: string | null; settled: boolean };
}

const FIELDS = [
  { key: "name", label: "Applicant name", type: "text", value: "Ada Lovelace" },
  { key: "ssn", label: "Social Security Number", type: "text", value: "888-77-6666" },
  { key: "income", label: "Annual income (USD)", type: "number", value: "120000" },
  { key: "propertyPrice", label: "Property price (USD)", type: "number", value: "500000" },
  { key: "loanAmount", label: "Loan amount (USD)", type: "number", value: "400000" },
  { key: "downPayment", label: "Down payment (USD)", type: "number", value: "100000" },
  { key: "termYears", label: "Term (years)", type: "number", value: "30" },
] as const;

export function App() {
  const [form, setForm] = useState<Record<string, string>>(
    Object.fromEntries(FIELDS.map((f) => [f.key, f.value])),
  );
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          ssn: form.ssn,
          income: Number(form.income),
          propertyPrice: Number(form.propertyPrice),
          loanAmount: Number(form.loanAmount),
          downPayment: Number(form.downPayment),
          termYears: Number(form.termYears),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setResult(body as ApplyResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const approved = result?.decision === "APPROVED";

  return (
    <div style={s.page}>
      <div style={s.card}>
        <h1 style={s.h1}>Home Mortgage Application</h1>
        <p style={s.sub}>
          On submit, the lender's backend pays a credit bureau <b>0.05 CC</b> per credit pull over
          Canton x402 — a server-to-server payment settled on-ledger.
        </p>

        <form onSubmit={submit} style={s.form}>
          {FIELDS.map((f) => (
            <label key={f.key} style={s.label}>
              {f.label}
              <input
                style={s.input}
                type={f.type}
                value={form[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            </label>
          ))}
          <button style={s.button} disabled={loading} type="submit">
            {loading ? "Underwriting… (paying credit bureau)" : "Apply"}
          </button>
        </form>

        {error && <div style={s.error}>Error: {error}</div>}

        {result && (
          <div style={s.result}>
            <div style={{ ...s.badge, background: approved ? "#0b7a3b" : "#a11" }}>
              {result.decision}
            </div>
            <div style={s.row}>
              <span>Credit score</span>
              <b>
                {result.credit.score} · {result.credit.band}
              </b>
            </div>
            <div style={s.row}>
              <span>Loan-to-value</span>
              <b>{(result.ltv * 100).toFixed(1)}%</b>
            </div>
            {result.reasons.length > 0 && (
              <ul style={s.reasons}>
                {result.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            <div style={s.receipt}>
              Credit check paid: <b>{result.payment.amountCC} CC</b>
              {result.payment.settled ? " · settled on Canton" : " · (not settled)"}
              {result.payment.updateId && (
                <div style={s.mono}>updateId {result.payment.updateId}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#0e1116", color: "#e6e6e6", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "48px 16px", fontFamily: "ui-sans-serif, system-ui, sans-serif" },
  card: { width: "100%", maxWidth: 520, background: "#161b22", border: "1px solid #2a313c", borderRadius: 12, padding: 28 },
  h1: { margin: "0 0 6px", fontSize: 22 },
  sub: { margin: "0 0 20px", color: "#9aa4b2", fontSize: 13, lineHeight: 1.5 },
  form: { display: "grid", gap: 12 },
  label: { display: "grid", gap: 4, fontSize: 13, color: "#c3cbd6" },
  input: { padding: "9px 10px", borderRadius: 8, border: "1px solid #2a313c", background: "#0e1116", color: "#e6e6e6", fontSize: 14 },
  button: { marginTop: 6, padding: "11px 14px", borderRadius: 8, border: 0, background: "#3b82f6", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" },
  error: { marginTop: 16, padding: 12, borderRadius: 8, background: "#3a1416", border: "1px solid #6b1f22", color: "#ffb4b4", fontSize: 13 },
  result: { marginTop: 20, display: "grid", gap: 10 },
  badge: { justifySelf: "start", padding: "4px 12px", borderRadius: 999, color: "#fff", fontWeight: 700, letterSpacing: 0.5, fontSize: 13 },
  row: { display: "flex", justifyContent: "space-between", fontSize: 14, borderBottom: "1px solid #222834", paddingBottom: 6 },
  reasons: { margin: 0, paddingLeft: 18, color: "#ffb4b4", fontSize: 13 },
  receipt: { marginTop: 6, padding: 12, borderRadius: 8, background: "#0e1116", border: "1px solid #2a313c", fontSize: 13, color: "#c3cbd6" },
  mono: { marginTop: 4, fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#7f8b99", wordBreak: "break-all" },
};
