// SPDX-License-Identifier: Apache-2.0

import type { JobInput } from "../../input.ts";
import { icsEvents } from "./convert-extra.ts";
import {
  certExpiry,
  dnsLookup,
  domainExpiry,
  eanProduct,
  emailMx,
  fxQuote,
  geoCode,
  geoRev,
  geoTz,
  ibanParse,
  ipCountry,
  isbnBook,
  phoneParse,
  vatCheck,
  vinDecode,
} from "./fact.ts";
import {
  urlFavicon,
  urlMeta,
  urlPdf,
  urlRead,
  urlShot,
  urlStatus,
  urlUnshort,
} from "./link.ts";
import {
  bgRemove,
  barcodeRead,
  exifStrip,
  imgCaption,
  imgCompress,
  imgDeskew,
  imgHeic,
  imgPalette,
  imgThumb,
  ocrPhoto,
  qrMake,
  qrRead,
  receiptRead,
  svgPng,
} from "./picture.ts";
import {
  officePdf,
  pdfCompress,
  pdfFromHtml,
  pdfImages,
  pdfMerge,
  pdfMeta,
  pdfRotate,
  pdfSplit,
  pdfTables,
  pdfText,
} from "./page.ts";
import { speechMp3, speechSay, speechSrt, speechText, speechTrim } from "./sound.ts";
import { dateParse, mdHtml, regexExplain, textLang, textSummary, textTranslate } from "./words.ts";

export type Runner = (input: JobInput) => unknown | Promise<unknown>;

export const RUNNERS: Record<string, Runner> = {
  "bg.remove": bgRemove,
  "img.compress": imgCompress,
  "img.heic": imgHeic,
  "img.thumb": imgThumb,
  "img.deskew": imgDeskew,
  "exif.strip": exifStrip,
  "qr.read": qrRead,
  "qr.make": qrMake,
  "ocr.photo": ocrPhoto,
  "receipt.read": receiptRead,
  "img.caption": imgCaption,
  "barcode.read": barcodeRead,
  "img.palette": imgPalette,
  "svg.png": svgPng,

  "pdf.text": pdfText,
  "pdf.tables": pdfTables,
  "pdf.merge": pdfMerge,
  "pdf.split": pdfSplit,
  "pdf.compress": pdfCompress,
  "pdf.from-html": pdfFromHtml,
  "office.pdf": officePdf,
  "pdf.meta": pdfMeta,
  "pdf.images": pdfImages,
  "pdf.rotate": pdfRotate,

  "speech.text": speechText,
  "speech.srt": speechSrt,
  "speech.trim": speechTrim,
  "speech.mp3": speechMp3,
  "speech.say": speechSay,

  "text.translate": textTranslate,
  "text.summary": textSummary,
  "text.lang": textLang,
  "md.html": mdHtml,
  "date.parse": dateParse,
  "regex.explain": regexExplain,

  "url.shot": urlShot,
  "url.read": urlRead,
  "url.meta": urlMeta,
  "url.unshort": urlUnshort,
  "url.status": urlStatus,
  "url.pdf": urlPdf,
  "url.favicon": urlFavicon,

  "dns.lookup": dnsLookup,
  "cert.expiry": certExpiry,
  "domain.expiry": domainExpiry,
  "email.mx": emailMx,
  "phone.parse": phoneParse,
  "iban.parse": ibanParse,
  "vat.check": vatCheck,
  "vin.decode": vinDecode,
  "isbn.book": isbnBook,
  "ean.product": eanProduct,
  "fx.quote": fxQuote,
  "geo.code": geoCode,
  "geo.rev": geoRev,
  "geo.tz": geoTz,
  "ip.country": ipCountry,

  "ics.events": icsEvents,
};