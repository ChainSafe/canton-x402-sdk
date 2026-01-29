/**
 * Balance Inquiry Server
 *
 * Query Canton Coin balance for any party.
 * GET /balance        -- query default payer's balance
 * GET /balance/:party -- query any party's balance
 */

import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createAuthProvider, CantonJsonClient } from "canton-x402-sdk";
import { loadEnv } from "../../shared/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { config, payerParty } = loadEnv(join(__dirname, "..", ".env"));

const auth = createAuthProvider(config.auth);
const client = new CantonJsonClient(config.ledgerApiUrl, auth);

const app = express();
app.use(express.json());

// ---------- Inline Web UI ----------
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Balance Inquiry</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2a2d3a;
    --text: #e4e4e7;
    --text-muted: #9ca3af;
    --accent: #6366f1;
    --accent-hover: #818cf8;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; }
  .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .badge { background: var(--accent); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-family: monospace; }
  .health-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--yellow); margin-left: auto; }
  .health-dot.ok { background: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .container { max-width: 720px; margin: 32px auto; padding: 0 16px; }
  .section-title { font-size: 14px; color: var(--text-muted); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .query-row { display: flex; gap: 8px; margin-bottom: 24px; }
  .query-row input { flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 10px 12px; border-radius: 6px; font-size: 14px; font-family: monospace; outline: none; transition: border-color 0.2s; }
  .query-row input:focus { border-color: var(--accent); }
  .btn { background: var(--accent); color: #fff; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; transition: background 0.2s; white-space: nowrap; }
  .btn:hover { background: var(--accent-hover); }
  .party-id { font-family: monospace; font-size: 13px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; display: block; margin-bottom: 16px; }
  .stat { text-align: center; padding: 16px 0; }
  .stat-val { font-size: 48px; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
  .contract-list { max-height: 320px; overflow-y: auto; margin-top: 16px; }
  .contract-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); font-family: monospace; font-size: 12px; word-break: break-all; }
  .contract-item:last-child { border-bottom: none; }
  .copy-btn { background: var(--border); color: var(--text-muted); border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; white-space: nowrap; flex-shrink: 0; }
  .copy-btn:hover { background: var(--accent); color: #fff; }
  .result-error { background: #2a0a0a; border: 1px solid var(--red); color: #fca5a5; border-radius: 8px; padding: 16px; margin-top: 16px; font-family: monospace; font-size: 13px; }
  .loading { text-align: center; color: var(--text-muted); padding: 40px; }
</style>
</head>
<body>
<div class="header">
  <h1>Balance Inquiry</h1>
  <span class="badge">:4030</span>
  <div class="health-dot" id="health"></div>
</div>
<div class="container">
  <div class="section-title">Query Balance</div>
  <div class="query-row">
    <input type="text" id="partyInput" placeholder="Party ID (leave empty for default payer)">
    <button class="btn" onclick="window._handleQuery()">Query</button>
  </div>
  <div id="result"><div class="loading">Loading default balance...</div></div>
</div>
<script>
(function() {
  var healthEl = document.getElementById('health');
  var resultEl = document.getElementById('result');
  var partyInput = document.getElementById('partyInput');

  function checkHealth() {
    fetch('/health').then(function(r) { return r.json(); }).then(function(d) {
      healthEl.className = 'health-dot' + (d.status === 'healthy' ? ' ok' : '');
    }).catch(function() { healthEl.className = 'health-dot'; });
  }
  checkHealth();
  setInterval(checkHealth, 30000);

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  function truncate(str, n) {
    if (!str || str.length <= n) return str || '';
    return str.slice(0, n) + '...';
  }

  function queryBalance(party) {
    resultEl.innerHTML = '<div class="loading">Querying balance...</div>';
    var url = party ? '/balance/' + encodeURIComponent(party) : '/balance';
    fetch(url).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) {
        resultEl.innerHTML = '<div class="result-error">' + escapeHtml(data.error) + '</div>';
        return;
      }
      var html = '<div class="card">';
      html += '<span class="party-id" title="' + escapeHtml(data.party) + '">' + escapeHtml(data.party) + '</span>';
      html += '<div class="stat"><div class="stat-val">' + data.holdingCount + '</div><div class="stat-label">Holdings</div></div>';
      html += '</div>';

      if (data.holdingContractIds && data.holdingContractIds.length > 0) {
        html += '<div class="section-title">Contract IDs</div>';
        html += '<div class="card"><div class="contract-list">';
        data.holdingContractIds.forEach(function(cid) {
          html += '<div class="contract-item">';
          html += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHtml(cid) + '">' + escapeHtml(cid) + '</span>';
          html += '<button class="copy-btn" onclick="navigator.clipboard.writeText(\\'' + escapeHtml(cid).replace(/'/g, "\\\\'") + '\\');this.textContent=\\'Copied!\\';setTimeout(function(){this.textContent=\\'Copy\\'}.bind(this),1500)">Copy</button>';
          html += '</div>';
        });
        html += '</div></div>';
      }
      resultEl.innerHTML = html;
    }).catch(function(err) {
      resultEl.innerHTML = '<div class="result-error">' + escapeHtml(err.message) + '</div>';
    });
  }

  window._handleQuery = function() {
    var party = partyInput.value.trim();
    queryBalance(party || null);
  };

  partyInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') window._handleQuery();
  });

  // Auto-query default balance on load
  queryBalance(null);
})();
</script>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.type("html").send(HTML_PAGE);
});

async function queryBalance(party: string) {
  const holdings = await client.getPayerHoldings(
    party,
    config.spliceHoldingPackageId,
  );
  return {
    party,
    holdingCount: holdings.length,
    holdingContractIds: holdings,
  };
}

// GET /balance -- query default payer's balance
app.get("/balance", async (_req, res) => {
  try {
    res.json(await queryBalance(payerParty));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// GET /balance/:party -- query any party's balance
app.get("/balance/:party", async (req, res) => {
  try {
    res.json(await queryBalance(req.params.party));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// GET /health
app.get("/health", async (_req, res) => {
  const healthy = await client.healthCheck();
  res.json({ status: healthy ? "healthy" : "degraded" });
});

const PORT = 4030;
app.listen(PORT, () => {
  console.log(`Balance Inquiry server running on http://localhost:${PORT}`);
  console.log(`  GET /                -- web UI`);
  console.log(`  GET /balance         -- query default payer's balance`);
  console.log(`  GET /balance/:party  -- query any party's balance`);
  console.log(`  GET /health          -- health check`);
});
