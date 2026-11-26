import { useEffect, useState } from "react";

import { fetchQuotaPacks, purchaseQuotaPack, type Me, type QuotaPack } from "./gateway.js";
import { centsLabel } from "./shared.js";

/** Bulk sales Kai can point at — one passkey receipt, then call quota. */
export function QuotaShelf({ me, onChange }: { me: Me | null; onChange: () => void }) {
  const [packs, setPacks] = useState<QuotaPack[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void fetchQuotaPacks()
      .then((d) => setPacks(d.packs))
      .catch(() => setPacks([]));
  }, []);

  if (!me?.signedIn || !me.hasPasskey) return null;

  async function buy(id: string) {
    setBusy(id);
    setError(null);
    setNote(null);
    try {
      const res = await purchaseQuotaPack(id);
      setNote(`${res.granted} calls added. ${res.prepaidCalls} left on your account.`);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk purchase failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="quota-shelf" aria-labelledby="quota-heading">
      <header className="quota-head">
        <h2 id="quota-heading">Bulk sales</h2>
        <p className="quota-balance">
          {me.prepaidCalls ? (
            <>
              <strong>{me.prepaidCalls}</strong> prepaid calls left — jobs run without a passkey each time.
            </>
          ) : (
            <>No prepaid calls. Buy a pack once, then skip micro-payments until it runs out.</>
          )}
        </p>
      </header>
      <ul className="quota-packs">
        {packs.map((p) => (
          <li key={p.id}>
            <button type="button" className="quota-pack" disabled={Boolean(busy)} onClick={() => void buy(p.id)}>
              <span className="quota-pack-title">{p.title}</span>
              <span className="quota-pack-pitch">{p.pitch}</span>
              <span className="quota-pack-foot">
                <span>{p.calls} calls</span>
                <span>{centsLabel(p.priceCents)} once</span>
              </span>
              {busy === p.id && <span className="quota-busy">Settling bulk sale…</span>}
            </button>
          </li>
        ))}
      </ul>
      {note && <p className="quota-note">{note}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}