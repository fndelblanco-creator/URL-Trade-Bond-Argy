# Dashboard de rotación de bonos corporativos — Cloud v5.6

Versión cloud para Render/Node.

## Cambios v5.6

- Simulador como bloque principal.
- Resultado de rotación con comparación **VN actual → VN resultante**.
- Aclaración de **Venta neta** dentro del tooltip del recuadro.
- Tooltips en cada recuadro del resultado: al pasar el cursor se explica qué mide cada métrica.
- Nuevas métricas en resultado:
  - Precio usado.
  - Costo total como % de venta bruta.
  - Diferencia de renta 12M.
  - Cambio de DV01.
  - Breakeven de costo en meses.
  - Tags de estrategia: mayor TIR, acorta duration, mejora renta, cambia rating, etc.
- Lectura de conveniencia más completa: distingue mejora económica, reducción de riesgo, extensión de duration y cambios de calidad crediticia.

## Deploy

Subir a GitHub el contenido de esta carpeta y redeployar en Render.

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```
