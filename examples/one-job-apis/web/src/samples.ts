/** Default input for live tools so Pay works on first open. */
export const SAMPLES: Record<string, { text: string; other?: string }> = {
  "hash.sha256": { text: "hello" },
  "json.fmt": { text: '{"a":1,"b":[2,3]}' },
  "csv.json": { text: "name,score\nAda,98\nBob,87" },
  "json.csv": { text: '[{"name":"Ada","score":"98"},{"name":"Bob","score":"87"}]' },
  "text.diff": { text: "line one\nline two", other: "line one\nline too" },
  "html.text": { text: "<p>Hello <b>world</b></p>" },
  "text.pii": { text: "Reach me at ada@example.com or +1 415 555 0100" },
  "cron.english": { text: "*/15 * * * 1" },
  "units.convert": { text: "72 F", other: "C" },
  "mime.sniff": { text: '{"ok":true}' },
  "ua.parse": {
    text: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "jwt.read": {
    text: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
  },
  "text.translate": { text: "Hello world", other: "de" },
  "text.summary": { text: "one two three four five six seven eight", other: "4" },
  "date.parse": { text: "next Friday at 3pm", other: "UTC" },
  "dns.lookup": { text: "chainsafe.io", other: "MX" },
  "fx.quote": { text: "100", other: "USD EUR" },
  "qr.make": { text: "https://chainsafe.io" },
  "url.meta": { text: "https://chainsafe.io" },
  "phone.parse": { text: "+14155550100" },
  "geo.code": { text: "Zürich, Switzerland" },
  "regex.explain": { text: "/^\\d{3}-\\d{2}-\\d{4}$/" },
  "ics.events": {
    text: "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Demo\nDTSTART:20250101T120000Z\nDTEND:20250101T130000Z\nEND:VEVENT\nEND:VCALENDAR",
  },
};