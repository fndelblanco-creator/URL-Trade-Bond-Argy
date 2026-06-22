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
function ratingRank(rating) {
  const r = String(rating || "").toUpperCase();
  const scale = ["AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-", "BB+", "BB", "BB-", "B+", "B", "B-", "CCC", "CC", "C", "D"];
  const clean = r.replace("(ARG)", "").trim();
  const hit = scale.findIndex(x => clean.includes(x));
  return hit >= 0 ? hit : null;
}
function ratingDirection(sell, buy) {
  const a = ratingRank(sell?.rating);
  const b = ratingRank(buy?.rating);
  if (a === null || b === null) return "No comparable";
  if (b < a) return "Mejora calidad";
  if (b > a) return "Baja calidad";
  return "Similar";
}
function strategyTags({tirPickup, durationChange, flow12Delta, ratingDir, sectorChange, lawChange}) {
  const tags = [];
  if (tirPickup !== null && tirPickup > 0.0025) tags.push("Mayor rendimiento/TIR");
  if (tirPickup !== null && tirPickup < -0.0025) tags.push("Resigna TIR");
  if (durationChange !== null && durationChange < -0.35) tags.push("Acorta duration");
  if (durationChange !== null && durationChange > 0.35) tags.push("Extiende duration");
  if (flow12Delta > 0) tags.push("Mejora renta 12M");
  if (flow12Delta < 0) tags.push("Menor renta 12M");
  if (ratingDir === "Mejora calidad") tags.push("Sube calidad crediticia");
  if (ratingDir === "Baja calidad") tags.push("Baja calidad crediticia");
  if (sectorChange) tags.push("Diversifica/cambia sector");
  if (lawChange) tags.push("Cambia ley aplicable");
  return tags.length ? tags : ["Rotación neutral / requiere análisis cualitativo"];
}
function kpi(label, value, tooltip, cls = "") {
  return `<div class="kpi has-tooltip" title="${escapeHtml(tooltip || "")}"><small>${label}</small><strong class="${cls}">${value}</strong></div>`;
}
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c]));
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
  const buyFeeAmt = grossBuyCapacity * buyFee;
  const buyNominal = grossBuyCapacity / buyPx * 100;
  const totalCosts = saleFeeAmt + buyFeeAmt;
  const totalCostsVsGross = grossSale ? totalCosts / grossSale : null;

  const tirPickup = buy.tir !== null && buy.tir !== undefined && sell.tir !== null && sell.tir !== undefined ? buy.tir - sell.tir : null;
  const durationChange = buy.durationMod !== null && buy.durationMod !== undefined && sell.durationMod !== null && sell.durationMod !== undefined ? buy.durationMod - sell.durationMod : null;
  const flow12Sell = (sell.flows12 || 0) * nominal / 100;
  const flow12Buy = (buy.flows12 || 0) * buyNominal / 100;
  const flow24Sell = (sell.flows24 || 0) * nominal / 100;
  const flow24Buy = (buy.flows24 || 0) * buyNominal / 100;
  const flow12Delta = flow12Buy - flow12Sell;
  const flow24Delta = flow24Buy - flow24Sell;
  const dv01Sell = (sell.durationMod && sell.dirtyPrice) ? sell.durationMod * (sell.dirtyPrice * nominal / 100) * 0.0001 : null;
  const dv01Buy = (buy.durationMod && buy.dirtyPrice) ? buy.durationMod * (buy.dirtyPrice * buyNominal / 100) * 0.0001 : null;
  const dv01Delta = (dv01Sell !== null && dv01Buy !== null) ? dv01Buy - dv01Sell : null;
  const carryPickup12 = grossSale ? flow12Delta / grossSale : null;
  const breakevenMonths = flow12Delta > 0 ? (totalCosts / flow12Delta) * 12 : null;
  const ratingDir = ratingDirection(sell, buy);
  const sectorChange = (sell.sector || "") !== (buy.sector || "");
  const lawChange = (sell.law || "") !== (buy.law || "");
  const tags = strategyTags({tirPickup, durationChange, flow12Delta, ratingDir, sectorChange, lawChange});

  const verdict = (() => {
    const positives = [];
    const alerts = [];
    if (tirPickup !== null && tirPickup > 0) positives.push("mejora la TIR");
    if (flow12Delta > 0) positives.push("aumenta el flujo de renta de los próximos 12 meses");
    if (durationChange !== null && durationChange < 0) positives.push("reduce duration/DV01");
    if (ratingDir === "Mejora calidad") positives.push("mejora calidad crediticia");
    if (tirPickup !== null && tirPickup < 0) alerts.push("resigna TIR");
    if (durationChange !== null && durationChange > 0.75) alerts.push("aumenta sensibilidad a tasa");
    if (ratingDir === "Baja calidad") alerts.push("baja calidad crediticia");
    if (flow12Delta < 0) alerts.push("reduce flujo de renta 12M");
    if (!positives.length && !alerts.length) return "Rotación neutra o incompleta. Validar ficha técnica, liquidez y spreads antes de ejecutar.";
    if (positives.length && !alerts.length) return `La rotación luce favorable porque ${positives.join(", ")}. Confirmar liquidez real y precio ejecutable.`;
    if (!positives.length && alerts.length) return `La rotación luce defensiva o de baja conveniencia económica: ${alerts.join(", ")}. Solo tendría sentido por objetivo cualitativo específico.`;
    return `Rotación mixta: ${positives.join(", ")}; pero ${alerts.join(", ")}. La decisión depende del objetivo de cartera.`;
  })();

  box.className = "result-box";
  box.innerHTML = `
    <div class="strategy-tags">${tags.map(t => `<span>${t}</span>`).join("")}</div>
    <div class="result-grid">
      ${kpi("VN actual → VN resultante", `${fmtNum(nominal, 0)} → ${fmtNum(buyNominal, 0)}`, "Compara los nominales que vendés contra los nominales estimados que podrías comprar del bono destino después de aplicar precio y comisión.")}
      ${kpi("Venta neta", `USD ${fmtNum(netSale, 2)}`, "Monto efectivo que queda disponible después de vender el bono actual y descontar la comisión de venta. Es la caja que se usa para comprar el bono destino.")}
      ${kpi("Precio usado", `${fmtNum(sellPx, 2)} → ${fmtNum(buyPx, 2)}`, "Precio de venta del bono actual y precio de compra del bono destino. Por defecto usa bid para vender y ask para comprar; con modo manual usa los precios cargados.")}
      ${kpi("Costo total", `USD ${fmtNum(totalCosts, 2)} (${fmtPct(totalCostsVsGross)})`, "Suma de comisiones estimadas de venta y compra. No incluye otros costos operativos ni posible deslizamiento adicional por liquidez.")}
      ${kpi("Pickup TIR", fmtPct(tirPickup), "Diferencia entre la TIR estimada del bono destino y la TIR estimada del bono actual. Positivo implica mayor rendimiento a vencimiento.", tirPickup >= 0 ? "positive" : "negative")}
      ${kpi("Cambio duration", fmtNum(durationChange, 2), "Cambio en duration modificada. Positivo implica más sensibilidad a movimientos de tasas; negativo implica menor sensibilidad.", durationChange <= 0 ? "positive" : "negative")}
      ${kpi("Flujo renta 12M", `USD ${fmtNum(flow12Sell, 2)} → ${fmtNum(flow12Buy, 2)}`, "Compara cupones y amortizaciones esperadas durante los próximos 12 meses para el VN actual y el VN resultante.", flow12Delta >= 0 ? "positive" : "negative")}
      ${kpi("Diferencia renta 12M", `USD ${fmtNum(flow12Delta, 2)} (${fmtPct(carryPickup12)})`, "Incremento o reducción del flujo estimado de los próximos 12 meses. El porcentaje se mide contra el monto bruto vendido.", flow12Delta >= 0 ? "positive" : "negative")}
      ${kpi("Flujo renta 24M", `USD ${fmtNum(flow24Sell, 2)} → ${fmtNum(flow24Buy, 2)}`, "Compara cupones y amortizaciones esperadas durante los próximos 24 meses.", flow24Delta >= 0 ? "positive" : "negative")}
      ${kpi("DV01 posición", `${fmtNum(dv01Sell, 2)} → ${fmtNum(dv01Buy, 2)}`, "Sensibilidad aproximada de la posición ante un movimiento de 1 punto básico en la tasa. Mayor DV01 implica más volatilidad de precio.")}
      ${kpi("Cambio DV01", fmtNum(dv01Delta, 2), "Aumento o reducción de sensibilidad total de la posición ante cambios de tasa.", dv01Delta <= 0 ? "positive" : "negative")}
      ${kpi("Breakeven costo", breakevenMonths ? `${fmtNum(breakevenMonths, 1)} meses` : "—", "Cantidad aproximada de meses de mejora de flujo 12M necesaria para recuperar el costo total de la rotación. Solo se calcula si el flujo 12M mejora.")}
      ${kpi("Rating", `${sell.rating || "—"} → ${buy.rating || "—"}`, "Compara calidad crediticia. Puede ser rating de emisor o de instrumento según la ficha disponible.")}
      ${kpi("Paridad", `${fmtPct(sell.parity)} → ${fmtPct(buy.parity)}`, "Precio limpio sobre valor técnico. Sirve para ver si comprás más caro o barato respecto del valor técnico estimado.")}
      ${kpi("Sector", `${sell.sector || "—"} → ${buy.sector || "—"}`, "Muestra si la rotación cambia exposición sectorial o aumenta concentración.")}
      ${kpi("Ley", `${sell.law || "—"} → ${buy.law || "—"}`, "Compara ley aplicable del bono. Puede afectar protección legal y recupero esperado.")}
    </div>
    <p style="margin-top:14px"><strong>Lectura:</strong> ${verdict}</p>
    <p class="muted" style="margin-top:8px">Las métricas dependen de que la ficha técnica esté validada. Para una decisión real, revisar liquidez, spread bid/ask, monto operable y precio ejecutable.</p>`;
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
