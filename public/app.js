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

function setStatus(type, title, detail = "") {
  const card = $("statusCard");
  card.className = `status-card ${type}`;
  $("statusTitle").textContent = title;
  $("statusTime").textContent = detail || new Date().toLocaleString("es-AR");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
}

function getTablePrice(row) {
  const mode = $("priceMode").value;
  if (mode === "bid") return row.bidUsd;
  if (mode === "ask") return row.askUsd;
  if (mode === "last") return row.lastUsd;
  return row.priceUsd;
}


function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
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
  if (!s || !bond) return false;
  return symbolAliasesOfBond(bond).includes(s);
}

function problemBadge(problems) {
  if (!problems || !problems.length) return '<span class="badge ok">OK</span>';
  return problems.map(p => `<span class="mini-warn">${p}</span>`).join(' ');
}

function renderTable() {
  const tbody = document.querySelector("#marketTable tbody");
  const q = $("tableSearch").value.trim().toLowerCase();
  const rows = (marketData?.rows || []).filter((r) => {
    const text = `${r.symbol} ${r.issuer} ${r.sector}`.toLowerCase();
    return !q || text.includes(q);
  });
  tbody.innerHTML = rows.map((r) => {
    const price = getTablePrice(r);
    const techBadge = r.maturity ? "ok" : "warn";
    return `<tr data-symbol="${r.symbol}" title="${(r.validationStatus || '').replace(/"/g, '&quot;')}">
      <td><span class="badge ${techBadge}">${r.symbol}</span></td>
      <td>${r.issuer || "—"}</td>
      <td>${fmtNum(price, 2)}</td>
      <td>${fmtNum(r.bidUsd, 2)}</td>
      <td>${fmtNum(r.askUsd, 2)}</td>
      <td>${fmtPct(r.tir)}</td>
      <td>${fmtNum(r.durationMod, 2)}</td>
      <td>${r.maturity || "—"}</td>
      <td>${r.rating ? `${r.rating} ${r.ratingAgency || ""}` : "—"}</td>
      <td>${fmtPct(r.spread)}</td>
      <td>${r.priceSource || "—"}</td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      const sym = tr.dataset.symbol;
      if (!$("sellSymbol").value) $("sellSymbol").value = sym;
      else $("buySymbol").value = sym;
    });
  });
}

function renderSymbols() {
  const dl = $("symbolsList");
  const symbols = Array.from(new Set([
    ...(marketData?.rows || []).flatMap(r => [r.symbol, r.canonicalSymbol, ...(r.aliases || [])]),
    ...bonds.flatMap(b => [b.symbol, ...(b.aliases || [])])
  ].filter(Boolean))).sort();
  dl.innerHTML = symbols.map((s) => `<option value="${s}"></option>`).join("");
}

function renderTechPreview() {
  $("techPreview").textContent = JSON.stringify(bonds, null, 2);
}


function renderMissingTechnical() {
  const tbody = document.querySelector("#missingTable tbody");
  if (!tbody) return;
  const rows = marketData?.missingTechnical || [];
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No hay faltantes detectados.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.slice(0, 80).map(r => `<tr>
    <td><span class="badge warn">${r.symbol}</span></td>
    <td>${fmtNum(r.priceUsd, 2)}</td>
    <td>${problemBadge(r.problems)}</td>
    <td><button class="small-btn" data-edit-missing="${r.symbol}">Completar</button></td>
  </tr>`).join("");
  tbody.querySelectorAll("[data-edit-missing]").forEach(btn => {
    btn.addEventListener("click", () => fillEditor(btn.dataset.editMissing));
  });
}

function findExistingBond(symbol) {
  const s = normalizeSymbol(symbol);
  return bonds.find(b => bondMatchesSymbol(b, s));
}

function fillEditor(symbol) {
  const s = normalizeSymbol(symbol);
  const existing = findExistingBond(s) || {};
  $("editSymbol").value = existing.symbol || s;
  $("editAliases").value = symbolAliasesOfBond(existing).length ? symbolAliasesOfBond(existing).join(", ") : s;
  $("editIssuer").value = existing.issuer || "";
  $("editSector").value = existing.sector || "";
  $("editCoupon").value = existing.coupon ?? "";
  $("editMaturity").value = existing.maturity || "";
  $("editFrequency").value = existing.frequency || "";
  $("editRating").value = existing.rating || "";
  $("editRatingAgency").value = existing.ratingAgency || "";
  $("editLaw").value = existing.law || "";
  window.scrollTo({ top: $("editSymbol").getBoundingClientRect().top + window.scrollY - 120, behavior: "smooth" });
}

async function saveTechFromEditor() {
  const symbol = normalizeSymbol($("editSymbol").value);
  if (!symbol) throw new Error("Falta ticker");
  const aliases = $("editAliases").value.split(",").map(normalizeSymbol).filter(Boolean);
  const existing = findExistingBond(symbol) || {};
  const couponRaw = $("editCoupon").value;
  const frequencyRaw = $("editFrequency").value;
  const maturity = $("editMaturity").value;
  const bond = {
    ...existing,
    symbol,
    aliases: Array.from(new Set([symbol, ...aliases])),
    issuer: $("editIssuer").value || existing.issuer || "",
    shortIssuer: existing.shortIssuer || ($("editIssuer").value || "").split(" ").slice(0, 2).join(" "),
    sector: $("editSector").value || existing.sector || "",
    currency: existing.currency || "USD MEP",
    coupon: couponRaw === "" ? existing.coupon : Number(couponRaw),
    maturity: maturity || existing.maturity || "",
    frequency: frequencyRaw === "" ? existing.frequency : Number(frequencyRaw),
    dayCount: existing.dayCount || "30/360",
    amortization: existing.amortization?.length ? existing.amortization : (maturity ? [{ date: maturity, percent: 1 }] : []),
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

async function loadBonds() {
  const data = await api("/api/bonds");
  bonds = data.bonds || [];
  renderTechPreview();
  renderMissingTechnical();
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
    if (marketData.errors?.length) {
      setStatus("warn", "Precios con advertencias", marketData.errors.join(" | "));
    } else {
      setStatus("ok", "Precios actualizados", new Date(marketData.asOf).toLocaleString("es-AR"));
    }
  } catch (e) {
    setStatus("error", "Error al consultar precios", e.message);
  }
}

function rowBySymbol(symbol) {
  const s = normalizeSymbol(symbol);
  return (marketData?.rows || []).find((r) => rowMatchesSymbol(r, s));
}

function bondBySymbol(symbol) {
  const s = normalizeSymbol(symbol);
  return bonds.find((b) => bondMatchesSymbol(b, s));
}

function calcRotation() {
  const sell = rowBySymbol($("sellSymbol").value);
  const buy = rowBySymbol($("buySymbol").value);
  const sellTech = bondBySymbol($("sellSymbol").value);
  const buyTech = bondBySymbol($("buySymbol").value);
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
  const sellPx = manual ? Number($("manualSellPrice").value || 0) : (sell.bidUsd || sell.priceUsd);
  const buyPx = manual ? Number($("manualBuyPrice").value || 0) : (buy.askUsd || buy.priceUsd);
  if (!nominal || !sellPx || !buyPx) {
    box.innerHTML = "Falta nominal o precio válido. Para venta se usa bid; para compra se usa ask.";
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

  const tirPickup = (buy.tir ?? null) !== null && (sell.tir ?? null) !== null ? buy.tir - sell.tir : null;
  const durationChange = (buy.durationMod ?? null) !== null && (sell.durationMod ?? null) !== null ? buy.durationMod - sell.durationMod : null;
  const flow12Sell = (sell.flows12 || 0) * nominal / 100;
  const flow12Buy = (buy.flows12 || 0) * buyNominal / 100;
  const flow24Sell = (sell.flows24 || 0) * nominal / 100;
  const flow24Buy = (buy.flows24 || 0) * buyNominal / 100;
  const dv01Sell = (sell.durationMod && sell.dirtyPrice) ? sell.durationMod * (sell.dirtyPrice * nominal / 100) * 0.0001 : null;
  const dv01Buy = (buy.durationMod && buy.dirtyPrice) ? buy.durationMod * (buy.dirtyPrice * buyNominal / 100) * 0.0001 : null;
  const dv01Change = dv01Sell !== null && dv01Buy !== null ? dv01Buy - dv01Sell : null;
  const upside100Sell = dv01Sell !== null ? dv01Sell * 100 : null;
  const upside100Buy = dv01Buy !== null ? dv01Buy * 100 : null;
  const costsAsPct = netSale ? totalCosts / netSale : null;

  const ratingLine = `${sell.rating || "—"} → ${buy.rating || "—"}`;
  const sectorLine = `${sell.sector || "—"} → ${buy.sector || "—"}`;
  const lawLine = `${sell.law || "—"} → ${buy.law || "—"}`;
  const verdict = (() => {
    if (tirPickup !== null && tirPickup > 0 && durationChange !== null && durationChange <= 0.75) return "La rotación mejora TIR sin aumentar demasiado duration. Revisar rating, liquidez y spread antes de ejecutar.";
    if (tirPickup !== null && tirPickup < 0) return "La rotación resigna TIR. Solo tiene sentido si mejora calidad crediticia, liquidez, duration o concentración.";
    return "La rotación requiere validación de ficha técnica y liquidez para completar la lectura.";
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
    <div class="kpi"><small>Impacto +100 bps compresión</small><strong>USD ${fmtNum(upside100Sell, 2)} → ${fmtNum(upside100Buy, 2)}</strong></div>
    <div class="kpi"><small>Costo total</small><strong>USD ${fmtNum(totalCosts, 2)} (${fmtPct(costsAsPct)})</strong></div>
    <div class="kpi"><small>Rating</small><strong>${ratingLine}</strong></div>
    <div class="kpi"><small>Sector</small><strong>${sectorLine}</strong></div>
    <div class="kpi"><small>Ley</small><strong>${lawLine}</strong></div>
  </div>
  <p style="margin-top:14px"><strong>Lectura:</strong> ${verdict}</p>
  <p class="muted" style="margin-top:8px">Precios usados: venta ${fmtNum(sellPx, 2)} / compra ${fmtNum(buyPx, 2)}. Las métricas dependen de que la ficha técnica esté validada.</p>`;
}

function download(filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const rows = marketData?.rows || [];
  const headers = ["symbol","issuer","priceUsd","bidUsd","askUsd","tir","durationMod","maturity","rating","ratingAgency","spread","priceSource"];
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => JSON.stringify(r[h] ?? "")).join(","))].join("\n");
  download("bonos-mercado-usd-mep.csv", csv, "text/csv");
}

async function sync(mode) {
  try {
    setStatus("muted", `Actualizando ${mode.toUpperCase()}...`, "Puede demorar");
    const data = await api(`/api/sync/${mode}`, { method: "POST", body: JSON.stringify({}) });
    await loadBonds();
    await refreshPrices(true);
    setStatus("ok", `Sincronización ${mode.toUpperCase()} finalizada`, `${data.count || 1} bonos procesados`);
  } catch (e) {
    setStatus("error", `Error al sincronizar ${mode.toUpperCase()}`, e.message);
  }
}

function bindEvents() {
  $("refreshPrices").addEventListener("click", () => refreshPrices());
  $("syncFix").addEventListener("click", () => sync("fix"));
  $("syncBoth").addEventListener("click", () => sync("both"));
  $("exportCsv").addEventListener("click", exportCsv);
  $("tableSearch").addEventListener("input", renderTable);
  $("priceMode").addEventListener("change", renderTable);
  $("calcRotation").addEventListener("click", calcRotation);
  $("manualPrices").addEventListener("change", (e) => {
    $("manualSellPrice").disabled = !e.target.checked;
    $("manualBuyPrice").disabled = !e.target.checked;
  });
  $("saveTech").addEventListener("click", async () => {
    try {
      setStatus("muted", "Guardando ficha técnica...", "Editor manual");
      const data = await saveTechFromEditor();
      setStatus("ok", "Ficha técnica guardada", `${data.action === "created" ? "Creada" : "Actualizada"}: ${data.bond.symbol}`);
    } catch (e) {
      setStatus("error", "Error al guardar ficha", e.message);
    }
  });
  $("exportJson").addEventListener("click", () => download("bonds.json", JSON.stringify(bonds, null, 2)));
  $("importJson").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported)) throw new Error("El JSON debe ser un array de bonos");
      await api("/api/bonds", { method: "POST", body: JSON.stringify({ bonds: imported }) });
      await loadBonds();
      await refreshPrices(true);
      setStatus("ok", "Base técnica importada", `${imported.length} bonos`);
    } catch (e) {
      setStatus("error", "Error al importar JSON", e.message);
    }
  });
}

async function init() {
  bindEvents();
  try {
    await loadBonds();
    await refreshPrices();
    autoTimer = setInterval(() => refreshPrices(true), 30_000);
  } catch (e) {
    setStatus("error", "No se pudo iniciar", e.message);
  }
}

init();
