# Dashboard de rotación de bonos corporativos — Cloud v5.3

Versión cloud para Render. No requiere instalar Python en la computadora del usuario.

## Cambios v5.3

- Agrega mapeo de aliases por ticker/especie.
- Corrige casos donde Data912 trae especie en ARS y la app la convierte a USD MEP.
- Agrega panel de bonos con ficha incompleta.
- Agrega editor rápido de ficha técnica desde la web.
- Agrega endpoint `/api/bonds/upsert` para crear/actualizar fichas.
- Mejora validaciones: emisor, cupón, vencimiento, frecuencia, amortización y rating.
- Agrega fichas iniciales para Telecom TLCP/TLCPO 2033, TLCTO 2036 y TLCOO 2028.

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

## Notas

La base técnica vive en `data/bonds.json`. El editor rápido permite guardar cambios, pero en Render Free esos cambios pueden no ser persistentes si el servicio se reinicia. Para una versión productiva conviene migrar la base a Supabase/PostgreSQL.

CNV/FIX automático sigue siendo best-effort. Todo dato técnico debe validarse contra prospecto, aviso de resultados y último informe de calificación antes de uso comercial.
