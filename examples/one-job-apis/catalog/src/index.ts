// The surface a person can browse. Every job runs behind paymentRequired in this build.
//
// SPDX-License-Identifier: Apache-2.0

export const GROUPS = ["Picture", "Page", "Sound", "Words", "Link", "Fact", "Convert"] as const;
export type Group = (typeof GROUPS)[number];

export type Via = "Finger" | "Call" | "Both";

export interface Tool {
  /** Route id. `POST /v1/${tool}`. */
  tool: string;
  group: Group;
  /** Finger: a person will do this on a phone. Call: a program pays. Both: either. */
  via: Via;
  /** What one call takes, in a sentence. */
  body: string;
  /** What one call returns, in a sentence. */
  result: string;
  /** Illustrative price in cents of Canton Coin. Not a tariff. */
  cents: number;
  /** This build runs the job behind paymentRequired. */
  live: boolean;
}

function tool(
  tool: string,
  group: Group,
  via: Via,
  body: string,
  result: string,
  cents: number,
): Tool {
  return { tool, group, via, body, result, cents, live: true };
}

export const TOOLS: readonly Tool[] = [
  tool("bg.remove", "Picture", "Both", "one image", "png with the subject kept", 8),
  tool("img.compress", "Picture", "Both", "one image, max kilobytes", "image under that size", 2),
  tool("img.heic", "Picture", "Finger", "one HEIC", "jpeg", 2),
  tool("img.thumb", "Picture", "Call", "one image, longest edge", "thumbnail", 1),
  tool("img.deskew", "Picture", "Finger", "photo of a page", "straightened page", 3),
  tool("exif.strip", "Picture", "Finger", "one image", "image with location and camera data removed", 1),
  tool("qr.read", "Picture", "Both", "photo of a code", "the text in it", 1),
  tool("qr.make", "Picture", "Finger", "a string", "png of the code", 1),
  tool("ocr.photo", "Picture", "Finger", "photo of writing", "the text", 5),
  tool("receipt.read", "Picture", "Finger", "photo of a receipt", "merchant, total, tax, line items", 8),
  tool("img.caption", "Picture", "Call", "one image", "one sentence", 4),
  tool("barcode.read", "Picture", "Finger", "photo of a barcode", "the code", 1),
  tool("img.palette", "Picture", "Call", "one image", "dominant hex colors", 1),
  tool("svg.png", "Picture", "Call", "one svg, pixel width", "png", 2),

  tool("pdf.text", "Page", "Both", "one pdf", "the text", 4),
  tool("pdf.tables", "Page", "Call", "one pdf", "tables as rows", 8),
  tool("pdf.merge", "Page", "Finger", "a handful of pdfs", "one pdf", 3),
  tool("pdf.split", "Page", "Call", "one pdf, page range", "those pages", 2),
  tool("pdf.compress", "Page", "Both", "one pdf", "smaller pdf", 3),
  tool("pdf.from-html", "Page", "Call", "an html string", "one pdf", 4),
  tool("office.pdf", "Page", "Both", "one docx, pptx, or sheet", "pdf", 5),
  tool("pdf.meta", "Page", "Call", "one pdf", "page count and page size", 1),
  tool("pdf.images", "Page", "Call", "one pdf", "the embedded images", 4),
  tool("pdf.rotate", "Page", "Finger", "one pdf, a quarter-turn", "pdf turned upright", 2),

  tool("speech.text", "Sound", "Both", "audio, up to 60 seconds", "transcript", 8),
  tool("speech.srt", "Sound", "Call", "audio, up to 60 seconds", "subtitles", 8),
  tool("speech.trim", "Sound", "Call", "audio, up to 60 seconds", "audio with silence cut", 2),
  tool("speech.mp3", "Sound", "Call", "audio, up to 60 seconds", "mp3", 2),
  tool("speech.say", "Sound", "Finger", "text, up to 500 characters", "audio of that text", 4),

  tool("text.translate", "Words", "Both", "a paragraph, target language", "that paragraph", 3),
  tool("text.summary", "Words", "Call", "text, word budget", "shorter text", 3),
  tool("text.lang", "Words", "Call", "a paragraph", "language code", 1),
  tool("text.pii", "Words", "Both", "a paragraph", "emails, phones, and card numbers masked", 2),
  tool("text.diff", "Words", "Call", "two texts", "a diff", 1),
  tool("md.html", "Words", "Call", "markdown", "html", 1),
  tool("date.parse", "Words", "Both", "a phrase, a timezone", "an instant", 1),
  tool("cron.english", "Words", "Call", "a cron expression", "one sentence", 1),
  tool("regex.explain", "Words", "Call", "a pattern", "what it matches", 1),
  tool("html.text", "Words", "Call", "html", "visible text", 1),

  tool("url.shot", "Link", "Both", "one url, viewport", "png", 5),
  tool("url.read", "Link", "Both", "one url", "article text", 4),
  tool("url.meta", "Link", "Call", "one url", "title, description, image", 2),
  tool("url.unshort", "Link", "Call", "one url", "the url it lands on", 1),
  tool("url.status", "Link", "Call", "one url", "status and redirect chain", 1),
  tool("url.pdf", "Link", "Both", "one url", "pdf of the page", 5),
  tool("url.favicon", "Link", "Call", "one host", "png", 1),

  tool("dns.lookup", "Fact", "Call", "a name, a record type", "the records", 1),
  tool("cert.expiry", "Fact", "Call", "a host", "issuer and expiry", 1),
  tool("domain.expiry", "Fact", "Call", "a domain", "registry expiry", 2),
  tool("email.mx", "Fact", "Call", "an address", "syntax, and whether mail hosts exist", 1),
  tool("phone.parse", "Fact", "Call", "a phone number", "country, type, E.164", 1),
  tool("iban.parse", "Fact", "Both", "an IBAN", "country, bank, checksum", 1),
  tool("vat.check", "Fact", "Call", "a VAT id", "valid, and the registered name", 3),
  tool("vin.decode", "Fact", "Both", "a VIN", "make, model, year, plant", 2),
  tool("isbn.book", "Fact", "Both", "an ISBN", "title, author, year", 2),
  tool("ean.product", "Fact", "Both", "a barcode number", "the product name", 2),
  tool("fx.quote", "Fact", "Both", "amount, pair, date", "the converted amount", 1),
  tool("geo.code", "Fact", "Call", "an address", "latitude and longitude", 2),
  tool("geo.rev", "Fact", "Call", "latitude and longitude", "an address", 2),
  tool("geo.tz", "Fact", "Call", "latitude and longitude", "the timezone", 1),
  tool("ip.country", "Fact", "Call", "an IP address", "the country", 1),
  tool("ua.parse", "Fact", "Call", "a user-agent", "browser and OS", 1),

  tool("csv.json", "Convert", "Call", "csv text", "rows of json", 1),
  tool("json.csv", "Convert", "Call", "rows of json", "csv", 1),
  tool("json.fmt", "Convert", "Call", "json", "json, pretty or compact", 1),
  tool("hash.sha256", "Convert", "Call", "bytes", "hex digest", 1),
  tool("jwt.read", "Convert", "Call", "a JWT", "header and payload", 1),
  tool("units.convert", "Convert", "Both", "a quantity and a target unit", "the quantity", 1),
  tool("mime.sniff", "Convert", "Call", "bytes", "media type", 1),
  tool("ics.events", "Convert", "Call", "an iCalendar snippet", "the events", 1),

  tool("bulk.25", "Fact", "Call", "prepaid pack id 25", "twenty-five calls on your account", 10),
  tool("bulk.100", "Fact", "Call", "prepaid pack id 100", "one hundred calls on your account", 35),
  tool("bulk.500", "Fact", "Call", "prepaid pack id 500", "five hundred calls on your account", 150),
];

export function findTool(id: string): Tool | undefined {
  return TOOLS.find((entry) => entry.tool === id);
}

/** Tools whose second field is part of the call, so a missing one is refused before payment. */
export const NEEDS_OTHER: ReadonlySet<string> = new Set([
  "text.diff",
  "units.convert",
  "text.translate",
  "text.summary",
  "date.parse",
  "dns.lookup",
  "fx.quote",
  "img.compress",
  "img.thumb",
  "pdf.split",
  "pdf.rotate",
  "svg.png",
  "url.shot",
]);
