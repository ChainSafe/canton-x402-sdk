/**
 * Token-Gated Document Access Server
 *
 * Download signed financial documents.
 * GET /docs      -- list available documents
 * GET /docs/:id  -- download a document
 */

import express from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv } from "../../shared/env.js";
import { paymentRequired, createFacilitatorRouter } from "canton-x402-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { config, payerParty, payeeParty } = loadEnv(join(__dirname, "..", ".env"));

const DOCS: Record<string, { title: string; file: string }> = {
  "term-sheet": { title: "Bond Term Sheet -- Canton Capital Senior Note", file: "term-sheet.json" },
  "trade-confirmation": { title: "Trade Confirmation -- TRD-2025-00847", file: "trade-confirmation.json" },
};

const app = express();
app.use(express.json());
app.use("/facilitator", createFacilitatorRouter({ config }));

// ---------- Inline Web UI ----------
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Token-Gated Docs</title>
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
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 12px; cursor: pointer; transition: border-color 0.2s; }
  .card:hover { border-color: var(--accent); }
  .card-title { font-size: 15px; font-weight: 500; }
  .card-id { font-family: monospace; font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .btn { background: var(--accent); color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: background 0.2s; }
  .btn:hover { background: var(--accent-hover); }
  .back-btn { margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  table td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  table td:first-child { color: var(--text-muted); font-size: 13px; width: 160px; white-space: nowrap; }
  table td:last-child { font-family: monospace; font-size: 13px; word-break: break-all; }
  ul.val-list { list-style: disc; padding-left: 20px; font-family: monospace; font-size: 13px; }
  ul.val-list li { margin-bottom: 4px; }
  .section-title { font-size: 14px; color: var(--text-muted); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .loading { text-align: center; color: var(--text-muted); padding: 40px; }
  .payment-card { background: var(--surface); border: 2px solid var(--yellow); border-radius: 8px; padding: 24px; margin-bottom: 12px; }
  .payment-card h3 { color: var(--yellow); margin-bottom: 12px; font-size: 16px; }
  .payment-price { font-size: 28px; font-weight: 700; color: var(--text); margin: 12px 0; }
  .payment-price span { font-size: 14px; color: var(--text-muted); font-weight: 400; }
  .btn-pay { background: var(--yellow); color: #000; font-weight: 600; padding: 10px 24px; font-size: 14px; }
  .btn-pay:hover { background: #facc15; }
  .btn-pay:disabled { opacity: 0.5; cursor: not-allowed; }
  .payment-detail { font-size: 12px; color: var(--text-muted); margin-top: 8px; font-family: monospace; }
  .receipt-card { background: var(--surface); border: 2px solid var(--green); border-radius: 8px; padding: 20px; margin-bottom: 12px; }
  .receipt-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .receipt-header h3 { font-size: 16px; font-weight: 600; }
  .receipt-status { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--green); font-weight: 500; }
  .receipt-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
  .receipt-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .receipt-row:last-child { border-bottom: none; }
  .receipt-label { color: var(--text-muted); }
  .receipt-value { font-family: monospace; text-align: right; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .receipt-value:hover { overflow: visible; white-space: normal; word-break: break-all; }
  .progress-msg { text-align: center; padding: 40px; color: var(--text-muted); }
  .progress-msg .step { margin-bottom: 8px; font-size: 14px; }
  .progress-msg .txid { font-family: monospace; font-size: 12px; color: var(--green); margin-top: 4px; }
  .tx-link { color: var(--accent); text-decoration: none; cursor: pointer; }
  .tx-link:hover { color: var(--accent-hover); text-decoration: underline; }
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
</style>
</head>
<body>
<div class="header">
  <h1>Token-Gated Docs</h1>
  <span class="badge">:4010</span>
  <div class="health-dot" id="health"></div>
</div>
<div class="container" id="app">
  <div class="loading">Loading documents...</div>
</div>
<script>
(function() {
  var appEl = document.getElementById('app');
  var healthEl = document.getElementById('health');
  var paymentInfo = null;

  // Load payment info on startup
  fetch('/payment-info').then(function(r) { return r.json(); }).then(function(data) {
    paymentInfo = data;
  }).catch(function() { console.warn('Could not load payment info'); });

  function checkHealth() {
    fetch('/health').then(function(r) { return r.json(); }).then(function(d) {
      healthEl.className = 'health-dot' + (d.status === 'healthy' ? ' ok' : '');
    }).catch(function() { healthEl.className = 'health-dot'; });
  }
  checkHealth();
  setInterval(checkHealth, 30000);

  function formatLabel(key) {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, function(s) { return s.toUpperCase(); });
  }

  function renderValue(val) {
    if (Array.isArray(val)) {
      var items = val.map(function(v) { return '<li>' + escapeHtml(String(v)) + '</li>'; }).join('');
      return '<ul class="val-list">' + items + '</ul>';
    }
    if (typeof val === 'object' && val !== null) {
      return '<pre style="margin:0;font-size:12px;white-space:pre-wrap;">' + escapeHtml(JSON.stringify(val, null, 2)) + '</pre>';
    }
    return escapeHtml(String(val));
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  function renderDoc(data, receipt) {
    var html = '<button class="btn back-btn" onclick="window._showList()">Back to Documents</button>';
    if (receipt) {
      html += '<div class="receipt-card">';
      html += '<div class="receipt-header"><h3>Payment Receipt</h3>';
      html += '<div class="receipt-status"><div class="receipt-status-dot"></div>Settled</div></div>';
      html += '<div class="receipt-row"><span class="receipt-label">Amount</span><span class="receipt-value">' + escapeHtml(receipt.amount) + ' ' + escapeHtml(receipt.currency) + '</span></div>';
      html += '<div class="receipt-row"><span class="receipt-label">Tx ID</span><span class="receipt-value" title="' + escapeHtml(receipt.transactionId) + '"><a class="tx-link" href="#" onclick="event.preventDefault();window._viewTx(\\'' + escapeHtml(receipt.transactionId) + '\\',\\'' + escapeHtml(receipt.payer) + '\\',\\'' + escapeHtml(receipt.payee) + '\\')">' + escapeHtml(receipt.transactionId) + '</a></span></div>';
      html += '<div class="receipt-row"><span class="receipt-label">Payer</span><span class="receipt-value" title="' + escapeHtml(receipt.payer) + '">' + escapeHtml(receipt.payer) + '</span></div>';
      html += '<div class="receipt-row"><span class="receipt-label">Payee</span><span class="receipt-value" title="' + escapeHtml(receipt.payee) + '">' + escapeHtml(receipt.payee) + '</span></div>';
      html += '<div class="receipt-row"><span class="receipt-label">Resource</span><span class="receipt-value">' + escapeHtml(receipt.resource) + '</span></div>';
      html += '<div class="receipt-row"><span class="receipt-label">Time</span><span class="receipt-value">' + escapeHtml(new Date(receipt.timestamp).toLocaleString()) + '</span></div>';
      html += '</div>';
    }
    html += '<div class="card" style="cursor:default;">';
    html += '<div class="card-title" style="margin-bottom:16px;font-size:17px;">' + escapeHtml(data.title) + '</div>';
    html += '<table>';
    var content = data.content;
    Object.keys(content).forEach(function(key) {
      html += '<tr><td>' + escapeHtml(formatLabel(key)) + '</td><td>' + renderValue(content[key]) + '</td></tr>';
    });
    html += '</table></div>';
    appEl.innerHTML = html;
  }

  function showList() {
    appEl.innerHTML = '<div class="loading">Loading documents...</div>';
    fetch('/docs').then(function(r) { return r.json(); }).then(function(data) {
      var html = '<div class="section-title">Available Documents</div>';
      data.documents.forEach(function(doc) {
        html += '<div class="card" onclick="window._viewDoc(\\'' + doc.id + '\\')">';
        html += '<div class="card-title">' + escapeHtml(doc.title) + '</div>';
        html += '<div class="card-id">' + escapeHtml(doc.id) + ' &middot; 0.10 CC</div>';
        html += '</div>';
      });
      appEl.innerHTML = html;
    }).catch(function(err) {
      appEl.innerHTML = '<div class="loading" style="color:#ef4444;">Failed to load documents: ' + escapeHtml(err.message) + '</div>';
    });
  }

  function viewDoc(id) {
    appEl.innerHTML = '<div class="loading">Loading document...</div>';
    fetch('/docs/' + encodeURIComponent(id)).then(function(r) {
      if (r.status === 402) {
        return r.json().then(function(body) {
          var req = body.accepts && body.accepts[0];
          var price = req ? req.maxAmountRequired : '0.10';
          var html = '<button class="btn back-btn" onclick="window._showList()">Back to Documents</button>';
          html += '<div class="payment-card">';
          html += '<h3>Payment Required</h3>';
          html += '<p style="color:var(--text-muted);font-size:13px;">This document requires a Canton Coin payment to access.</p>';
          html += '<div class="payment-price">' + escapeHtml(price) + ' <span>CC (Canton Coin)</span></div>';
          if (req) {
            html += '<div class="payment-detail">Resource: ' + escapeHtml(req.resource) + '</div>';
            html += '<div class="payment-detail">Pay to: ' + escapeHtml(req.payTo) + '</div>';
          }
          html += '<br><button class="btn btn-pay" id="payBtn" onclick="window._payAndView(\\'' + escapeHtml(id) + '\\')">Pay &amp; View Document</button>';
          html += '</div>';
          appEl.innerHTML = html;
        });
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json().then(function(data) { renderDoc(data); });
    }).catch(function(err) {
      appEl.innerHTML = '<button class="btn back-btn" onclick="window._showList()">Back to Documents</button>';
      appEl.innerHTML += '<div class="loading" style="color:#ef4444;">Failed to load document: ' + escapeHtml(err.message) + '</div>';
    });
  }

  function showProgress(steps) {
    var html = '<button class="btn back-btn" onclick="window._showList()">Back to Documents</button>';
    html += '<div class="progress-msg">';
    steps.forEach(function(s) {
      html += '<div class="step">' + escapeHtml(s.text) + '</div>';
      if (s.txid) html += '<div class="txid">tx: ' + escapeHtml(s.txid) + '</div>';
    });
    html += '</div>';
    appEl.innerHTML = html;
  }

  function payAndView(id) {
    if (!paymentInfo) {
      appEl.innerHTML += '<div class="loading" style="color:#ef4444;">Payment info not loaded. Refresh and try again.</div>';
      return;
    }

    var resourceId = '/docs/' + encodeURIComponent(id);
    var txId = '';

    // Step 1: Show settling progress
    showProgress([{ text: 'Settling payment on Canton ledger...' }]);

    // Settle via facilitator
    fetch('/facilitator/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payerParty: paymentInfo.payerParty,
        payeeParty: paymentInfo.payeeParty,
        amount: paymentInfo.docPrice,
        resourceId: resourceId,
      }),
    }).then(function(r) { return r.json(); }).then(function(settleResult) {
      if (!settleResult.success) throw new Error(settleResult.error || 'Settlement failed');

      txId = settleResult.transactionId || '';

      // Step 2: Show settled + fetching
      showProgress([
        { text: 'Payment settled.', txid: txId },
        { text: 'Fetching document...' },
      ]);

      // Build payment payload
      var payload = {
        x402Version: 1,
        scheme: 'exact-canton',
        network: 'canton-local',
        payload: {
          command: {
            payer: paymentInfo.payerParty,
            payee: paymentInfo.payeeParty,
            amount: paymentInfo.docPrice,
            currency: 'CC',
            resourceId: resourceId,
            nonce: crypto.randomUUID(),
          },
        },
      };
      var paymentHeader = btoa(JSON.stringify(payload));

      // Retry with payment header
      return fetch('/docs/' + encodeURIComponent(id), {
        headers: { 'X-PAYMENT': paymentHeader },
      });
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' after payment');
      return r.json();
    }).then(function(data) {
      // Step 3: Render receipt + document
      var receipt = {
        transactionId: txId || 'N/A',
        amount: paymentInfo.docPrice,
        currency: 'CC',
        payer: paymentInfo.payerParty,
        payee: paymentInfo.payeeParty,
        resource: resourceId,
        timestamp: new Date().toISOString(),
      };
      renderDoc(data, receipt);
    }).catch(function(err) {
      appEl.innerHTML = '<button class="btn back-btn" onclick="window._showList()">Back to Documents</button>';
      appEl.innerHTML += '<div class="loading" style="color:#ef4444;">Payment failed: ' + escapeHtml(err.message) + '</div>';
    });
  }

  function viewTx(txId, payer, payee) {
    appEl.innerHTML = '<button class="btn back-btn" onclick="window._showList()">Back to Documents</button>' +
      '<div class="loading">Loading transaction details...</div>';

    var parties = encodeURIComponent(payer + ',' + payee);
    fetch('/facilitator/transaction/' + encodeURIComponent(txId) + '?parties=' + parties)
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(tx) {
        var html = '<button class="btn back-btn" onclick="window._showList()">Back to Documents</button>';

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

        appEl.innerHTML = html;
      })
      .catch(function(err) {
        appEl.innerHTML = '<button class="btn back-btn" onclick="window._showList()">Back to Documents</button>' +
          '<div class="loading" style="color:#ef4444;">Failed to load transaction: ' + escapeHtml(err.message) + '</div>';
      });
  }

  window._viewDoc = viewDoc;
  window._showList = showList;
  window._payAndView = payAndView;
  window._viewTx = viewTx;
  showList();
})();
</script>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.type("html").send(HTML_PAGE);
});

// GET /payment-info -- browser fetches party IDs and price
app.get("/payment-info", (_req, res) => {
  res.json({ payerParty, payeeParty, docPrice: "0.10" });
});

// GET /docs -- list available documents (free)
app.get("/docs", (_req, res) => {
  const docs = Object.entries(DOCS).map(([id, d]) => ({
    id,
    title: d.title,
  }));
  res.json({ documents: docs });
});

// GET /docs/:id -- download document (payment gated)
app.get("/docs/:id", paymentRequired({
  payTo: payeeParty,
  amount: "0.10",
  facilitatorUrl: "http://localhost:4010/facilitator",
  description: "Access to financial document",
}), (req, res) => {
  res.set("Cache-Control", "no-store");
  const docMeta = DOCS[req.params.id];
  if (!docMeta) return res.status(404).json({ error: "Document not found" });
  const content = JSON.parse(
    readFileSync(join(__dirname, "docs", docMeta.file), "utf-8"),
  );
  res.json({ title: docMeta.title, content });
});

// GET /health
app.get("/health", (_req, res) => {
  res.json({ status: "healthy" });
});

const PORT = 4010;
app.listen(PORT, () => {
  console.log(`Token-Gated Docs server running on http://localhost:${PORT}`);
  console.log(`  GET /              -- web UI`);
  console.log(`  GET /docs          -- list available documents (free)`);
  console.log(`  GET /docs/:id      -- download document (0.10 CC)`);
  console.log(`  GET /payment-info  -- payment configuration`);
  console.log(`  /facilitator/*     -- x402 facilitator endpoints`);
  console.log(`  GET /health        -- health check`);
});
