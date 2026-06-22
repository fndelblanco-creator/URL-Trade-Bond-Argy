# Dashboard de rotación de bonos corporativos — Cloud v5.9

Esta versión limpia la base semilla para evitar mostrar datos no verificados como si fueran oficiales.

## Cambios v5.9

- Ratings no verificados removidos de la visualización.
- Los ratings quedan como **Pendiente FIX/CNV** salvo que tengan fuente formal validada.
- Se agrega estado de validación por bono: **Validado**, **Pendiente CNV/FIX**, **Ficha incompleta** o **Sin ficha**.
- RUCDO conserva la corrección de ley a **NY**, marcada como corrección manual pendiente de validación formal CNV.
- Se separan problemas de cálculo de advertencias de validación. Una ficha puede calcular TIR/duration, pero seguir pendiente de auditoría formal.
- El scoring crediticio solo se muestra si viene de fuente aceptada: `FIX`, `CNV_EEFF`, `FIX_CNV` o `MANUAL_VERIFIED`.
- No se usa el informe de corporativos cargado por el usuario como fuente de scoring.

## Criterio de fuentes

- **Precio:** Data912, hasta migrar a BYMA/Tecval.
- **Ficha técnica:** pendiente de validación CNV/prospecto/aviso de resultados.
- **Rating:** pendiente FIX/CNV salvo fuente formal.
- **Scoring:** cálculo propio solo con métricas verificadas de FIX, CNV/EEFF o carga manual validada.

## Deploy

En Render mantener:

- Build Command: `npm install`
- Start Command: `npm start`

Subir a GitHub el contenido de este ZIP, no el ZIP cerrado.
