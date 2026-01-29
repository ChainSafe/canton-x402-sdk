/**
 * CC Transfer Service Server
 *
 * POST /transfer -- execute a Canton Coin transfer on the ledger.
 * GET /transfers/:txId -- look up a transfer by transaction ID.
 */

import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createAuthProvider,
  CantonJsonClient,
  settleLocal,
} from "canton-x402-sdk";
import { loadEnv } from "../../shared/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { config, payerParty, payeeParty } = loadEnv(
  join(__dirname, "..", ".env"),
);

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
<title>CC Transfer Service</title>
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
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 24px; }
  label { display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 4px; }
  input { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 10px 12px; border-radius: 6px; font-size: 14px; font-family: monospace; margin-bottom: 12px; outline: none; transition: border-color 0.2s; }
  input:focus { border-color: var(--accent); }
  .btn { background: var(--accent); color: #fff; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; transition: background 0.2s; width: 100%; }
  .btn:hover { background: var(--accent-hover); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .result { border-radius: 8px; padding: 16px; margin-top: 16px; font-family: monospace; font-size: 13px; word-break: break-all; }
  .result.success { background: #052e16; border: 1px solid var(--green); color: #86efac; }
  .result.error { background: #2a0a0a; border: 1px solid var(--red); color: #fca5a5; }
  .result .tx-link { color: var(--accent); cursor: pointer; text-decoration: underline; }
  .tx-link { color: var(--accent); text-decoration: none; cursor: pointer; }
  .tx-link:hover { color: var(--accent-hover); text-decoration: underline; }
  .receipt-card { background: var(--surface); border: 2px solid var(--green); border-radius: 8px; padding: 20px; margin-top: 16px; }
  .receipt-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .receipt-header h3 { font-size: 16px; font-weight: 600; }
  .receipt-status { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--green); font-weight: 500; }
  .receipt-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
  .receipt-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .receipt-row:last-child { border-bottom: none; }
  .receipt-label { color: var(--text-muted); }
  .receipt-value { font-family: monospace; text-align: right; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .receipt-value:hover { overflow: visible; white-space: normal; word-break: break-all; }
  .tx-detail-card { background: var(--surface); border: 2px solid var(--accent); border-radius: 8px; padding: 20px; margin-bottom: 12px; }
  .tx-detail-card h3 { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: var(--accent); }
  .event-card { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 16px; margin-bottom: 10px; }
  .event-card .event-type { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--accent); margin-bottom: 8px; }
  .event-card .event-choice { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
  .event-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .event-row:last-child { border-bottom: none; }
  .event-row .ev-label { color: var(--text-muted); min-width: 120px; }
  .event-row .ev-value { font-family: monospace; text-align: right; max-width: 65%; word-break: break-all; }
  .event-args { margin-top: 8px; }
  .event-args summary { cursor: pointer; font-size: 12px; color: var(--text-muted); }
  .event-args pre { margin-top: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-all; background: var(--surface); padding: 8px; border-radius: 4px; }
  .back-btn { margin-bottom: 16px; }
  .divider { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
  table { width: 100%; border-collapse: collapse; }
  table td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; font-size: 13px; }
  table td:first-child { color: var(--text-muted); width: 140px; white-space: nowrap; }
  table td:last-child { font-family: monospace; word-break: break-all; }
  .loading { text-align: center; color: var(--text-muted); padding: 20px; }
</style>
</head>
<body>
<div class="header">
  <h1>CC Transfer Service</h1>
  <span class="badge">:4020</span>
  <div class="health-dot" id="health"></div>
</div>
<div class="container">
  <div class="section-title">Execute Transfer</div>
  <div class="card">
    <form id="transferForm" onsubmit="return window._handleTransfer(event)">
      <label>Amount (CC)</label>
      <input type="text" id="amount" value="0.50" placeholder="0.50">
      <label>From (optional — defaults to payer)</label>
      <input type="text" id="from" placeholder="Party ID">
      <label>To (optional — defaults to payee)</label>
      <input type="text" id="to" placeholder="Party ID">
      <button class="btn" type="submit" id="submitBtn">Send Transfer</button>
    </form>
    <div id="transferResult"></div>
  </div>

  <hr class="divider">

  <div class="section-title">Transfer Log</div>
  <div id="logSection">
    <div class="loading">No transfers yet</div>
  </div>

  <hr class="divider">

  <div class="section-title">Lookup Transaction</div>
  <div class="card">
    <label>Transaction ID</label>
    <input type="text" id="txId" placeholder="Paste transaction ID">
    <button class="btn" onclick="window._lookupTx()">Look Up</button>
    <div id="lookupResult"></div>
  </div>
</div>
<script>
(function() {
  var healthEl = document.getElementById('health');
  var containerEl = document.querySelector('.container');
  var mainContent = containerEl.innerHTML;

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

  function showMain() {
    containerEl.innerHTML = mainContent;
    refreshLog();
  }

  function refreshLog() {
    var logEl = document.getElementById('logSection');
    if (!logEl) return;
    fetch('/transfer-log').then(function(r) { return r.json(); }).then(function(data) {
      var transfers = data.transfers || [];
      if (transfers.length === 0) {
        logEl.innerHTML = '<div class="loading">No transfers yet</div>';
        return;
      }
      var html = '';
      transfers.slice().reverse().forEach(function(t) {
        html += '<div class="card" style="margin-bottom:8px;padding:14px;">';
        html += '<div class="receipt-row"><span class="receipt-label">Amount</span><span class="receipt-value">' + escapeHtml(t.amount) + ' CC</span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">Tx ID</span><span class="receipt-value"><a class="tx-link" href="#" onclick="event.preventDefault();window._viewTx(\\'' + escapeHtml(t.transactionId) + '\\')">' + escapeHtml(t.transactionId) + '</a></span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">From</span><span class="receipt-value" title="' + escapeHtml(t.from) + '">' + escapeHtml(t.from) + '</span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">To</span><span class="receipt-value" title="' + escapeHtml(t.to) + '">' + escapeHtml(t.to) + '</span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">Time</span><span class="receipt-value">' + escapeHtml(new Date(t.timestamp).toLocaleString()) + '</span></div>';
        html += '</div>';
      });
      logEl.innerHTML = html;
    }).catch(function() {});
  }

  function viewTx(txId) {
    containerEl.innerHTML = '<button class="btn back-btn" onclick="window._showMain()">Back</button>' +
      '<div class="loading">Loading transaction details...</div>';

    fetch('/transfers/' + encodeURIComponent(txId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) {
          containerEl.innerHTML = '<button class="btn back-btn" onclick="window._showMain()">Back</button>' +
            '<div class="result error">' + escapeHtml(data.error) + '</div>';
          return;
        }
        var tx = data.transaction || data;
        var html = '<button class="btn back-btn" onclick="window._showMain()">Back</button>';

        // Transaction overview card
        html += '<div class="tx-detail-card">';
        html += '<h3>Transaction Details</h3>';
        var updateId = tx.updateId || tx.update_id || txId;
        var commandId = tx.commandId || tx.command_id || 'N/A';
        var workflowId = tx.workflowId || tx.workflow_id || 'N/A';
        var effectiveAt = tx.effectiveAt || tx.effective_at || 'N/A';
        var offset = tx.offset || 'N/A';
        var syncId = tx.synchronizerId || tx.domainId || tx.synchronizer_id || tx.domain_id || 'N/A';

        html += '<div class="receipt-row"><span class="receipt-label">Update ID</span><span class="receipt-value">' + escapeHtml(String(updateId)) + '</span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">Command ID</span><span class="receipt-value">' + escapeHtml(String(commandId)) + '</span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">Workflow ID</span><span class="receipt-value">' + escapeHtml(String(workflowId)) + '</span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">Effective At</span><span class="receipt-value">' + escapeHtml(String(effectiveAt)) + '</span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">Offset</span><span class="receipt-value">' + escapeHtml(String(offset)) + '</span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">Synchronizer</span><span class="receipt-value">' + escapeHtml(String(syncId)) + '</span></div>';
        html += '</div>';

        // Events
        var events = tx.events || [];
        if (events.length > 0) {
          html += '<div class="section-title">Events (' + events.length + ')</div>';
          events.forEach(function(ev, i) {
            var exercised = ev.ExercisedEvent || ev.exercisedEvent;
            var created = ev.CreatedEvent || ev.createdEvent;

            if (exercised) {
              html += '<div class="event-card">';
              html += '<div class="event-type">Exercised Event #' + (i + 1) + '</div>';
              html += '<div class="event-choice">' + escapeHtml(String(exercised.choice || '')) + '</div>';
              html += '<div class="event-row"><span class="ev-label">Template</span><span class="ev-value">' + escapeHtml(String(exercised.templateId || '')) + '</span></div>';
              html += '<div class="event-row"><span class="ev-label">Contract ID</span><span class="ev-value">' + escapeHtml(String(exercised.contractId || '')) + '</span></div>';
              var acting = exercised.actingParties || [];
              if (acting.length > 0) {
                html += '<div class="event-row"><span class="ev-label">Acting Parties</span><span class="ev-value">' + acting.map(function(p) { return escapeHtml(String(p)); }).join(', ') + '</span></div>';
              }
              var witness = exercised.witnessParties || [];
              if (witness.length > 0) {
                html += '<div class="event-row"><span class="ev-label">Witness Parties</span><span class="ev-value">' + witness.map(function(p) { return escapeHtml(String(p)); }).join(', ') + '</span></div>';
              }
              html += '<div class="event-row"><span class="ev-label">Consuming</span><span class="ev-value">' + (exercised.consuming ? 'Yes' : 'No') + '</span></div>';
              var choiceArg = exercised.choiceArgument || exercised.choice_argument;
              if (choiceArg) {
                html += '<div class="event-args"><details><summary>Choice Arguments</summary>';
                html += '<pre>' + escapeHtml(JSON.stringify(choiceArg, null, 2)) + '</pre>';
                html += '</details></div>';
              }
              html += '</div>';
            }

            if (created) {
              html += '<div class="event-card">';
              html += '<div class="event-type">Created Event #' + (i + 1) + '</div>';
              html += '<div class="event-row"><span class="ev-label">Template</span><span class="ev-value">' + escapeHtml(String(created.templateId || '')) + '</span></div>';
              html += '<div class="event-row"><span class="ev-label">Contract ID</span><span class="ev-value">' + escapeHtml(String(created.contractId || '')) + '</span></div>';
              var cWitness = created.witnessParties || [];
              if (cWitness.length > 0) {
                html += '<div class="event-row"><span class="ev-label">Witness Parties</span><span class="ev-value">' + cWitness.map(function(p) { return escapeHtml(String(p)); }).join(', ') + '</span></div>';
              }
              var createArg = created.createArguments || created.create_arguments;
              if (createArg) {
                html += '<div class="event-args"><details><summary>Create Arguments</summary>';
                html += '<pre>' + escapeHtml(JSON.stringify(createArg, null, 2)) + '</pre>';
                html += '</details></div>';
              }
              html += '</div>';
            }
          });
        }

        containerEl.innerHTML = html;
      })
      .catch(function(err) {
        containerEl.innerHTML = '<button class="btn back-btn" onclick="window._showMain()">Back</button>' +
          '<div class="result error">' + escapeHtml(err.message) + '</div>';
      });
  }

  window._handleTransfer = function(e) {
    e.preventDefault();
    var btn = document.getElementById('submitBtn');
    var resultEl = document.getElementById('transferResult');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    resultEl.innerHTML = '';

    var body = {};
    var amount = document.getElementById('amount').value.trim();
    var from = document.getElementById('from').value.trim();
    var to = document.getElementById('to').value.trim();
    if (amount) body.amount = amount;
    if (from) body.from = from;
    if (to) body.to = to;

    fetch('/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r) { return r.json(); }).then(function(data) {
      btn.disabled = false;
      btn.textContent = 'Send Transfer';
      if (data.success === false || data.error) {
        resultEl.innerHTML = '<div class="result error">' + escapeHtml(data.error || 'Transfer failed') + '</div>';
      } else {
        var txId = data.transactionId || data.updateId || '';
        var html = '<div class="receipt-card">';
        html += '<div class="receipt-header"><h3>Transfer Receipt</h3>';
        html += '<div class="receipt-status"><div class="receipt-status-dot"></div>Settled</div></div>';
        html += '<div class="receipt-row"><span class="receipt-label">Amount</span><span class="receipt-value">' + escapeHtml(amount || '0.50') + ' CC</span></div>';
        if (txId) {
          html += '<div class="receipt-row"><span class="receipt-label">Tx ID</span><span class="receipt-value"><a class="tx-link" href="#" onclick="event.preventDefault();window._viewTx(\\'' + escapeHtml(txId) + '\\')">' + escapeHtml(txId) + '</a></span></div>';
        }
        html += '<div class="receipt-row"><span class="receipt-label">From</span><span class="receipt-value" title="' + escapeHtml(from || 'default payer') + '">' + escapeHtml(from || 'default payer') + '</span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">To</span><span class="receipt-value" title="' + escapeHtml(to || 'default payee') + '">' + escapeHtml(to || 'default payee') + '</span></div>';
        html += '<div class="receipt-row"><span class="receipt-label">Time</span><span class="receipt-value">' + escapeHtml(new Date().toLocaleString()) + '</span></div>';
        html += '</div>';
        resultEl.innerHTML = html;
        refreshLog();
      }
    }).catch(function(err) {
      btn.disabled = false;
      btn.textContent = 'Send Transfer';
      resultEl.innerHTML = '<div class="result error">' + escapeHtml(err.message) + '</div>';
    });
    return false;
  };

  window._lookupTx = function() {
    var txId = document.getElementById('txId').value.trim();
    if (!txId) {
      document.getElementById('lookupResult').innerHTML = '<div class="result error">Enter a transaction ID</div>';
      return;
    }
    viewTx(txId);
  };

  window._viewTx = viewTx;
  window._showMain = showMain;
  refreshLog();
})();
</script>
</body>
</html>`;

// In-memory transfer log
const transferLog: Array<{
  transactionId: string;
  amount: string;
  from: string;
  to: string;
  timestamp: string;
}> = [];

app.get("/", (_req, res) => {
  res.type("html").send(HTML_PAGE);
});

// GET /transfer-log -- return all transfers
app.get("/transfer-log", (_req, res) => {
  res.json({ transfers: transferLog });
});

// POST /transfer -- execute CC transfer
app.post("/transfer", async (req, res) => {
  try {
    const { from, to, amount } = req.body as {
      from?: string;
      to?: string;
      amount?: string;
    };
    const sender = from ?? payerParty;
    const receiver = to ?? payeeParty;
    const transferAmount = amount ?? "0.50";

    console.log(
      `[${new Date().toISOString()}] Transferring ${transferAmount} CC: ${sender} -> ${receiver}`,
    );

    const result = await settleLocal(
      {
        payerParty: sender,
        payeeParty: receiver,
        amount: transferAmount,
        resourceId: "cc-transfer-service",
      },
      config,
      client,
      auth,
    );

    const txId = (result as { transactionId?: string; updateId?: string }).transactionId
      ?? (result as { updateId?: string }).updateId ?? "";

    const logEntry = {
      transactionId: txId,
      amount: transferAmount,
      from: sender,
      to: receiver,
      timestamp: new Date().toISOString(),
    };
    transferLog.push(logEntry);
    console.log(`[${logEntry.timestamp}] Settled: ${txId}`);

    res.json(result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Transfer failed:`, error instanceof Error ? error.message : String(error));
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// GET /transfers/:txId -- look up transfer
app.get("/transfers/:txId", async (req, res) => {
  try {
    const txData = await client.getTransactionById(req.params.txId, [
      payerParty,
      payeeParty,
    ]);
    res.json(txData);
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

const PORT = 4020;
app.listen(PORT, () => {
  console.log(
    `CC Transfer Service running on http://localhost:${PORT}`,
  );
  console.log(`  GET  /                 -- web UI`);
  console.log(`  POST /transfer         -- execute CC transfer`);
  console.log(`  GET  /transfers/:txId  -- look up transfer`);
});
