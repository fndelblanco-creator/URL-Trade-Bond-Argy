# Dashboard de rotación de bonos corporativos — Cloud v6.0

Cambios principales:

- Ratings FIX automáticos en modo best-effort desde la página pública de FIX.
- Ya no depende del informe cargado por el usuario para rating ni scoring.
- El score mostrado puede usar `ratingScore` cuando solo hay rating FIX validado.
- Las métricas financieras `ND/EBITDA`, `Caja/ST Debt` y `EBITDA/Intereses` siguen pendientes hasta integrar extractor de informes FIX PDF o estados contables CNV.
- Se agrega `data/issuer_sources.json` para mapear emisores con fuentes FIX/CNV.

Importante: el rating desde FIX se puede traer desde HTML público. El scoring financiero completo requiere extraer métricas desde informes de FIX o EEFF de CNV; no debe inventarse.
