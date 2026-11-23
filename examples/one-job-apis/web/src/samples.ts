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
};