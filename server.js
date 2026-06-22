import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 8000;
const DATA912_BASE_URL = process.env.DATA912_BASE_URL || "https://data912.com";
const DATA_DIR = path.join(__dirname, "data");
const BONDS_PATH = path.join(DATA_DIR, "bonds.json");
const ISSUER_METRICS_PATH = path.join(DATA_DIR, "issuer_metrics.json");
const ISSUER_SOURCES_PATH = path.join(DATA_DIR, "issuer_sources.json");

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const cache = { prices: { ts: 0, data: null }, bonds: { ts: 0, data: null }, issuerMetrics: { ts: 0, data: null }, issuerSources: { ts: 0, data: null }, fixRatings: { ts: 0, data: new Map() } };
const MAX_REASONABLE_USD_BOND_PRICE = 500;
const USD_DIRECT_MIN_DEPTH = Number(process.env.USD_DIRECT_MIN_DEPTH || 1);

function nowIso() { return new Date().toISOString(); }
function normalizeSymbol(symbol) { return String(symbol || "").trim().toUpperCase(); }
function normalizeText(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
function cleanNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (!raw) return null;
  let s = raw.replace(/\s/g, "");
  // Soporta 1.234,56 y 1234.56
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(/,/g, ".");
  else s = s.replace(/,/g, ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function parseDate(dateString) {
  if (!dateString) return null;
  const d = new Date(`${dateString}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtDateKey(date) { return date.toISOString().slice(0, 10); }
function addMonths(date, months) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d;
}
function yearFracActual365(start, end) { return Math.max(0, (end - start) / (365 * 24 * 60 * 60 * 1000)); }
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
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      headers: { "user-agent": "Mozilla/5.0 DashboardBonos/5.4", accept: "application/json,text/html,*/*", ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res;
  } finally { clearTimeout(timeout); }
}
async function fetchJson(url) { const res = await fetchWithTimeout(url); return res.json(); }
async function fetchText(url) { const res = await fetchWithTimeout(url); return res.text(); }

const ACCEPTED_METRIC_SOURCES = new Set(["FIX", "CNV_EEFF", "FIX_CNV", "MANUAL_VERIFIED"]);
function metricNumber(value) {
  const n = cleanNumber(value);
  return n === null || Number.isNaN(n) ? null : n;
}
function isVerifiedMetricSource(metric) {
  return ACCEPTED_METRIC_SOURCES.has(String(metric?.sourceType || "").toUpperCase());
}
function scoreLowerBetter(value, excellent, weak) {
  const n = metricNumber(value);
  if (n === null) return null;
  if (n <= excellent) return 10;
  if (n >= weak) return 0;
  return Math.max(0, Math.min(10, 10 * (weak - n) / (weak - excellent)));
}
function scoreHigherBetter(value, weak, excellent) {
  const n = metricNumber(value);
  if (n === null) return null;
  if (n >= excellent) return 10;
  if (n <= weak) return 0;
  return Math.max(0, Math.min(10, 10 * (n - weak) / (excellent - weak)));
}
function weightedAverage(parts) {
  const valid = parts.filter(p => p.score !== null && p.score !== undefined && Number.isFinite(Number(p.score)));
  if (!valid.length) return null;
  const totalW = valid.reduce((a,p) => a + p.weight, 0);
  return valid.reduce((a,p) => a + Number(p.score) * p.weight, 0) / totalW;
}
function computeFundamentalScore(metric) {
  // Metodología inicial 0-10. Solo se calcula con fuentes verificadas FIX/CNV/manual validada.
  // Apalancamiento: menor ND/EBITDA es mejor. Liquidez y cobertura: mayor es mejor.
  return weightedAverage([
    { score: scoreLowerBetter(metric.netDebtEbitda, 0.5, 6.0), weight: 0.50 },
    { score: scoreHigherBetter(metric.cashStDebt, 0.25, 3.0), weight: 0.25 },
    { score: scoreHigherBetter(metric.ebitdaInterest, 1.0, 8.0), weight: 0.25 },
  ]);
}
function normalizeIssuerMetric(metric) {
  if (!isVerifiedMetricSource(metric)) return null;
  const out = { ...metric };
  out.netDebtEbitda = metricNumber(out.netDebtEbitda);
  out.cashStDebt = metricNumber(out.cashStDebt);
  out.ebitdaInterest = metricNumber(out.ebitdaInterest);
  out.scoreFundamentals = metricNumber(out.scoreFundamentals);
  if (out.scoreFundamentals === null) out.scoreFundamentals = computeFundamentalScore(out);
  out.scoreTotal = metricNumber(out.scoreTotal);
  if (out.scoreTotal === null) out.scoreTotal = out.scoreFundamentals;
  out.metricsStatus = "validado";
  out.source = out.source || out.sourceName || out.sourceType;
  return out;
}
async function loadIssuerMetrics() {
  if (cache.issuerMetrics.data && Date.now() - cache.issuerMetrics.ts < 30_000) return cache.issuerMetrics.data;
  try {
    const raw = await fs.readFile(ISSUER_METRICS_PATH, "utf8");
    const data = JSON.parse(raw);
    const metrics = (Array.isArray(data) ? data : []).map(normalizeIssuerMetric).filter(Boolean);
    cache.issuerMetrics = { ts: Date.now(), data: metrics };
    return cache.issuerMetrics.data;
  } catch {
    cache.issuerMetrics = { ts: Date.now(), data: [] };
    return [];
  }
}
function simplifyText(value) {
  return normalizeText(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function findIssuerMetrics(metrics, tech) {
  if (!tech) return null;
  const candidates = [tech.scoreKey, tech.shortIssuer, tech.issuer, tech.symbol, ...(Array.isArray(tech.aliases) ? tech.aliases : [])].filter(Boolean).map(simplifyText);
  for (const m of metrics) {
    const aliases = [m.key, m.issuer, ...(Array.isArray(m.aliases) ? m.aliases : [])].filter(Boolean).map(simplifyText);
    if (aliases.some(a => candidates.includes(a))) return m;
  }
  for (const m of metrics) {
    const aliases = [m.key, m.issuer, ...(Array.isArray(m.aliases) ? m.aliases : [])].filter(Boolean).map(simplifyText);
    if (aliases.some(a => candidates.some(c => c.includes(a) || a.includes(c)))) return m;
  }
  return null;
}
function creditQualityLabel(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return "Sin score";
  const n = Number(score);
  if (n >= 8.5) return "Alta";
  if (n >= 7.0) return "Media/Alta";
  if (n >= 5.0) return "Media";
  if (n >= 3.0) return "Baja/Media";
  return "Baja";
}
function ratingToScore(rating) {
  const r = String(rating || "").toUpperCase().replace(/\s+/g, "");
  const scale = [
    ["AAA(ARG)", 10], ["AA+(ARG)", 9.5], ["AA(ARG)", 9], ["AA-(ARG)", 8.5],
    ["A+(ARG)", 8], ["A(ARG)", 7.5], ["A-(ARG)", 7],
    ["BBB+(ARG)", 6.5], ["BBB(ARG)", 6], ["BBB-(ARG)", 5.5],
    ["BB+(ARG)", 5], ["BB(ARG)", 4.5], ["BB-(ARG)", 4],
    ["B+(ARG)", 3.5], ["B(ARG)", 3], ["B-(ARG)", 2.5],
    ["CCC(ARG)", 2], ["CC(ARG)", 1], ["C(ARG)", 0.5], ["D(ARG)", 0]
  ];
  const hit = scale.find(([k]) => r.includes(k));
  return hit ? hit[1] : null;
}
async function loadIssuerSources() {
  if (cache.issuerSources.data && Date.now() - cache.issuerSources.ts < 60_000) return cache.issuerSources.data;
  try {
    const raw = await fs.readFile(ISSUER_SOURCES_PATH, "utf8");
    const data = JSON.parse(raw);
    cache.issuerSources = { ts: Date.now(), data: Array.isArray(data) ? data : [] };
    return cache.issuerSources.data;
  } catch {
    cache.issuerSources = { ts: Date.now(), data: [] };
    return [];
  }
}
function findIssuerSource(sources, tech) {
  if (!tech) return null;
  const candidates = [tech.scoreKey, tech.shortIssuer, tech.issuer, tech.symbol, ...(Array.isArray(tech.aliases) ? tech.aliases : [])].filter(Boolean).map(simplifyText);
  return sources.find(src => [src.key, src.issuer, src.shortIssuer, ...(Array.isArray(src.aliases) ? src.aliases : [])].filter(Boolean).map(simplifyText).some(a => candidates.some(c => c.includes(a) || a.includes(c)))) || null;
}
function parseFixDate(text) {
  const m = String(text || "").match(/(\d{2})[-\/](ene|feb|mar|abr|may|jun|jul|ago|sept|sep|oct|nov|dic)[-\/](\d{2,4})/i);
  if (!m) return null;
  const months = { ene:"01", feb:"02", mar:"03", abr:"04", may:"05", jun:"06", jul:"07", ago:"08", sept:"09", sep:"09", oct:"10", nov:"11", dic:"12" };
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${months[m[2].toLowerCase()]}-${m[1]}`;
}
function normalizeFixRating(raw) {
  if (!raw) return null;
  let r = String(raw).replace(/\s+/g, "").replace(/arg$/i, "(arg)");
  r = r.replace(/\.ar$/i, "(arg)");
  r = r.replace(/\(ARG\)/i, "(arg)");
  return r;
}
function extractFixRatingFromIssuerPage(html, issuerName = "") {
  const $ = cheerio.load(html);
  const text = normalizeText($.text());
  const issuer = normalizeText($('h1').first().text()) || issuerName;
  const sectorMatch = text.match(/Sector:\s*([^ÁÉÍÓÚáéíóú]*?)(?:Área:|País:)/i);
  const ratingRegex = /Calificaci[oó]n Nacional.*?Fecha\s*(\d{2}[-\/][A-Za-záéíóúñ]+[-\/]\d{2,4}).*?Plazo\s*Largo Plazo.*?Rating\s*((?:AAA|AA|A|BBB|BB|B|CCC|CC|C|D)(?:[+-])?\s*(?:\(arg\)|arg|\.ar)).*?Perspectiva\s*(Perspectiva\s+[A-Za-zÁÉÍÓÚáéíóúñ]+|N\.?C|Estable|Positiva|Negativa|En evolucion)?/i;
  let m = text.match(ratingRegex);
  if (!m) {
    const fallback = text.match(/Largo Plazo\s*Rating\s*((?:AAA|AA|A|BBB|BB|B|CCC|CC|C|D)(?:[+-])?\s*(?:\(arg\)|arg|\.ar)).*?Perspectiva\s*(Perspectiva\s+[A-Za-zÁÉÍÓÚáéíóúñ]+|N\.?C|Estable|Positiva|Negativa|En evolucion)?/i);
    if (fallback) m = [fallback[0], null, fallback[1], fallback[2]];
  }
  if (!m) return null;
  const rating = normalizeFixRating(m[2]);
  return {
    issuer,
    sector: sectorMatch ? normalizeText(sectorMatch[1]) : null,
    rating,
    outlook: normalizeText(m[3] || ""),
    asOf: m[1] ? parseFixDate(m[1]) : null,
    ratingScore: ratingToScore(rating),
  };
}
function extractFixRatingFromListPage(html, issuerName = "") {
  const $ = cheerio.load(html);
  const text = normalizeText($.text());
  const ratingPattern = /([A-ZÁÉÍÓÚÑa-záéíóúñ0-9 .,&-]{3,80}?S\.?A\.?[A-ZÁÉÍÓÚÑa-záéíóúñ0-9 .,&-]*)\s+(\d{4}-\d{2}-\d{2})\s+Argentina\s+Finanzas Corporativas.*?Emisor\s+((?:AAA|AA|A|BBB|BB|B|CCC|CC|C|D)(?:[+-])?\s*(?:\(arg\)|arg|\.ar))\s+(Perspectiva\s+[A-Za-zÁÉÍÓÚáéíóúñ]+|N\.?C)?/i;
  const m = text.match(ratingPattern);
  if (!m) {
    const r = text.match(/Emisor\s+((?:AAA|AA|A|BBB|BB|B|CCC|CC|C|D)(?:[+-])?\s*(?:\(arg\)|arg|\.ar))\s+(Perspectiva\s+[A-Za-zÁÉÍÓÚáéíóúñ]+|N\.?C)?/i);
    if (!r) return null;
    const rating = normalizeFixRating(r[1]);
    return { issuer: issuerName, rating, outlook: normalizeText(r[2] || ""), asOf: null, ratingScore: ratingToScore(rating) };
  }
  const rating = normalizeFixRating(m[3]);
  return { issuer: normalizeText(m[1]) || issuerName, rating, outlook: normalizeText(m[4] || ""), asOf: m[2], ratingScore: ratingToScore(rating) };
}
async function fetchFixRatingForTech(tech, sources = []) {
  const issuer = tech?.issuer || tech?.shortIssuer;
  if (!issuer) return null;
  const key = simplifyText(tech.scoreKey || issuer);
  const cached = cache.fixRatings.data.get(key);
  if (cached && Date.now() - cached.ts < 6 * 60 * 60 * 1000) return cached.data;
  const source = findIssuerSource(sources, tech);
  const urls = [];
  if (source?.fixUrl) urls.push(source.fixUrl);
  if (source?.fixIssuerId) urls.push(`https://www.fixscr.com/emisor/view?id=${source.fixIssuerId}&type=emisor`);
  urls.push(`https://www.fixscr.com/calificaciones?CalificacionesWebSearch%5Bentidades_name%5D=${encodeURIComponent(issuer)}&CalificacionesWebSearch%5Bsection_id%5D=1&CalificacionesWebSearch%5Btype%5D=1&dp-1-per-page=20&sort=-national_rating_date`);
  for (const url of [...new Set(urls)]) {
    try {
      const html = await fetchText(url);
      const data = url.includes('/emisor/view') ? extractFixRatingFromIssuerPage(html, issuer) : extractFixRatingFromListPage(html, issuer);
      if (data?.rating) {
        const out = { ...data, sourceType: 'FIX', source: url, fetchedAt: nowIso() };
        cache.fixRatings.data.set(key, { ts: Date.now(), data: out });
        return out;
      }
    } catch (e) { /* probar siguiente fuente */ }
  }
  const out = null;
  cache.fixRatings.data.set(key, { ts: Date.now(), data: out });
  return out;
}
async function loadFixRatingsForBonds(bonds) {
  if (process.env.AUTO_FIX_RATINGS === '0') return new Map();
  const sources = await loadIssuerSources();
  const unique = [];
  const seen = new Set();
  for (const b of bonds) {
    const key = simplifyText(b.scoreKey || b.issuer || b.shortIssuer || b.symbol);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(b);
  }
  const map = new Map();
  const limit = Number(process.env.FIX_RATING_CONCURRENCY || 4);
  let idx = 0;
  async function worker() {
    while (idx < unique.length) {
      const b = unique[idx++];
      const key = simplifyText(b.scoreKey || b.issuer || b.shortIssuer || b.symbol);
      const r = await fetchFixRatingForTech(b, sources);
      if (r) map.set(key, r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, unique.length) }, worker));
  return map;
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
function baseSymbol(symbol) {
  const s = normalizeSymbol(symbol);
  if (!s) return "";
  if (/[OCDP]$/.test(s)) return s.slice(0, -1);
  return s;
}
function symbolAliasesOf(bond) {
  const vals = [bond?.symbol, ...(Array.isArray(bond?.aliases) ? bond.aliases : [])];
  const out = new Set();
  for (const v of vals) {
    const s = normalizeSymbol(v);
    if (!s) continue;
    out.add(s);
    const b = baseSymbol(s);
    if (b) { out.add(b); out.add(`${b}O`); out.add(`${b}D`); out.add(`${b}C`); }
  }
  return [...out];
}
function findBondIndexBySymbol(bonds, symbol, base = null) {
  const s = normalizeSymbol(symbol);
  const b = normalizeSymbol(base || baseSymbol(s));
  for (let i = 0; i < bonds.length; i++) if (symbolAliasesOf(bonds[i]).includes(s)) return i;
  for (let i = 0; i < bonds.length; i++) if (symbolAliasesOf(bonds[i]).some(a => baseSymbol(a) === b)) return i;
  return -1;
}
function findBondTech(bonds, symbol, base = null) {
  const idx = findBondIndexBySymbol(bonds, symbol, base);
  return idx >= 0 ? bonds[idx] : null;
}
function technicalProblems(tech) {
  // Problemas que impiden o degradan cálculos de TIR/duration/paridad.
  if (!tech) return ["Falta ficha técnica"];
  const p = [];
  if (!tech.issuer && !tech.shortIssuer) p.push("Falta emisor");
  if (tech.coupon === undefined || tech.coupon === null || tech.coupon === "") p.push("Falta cupón");
  if (!tech.maturity) p.push("Falta vencimiento");
  if (!tech.frequency) p.push("Falta frecuencia");
  if (!Array.isArray(tech.amortization) || !tech.amortization.length) p.push("Falta amortización");
  return p;
}
const ACCEPTED_TECH_SOURCES = new Set(["CNV", "PROSPECTO_CNV", "AVISO_RESULTADO_CNV", "FIX", "MANUAL_VERIFIED", "USER_VERIFIED"]);
function sourceStatusOf(tech, field) {
  const src = tech?.fieldSources?.[field] || {};
  return String(src.status || tech?.[`${field}ValidationStatus`] || "").toLowerCase();
}
function sourceNameOf(tech, field) {
  const src = tech?.fieldSources?.[field] || {};
  return src.source || tech?.[`${field}Source`] || tech?.sourceStatus || "—";
}
function isFieldVerified(tech, field) {
  const src = tech?.fieldSources?.[field] || {};
  const status = String(src.status || tech?.[`${field}ValidationStatus`] || "").toLowerCase();
  const type = String(src.sourceType || tech?.[`${field}SourceType`] || "").toUpperCase();
  return status.includes("valid") || status.includes("verific") || ACCEPTED_TECH_SOURCES.has(type);
}
function ratingStatus(tech) {
  if (!tech) return { status: "Sin ficha", label: "Pendiente", source: "Sin ficha técnica" };
  if (tech.rating && isFieldVerified(tech, "rating")) return { status: "validado", label: tech.rating, source: sourceNameOf(tech, "rating") };
  return { status: "pendiente", label: "Pendiente", source: "Pendiente FIX/CNV" };
}
function validationWarnings(tech) {
  if (!tech) return ["Sin ficha técnica"];
  const w = [];
  if (!isFieldVerified(tech, "coupon")) w.push("Cupón pendiente CNV");
  if (!isFieldVerified(tech, "maturity")) w.push("Vencimiento pendiente CNV");
  if (!isFieldVerified(tech, "amortization")) w.push("Amortización pendiente CNV");
  if (!isFieldVerified(tech, "law")) w.push("Ley pendiente CNV");
  if (!isFieldVerified(tech, "rating")) w.push("Rating pendiente FIX/CNV");
  if (tech.amortizationApprox) w.push("Amortización aproximada");
  return w;
}
function validationBadge(tech, problems) {
  if (!tech) return "Sin ficha";
  if (problems?.length) return "Ficha incompleta";
  const warnings = validationWarnings(tech);
  if (warnings.length) return "Pendiente CNV/FIX";
  return "Validado";
}

function normalizeMarketRow(row) {
  const symbol = normalizeSymbol(row.symbol || row.ticker || row.s || row.descripcion || row.nombre);
  const last = cleanNumber(row.c ?? row.close ?? row.last ?? row.price ?? row.px_last ?? row.ultimo);
  const bid = cleanNumber(row.px_bid ?? row.bid ?? row.compra ?? row.bid_price);
  const ask = cleanNumber(row.px_ask ?? row.ask ?? row.venta ?? row.ask_price);
  const volume = cleanNumber(row.v ?? row.volume ?? row.volumen);
  const qBid = cleanNumber(row.q_bid ?? row.bid_size ?? row.cantidad_compra);
  const qAsk = cleanNumber(row.q_ask ?? row.ask_size ?? row.cantidad_venta);
  const qOp = cleanNumber(row.q_op ?? row.trades ?? row.operaciones);
  const pctChange = cleanNumber(row.pct_change ?? row.change_percent ?? row.var_pct);
  return { raw: row, symbol, base: baseSymbol(symbol), last, bid, ask, volume, qBid, qAsk, qOp, pctChange };
}
function representativePrice(row) {
  if (!row) return null;
  if (row.bid && row.ask) return (row.bid + row.ask) / 2;
  return row.last || row.bid || row.ask || null;
}
function isLikelyArs(row) { const p = representativePrice(row); return p !== null && p > MAX_REASONABLE_USD_BOND_PRICE; }
function scaleUsdPrice(n) {
  const v = cleanNumber(n);
  if (!v || v <= 0) return null;
  // Algunas fuentes muestran 1,105 en vez de 110,50 por 100 VN.
  if (v > 0 && v < 10) return v * 100;
  return v;
}
function rowDepth(row) { return (row?.qBid || 0) + (row?.qAsk || 0) + (row?.qOp || 0) + ((row?.volume || 0) > 0 ? 1 : 0); }
function normalizeUsdDirectRow(row) {
  if (!row) return null;
  return {
    last: scaleUsdPrice(row.last),
    bid: scaleUsdPrice(row.bid),
    ask: scaleUsdPrice(row.ask),
    symbol: row.symbol,
    depth: rowDepth(row),
    volume: row.volume,
    qBid: row.qBid,
    qAsk: row.qAsk,
    qOp: row.qOp,
    pctChange: row.pctChange,
  };
}
function convertArsRowToUsd(row, mep) {
  if (!row || !mep || mep <= 0) return null;
  const div = (x) => { const n = cleanNumber(x); return n && n > 0 ? n / mep : null; };
  return {
    last: div(row.last), bid: div(row.bid), ask: div(row.ask), symbol: row.symbol,
    depth: rowDepth(row), volume: row.volume, qBid: row.qBid, qAsk: row.qAsk, qOp: row.qOp, pctChange: row.pctChange,
  };
}
function extractMepValue(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [payload];
  const preferred = [];
  const all = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const text = JSON.stringify(r).toLowerCase();
    for (const key of ["mark", "close", "c", "last", "price", "px", "mep", "value", "ask", "bid"]) {
      const value = cleanNumber(r[key]);
      if (value && value > 500 && value < 10000) {
        all.push(value);
        if (/mep|al30|gd30/.test(text)) preferred.push(value);
      }
    }
  }
  const arr = preferred.length ? preferred : all;
  if (!arr.length) return null;
  arr.sort((a, b) => a - b);
  return arr[Math.floor(arr.length / 2)];
}
function selectPricesForGroup(groupRows, mep) {
  const arsRows = [];
  const mepRows = [];
  const cableRows = [];
  for (const r of groupRows) {
    const p = representativePrice(r);
    if (!p) continue;
    const s = normalizeSymbol(r.symbol);
    if (isLikelyArs(r)) arsRows.push(r);
    else if (/C$/.test(s)) cableRows.push(r);
    else mepRows.push(r);
  }
  const pickBest = (rows) => rows.slice().sort((a,b) => rowDepth(b)-rowDepth(a))[0] || null;
  const directMep = normalizeUsdDirectRow(pickBest(mepRows));
  const cable = normalizeUsdDirectRow(pickBest(cableRows));
  const ars = pickBest(arsRows);
  const converted = convertArsRowToUsd(ars, mep);
  const useDirect = directMep && directMep.depth >= USD_DIRECT_MIN_DEPTH;
  let selected = useDirect ? directMep : (converted || directMep || null);
  let source = useDirect ? `USD MEP directo (${directMep.symbol})` : "—";
  if (!useDirect && converted) source = directMep ? `ARS/MEP por baja liquidez USD (${ars.symbol})` : `ARS/MEP (${ars.symbol})`;
  if (!selected && cable) { selected = cable; source = `Cable directo (${cable.symbol})`; }
  const mid = (x) => x ? (x.bid && x.ask ? (x.bid + x.ask) / 2 : (x.last || x.bid || x.ask || null)) : null;
  return {
    selected, source,
    priceUsdMep: mid(selected), bidUsdMep: selected?.bid || null, askUsdMep: selected?.ask || null, lastUsdMep: selected?.last || null,
    priceArs: representativePrice(ars), bidArs: ars?.bid || null, askArs: ars?.ask || null, symbolArs: ars?.symbol || null,
    priceCable: mid(cable), bidCable: cable?.bid || null, askCable: cable?.ask || null, symbolCable: cable?.symbol || null,
    directMepSymbol: directMep?.symbol || null, selectedSymbol: selected?.symbol || null,
    volume: selected?.volume || ars?.volume || cable?.volume || null,
    qBid: selected?.qBid ?? null, qAsk: selected?.qAsk ?? null, qOp: selected?.qOp ?? null,
  };
}

function couponSchedule(tech, today = new Date()) {
  const maturity = parseDate(tech?.maturity);
  if (!maturity || !tech.frequency) return [];
  const interval = Math.max(1, Math.round(12 / Number(tech.frequency)));
  const dates = [];
  let d = maturity;
  let guard = 0;
  while (d > addMonths(today, -60) && guard < 240) { dates.push(d); d = addMonths(d, -interval); guard += 1; }
  return dates.sort((a, b) => a - b);
}
function getOutstandingBefore(tech, date) {
  const amorts = Array.isArray(tech?.amortization) ? tech.amortization : [];
  let outstanding = 100;
  for (const a of amorts) { const ad = parseDate(a.date); if (ad && ad < date) outstanding -= 100 * Number(a.percent || 0); }
  return Math.max(0, outstanding);
}
function getPrincipalOnDate(tech, date) {
  const key = fmtDateKey(date);
  const amorts = Array.isArray(tech?.amortization) ? tech.amortization : [];
  return amorts.filter(a => a.date === key).reduce((acc, a) => acc + 100 * Number(a.percent || 0), 0);
}
function buildCashflows(tech, today = new Date()) {
  if (!tech || tech.coupon === undefined || !tech.maturity || !tech.frequency) return [];
  return couponSchedule(tech, today).filter(d => d > today).map(d => {
    const outstanding = getOutstandingBefore(tech, d);
    const interest = outstanding * Number(tech.coupon) / Number(tech.frequency);
    const principal = getPrincipalOnDate(tech, d);
    return { date: fmtDateKey(d), t: yearFracActual365(today, d), interest, principal, cf: interest + principal };
  }).filter(f => f.cf > 0);
}
function accruedInterest(tech, today = new Date()) {
  if (!tech || tech.coupon === undefined || !tech.frequency || !tech.maturity) return 0;
  const schedule = couponSchedule(tech, today);
  const future = schedule.find(d => d > today);
  if (!future) return 0;
  const interval = Math.max(1, Math.round(12 / Number(tech.frequency)));
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
  let lo = -0.95, hi = 3.0, fLo = pv(lo), fHi = pv(hi);
  for (let tries = 0; tries < 12 && fLo * fHi > 0; tries++) { hi *= 1.8; fHi = pv(hi); }
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2, fMid = pv(mid);
    if (Math.abs(fMid) < 1e-8) return mid;
    if (fLo * fMid <= 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}
function calcMetrics(tech, cleanPrice, today = new Date()) {
  if (!tech || !cleanPrice || cleanPrice <= 0 || !tech.maturity || tech.coupon === undefined || !tech.frequency) {
    return { tir: null, durationMod: null, accrued: null, dirtyPrice: null, technicalValue: null, residualValue: null, parity: null, flows12: null, flows24: null, cashflows: [] };
  }
  const clean = Number(cleanPrice);
  const residualValue = getOutstandingBefore(tech, today);
  const accrued = accruedInterest(tech, today);
  const dirty = clean + accrued;
  const technicalValue = residualValue + accrued;
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
  const flows12 = cashflows.filter(f => f.t <= 1).reduce((a, f) => a + f.cf, 0);
  const flows24 = cashflows.filter(f => f.t <= 2).reduce((a, f) => a + f.cf, 0);
  const parity = technicalValue > 0 ? dirty / technicalValue : null;
  return { tir: y, durationMod, accrued, dirtyPrice: dirty, technicalValue, residualValue, parity, flows12, flows24, cashflows };
}
function spreadPct(bid, ask) { if (!bid || !ask || bid <= 0 || ask <= 0) return null; const mid = (bid + ask) / 2; return (ask - bid) / mid; }

async function getPrices() {
  if (cache.prices.data && Date.now() - cache.prices.ts < 15_000) return cache.prices.data;
  const errors = [];
  let corpPayload, mepPayload;
  try { corpPayload = await fetchJson(`${DATA912_BASE_URL}/live/arg_corp`); } catch (e) { errors.push(`Data912 arg_corp: ${e.message}`); }
  try { mepPayload = await fetchJson(`${DATA912_BASE_URL}/live/mep`); } catch (e) { errors.push(`Data912 mep: ${e.message}`); }
  const mep = mepPayload ? extractMepValue(mepPayload) : null;
  const corpRowsRaw = Array.isArray(corpPayload) ? corpPayload : Array.isArray(corpPayload?.data) ? corpPayload.data : [];
  const rawRows = corpRowsRaw.map(normalizeMarketRow).filter(r => r.symbol);
  const groupMap = new Map();
  for (const r of rawRows) {
    if (!groupMap.has(r.base)) groupMap.set(r.base, []);
    groupMap.get(r.base).push(r);
  }
  const bonds = await loadBonds();
  const issuerMetrics = await loadIssuerMetrics();
  const fixRatings = await loadFixRatingsForBonds(bonds);
  const today = new Date();
  const basesFromBonds = new Set();
  for (const b of bonds) for (const a of symbolAliasesOf(b)) basesFromBonds.add(baseSymbol(a));
  const bases = new Set([...groupMap.keys(), ...basesFromBonds]);
  const out = [];
  for (const base of bases) {
    const groupRows = groupMap.get(base) || [];
    const firstSym = groupRows[0]?.symbol || `${base}O`;
    const tech = findBondTech(bonds, firstSym, base);
    if (!groupRows.length && !tech) continue;
    const prices = selectPricesForGroup(groupRows, mep);
    const displaySymbol = tech?.symbol || prices.selectedSymbol || firstSym;
    const price = prices.priceUsdMep;
    const metrics = tech ? calcMetrics(tech, price, today) : calcMetrics(null, null, today);
    const credit = findIssuerMetrics(issuerMetrics, tech);
    const problems = technicalProblems(tech);
    const warnings = validationWarnings(tech);
    const rStatus = ratingStatus(tech);
    const fixRating = tech ? fixRatings.get(simplifyText(tech.scoreKey || tech.issuer || tech.shortIssuer || tech.symbol)) : null;
    const effectiveRating = rStatus.status === "validado" ? { rating: tech?.rating, agency: tech?.ratingAgency || "FIX", source: rStatus.source, status: "validado", outlook: tech?.ratingOutlook || null, ratingScore: ratingToScore(tech?.rating) } : (fixRating ? { rating: fixRating.rating, agency: "FIX", source: fixRating.source, status: "validado", outlook: fixRating.outlook, ratingScore: fixRating.ratingScore } : { rating: null, agency: null, source: rStatus.source, status: rStatus.status, outlook: null, ratingScore: null });
    const validation = validationBadge(tech, problems);
    out.push({
      symbol: displaySymbol, base, canonicalSymbol: tech?.symbol || null, aliases: tech ? symbolAliasesOf(tech) : [],
      hasTechnical: !!tech, technicalProblems: problems, validationWarnings: warnings, validationBadge: validation,
      issuer: tech?.shortIssuer || tech?.issuer || "—", sector: tech?.sector || "—",
      priceArs: prices.priceArs, bidArs: prices.bidArs, askArs: prices.askArs, symbolArs: prices.symbolArs,
      priceUsdMep: prices.priceUsdMep, bidUsdMep: prices.bidUsdMep, askUsdMep: prices.askUsdMep, lastUsdMep: prices.lastUsdMep,
      priceCable: prices.priceCable, bidCable: prices.bidCable, askCable: prices.askCable, symbolCable: prices.symbolCable,
      priceUsd: prices.priceUsdMep, bidUsd: prices.bidUsdMep, askUsd: prices.askUsdMep,
      volume: prices.volume, qBid: prices.qBid, qAsk: prices.qAsk, qOp: prices.qOp,
      spread: spreadPct(prices.bidUsdMep, prices.askUsdMep), priceSource: prices.source, mepUsed: prices.source?.includes("ARS") ? mep : null,
      maturity: tech?.maturity || null, coupon: tech?.coupon ?? null, couponMonths: tech?.couponMonths || null, frequency: tech?.frequency ?? null,
      amortizationType: tech?.amortizationType || (tech?.amortization?.length === 1 ? "Bullet" : "Amortizable"), amortizationApprox: !!tech?.amortizationApprox,
      dollar: tech?.dollar || null, law: tech?.law || null, lawValidationStatus: sourceStatusOf(tech, "law") || null, lawSource: sourceNameOf(tech, "law"),
      rating: effectiveRating.rating, ratingDisplay: effectiveRating.rating || "Pendiente", ratingAgency: effectiveRating.agency, ratingValidationStatus: effectiveRating.status, ratingSource: effectiveRating.source, ratingOutlook: effectiveRating.outlook, ratingScore: effectiveRating.ratingScore, legacySeedRating: tech?.legacySeedRating || null, minLot: tech?.minLot ?? null,
      creditKey: credit?.key || null, creditView: credit?.view || (effectiveRating.ratingScore !== null ? creditQualityLabel(effectiveRating.ratingScore) : null), creditViewScore: credit?.viewScore ?? null,
      scoreFundamentals: credit?.scoreFundamentals ?? null, scoreQualitative: credit?.scoreQualitative ?? null, scoreTotal: credit?.scoreTotal ?? effectiveRating.ratingScore ?? null, scoreChangeYoY: credit?.scoreChangeYoY ?? null, creditQuality: creditQualityLabel(credit?.scoreTotal ?? effectiveRating.ratingScore),
      netDebtEbitda: credit?.netDebtEbitda ?? null, netDebtEbitdaChangeYoY: credit?.netDebtEbitdaChangeYoY ?? null, cashStDebt: credit?.cashStDebt ?? null, cashStDebtChangeYoY: credit?.cashStDebtChangeYoY ?? null, ebitdaInterest: credit?.ebitdaInterest ?? null, ebitdaInterestChangeYoY: credit?.ebitdaInterestChangeYoY ?? null,
      creditMetricsAsOf: credit?.asOf || fixRating?.asOf || null, creditMetricsSource: credit?.source || (fixRating ? `${fixRating.source} (rating FIX; métricas financieras pendientes)` : null), creditMetricsSourceType: credit?.sourceType || (fixRating ? "FIX_RATING_ONLY" : null), creditMetricsStatus: credit ? "validado" : (fixRating ? "rating FIX validado; métricas financieras pendientes" : "pendiente FIX/CNV"), tirPerScore: metrics.tir && (credit?.scoreTotal || effectiveRating.ratingScore) ? metrics.tir / (credit?.scoreTotal || effectiveRating.ratingScore) : null,
      sourceStatus: tech?.sourceStatus || (tech ? "manual" : "sin ficha técnica"), dataQuality: tech?.dataQuality || null, technicalValidationStatus: tech?.technicalValidationStatus || null, technicalSource: tech?.technicalSource || tech?.sourceStatus || null,
      validationStatus: problems.length ? problems.join("; ") : (warnings.length ? warnings.join("; ") : "OK"),
      tir: metrics.tir, durationMod: metrics.durationMod, accrued: metrics.accrued, dirtyPrice: metrics.dirtyPrice,
      technicalValue: metrics.technicalValue, residualValue: metrics.residualValue, parity: metrics.parity,
      flows12: metrics.flows12, flows24: metrics.flows24, cashflows: metrics.cashflows?.slice(0, 12) || [],
    });
  }
  out.sort((a,b) => (a.issuer === "—" ? 1 : 0) - (b.issuer === "—" ? 1 : 0) || a.symbol.localeCompare(b.symbol));
  const missingTechnical = out.filter(r => !r.hasTechnical || r.technicalProblems?.length).map(r => ({ symbol: r.symbol, base: r.base, issuer: r.issuer, priceUsd: r.priceUsdMep, problems: r.technicalProblems || [], suggestion: !r.hasTechnical ? "Crear ficha o agregar alias" : "Completar campos faltantes" }));
  const payload = { ok: true, asOf: nowIso(), mep, rows: out, missingTechnical, errors };
  cache.prices = { ts: Date.now(), data: payload };
  return payload;
}

function extractRatingFromFixText(text) {
  const normalized = normalizeText(text);
  const localRatingRegex = /\b(?:AAA|AA|A|BBB|BB|B|CCC|CC|C|D)(?:[+-])?\s*(?:\(arg\)|arg|\.ar)\b/gi;
  const m = normalized.match(localRatingRegex);
  if (!m?.length) return null;
  return m[0].replace(/\s+/g, "").replace(/arg$/i, "(arg)");
}
async function syncFixForBond(bond) {
  const issuer = bond?.issuer || bond?.shortIssuer;
  if (!issuer) return { ok: false, message: "Falta emisor" };
  const sources = await loadIssuerSources();
  try {
    const data = await fetchFixRatingForTech(bond, sources);
    if (!data?.rating) return { ok: false, message: "No se detectó rating FIX", url: data?.source || null };
    return { ok: true, patch: { rating: data.rating, ratingAgency: "FIX", ratingOutlook: data.outlook, ratingScore: data.ratingScore, ratingUpdatedAt: nowIso(), ratingSource: data.source, ratingValidationStatus: "validado", fieldSources: { ...(bond.fieldSources || {}), rating: { status: "validado", sourceType: "FIX", source: data.source, date: data.asOf, note: "Rating extraído desde página pública de FIX. El scoring financiero requiere métricas de FIX/CNV." } } }, url: data.source };
  } catch (e) { return { ok: false, message: e.message }; }
}
async function syncOne(symbol, mode = "fix") {
  const bonds = await loadBonds();
  const idx = findBondIndexBySymbol(bonds, symbol);
  if (idx < 0) return { ok: false, message: "Bono no encontrado" };
  const bond = bonds[idx];
  const reports = {};
  let patch = {};
  if (mode === "fix" || mode === "both") {
    const fix = await syncFixForBond(bond);
    reports.fix = fix;
    if (fix.ok && fix.patch) patch = { ...patch, ...fix.patch };
  }
  // CNV sigue best-effort: se conserva el mapeo por CUIT/clase y se evita pisar datos si no hay match fuerte.
  if (mode === "cnv" || mode === "both") reports.cnv = { ok: false, message: "CNV automático pendiente de validación por formato de prospectos" };
  if (Object.keys(patch).length) { bonds[idx] = { ...bond, ...patch }; await saveBonds(bonds); cache.prices = { ts: 0, data: null }; }
  return { ok: true, symbol: bond.symbol, patch, reports };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, asOf: nowIso(), service: "bonos-rotacion-cloud-v6.0" }));
app.get("/api/bonds", async (_req, res) => { try { res.json({ ok: true, bonds: await loadBonds() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
app.get("/api/issuer-metrics", async (_req, res) => { try { res.json({ ok: true, metrics: await loadIssuerMetrics() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
app.post("/api/bonds", async (req, res) => { try { if (!Array.isArray(req.body?.bonds)) return res.status(400).json({ ok: false, error: "Enviar { bonds: [...] }" }); await saveBonds(req.body.bonds); cache.prices = { ts: 0, data: null }; res.json({ ok: true, count: req.body.bonds.length }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
app.post("/api/bonds/upsert", async (req, res) => {
  try {
    const bond = req.body?.bond;
    if (!bond || !bond.symbol) return res.status(400).json({ ok: false, error: "Enviar { bond: { symbol, ... } }" });
    const bonds = await loadBonds();
    const symbol = normalizeSymbol(bond.symbol);
    const idx = findBondIndexBySymbol(bonds, symbol);
    const aliases = [...new Set([symbol, ...(Array.isArray(bond.aliases) ? bond.aliases : [])].map(normalizeSymbol).filter(Boolean))];
    const cleaned = { ...bond, symbol, aliases, coupon: bond.coupon === "" || bond.coupon === null || bond.coupon === undefined ? undefined : Number(bond.coupon), frequency: bond.frequency === "" || bond.frequency === null || bond.frequency === undefined ? undefined : Number(bond.frequency), minLot: bond.minLot === "" || bond.minLot === null || bond.minLot === undefined ? undefined : Number(bond.minLot), updatedAt: nowIso(), sourceStatus: bond.sourceStatus || "editado-manual" };
    if (!Array.isArray(cleaned.amortization) || !cleaned.amortization.length) if (cleaned.maturity) cleaned.amortization = [{ date: cleaned.maturity, percent: 1 }];
    if (idx >= 0) bonds[idx] = { ...bonds[idx], ...cleaned }; else bonds.push(cleaned);
    await saveBonds(bonds); cache.prices = { ts: 0, data: null };
    res.json({ ok: true, bond: idx >= 0 ? bonds[idx] : bonds[bonds.length - 1], action: idx >= 0 ? "updated" : "created" });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/api/prices", async (_req, res) => { try { res.json(await getPrices()); } catch (e) { res.status(500).json({ ok: false, asOf: nowIso(), error: e.message }); } });
app.post("/api/sync/:mode", async (req, res) => {
  try {
    const mode = req.params.mode;
    if (!["cnv", "fix", "both"].includes(mode)) return res.status(400).json({ ok: false, error: "Modo inválido" });
    const symbol = req.body?.symbol;
    if (symbol) return res.json(await syncOne(symbol, mode));
    const bonds = await loadBonds();
    const results = [];
    for (const b of bonds.slice(0, 60)) results.push(await syncOne(b.symbol, mode));
    res.json({ ok: true, count: results.length, results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Dashboard escuchando en puerto ${PORT}`));
