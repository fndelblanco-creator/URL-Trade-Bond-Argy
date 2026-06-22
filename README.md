# Dashboard de rotación de bonos corporativos — Cloud v5.7

Versión cloud para Render.

## Cambios v5.7

- Agrega `data/issuer_metrics.json` con métricas crediticias de emisores.
- Incorpora score fundamental, score total, preferencia relativa y métricas financieras.
- El panel de mercado muestra: score, preferencia, ND/EBITDA, EBITDA/Intereses y Caja/ST Debt.
- El resultado del simulador compara métricas financieras del emisor actual vs. destino.
- Agrega una tabla de scoring crediticio por emisor.

## Fuentes de datos

- Precios: Data912, mientras no esté disponible BYMA/Tecval.
- Ficha técnica: `data/bonds.json`.
- Scoring/métricas: `data/issuer_metrics.json`, cargado inicialmente con datos del informe corporativo 1Q26.

## Deploy Render

- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: vacío
