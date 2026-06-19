# Dashboard de rotación de bonos corporativos — Cloud v5.2

Corrección principal frente a v5.1:

- El panel normaliza **todo a USD MEP**.
- Si Data912 devuelve una especie `O` con precio alto en ARS, el backend la divide por el MEP vigente.
- Si no existe especie USD directa, usa la especie en pesos y la convierte por MEP.
- Corrige TIR y duration cuando el precio venía en ARS y se estaba tomando como USD.
- Mejora el parser de FIX para evitar ratings falsos como letras sueltas (`d`, `c`, etc.).

## Deploy en Render

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

## Nota operativa

La TIR, duration, vencimiento y flujos solo se calculan cuando el ticker existe en `data/bonds.json` con ficha técnica completa: cupón, vencimiento, frecuencia y amortización.

El scraper CNV/FIX es best-effort. Para uso comercial, validar manualmente cada ficha técnica contra prospecto, aviso de suscripción, aviso de resultados y último informe de calificación.
