# Panel de Itinerarios en el Mapa — Spec

**Fecha:** 2026-05-27  
**Proyectos afectados:** LeónXIV (Canarias), LeónXIV_Madrid, LeónXIV_Barcelona

---

## Problema

Cuando hay múltiples itinerarios creados, todos se dibujan a la vez en el mapa. No hay forma de ver uno solo sin borrar los demás.

## Solución

Panel inferior deslizante en la pestaña del mapa con una lista de itinerarios y checkboxes para activar/desactivar cada uno individualmente.

---

## Comportamiento

- **Colapsado por defecto** al abrir la pestaña del mapa.
- El tirador muestra: `▬ Itinerarios (N activos / M total)`.
- Si no hay itinerarios creados, el tirador no aparece.
- Tap en el tirador → el panel sube con animación suave (transition CSS).
- Tap de nuevo → se colapsa.
- Cada fila del panel: **punto de color** del itinerario + **nombre** + **checkbox**.
- Checkbox marcado = ruta visible en el mapa. Desmarcado = ruta oculta.
- Todos los checkboxes inician marcados (todo visible).
- El estado de visibilidad es **local** (en `appState.routeVisibility`), no se persiste en Firebase.
- Cuando se añade una nueva ruta desde Firestore, aparece en el panel con checkbox marcado por defecto.

---

## Cambios técnicos

### app.js

1. Añadir `routeVisibility: {}` a `appState`.
2. Nueva función `renderRoutesPanel()`:
   - Genera la lista de rutas con checkboxes.
   - Si no hay rutas, oculta el tirador.
   - Actualiza el contador del tirador.
3. Modificar `updateMapOverlays()`:
   - Antes de dibujar cada ruta, consultar `appState.routeVisibility[route.id]`.
   - Si es `false`, saltar esa ruta.
4. Nueva función `toggleRouteVisibility(id)`:
   - Invierte el valor en `appState.routeVisibility[id]`.
   - Llama a `updateMapOverlays()`.
   - Actualiza el contador del tirador.
5. Llamar a `renderRoutesPanel()` desde el listener `onSnapshot` de itinerarios y desde `loadLocalData`.

### index.html

1. Añadir el panel HTML dentro de `#map-tab`, debajo del `map-container-wrapper`:
   - Div tirador (`.routes-panel-handle`)
   - Div lista (`.routes-panel-list`)
2. Añadir modal CSS inline o en `style.css` para la animación.

### style.css

Estilos nuevos:
- `.routes-panel` — contenedor pegado al fondo del `#map-tab`
- `.routes-panel-handle` — tirador con altura fija, cursor pointer
- `.routes-panel-list` — área expandible, `max-height` con `transition`
- `.route-panel-item` — fila con punto de color + nombre + checkbox
- Estado colapsado: `max-height: 0; overflow: hidden`
- Estado expandido: `max-height: 300px`

---

## Lo que NO cambia

- Los datos de Firestore no se modifican.
- El panel admin de itinerarios no cambia.
- El comportamiento de dibujo de rutas en `updateMapOverlays()` se mantiene igual salvo el filtro de visibilidad.
