// SPDX-License-Identifier: Apache-2.0

import { lookup, resolveMx, resolveTxt } from "node:dns/promises";
import { connect } from "node:tls";

import IBAN from "iban";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import whois from "whois-json";

import type { JobInput } from "../../input.ts";
import { fetchWithTimeout, requireOther } from "../helpers.ts";

export async function dnsLookup(input: JobInput): Promise<{ records: unknown }> {
  const type = requireOther(input, "record type").toUpperCase();
  const name = input.text.trim();
  if (type === "MX") return { records: await resolveMx(name) };
  if (type === "TXT") return { records: await resolveTxt(name) };
  if (type === "A" || type === "AAAA") return { records: await lookup(name, { all: true }) };
  throw new Error("Use A, AAAA, MX, or TXT.");
}

export async function certExpiry(input: JobInput): Promise<{ host: string; issuer?: string; validTo?: string }> {
  const host = input.text.trim().replace(/^https?:\/\//i, "").split("/")[0] ?? "";
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host, port: 443, servername: host, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        const org = cert.issuer?.O;
        resolve({
          host,
          issuer: Array.isArray(org) ? org[0] : org,
          validTo: cert.valid_to,
        });
      },
    );
    socket.on("error", (err) => reject(err));
  });
}

export async function domainExpiry(input: JobInput): Promise<{ domain: string; expiry?: string; raw?: unknown }> {
  const domain = input.text.trim();
  const raw = await whois(domain);
  const expiry =
    (raw as { expiryDate?: string; registrarRegistrationExpirationDate?: string }).expiryDate ??
    (raw as { registrarRegistrationExpirationDate?: string }).registrarRegistrationExpirationDate;
  return { domain, expiry, raw };
}

export async function emailMx(input: JobInput): Promise<{ validSyntax: boolean; mx: unknown[] }> {
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.text.trim());
  const domain = input.text.trim().split("@")[1];
  const mx = domain && ok ? await resolveMx(domain).catch(() => []) : [];
  return { validSyntax: ok, mx };
}

export function phoneParse(input: JobInput): { e164?: string; country?: string; type?: string } {
  const parsed = parsePhoneNumberFromString(input.text);
  if (!parsed?.isValid()) throw new Error("Could not parse that phone number.");
  return {
    e164: parsed.format("E.164"),
    country: parsed.country,
    type: parsed.getType() ?? undefined,
  };
}

export function ibanParse(input: JobInput): { country?: string; valid: boolean; electronicFormat?: string } {
  const electronic = IBAN.electronicFormat(input.text);
  const valid = IBAN.isValid(electronic);
  return {
    valid,
    country: valid ? IBAN.getCountryCode(electronic) : undefined,
    electronicFormat: electronic,
  };
}

export function vatCheck(input: JobInput): { id: string; valid: boolean; name?: string } {
  const id = input.text.trim().toUpperCase();
  const valid = /^[A-Z]{2}[A-Z0-9]{8,12}$/.test(id);
  return { id, valid, name: valid ? undefined : undefined };
}

export function vinDecode(input: JobInput): { vin: string; wmi?: string; yearHint?: number } {
  const vin = input.text.trim().toUpperCase();
  if (vin.length < 11) throw new Error("VIN must be at least 11 characters.");
  const yearCode = vin[9];
  const yearMap: Record<string, number> = {
    A: 2010,
    B: 2011,
    C: 2012,
    D: 2013,
    E: 2014,
    F: 2015,
    G: 2016,
    H: 2017,
    J: 2018,
    K: 2019,
    L: 2020,
    M: 2021,
    N: 2022,
    P: 2023,
    R: 2024,
    S: 2025,
  };
  return { vin, wmi: vin.slice(0, 3), yearHint: yearCode ? yearMap[yearCode] : undefined };
}

export async function isbnBook(input: JobInput): Promise<{ isbn: string; title?: string }> {
  const isbn = input.text.replace(/\D/g, "");
  const res = await fetchWithTimeout(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  const data = (await res.json()) as Record<string, { title?: string }>;
  const hit = data[`ISBN:${isbn}`];
  return { isbn, title: hit?.title };
}

export async function eanProduct(input: JobInput): Promise<{ ean: string; lookup: string }> {
  const ean = input.text.replace(/\D/g, "");
  return { ean, lookup: `https://world.openfoodfacts.org/product/${ean}` };
}

export async function fxQuote(input: JobInput): Promise<{ amount: number; from: string; to: string; result: number }> {
  const amount = Number.parseFloat(input.text.trim());
  const pair = requireOther(input, "currency pair").toUpperCase().split(/\s+/);
  const from = pair[0];
  const to = pair[1];
  if (!from || !to || !Number.isFinite(amount)) throw new Error('Use text "100" and other "USD EUR".');
  const res = await fetchWithTimeout(`https://api.frankfurter.app/latest?amount=${amount}&from=${from}&to=${to}`);
  const body = (await res.json()) as { rates?: Record<string, number> };
  const result = body.rates?.[to];
  if (result === undefined) throw new Error("Could not quote that pair.");
  return { amount, from, to, result };
}

export async function geoCode(input: JobInput): Promise<{ lat: number; lon: number }> {
  const q = encodeURIComponent(input.text.trim());
  const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`, {
    headers: { "user-agent": "chainsafe-one-job-demo/1.0" },
  });
  const rows = (await res.json()) as Array<{ lat: string; lon: string }>;
  const hit = rows[0];
  if (!hit) throw new Error("No coordinates for that address.");
  return { lat: Number(hit.lat), lon: Number(hit.lon) };
}

export async function geoRev(input: JobInput): Promise<{ address: string }> {
  const [lat, lon] = input.text.split(",").map((p) => p.trim());
  const res = await fetchWithTimeout(
    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
    { headers: { "user-agent": "chainsafe-one-job-demo/1.0" } },
  );
  const body = (await res.json()) as { display_name?: string };
  if (!body.display_name) throw new Error("No address for those coordinates.");
  return { address: body.display_name };
}

export async function geoTz(input: JobInput): Promise<{ timezone: string }> {
  const [lat, lon] = input.text.split(",").map((p) => p.trim());
  const res = await fetchWithTimeout(
    `https://timeapi.io/api/timezone/coordinate?latitude=${lat}&longitude=${lon}`,
  );
  const body = (await res.json()) as { timeZone?: string };
  if (!body.timeZone) throw new Error("Could not resolve timezone.");
  return { timezone: body.timeZone };
}

export async function ipCountry(input: JobInput): Promise<{ country?: string; countryCode?: string }> {
  const ip = input.text.trim();
  const res = await fetchWithTimeout(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=country,countryCode,status`);
  const body = (await res.json()) as { status: string; country?: string; countryCode?: string };
  if (body.status !== "success") throw new Error("Lookup failed.");
  return { country: body.country, countryCode: body.countryCode };
}