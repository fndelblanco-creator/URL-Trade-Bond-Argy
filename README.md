# Dashboard de rotación de bonos corporativos — Cloud v5.4

Versión cloud para Render. No requiere instalar Python localmente.

## Cambios v5.4

- Panel de mercado ampliado: precio en pesos, USD MEP y Cable.
- Prioriza precio USD MEP directo cuando existe profundidad suficiente.
- Si no hay USD MEP directo o no tiene profundidad suficiente, convierte especie ARS / MEP.
- Mejora el agrupamiento de especies por ticker base: ARS / MEP / Cable.
- Agrega columnas: cupón anual, meses de cupón, amortización, dólar, ley, lámina mínima, sector, valor técnico, valor residual y paridad.
- Carga una base semilla más amplia con los tickers visibles en la tabla de referencia provista.
- Calcula TIR, duration modificada, valor técnico, valor residual y paridad cuando hay ficha técnica.
- Agrega más aliases automáticos para especies O / D / C.
- Mantiene editor rápido de ficha técnica desde la web.

## Deploy en Render

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

Root Directory: dejar vacío si `package.json` está en la raíz del repo.

## Nota importante

CNV/FIX automático sigue siendo best-effort. La extracción automática de prospectos y ratings no debe reemplazar la validación contra prospecto, aviso de resultados y último informe de calificación. Para una versión productiva, conviene migrar `data/bonds.json` a Supabase/PostgreSQL para persistencia real.
