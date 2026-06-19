# Dashboard de rotación de bonos corporativos — Cloud v5

Esta versión está pensada para publicarse en una URL sin instalar Python ni correr nada en tu computadora.

## Qué incluye

- App web servida por Node/Express.
- Precios desde Data912.
- Panel solo USD MEP.
- Si no hay especie USD MEP, intenta convertir precio ARS / MEP.
- Base técnica de bonos en `data/bonds.json`.
- Cálculo estimado de TIR, interés corrido, duration modificada, flujos 12M/24M y DV01.
- Simulador de rotación: bid para vender, ask para comprar y opción de precios manuales.
- Sync best-effort de CNV y FIX desde backend cloud.

## Importante

La sincronización automática CNV/FIX es best-effort. CNV y FIX no siempre exponen los documentos con una estructura uniforme. Para uso comercial, toda ficha técnica debe quedar validada manualmente contra prospecto, aviso de suscripción, aviso de resultados y último informe de rating.

## Deploy recomendado: Render

1. Crear una cuenta en Render.
2. Subir esta carpeta a un repositorio de GitHub.
3. En Render, elegir **New > Blueprint** si usa `render.yaml`, o **New > Web Service**.
4. Conectar el repo.
5. Usar:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Node Version: 20+
6. Render genera una URL pública del estilo:
   `https://bonos-rotacion-dashboard.onrender.com`

## Variables de entorno

- `DATA912_BASE_URL=https://data912.com`
- `AUTO_SYNC_FIX=false`
- `AUTO_SYNC_CNV=false`

Para que ratings FIX se actualicen automáticamente cada 6 horas:

`AUTO_SYNC_FIX=true`

Para intentar actualización CNV diaria:

`AUTO_SYNC_CNV=true`

## Base técnica

Editar `data/bonds.json`. Estructura mínima:

```json
{
  "symbol": "CP38O",
  "issuer": "Compañía General de Combustibles S.A.",
  "shortIssuer": "CGC",
  "cuit": "30506733932",
  "classKeywords": ["Clase 38", "Obligaciones Negociables Clase 38"],
  "sector": "Oil & Gas",
  "currency": "USD MEP",
  "coupon": 0.11875,
  "maturity": "2030-11-28",
  "frequency": 2,
  "amortization": [
    { "date": "2030-11-28", "percent": 1 }
  ],
  "law": "NY",
  "rating": "CCC+",
  "ratingAgency": "S&P",
  "secured": "Senior unsecured"
}
```

## Limitación de persistencia

En el plan gratuito de Render, los cambios hechos por botones de sync pueden perderse ante reinicios o redeploys porque el sistema de archivos no es una base de datos persistente.

Para versión productiva conviene agregar:

- Supabase / Neon PostgreSQL para base técnica persistente.
- Tabla de auditoría de fuentes CNV/FIX.
- Panel de validación manual de datos extraídos.

## Endpoints

- `GET /api/prices`
- `GET /api/bonds`
- `POST /api/bonds`
- `POST /api/sync/fix`
- `POST /api/sync/cnv`
- `POST /api/sync/both`
- `GET /api/health`

