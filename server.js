import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import * as cheerio from "cheerio";
import pdfParse from "pdf-parse";
import cron from "node-cron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 8000;
const DATA912_BASE_URL = process.env.DATA912_BASE_URL || "https://data912.com";
const DATA_DIR = path.join(__dirname, "data");
const BONDS_PATH = path.join(DATA_DIR, "bonds.json");

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const cache = {
  prices: { ts: 0, data: null },
  bonds: { ts: 0, data: null },
};

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(/,/g, ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function cleanNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim().replace(/,/g, ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmtDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(dateString) {
  if (!dateString) return null;
  const d = new Date(`${dateString}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addMonths(date, months) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d;
}

function yearFracActual365(start, end) {
  return Math.max(0, (end - start) / (365 * 24 * 60 * 60 * 1000));
}

function days360US(start, end) {
  let d1 = start.getUTCDate();
  let d2 = end.getUTCDate();
  const m1 = start.getUTCMonth() + 1;
  const m2 = end.getUTCMonth() + 1;
  const y1 = start.getUTCFullYear();
  const y2 = end.getUTCFullYear();
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;
  return 360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "user-agent": "Mozilla/5.0 DashboardBonos/5.0",
        accept: "application/json,text/html,application/pdf,*/*",
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url);
  return res.json();
}

async function fetchText(url) {
  const res = await fetchWithTimeout(url);
  return res.text();
}

async function fetchBuffer(url) {
  const res = await fetchWithTimeout(url, {}, 20000);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function loadBonds() {
  if (cache.bonds.data && Date.now() - cache.bonds.ts < 10_000) return cache.bonds.data;
  const raw = await fs.readFile(BONDS_PATH, "utf8");
  const data = JSON.parse(raw);
  cache.bonds = { ts: Date.now(), data };
  return data;
}

async function saveBonds(bonds) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(BONDS_PATH, JSON.stringify(bonds, null, 2), "utf8");
  cache.bonds = { ts: Date.now(), data: bonds };
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function isCclSymbol(symbol) {
  return /C$/.test(normalizeSymbol(symbol));
}

function isUsdMepSymbol(symbol) {
  return /O$/.test(normalizeSymbol(symbol));
}

function baseSymbol(symbol) {
  const s = normalizeSymbol(symbol);
  if (/[OCPD]$/.test(s)) return s.slice(0, -1);
  return s;
}

function normalizeMarketRow(row) {
  const symbol = normalizeSymbol(row.symbol || row.ticker || row.s || row.descripcion || row.nombre);
  const last = cleanNumber(row.c ?? row.close ?? row.last ?? row.price ?? row.px_last ?? row.ultimo);
  const bid = cleanNumber(row.px_bid ?? row.bid ?? row.compra ?? row.bid_price);
  const ask = cleanNumber(row.px_ask ?? row.ask ?? row.venta ?? row.ask_price);
  const volume = cleanNumber(row.v ?? row.volume ?? row.volumen);
  const qBid = cleanNumber(row.q_bid ?? row.bid_size ?? row.cantidad_compra);
  const qAsk = cleanNumber(row.q_ask ?? row.ask_size ?? row.cantidad_venta);
  const pctChange = cleanNumber(row.pct_change ?? row.change_percent ?? row.var_pct);
  return { raw: row, symbol, base: baseSymbol(symbol), last, bid, ask, volume, qBid, qAsk, pctChange };
}

function extractMepValue(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [payload];
  const candidates = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    for (const key of ["mark", "close", "c", "last", "price", "px", "mep", "value", "ask", "bid"]) {
      const value = cleanNumber(r[key]);
      if (value && value > 500 && value < 10000) candidates.push(value);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a - b);
  return candidates[Math.floor(candidates.length / 2)];
}

function couponSchedule(tech, today = new Date()) {
  const maturity = parseDate(tech.maturity);
  if (!maturity || !tech.frequency) return [];
  const interval = Math.round(12 / tech.frequency);
  const dates = [];
  let d = maturity;
  let guard = 0;
  while (d > addMonths(today, -60) && guard < 200) {
    dates.push(d);
    d = addMonths(d, -interval);
    guard += 1;
  }
  return dates.sort((a, b) => a - b);
}

function getOutstandingBefore(tech, date) {
  const amorts = Array.isArray(tech.amortization) ? tech.amortization : [];
  let outstanding = 100;
  for (const a of amorts) {
    const ad = parseDate(a.date);
    if (ad && ad < date) outstanding -= 100 * Number(a.percent || 0);
  }
  return Math.max(0, outstanding);
}

function getPrincipalOnDate(tech, date) {
  const key = fmtDateKey(date);
  const amorts = Array.isArray(tech.amortization) ? tech.amortization : [];
  return amorts
    .filter((a) => a.date === key)
    .reduce((acc, a) => acc + 100 * Number(a.percent || 0), 0);
}

function buildCashflows(tech, today = new Date()) {
  if (!tech?.coupon || !tech?.maturity || !tech?.frequency) return [];
  const schedule = couponSchedule(tech, today);
  const flows = [];
  for (const d of schedule) {
    if (d <= today) continue;
    const outstanding = getOutstandingBefore(tech, d);
    const interest = outstanding * Number(tech.coupon) / Number(tech.frequency);
    const principal = getPrincipalOnDate(tech, d);
    const cf = interest + principal;
    if (cf > 0) {
      flows.push({ date: fmtDateKey(d), t: yearFracActual365(today, d), interest, principal, cf });
    }
  }
  return flows;
}

function accruedInterest(tech, today = new Date()) {
  if (!tech?.coupon || !tech?.frequency || !tech?.maturity) return 0;
  const schedule = couponSchedule(tech, today);
  const future = schedule.find((d) => d > today);
  if (!future) return 0;
  const interval = Math.round(12 / tech.frequency);
  const previous = addMonths(future, -interval);
  const outstanding = getOutstandingBefore(tech, today);
  const couponPayment = outstanding * Number(tech.coupon) / Number(tech.frequency);
  const elapsed = Math.max(0, days360US(previous, today));
  const total = Math.max(1, days360US(previous, future));
  return couponPayment * Math.min(1, elapsed / total);
}

function solveIrr(flows, dirtyPrice) {
  if (!flows.length || !dirtyPrice || dirtyPrice <= 0) return null;
  const pv = (y) => flows.reduce((acc, f) => acc + f.cf / Math.pow(1 + y, f.t), 0) - dirtyPrice;
  let lo = -0.95;
  let hi = 2.0;
  let fLo = pv(lo);
  let fHi = pv(hi);
  for (let tries = 0; tries < 10 && fLo * fHi > 0; tries += 1) {
    hi *= 2;
    fHi = pv(hi);
  }
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = pv(mid);
    if (Math.abs(fMid) < 1e-8) return mid;
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

function calcMetrics(tech, cleanPrice, today = new Date()) {
  if (!tech || !cleanPrice || cleanPrice <= 0 || !tech.maturity || !tech.coupon || !tech.frequency) {
    return { tir: null, durationMod: null, accrued: null, dirtyPrice: null, flows12: null, flows24: null, cashflows: [] };
  }
  const clean = Number(cleanPrice);
  const accrued = accruedInterest(tech, today);
  const dirty = clean + accrued;
  const cashflows = buildCashflows(tech, today);
  const y = solveIrr(cashflows, dirty);
  let durationMod = null;
  if (y !== null && y > -0.99) {
    const pvTotal = cashflows.reduce((acc, f) => acc + f.cf / Math.pow(1 + y, f.t), 0);
    if (pvTotal > 0) {
      const macaulay = cashflows.reduce((acc, f) => acc + f.t * (f.cf / Math.pow(1 + y, f.t)), 0) / pvTotal;
      durationMod = macaulay / (1 + y);
    }
  }
  const flows12 = cashflows.filter((f) => f.t <= 1).reduce((a, f) => a + f.cf, 0);
  const flows24 = cashflows.filter((f) => f.t <= 2).reduce((a, f) => a + f.cf, 0);
  return { tir: y, durationMod, accrued, dirtyPrice: dirty, flows12, flows24, cashflows };
}

function spreadPct(bid, ask) {
  if (!bid || !ask || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  return (ask - bid) / mid;
}

// En Data912, algunas especies corporativas que terminan en O pueden venir con precio
// expresado en ARS. Para el dashboard normalizamos todo a USD MEP.
// Regla práctica: precio por 100 VN de un bono en USD suele estar cerca de 30-200.
// Si el número viene arriba de 500, lo tratamos como precio en ARS y lo dividimos por MEP.
const MAX_REASONABLE_USD_BOND_PRICE = 500;

function needsArsToMepConversion(value) {
  return value !== null && value !== undefined && Number(value) > MAX_REASONABLE_USD_BOND_PRICE;
}

function normalizePriceToUsdMep(value, mep, forceArs = false) {
  const n = cleanNumber(value);
  if (n === null || n <= 0) return { value: null, converted: false, unavailable: false };
  if (forceArs || needsArsToMepConversion(n)) {
    if (!mep || mep <= 0) return { value: null, converted: false, unavailable: true };
    return { value: n / mep, converted: true, unavailable: false };
  }
  return { value: n, converted: false, unavailable: false };
}

function normalizeRowPricesToUsdMep(row, mep, forceArs = false) {
  const last = normalizePriceToUsdMep(row.last, mep, forceArs);
  const bid = normalizePriceToUsdMep(row.bid, mep, forceArs);
  const ask = normalizePriceToUsdMep(row.ask, mep, forceArs);
  const converted = last.converted || bid.converted || ask.converted;
  const unavailable = last.unavailable || bid.unavailable || ask.unavailable;
  return {
    lastUsd: last.value,
    bidUsd: bid.value,
    askUsd: ask.value,
    converted,
    unavailable,
  };
}

async function getPrices() {
  if (cache.prices.data && Date.now() - cache.prices.ts < 15_000) return cache.prices.data;
  const errors = [];
  let corpPayload;
  let mepPayload;
  try {
    corpPayload = await fetchJson(`${DATA912_BASE_URL}/live/arg_corp`);
  } catch (e) {
    errors.push(`Data912 arg_corp: ${e.message}`);
  }
  try {
    mepPayload = await fetchJson(`${DATA912_BASE_URL}/live/mep`);
  } catch (e) {
    errors.push(`Data912 mep: ${e.message}`);
  }
  const mep = mepPayload ? extractMepValue(mepPayload) : null;
  const corpRowsRaw = Array.isArray(corpPayload) ? corpPayload : Array.isArray(corpPayload?.data) ? corpPayload.data : [];
  const rows = corpRowsRaw.map(normalizeMarketRow).filter((r) => r.symbol);
  const usdMap = new Map();
  const arsMap = new Map();
  for (const r of rows) {
    if (isCclSymbol(r.symbol)) continue;
    if (isUsdMepSymbol(r.symbol)) usdMap.set(r.base, r);
    else if (!arsMap.has(r.base)) arsMap.set(r.base, r);
  }
  const bases = new Set([...usdMap.keys(), ...arsMap.keys()]);
  const bonds = await loadBonds();
  const bondBySymbol = new Map(bonds.map((b) => [normalizeSymbol(b.symbol), b]));
  const today = new Date();
  const out = [];
  for (const base of bases) {
    const usd = usdMap.get(base);
    const ars = arsMap.get(base);

    // Preferimos la especie O cuando existe. Si Data912 la informa en ARS, la convertimos.
    // Si no existe especie O, usamos la especie en pesos y la convertimos por MEP.
    let chosen = usd || ars;
    if (!chosen) continue;

    const forceArs = !usd;
    const normalizedPrices = normalizeRowPricesToUsdMep(chosen, mep, forceArs);
    if (normalizedPrices.unavailable || (!normalizedPrices.lastUsd && !normalizedPrices.bidUsd && !normalizedPrices.askUsd)) {
      continue;
    }

    const symbol = normalizeSymbol(usd?.symbol || `${base}O`);
    const lastUsd = normalizedPrices.lastUsd;
    const bidUsd = normalizedPrices.bidUsd;
    const askUsd = normalizedPrices.askUsd;
    const tablePrice = bidUsd && askUsd ? (bidUsd + askUsd) / 2 : lastUsd || bidUsd || askUsd;

    let priceSource = "USD MEP directo";
    if (usd && normalizedPrices.converted) priceSource = "Especie O convertida: ARS / MEP";
    if (!usd && ars) priceSource = "Especie ARS convertida: ARS / MEP";

    const tech = bondBySymbol.get(symbol) || bondBySymbol.get(`${base}O`) || null;
    const metrics = tech ? calcMetrics(tech, tablePrice, today) : calcMetrics(null, null, today);
    out.push({
      symbol,
      base,
      issuer: tech?.shortIssuer || tech?.issuer || "—",
      sector: tech?.sector || "—",
      priceUsd: tablePrice,
      lastUsd,
      bidUsd,
      askUsd,
      rawLast: chosen.last,
      rawBid: chosen.bid,
      rawAsk: chosen.ask,
      volume: chosen.volume,
      qBid: chosen.qBid,
      qAsk: chosen.qAsk,
      pctChange: chosen.pctChange,
      spread: spreadPct(bidUsd, askUsd),
      priceSource,
      mepUsed: normalizedPrices.converted ? mep : null,
      maturity: tech?.maturity || null,
      coupon: tech?.coupon ?? null,
      frequency: tech?.frequency ?? null,
      rating: tech?.rating || null,
      ratingAgency: tech?.ratingAgency || null,
      law: tech?.law || null,
      secured: tech?.secured || null,
      sourceStatus: tech?.sourceStatus || (tech ? "manual" : "sin ficha técnica"),
      tir: metrics.tir,
      durationMod: metrics.durationMod,
      accrued: metrics.accrued,
      dirtyPrice: metrics.dirtyPrice,
      flows12: metrics.flows12,
      flows24: metrics.flows24,
      cashflows: metrics.cashflows?.slice(0, 12) || [],
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const payload = { asOf: nowIso(), mep, rows: out, errors };
  cache.prices = { ts: Date.now(), data: payload };
  return payload;
}

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

const MONTHS_ES = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

function parseSpanishDate(match) {
  if (!match) return null;
  const m = String(match).toLowerCase().match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i);
  if (!m) return null;
  const dd = m[1].padStart(2, "0");
  const mm = MONTHS_ES[m[2].normalize("NFD").replace(/[\u0300-\u036f]/g, "")] || null;
  if (!mm) return null;
  return `${m[3]}-${mm}-${dd}`;
}

function extractTechnicalFromText(rawText) {
  const text = normalizeText(rawText);
  const patch = {};
  const couponMatch = text.match(/tasa(?:\s+de\s+inter[eé]s)?(?:\s+fija)?(?:\s+nominal\s+anual)?(?:\s+del|\s*:)?\s*(\d{1,2}(?:[,.]\d+)?)\s*%/i);
  if (couponMatch) patch.coupon = toNumber(couponMatch[1]) / 100;
  const maturityMatch = text.match(/vencimiento(?:\s+el|\s+en)?\s+(\d{1,2}\s+de\s+[a-záéíóúñ]+\s+de\s+\d{4})/i);
  if (maturityMatch) patch.maturity = parseSpanishDate(maturityMatch[1]);
  if (/semestral(?:mente)?/i.test(text)) patch.frequency = 2;
  if (/trimestral(?:mente)?/i.test(text)) patch.frequency = 4;
  if (/mensual(?:mente)?/i.test(text)) patch.frequency = 12;
  if (/amortizar[áa].{0,80}(?:[úu]nica cuota|vencimiento|bullet)/i.test(text) || /amortizaci[oó]n.{0,80}(?:[úu]nica cuota|vencimiento|bullet)/i.test(text)) {
    if (patch.maturity) patch.amortization = [{ date: patch.maturity, percent: 1 }];
  }
  if (/ley(?:es)?\s+del\s+Estado\s+de\s+Nueva\s+York|New\s+York/i.test(text)) patch.law = "NY";
  else if (/ley(?:es)?\s+argentina|Rep[uú]blica\s+Argentina/i.test(text)) patch.law = "Argentina";
  if (/garantizada|senior secured|garant[ií]a/i.test(text)) patch.secured = "Revisar garantía / menciona garantía";
  if (/no\s+garantizada|unsecured/i.test(text)) patch.secured = "Senior unsecured";
  return patch;
}

async function readPdfText(url) {
  const buffer = await fetchBuffer(url);
  const parsed = await pdfParse(buffer);
  return parsed.text || "";
}

function includesAnyKeyword(text, keywords = []) {
  const lower = normalizeText(text).toLowerCase();
  return keywords.some((k) => lower.includes(String(k).toLowerCase()));
}

async function syncCnvForBond(bond) {
  if (!bond?.cuit) return { ok: false, message: "Falta CUIT del emisor" };
  const url = `https://www.cnv.gov.ar/SitioWeb/Empresas/Empresa/${bond.cuit}?formType=EMISIO`;
  const result = { ok: true, url, documents: [], patch: {}, confidence: "baja", warnings: [] };
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);
    const pageText = normalizeText($.text());
    if (includesAnyKeyword(pageText, bond.classKeywords || [])) {
      result.patch = { ...result.patch, ...extractTechnicalFromText(pageText) };
      result.confidence = Object.keys(result.patch).length ? "media" : "baja";
    }
    $("a").each((_, el) => {
      const href = $(el).attr("href") || "";
      const label = normalizeText($(el).text());
      const combined = `${label} ${href}`;
      if (/prospecto|suplemento|aviso|emisi[oó]n|obligaciones/i.test(combined)) {
        let fullUrl = href;
        if (href && href.startsWith("/")) fullUrl = `https://www.cnv.gov.ar${href}`;
        if (href && !href.startsWith("http") && !href.startsWith("/")) fullUrl = `https://www.cnv.gov.ar/${href}`;
        result.documents.push({ label, url: fullUrl });
      }
    });
    // Best effort: try first PDF-like document that matches class keywords.
    for (const doc of result.documents.slice(0, 8)) {
      if (!/pdf|download|AIF|archivo|doc/i.test(doc.url + " " + doc.label)) continue;
      try {
        const pdfText = await readPdfText(doc.url);
        if (!includesAnyKeyword(pdfText, bond.classKeywords || [])) continue;
        const patch = extractTechnicalFromText(pdfText);
        result.patch = { ...result.patch, ...patch };
        result.confidence = Object.keys(patch).length >= 3 ? "alta" : result.confidence;
        result.bestDocument = doc;
        break;
      } catch (e) {
        result.warnings.push(`No pude leer PDF ${doc.url}: ${e.message}`);
      }
    }
    return result;
  } catch (e) {
    return { ok: false, url, message: e.message };
  }
}

function extractFixFromText(text, issuer, keywords = []) {
  const normalized = normalizeText(text);
  const issuerParts = String(issuer || "").split(/\s+/).filter((w) => w.length > 4).slice(0, 3);
  const issuerHit = issuerParts.some((w) => normalized.toLowerCase().includes(w.toLowerCase()));
  const keywordHit = keywords.length ? includesAnyKeyword(normalized, keywords) : true;
  // FIX suele publicar calificaciones locales tipo AAA(arg), AA(arg), A(arg), etc.
  // Evitamos tomar letras sueltas de la página como rating, que era lo que generaba valores erróneos como "d".
  const localRatingRegex = /\b(?:AAA|AA|A|BBB|BB|B|CCC|CC|C|D)(?:[+-])?\s*(?:\(arg\)|arg|\.ar)\b/gi;
  const globalRatingRegex = /\b(?:AAA|AA|BBB|BB|CCC|CC|C)(?:[+-])?\b/g;
  const matches = [
    ...(normalized.match(localRatingRegex) || []),
    ...(normalized.match(globalRatingRegex) || []),
  ];
  const filtered = Array.from(new Set(matches
    .map((m) => m.replace(/\s+/g, "").replace(/\.ar$/i, ".ar").replace(/arg$/i, "(arg)"))
    .filter((m) => !/^AR$/i.test(m))));
  let outlook = null;
  const outlookMatch = normalized.match(/Perspectiva\s+(Estable|Positiva|Negativa)|Rating\s+Watch\s+(Positivo|Negativo|En\s+Evoluci[oó]n)/i);
  if (outlookMatch) outlook = outlookMatch[1] || outlookMatch[2];
  return {
    issuerHit,
    keywordHit,
    rating: filtered[0] || null,
    outlook,
    rawSample: normalized.slice(0, 500),
  };
}

async function syncFixForBond(bond) {
  const issuer = bond?.issuer || bond?.shortIssuer;
  if (!issuer) return { ok: false, message: "Falta emisor" };
  const q = encodeURIComponent(issuer);
  const urls = [
    `https://www.fixscr.com/calificaciones?search=${q}`,
    `https://www.fixscr.com/calificaciones?q=${q}`,
    `https://www.fixscr.com/reportes-web/index?search=${q}`,
  ];
  const attempts = [];
  for (const url of urls) {
    try {
      const html = await fetchText(url);
      const $ = cheerio.load(html);
      const text = normalizeText($.text());
      const extracted = extractFixFromText(text, issuer, bond.classKeywords || []);
      attempts.push({ url, ...extracted });
      if (extracted.rating && extracted.issuerHit) {
        return {
          ok: true,
          url,
          patch: {
            rating: extracted.rating,
            ratingAgency: "FIX",
            ratingOutlook: extracted.outlook || bond.ratingOutlook || "",
            ratingUpdatedAt: nowIso(),
            ratingSource: url,
          },
          confidence: extracted.keywordHit ? "media" : "baja",
          attempts,
        };
      }
    } catch (e) {
      attempts.push({ url, error: e.message });
    }
  }
  return { ok: false, message: "No se detectó rating FIX de forma automática", attempts };
}

async function syncOne(symbol, mode = "both") {
  const bonds = await loadBonds();
  const idx = bonds.findIndex((b) => normalizeSymbol(b.symbol) === normalizeSymbol(symbol));
  if (idx < 0) return { ok: false, message: "Bono no encontrado en base técnica" };
  const bond = bonds[idx];
  const reports = {};
  let patch = {};
  if (mode === "cnv" || mode === "both") {
    const cnv = await syncCnvForBond(bond);
    reports.cnv = cnv;
    if (cnv.ok && cnv.patch) patch = { ...patch, ...cnv.patch, sourceStatus: `CNV ${cnv.confidence}`, technicalUpdatedAt: nowIso(), technicalSource: cnv.bestDocument?.url || cnv.url };
  }
  if (mode === "fix" || mode === "both") {
    const fix = await syncFixForBond(bond);
    reports.fix = fix;
    if (fix.ok && fix.patch) patch = { ...patch, ...fix.patch };
  }
  if (Object.keys(patch).length) {
    bonds[idx] = { ...bond, ...patch };
    await saveBonds(bonds);
  }
  return { ok: true, symbol: bond.symbol, patch, reports };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, asOf: nowIso(), service: "bonos-rotacion-cloud-v5" });
});

app.get("/api/bonds", async (_req, res) => {
  try {
    res.json({ ok: true, bonds: await loadBonds() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/bonds", async (req, res) => {
  try {
    if (!Array.isArray(req.body?.bonds)) return res.status(400).json({ ok: false, error: "Enviar { bonds: [...] }" });
    await saveBonds(req.body.bonds);
    res.json({ ok: true, count: req.body.bonds.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/prices", async (_req, res) => {
  try {
    res.json(await getPrices());
  } catch (e) {
    res.status(500).json({ ok: false, asOf: nowIso(), error: e.message });
  }
});

app.post("/api/sync/:mode", async (req, res) => {
  try {
    const mode = req.params.mode;
    if (!["cnv", "fix", "both"].includes(mode)) return res.status(400).json({ ok: false, error: "Modo inválido" });
    const symbol = req.body?.symbol;
    if (symbol) return res.json(await syncOne(symbol, mode));
    const bonds = await loadBonds();
    const results = [];
    for (const b of bonds) {
      results.push(await syncOne(b.symbol, mode));
    }
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (process.env.AUTO_SYNC_FIX === "true") {
  cron.schedule("0 */6 * * *", async () => {
    try {
      const bonds = await loadBonds();
      for (const b of bonds) await syncOne(b.symbol, "fix");
      console.log(`[${nowIso()}] FIX sync OK`);
    } catch (e) {
      console.error(`[${nowIso()}] FIX sync error`, e.message);
    }
  });
}

if (process.env.AUTO_SYNC_CNV === "true") {
  cron.schedule("15 3 * * *", async () => {
    try {
      const bonds = await loadBonds();
      for (const b of bonds) await syncOne(b.symbol, "cnv");
      console.log(`[${nowIso()}] CNV sync OK`);
    } catch (e) {
      console.error(`[${nowIso()}] CNV sync error`, e.message);
    }
  });
}

if (!fsSync.existsSync(BONDS_PATH)) {
  console.warn(`No existe ${BONDS_PATH}. Crear data/bonds.json antes de iniciar.`);
}

app.listen(PORT, () => {
  console.log(`Dashboard escuchando en puerto ${PORT}`);
});
