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

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const cache = { prices: { ts: 0, data: null }, bonds: { ts: 0, data: null } };
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
  if (!tech) return ["Falta ficha técnica"];
  const p = [];
  if (!tech.issuer && !tech.shortIssuer) p.push("Falta emisor");
  if (tech.coupon === undefined || tech.coupon === null || tech.coupon === "") p.push("Falta cupón");
  if (!tech.maturity) p.push("Falta vencimiento");
  if (!tech.frequency) p.push("Falta frecuencia");
  if (!Array.isArray(tech.amortization) || !tech.amortization.length) p.push("Falta amortización");
  if (!tech.rating) p.push("Falta rating");
  return p;
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
    const problems = technicalProblems(tech);
    out.push({
      symbol: displaySymbol, base, canonicalSymbol: tech?.symbol || null, aliases: tech ? symbolAliasesOf(tech) : [],
      hasTechnical: !!tech, technicalProblems: problems,
      issuer: tech?.shortIssuer || tech?.issuer || "—", sector: tech?.sector || "—",
      priceArs: prices.priceArs, bidArs: prices.bidArs, askArs: prices.askArs, symbolArs: prices.symbolArs,
      priceUsdMep: prices.priceUsdMep, bidUsdMep: prices.bidUsdMep, askUsdMep: prices.askUsdMep, lastUsdMep: prices.lastUsdMep,
      priceCable: prices.priceCable, bidCable: prices.bidCable, askCable: prices.askCable, symbolCable: prices.symbolCable,
      priceUsd: prices.priceUsdMep, bidUsd: prices.bidUsdMep, askUsd: prices.askUsdMep,
      volume: prices.volume, qBid: prices.qBid, qAsk: prices.qAsk, qOp: prices.qOp,
      spread: spreadPct(prices.bidUsdMep, prices.askUsdMep), priceSource: prices.source, mepUsed: prices.source?.includes("ARS") ? mep : null,
      maturity: tech?.maturity || null, coupon: tech?.coupon ?? null, couponMonths: tech?.couponMonths || null, frequency: tech?.frequency ?? null,
      amortizationType: tech?.amortizationType || (tech?.amortization?.length === 1 ? "Bullet" : "Amortizable"), amortizationApprox: !!tech?.amortizationApprox,
      dollar: tech?.dollar || null, law: tech?.law || null, rating: tech?.rating || null, ratingAgency: tech?.ratingAgency || null, minLot: tech?.minLot ?? null,
      sourceStatus: tech?.sourceStatus || (tech ? "manual" : "sin ficha técnica"), validationStatus: problems.length ? problems.join("; ") : "OK",
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
  const url = `https://www.fixscr.com/calificaciones?search=${encodeURIComponent(issuer)}`;
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);
    const text = $.text();
    const rating = extractRatingFromFixText(text);
    if (!rating) return { ok: false, message: "No se detectó rating FIX", url };
    return { ok: true, patch: { rating, ratingAgency: "FIX", ratingUpdatedAt: nowIso(), ratingSource: url }, url };
  } catch (e) { return { ok: false, message: e.message, url }; }
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

app.get("/api/health", (_req, res) => res.json({ ok: true, asOf: nowIso(), service: "bonos-rotacion-cloud-v5.4" }));
app.get("/api/bonds", async (_req, res) => { try { res.json({ ok: true, bonds: await loadBonds() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
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
