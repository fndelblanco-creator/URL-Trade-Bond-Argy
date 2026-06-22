let marketData = null;
let bonds = [];
let autoTimer = null;

const $ = (id) => document.getElementById(id);

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("es-AR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return `${(Number(n) * 100).toLocaleString("es-AR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}
function fmtCoupon(n) { return fmtPct(n, 2); }
function normalizeSymbol(symbol) { return String(symbol || "").trim().toUpperCase(); }
function setStatus(type, title, detail = "") {
  const card = $("statusCard");
  card.className = `status-card ${type}`;
  $("statusTitle").textContent = title;
  $("statusTime").textContent = detail || new Date().toLocaleString("es-AR");
}
async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
}
function symbolAliasesOfBond(bond) {
  return Array.from(new Set([bond?.symbol, ...(Array.isArray(bond?.aliases) ? bond.aliases : [])].map(normalizeSymbol).filter(Boolean)));
}
function rowMatchesSymbol(row, symbol) {
  const s = normalizeSymbol(symbol);
  if (!s || !row) return false;
  if (normalizeSymbol(row.symbol) === s) return true;
  if (normalizeSymbol(row.canonicalSymbol) === s) return true;
  if ((row.aliases || []).map(normalizeSymbol).includes(s)) return true;
  return false;
}
function bondMatchesSymbol(bond, symbol) {
  const s = normalizeSymbol(symbol);
  return !!s && symbolAliasesOfBond(bond).includes(s);
}
function getTablePrice(row) {
  const mode = $("priceMode").value;
  if (mode === "bid") return row.bidUsdMep;
  if (mode === "ask") return row.askUsdMep;
  if (mode === "last") return row.lastUsdMep;
  return row.priceUsdMep;
}
function renderTable() {
  const tbody = document.querySelector("#marketTable tbody");
  const q = $("tableSearch").value.trim().toLowerCase();
  const rows = (marketData?.rows || []).filter((r) => {
    const text = `${r.symbol} ${r.issuer} ${r.sector} ${r.rating} ${r.law}`.toLowerCase();
    return !q || text.includes(q);
  });
  tbody.innerHTML = rows.map((r) => {
    const price = getTablePrice(r);
    const badgeClass = r.technicalProblems?.length ? "warn" : "ok";
    const rating = r.rating ? `${r.rating}${r.ratingAgency ? ` ${r.ratingAgency}` : ""}` : "—";
    const amort = `${r.amortizationType || "—"}${r.amortizationApprox ? "*" : ""}`;
    return `<tr title="${r.validationStatus || ""}">
      <td><span class="badge ${badgeClass}">${r.symbol}</span></td>
      <td>${r.issuer || "—"}</td>
      <td>${r.priceArs ? `$ ${fmtNum(r.priceArs, 2)}` : "—"}</td>
      <td>${fmtNum(price, 2)}</td>
      <td>${fmtNum(r.bidUsdMep, 2)}</td>
      <td>${fmtNum(r.askUsdMep, 2)}</td>
      <td>${fmtNum(r.priceCable, 2)}</td>
      <td>${fmtPct(r.tir)}</td>
      <td>${fmtNum(r.durationMod, 2)}</td>
      <td>${r.maturity || "—"}</td>
      <td>${amort}</td>
      <td>${fmtCoupon(r.coupon)}</td>
      <td>${r.couponMonths || "—"}</td>
      <td>${r.dollar || "—"}</td>
      <td>${r.law || "—"}</td>
      <td>${rating}</td>
      <td>${r.minLot ? fmtNum(r.minLot, 0) : "—"}</td>
      <td>${r.sector || "—"}</td>
      <td>${fmtNum(r.technicalValue, 2)}</td>
      <td>${fmtNum(r.residualValue, 2)}</td>
      <td>${fmtPct(r.parity)}</td>
      <td>${fmtPct(r.spread)}</td>
      <td>${r.priceSource || "—"}</td>
    </tr>`;
  }).join("");
}
function renderMissingTechnical() {
  const tbody = document.querySelector("#missingTable tbody");
  if (!tbody) return;
  const rows = marketData?.missingTechnical || [];
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No hay faltantes relevantes.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.slice(0, 80).map(r => `<tr>
    <td><span class="badge warn">${r.symbol}</span></td>
    <td>${fmtNum(r.priceUsd, 2)}</td>
    <td>${(r.problems || []).join(" · ")}</td>
    <td>${r.suggestion || "Completar ficha"}</td>
  </tr>`).join("");
}
function renderTechPreview() {
  const pre = $("techPreview");
  if (pre) pre.textContent = JSON.stringify(bonds.slice(0, 40), null, 2);
}
function renderSymbols() {
  const list = $("symbolsList");
  if (!list) return;
  const symbols = new Set();
  (marketData?.rows || []).forEach(r => { symbols.add(r.symbol); (r.aliases || []).forEach(a => symbols.add(a)); });
  bonds.forEach(b => symbolAliasesOfBond(b).forEach(a => symbols.add(a)));
  list.innerHTML = [...symbols].sort().map(s => `<option value="${s}"></option>`).join("");
}
function rowBySymbol(symbol) {
  const s = normalizeSymbol(symbol);
  return (marketData?.rows || []).find((r) => rowMatchesSymbol(r, s));
}
function bondBySymbol(symbol) {
  const s = normalizeSymbol(symbol);
  return bonds.find((b) => bondMatchesSymbol(b, s));
}
async function loadBonds() {
  const data = await api("/api/bonds");
  bonds = data.bonds || [];
  renderTechPreview();
  renderSymbols();
}
async function refreshPrices(silent = false) {
  try {
    if (!silent) setStatus("muted", "Consultando precios...", "Data912 / backend cloud");
    marketData = await api("/api/prices");
    $("mepValue").textContent = marketData.mep ? `$ ${fmtNum(marketData.mep, 2)}` : "—";
    renderTable();
    renderMissingTechnical();
    renderSymbols();
    if (marketData.errors?.length) setStatus("warn", "Precios con advertencias", marketData.errors.join(" | "));
    else setStatus("ok", "Precios actualizados", new Date(marketData.asOf).toLocaleString("es-AR"));
  } catch (e) {
    setStatus("error", "Error al consultar precios", e.message);
  }
}
function calcRotation() {
  const sell = rowBySymbol($("sellSymbol").value);
  const buy = rowBySymbol($("buySymbol").value);
  const box = $("rotationResult");
  if (!sell || !buy) {
    box.innerHTML = "No encontré uno de los bonos en el panel de mercado.";
    box.className = "result-box muted-box";
    return;
  }
  const nominal = Number($("sellNominal").value || 0);
  const sellFee = Number($("sellFee").value || 0) / 100;
  const buyFee = Number($("buyFee").value || 0) / 100;
  const manual = $("manualPrices").checked;
  const sellPx = manual ? Number($("manualSellPrice").value || 0) : (sell.bidUsdMep || sell.priceUsdMep);
  const buyPx = manual ? Number($("manualBuyPrice").value || 0) : (buy.askUsdMep || buy.priceUsdMep);
  if (!nominal || !sellPx || !buyPx) {
    box.innerHTML = "Falta nominal o precio válido. Para venta se usa bid MEP; para compra se usa ask MEP.";
    box.className = "result-box muted-box";
    return;
  }
  const grossSale = nominal * sellPx / 100;
  const saleFeeAmt = grossSale * sellFee;
  const netSale = grossSale - saleFeeAmt;
  const grossBuyCapacity = netSale / (1 + buyFee);
  const buyNominal = grossBuyCapacity / buyPx * 100;
  const buyFeeAmt = grossBuyCapacity * buyFee;
  const totalCosts = saleFeeAmt + buyFeeAmt;
  const tirPickup = buy.tir !== null && sell.tir !== null ? buy.tir - sell.tir : null;
  const durationChange = buy.durationMod !== null && sell.durationMod !== null ? buy.durationMod - sell.durationMod : null;
  const flow12Sell = (sell.flows12 || 0) * nominal / 100;
  const flow12Buy = (buy.flows12 || 0) * buyNominal / 100;
  const flow24Sell = (sell.flows24 || 0) * nominal / 100;
  const flow24Buy = (buy.flows24 || 0) * buyNominal / 100;
  const dv01Sell = (sell.durationMod && sell.dirtyPrice) ? sell.durationMod * (sell.dirtyPrice * nominal / 100) * 0.0001 : null;
  const dv01Buy = (buy.durationMod && buy.dirtyPrice) ? buy.durationMod * (buy.dirtyPrice * buyNominal / 100) * 0.0001 : null;
  const costsAsPct = netSale ? totalCosts / netSale : null;
  const verdict = (() => {
    if (tirPickup !== null && tirPickup > 0 && (durationChange ?? 0) <= 0.75) return "Mejora TIR sin aumentar demasiado duration. Revisar rating, liquidez y spread antes de ejecutar.";
    if (tirPickup !== null && tirPickup < 0) return "Resigna TIR. Solo tiene sentido si mejora calidad crediticia, liquidez, duration o concentración.";
    return "Requiere validación de ficha técnica y liquidez para completar la lectura.";
  })();
  box.className = "result-box";
  box.innerHTML = `<div class="result-grid">
    <div class="kpi"><small>Venta neta</small><strong>USD ${fmtNum(netSale, 2)}</strong></div>
    <div class="kpi"><small>VN nuevo estimado</small><strong>${fmtNum(buyNominal, 0)}</strong></div>
    <div class="kpi"><small>Pickup TIR</small><strong class="${tirPickup >= 0 ? "positive" : "negative"}">${fmtPct(tirPickup)}</strong></div>
    <div class="kpi"><small>Cambio duration</small><strong>${fmtNum(durationChange, 2)}</strong></div>
    <div class="kpi"><small>Flujo 12M</small><strong>USD ${fmtNum(flow12Sell, 2)} → ${fmtNum(flow12Buy, 2)}</strong></div>
    <div class="kpi"><small>Flujo 24M</small><strong>USD ${fmtNum(flow24Sell, 2)} → ${fmtNum(flow24Buy, 2)}</strong></div>
    <div class="kpi"><small>DV01 posición</small><strong>${fmtNum(dv01Sell, 2)} → ${fmtNum(dv01Buy, 2)}</strong></div>
    <div class="kpi"><small>Costo total</small><strong>USD ${fmtNum(totalCosts, 2)} (${fmtPct(costsAsPct)})</strong></div>
    <div class="kpi"><small>Rating</small><strong>${sell.rating || "—"} → ${buy.rating || "—"}</strong></div>
    <div class="kpi"><small>Paridad</small><strong>${fmtPct(sell.parity)} → ${fmtPct(buy.parity)}</strong></div>
    <div class="kpi"><small>Sector</small><strong>${sell.sector || "—"} → ${buy.sector || "—"}</strong></div>
    <div class="kpi"><small>Ley</small><strong>${sell.law || "—"} → ${buy.law || "—"}</strong></div>
  </div><p style="margin-top:14px"><strong>Lectura:</strong> ${verdict}</p>
  <p class="muted" style="margin-top:8px">Precios usados: venta ${fmtNum(sellPx, 2)} / compra ${fmtNum(buyPx, 2)}. Las métricas dependen de que la ficha técnica esté validada.</p>`;
}
async function saveTechFromEditor() {
  const symbol = normalizeSymbol($("editSymbol").value);
  if (!symbol) throw new Error("Falta ticker");
  const existing = bondBySymbol(symbol) || {};
  const aliases = $("editAliases").value.split(",").map(s => normalizeSymbol(s)).filter(Boolean);
  const maturity = $("editMaturity").value;
  const couponRaw = $("editCoupon").value;
  const frequencyRaw = $("editFrequency").value;
  const minLotRaw = $("editMinLot")?.value || "";
  const bond = {
    ...existing,
    symbol,
    aliases: Array.from(new Set([symbol, ...aliases, ...(existing.aliases || [])])),
    issuer: $("editIssuer").value || existing.issuer || "",
    shortIssuer: $("editIssuer").value || existing.shortIssuer || existing.issuer || "",
    sector: $("editSector").value || existing.sector || "",
    coupon: couponRaw === "" ? existing.coupon : Number(couponRaw),
    maturity: maturity || existing.maturity || "",
    frequency: frequencyRaw === "" ? existing.frequency : Number(frequencyRaw),
    dayCount: existing.dayCount || "30/360",
    amortization: existing.amortization?.length ? existing.amortization : (maturity ? [{ date: maturity, percent: 1 }] : []),
    amortizationType: existing.amortizationType || "Bullet",
    couponMonths: $("editCouponMonths")?.value || existing.couponMonths || "",
    minLot: minLotRaw === "" ? existing.minLot : Number(minLotRaw),
    rating: $("editRating").value || existing.rating || "",
    ratingAgency: $("editRatingAgency").value || existing.ratingAgency || "",
    law: $("editLaw").value || existing.law || "",
    sourceStatus: "editado-manual",
    notes: existing.notes || "Ficha cargada desde editor rápido. Validar contra prospecto / aviso de resultados.",
  };
  const data = await api("/api/bonds/upsert", { method: "POST", body: JSON.stringify({ bond }) });
  await loadBonds();
  await refreshPrices(true);
  return data;
}
function download(filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function exportCsv() {
  const rows = marketData?.rows || [];
  const headers = ["symbol","issuer","priceArs","priceUsdMep","bidUsdMep","askUsdMep","priceCable","tir","durationMod","maturity","amortizationType","coupon","couponMonths","dollar","law","rating","ratingAgency","minLot","sector","technicalValue","residualValue","parity","spread","priceSource"];
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => JSON.stringify(r[h] ?? "")).join(","))].join("\n");
  download("bonos-mercado-completo.csv", csv, "text/csv");
}
async function sync(mode) {
  try {
    setStatus("muted", `Actualizando ${mode.toUpperCase()}...`, "Puede demorar");
    const data = await api(`/api/sync/${mode}`, { method: "POST", body: JSON.stringify({}) });
    await loadBonds(); await refreshPrices(true);
    setStatus("ok", `Sincronización ${mode.toUpperCase()} finalizada`, `${data.count || 1} bonos procesados`);
  } catch (e) { setStatus("error", `Error al sincronizar ${mode.toUpperCase()}`, e.message); }
}
function bindIfExists(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
}
function bindEvents() {
  bindIfExists("refreshPrices", "click", () => refreshPrices());
  bindIfExists("syncFix", "click", () => sync("fix"));
  bindIfExists("syncBoth", "click", () => sync("both"));
  bindIfExists("exportCsv", "click", exportCsv);
  bindIfExists("tableSearch", "input", renderTable);
  bindIfExists("priceMode", "change", renderTable);
  bindIfExists("calcRotation", "click", calcRotation);
  bindIfExists("manualPrices", "change", (e) => {
    if ($("manualSellPrice")) $("manualSellPrice").disabled = !e.target.checked;
    if ($("manualBuyPrice")) $("manualBuyPrice").disabled = !e.target.checked;
  });
  bindIfExists("saveTech", "click", async () => {
    try { setStatus("muted", "Guardando ficha técnica...", "Editor manual"); const data = await saveTechFromEditor(); setStatus("ok", "Ficha técnica guardada", `${data.action === "created" ? "Creada" : "Actualizada"}: ${data.bond.symbol}`); }
    catch (e) { setStatus("error", "Error al guardar ficha", e.message); }
  });
  bindIfExists("exportJson", "click", () => download("bonds.json", JSON.stringify(bonds, null, 2)));
  bindIfExists("importJson", "change", async (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    try { const imported = JSON.parse(await file.text()); if (!Array.isArray(imported)) throw new Error("El JSON debe ser un array de bonos"); await api("/api/bonds", { method: "POST", body: JSON.stringify({ bonds: imported }) }); await loadBonds(); await refreshPrices(true); setStatus("ok", "Base técnica importada", `${imported.length} bonos`); }
    catch (e) { setStatus("error", "Error al importar JSON", e.message); }
  });
}
async function init() {
  bindEvents();
  try { await loadBonds(); await refreshPrices(); autoTimer = setInterval(() => refreshPrices(true), 30_000); }
  catch (e) { setStatus("error", "No se pudo iniciar", e.message); }
}
init();
