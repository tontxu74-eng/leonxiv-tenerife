/* app.js - Lógica táctica y sincronización en tiempo real con Firebase para León XIV */

// --- ESTADO GLOBAL DE LA APLICACIÓN ---
let appState = {
  teams: [],
  events: [],
  contacts: [],
  locations: [],
  routes: [],
  channels: [],
  routeVisibility: {},
  isAdmin: false,
  firebaseEnabled: false,
  activeTab: 'dashboard',
  db: null,
  map: null,
  mapMarkers: {},
  mapOverlays: {
    locations: {},
    routes: []
  },
  adminPin: '1234'
};

// Coordenadas Semilla
const SEED_COORDS = {
  1: { lat: 28.46367, lng: -16.25190, label: "PMA (Base)" },
  2: { lat: 28.46367, lng: -16.25190, label: "Punto de Referencia" }
};

// Datos semilla por defecto (si la base de datos está vacía o corre en local)
const DEFAULT_TEAMS = [];
const DEFAULT_EVENTS = [];
const DEFAULT_CONTACTS = [];

// Ubicaciones de Interés por defecto (vacío — el admin las crea desde el panel)
const DEFAULT_LOCATIONS = [];

// Rutas / Itinerarios por defecto (Semillas)
// Rutas / Itinerarios por defecto (vacío — el admin los crea desde el panel)
const DEFAULT_ROUTES = [];

// Canales y Frecuencias por defecto (vacío — el admin los crea desde el panel)
const DEFAULT_CHANNELS = [];

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function checkForUpdates() {
  try {
    const res = await fetch('./version.json?t=' + Date.now(), { cache: 'no-store' });
    const data = await res.json();
    const versionGuardada = localStorage.getItem('uap_app_version');
    if (versionGuardada && versionGuardada !== data.v) {
      // Nueva versión detectada: limpiar caché y recargar
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      localStorage.setItem('uap_app_version', data.v);
      window.location.reload(true);
      return;
    }
    localStorage.setItem('uap_app_version', data.v);
  } catch (e) {
    // Sin red — continuar con la versión cacheada sin interrumpir
  }
}

function initApp() {
  // Comprobar si hay una versión nueva disponible
  checkForUpdates();

  // Cargar PIN guardado o establecer el por defecto
  const savedPin = localStorage.getItem('uap_admin_pin');
  if (savedPin) appState.adminPin = savedPin;

  // Registrar Service Worker para soporte offline PWA
  registerServiceWorker();

  // Intentar cargar Firebase
  setupFirebase();

  // Inicializar Interfaz de Usuario
  initUI();

  // Manejar el enrutamiento inicial basado en hash
  const initialHash = window.location.hash.substring(1);
  const validTabs = ['dashboard', 'map', 'teams', 'timeline', 'directory', 'admin'];
  const startTab = validTabs.includes(initialHash) ? initialHash : 'dashboard';
  
  // Guardar estado inicial en el historial
  history.replaceState({ tab: startTab }, '', '#' + startTab);
  switchTab(startTab, false);

  // Escuchar el evento popstate del navegador (botón Atrás/Adelante)
  window.addEventListener('popstate', (event) => {
    if (event.state && event.state.tab) {
      switchTab(event.state.tab, false);
    } else {
      switchTab('dashboard', false);
    }
  });

  // Ocultar pantalla de carga con retardo para suavizar
  setTimeout(() => {
    const loader = document.getElementById('app-loader');
    if (loader) {
      loader.style.opacity = '0';
      setTimeout(() => loader.style.display = 'none', 500);
    }
  }, 800);
}

// Referencia al Service Worker nuevo que está "en espera" (waiting).
// La guardamos al detectarlo para no depender de volver a consultarlo en el clic.
let swEnEspera = null;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('./sw.js').then((reg) => {
    console.log('[PWA] Service Worker registrado:', reg.scope);

    const mostrarBanner = (sw) => {
      swEnEspera = sw; // recordar el worker concreto al que avisar después
      const banner = document.getElementById('update-banner');
      if (banner) banner.style.display = 'flex';
    };

    // SW nuevo esperando (ya había uno activo antes)
    if (reg.waiting) { mostrarBanner(reg.waiting); return; }

    reg.addEventListener('updatefound', () => {
      const nuevoSW = reg.installing;
      nuevoSW.addEventListener('statechange', () => {
        if (nuevoSW.state === 'installed' && navigator.serviceWorker.controller) {
          mostrarBanner(nuevoSW);
        }
      });
    });
  }).catch((err) => {
    console.warn('[PWA] Fallo al registrar el Service Worker:', err);
  });

  // Recargar todas las pestañas cuando el SW nuevo toma el control
  let refrescando = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refrescando) { refrescando = true; window.location.reload(); }
  });
}

window.aplicarActualizacion = function() {
  // Red de seguridad: si en 3 s la página no se ha recargado sola
  // (controllerchange no llegó), forzamos limpieza de cachés y recarga.
  const redDeSeguridad = () => setTimeout(() => window.forzarActualizacion(), 3000);

  // Camino normal: avisar al SW en espera para que tome el control de inmediato.
  if (swEnEspera) {
    swEnEspera.postMessage({ type: 'SKIP_WAITING' });
    redDeSeguridad();
    return;
  }

  // No teníamos la referencia: intentar recuperarla una última vez.
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (reg?.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      redDeSeguridad();
    } else {
      // No hay worker en espera localizable: forzar limpieza y recarga directamente.
      window.forzarActualizacion();
    }
  }).catch(() => window.forzarActualizacion());
};

window.forzarActualizacion = async function() {
  showToast("Limpiando caché y actualizando...", "info");
  try {
    // Desregistrar todos los Service Workers
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(r => r.unregister()));
    // Borrar todas las cachés
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(name => caches.delete(name)));
  } catch (e) {
    console.warn("Error al limpiar caché:", e);
  }
  window.location.reload(true);
};

// --- CONFIGURACIÓN DE FIREBASE ---

// Carga los SDKs de Firebase desde el CDN solo cuando se necesitan
function loadFirebaseScripts() {
  return new Promise((resolve, reject) => {
    if (window.firebase) { resolve(); return; }
    const s1 = document.createElement('script');
    s1.src = 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js';
    s1.onload = () => {
      const s2 = document.createElement('script');
      s2.src = 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js';
      s2.onload = resolve;
      s2.onerror = () => reject(new Error('No se pudo cargar firebase-firestore'));
      document.head.appendChild(s2);
    };
    s1.onerror = () => reject(new Error('No se pudo cargar firebase-app'));
    document.head.appendChild(s1);
  });
}

// Configuración de producción (siempre activa)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCtQtD1nux76h3OBiCcIOUCTZ9PtvAklos",
  authDomain: "leonxiv-tenerife.firebaseapp.com",
  projectId: "leonxiv-tenerife",
  storageBucket: "leonxiv-tenerife.firebasestorage.app",
  messagingSenderId: "732075057423",
  appId: "1:732075057423:web:946134c360814f0dd5de7a"
};

function setupFirebase() {
  // Usar config del panel admin si existe, si no la config de producción
  let config = FIREBASE_CONFIG;
  const savedConfig = localStorage.getItem('uap_firebase_config');
  if (savedConfig) {
    try {
      config = JSON.parse(savedConfig);
    } catch (e) {
      console.warn("Config de Firebase en localStorage corrupta, usando config de producción");
    }
  }

  // Siempre conectar a Firebase → cargar SDK dinámicamente
  loadFirebaseScripts()
    .then(() => {
      if (firebase.apps.length > 0) firebase.app().delete();
      firebase.initializeApp(config);
      appState.db = firebase.firestore();
      appState.db.enablePersistence({ synchronizeTabs: true })
        .catch(err => {
          if (err.code === 'failed-precondition') console.warn("Persistencia fallida: varias pestañas abiertas");
          else if (err.code === 'unimplemented') console.warn("El navegador no soporta persistencia offline de Firestore");
        });
      appState.firebaseEnabled = true;
      updateNetworkBadge(true);
      showToast("Conectado con Firebase Cloud", "success");
      listenToFirestore();
    })
    .catch(error => {
      console.error("Error al cargar o inicializar Firebase:", error);
      appState.firebaseEnabled = false;
      updateNetworkBadge(false);
      showToast("Error de Firebase. Operando en MODO LOCAL.", "warning");
      loadLocalData();
    });
}

// Ordena eventos: primero por fecha (sin fecha al final), luego por hora
function compararEventos(a, b) {
  const fechaA = a.date || 'ZZZZ';
  const fechaB = b.date || 'ZZZZ';
  if (fechaA !== fechaB) return fechaA.localeCompare(fechaB);
  return (a.time || '').localeCompare(b.time || '');
}

// Escuchas en tiempo real desde Firestore
function listenToFirestore() {
  if (!appState.db) return;

  // Escuchar Equipos
  appState.db.collection('equipos').onSnapshot(snapshot => {
    let teams = [];
    snapshot.forEach(doc => {
      teams.push({ id: doc.id, ...doc.data() });
    });
    if (teams.length === 0) {
      seedFirestoreData('equipos', DEFAULT_TEAMS);
    }
    appState.teams = teams;
    renderTeams();
    updateMapMarkers();
    updateDashboardStats();
    if (appState.isAdmin) renderAdminLists();
  }, error => {
    console.error("Error escuchando equipos:", error);
    showToast("Error de sincronización de equipos", "danger");
  });

  // Escuchar Eventos
  appState.db.collection('eventos').onSnapshot(snapshot => {
    let events = [];
    snapshot.forEach(doc => {
      events.push({ id: doc.id, ...doc.data() });
    });
    if (events.length === 0) {
      seedFirestoreData('eventos', DEFAULT_EVENTS);
    }
    events.sort(compararEventos);
    appState.events = events;
    renderEvents();
    updateDashboardStats();
    if (appState.isAdmin) renderAdminLists();
  }, error => {
    console.error("Error escuchando eventos:", error);
  });

  // Escuchar Contactos
  appState.db.collection('contactos').onSnapshot(snapshot => {
    let contacts = [];
    snapshot.forEach(doc => {
      contacts.push({ id: doc.id, ...doc.data() });
    });
    if (contacts.length === 0) {
      seedFirestoreData('contactos', DEFAULT_CONTACTS);
    }
    appState.contacts = contacts;
    renderContacts();
    if (appState.isAdmin) renderAdminLists();
  }, error => {
    console.error("Error escuchando contactos:", error);
  });

  // Escuchar Ubicaciones (POIs)
  appState.db.collection('ubicaciones').onSnapshot(snapshot => {
    let locations = [];
    snapshot.forEach(doc => {
      locations.push({ id: doc.id, ...doc.data() });
    });
    if (locations.length === 0) {
      seedFirestoreData('ubicaciones', DEFAULT_LOCATIONS);
    }
    appState.locations = locations;
    updateMapOverlays();
    if (appState.isAdmin) renderAdminLists();
  }, error => {
    console.error("Error escuchando ubicaciones:", error);
  });

  // Escuchar Rutas e Itinerarios
  appState.db.collection('itinerarios').onSnapshot(snapshot => {
    let routes = [];
    snapshot.forEach(doc => {
      routes.push({ id: doc.id, ...doc.data() });
    });
    if (routes.length === 0) {
      seedFirestoreData('itinerarios', DEFAULT_ROUTES);
    }
    appState.routes = routes;
    renderRoutesPanel();
    updateMapOverlays();
    if (appState.isAdmin) renderAdminLists();
  }, error => {
    console.error("Error escuchando rutas:", error);
  });

  // Escuchar Canales y Frecuencias
  appState.db.collection('canales').onSnapshot(snapshot => {
    let channels = [];
    snapshot.forEach(doc => {
      channels.push({ id: doc.id, ...doc.data() });
    });
    appState.channels = channels;
    renderChannels();
    if (appState.isAdmin) renderAdminLists();
  }, error => {
    console.error("Error escuchando canales:", error);
  });
}

// Inyectar datos semilla en Firestore por primera vez
function seedFirestoreData(collectionName, dataArray) {
  if (!appState.db) return;
  const batch = appState.db.batch();
  dataArray.forEach(item => {
    const cleanItem = { ...item };
    delete cleanItem.id; // El ID lo autogenera Firestore
    const ref = appState.db.collection(collectionName).doc();
    batch.set(ref, cleanItem);
  });
  batch.commit().then(() => {
    console.log(`Colección ${collectionName} sembrada con éxito en Firestore.`);
  }).catch(err => {
    console.error(`Error al sembrar ${collectionName}:`, err);
  });
}

// Cargar datos locales de respaldo
function loadLocalData() {
  // Cargar de LocalStorage o usar valores semilla por defecto
  const localTeams = localStorage.getItem('uap_local_teams');
  const localEvents = localStorage.getItem('uap_local_events');
  const localContacts = localStorage.getItem('uap_local_contacts');
  const localLocations = localStorage.getItem('uap_local_locations');
  const localRoutes = localStorage.getItem('uap_local_routes');
  const localChannels = localStorage.getItem('uap_local_channels');

  appState.teams = localTeams ? JSON.parse(localTeams) : [...DEFAULT_TEAMS];
  appState.events = localEvents ? JSON.parse(localEvents) : [...DEFAULT_EVENTS];
  appState.contacts = localContacts ? JSON.parse(localContacts) : [...DEFAULT_CONTACTS];
  appState.channels = localChannels ? JSON.parse(localChannels) : [...DEFAULT_CHANNELS];
  // Descartar ubicaciones y rutas semilla antiguas (ids que empiezan por "seed-")
  const parsedLocs = localLocations ? JSON.parse(localLocations) : [];
  appState.locations = parsedLocs.filter(l => !l.id.startsWith('seed-'));
  const parsedRoutes = localRoutes ? JSON.parse(localRoutes) : [];
  appState.routes = parsedRoutes.filter(r => !r.id.startsWith('seed-'));

  // Ordenar eventos localmente
  appState.events.sort(compararEventos);

  renderTeams();
  renderEvents();
  renderContacts();
  renderChannels();
  renderRoutesPanel();
  updateMapMarkers();
  updateMapOverlays();
  updateDashboardStats();
  if (appState.isAdmin) renderAdminLists();
}

// Guardar datos en local (modo local)
function saveLocalData(type) {
  if (appState.firebaseEnabled) return; // Si corre Firebase, Firestore gestiona todo

  if (type === 'teams' || !type) {
    localStorage.setItem('uap_local_teams', JSON.stringify(appState.teams));
    renderTeams();
    updateMapMarkers();
    updateDashboardStats();
  }
  if (type === 'events' || !type) {
    appState.events.sort(compararEventos);
    localStorage.setItem('uap_local_events', JSON.stringify(appState.events));
    renderEvents();
  }
  if (type === 'contacts' || !type) {
    localStorage.setItem('uap_local_contacts', JSON.stringify(appState.contacts));
    renderContacts();
  }
  if (type === 'locations' || !type) {
    localStorage.setItem('uap_local_locations', JSON.stringify(appState.locations));
    updateMapOverlays();
  }
  if (type === 'routes' || !type) {
    localStorage.setItem('uap_local_routes', JSON.stringify(appState.routes));
    updateMapOverlays();
  }
  if (type === 'channels' || !type) {
    localStorage.setItem('uap_local_channels', JSON.stringify(appState.channels));
    renderChannels();
  }

  if (appState.isAdmin) renderAdminLists();
}

// Actualizar indicador de red
function updateNetworkBadge(online) {
  const badge = document.getElementById('network-status');
  const text = document.getElementById('network-text');
  if (!badge || !text) return;

  if (online) {
    badge.className = 'connection-badge';
    text.textContent = 'CLOUD-SYNC';
  } else {
    badge.className = 'connection-badge offline';
    text.textContent = 'MODO LOCAL';
  }
}


// --- INICIALIZAR Y GESTIONAR MAPA LEAFLET ---
function initMap() {
  if (appState.map) return; // Ya inicializado

  // Centrar el mapa en la coordenada semilla del proyecto
  const defaultCenter = [SEED_COORDS[1].lat, SEED_COORDS[1].lng];
  appState.map = L.map('map', {
    zoomControl: false, // Lo reposicionamos más tarde
    attributionControl: false
  }).setView(defaultCenter, 13);

  // Añadir control de zoom abajo a la derecha
  L.control.zoom({ position: 'bottomright' }).addTo(appState.map);

  // Cargar capa base táctica de OpenStreetMap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
  }).addTo(appState.map);

  // Forzar actualización del mapa tras su creación por problemas de redimensión del div oculto
  setTimeout(() => {
    appState.map.invalidateSize();
  }, 400);

  updateMapMarkers();
  updateMapOverlays();

  // Escuchar clicks en el mapa para capturar coordenadas de manera intuitiva
  appState.map.on('click', (e) => {
    const lat = e.latlng.lat.toFixed(6);
    const lng = e.latlng.lng.toFixed(6);

    // Modo selección de posición de equipo
    const teamBanner = document.getElementById('team-pick-banner');
    if (teamBanner && teamBanner.style.display === 'flex') {
      document.getElementById('team-lat').value = lat;
      document.getElementById('team-lng').value = lng;
      L.circleMarker([parseFloat(lat), parseFloat(lng)], {
        radius: 7, color: 'hsl(var(--gold-papal))', fillColor: 'hsl(var(--gold-papal))', fillOpacity: 0.9, weight: 2
      }).addTo(appState.map).bindTooltip('Posición equipo', { permanent: true, direction: 'top', offset: [0, -10] });
      teamBanner.style.display = 'none';
      document.getElementById('modal-team').style.visibility = 'visible';
      actualizarDisplayCoordsEquipo();
      return;
    }

    // Modo selección de punto único para ubicación
    const locBanner = document.getElementById('location-pick-banner');
    if (locBanner && locBanner.style.display === 'flex') {
      document.getElementById('location-lat').value = lat;
      document.getElementById('location-lng').value = lng;
      L.circleMarker([parseFloat(lat), parseFloat(lng)], {
        radius: 7, color: '#7c5cfc', fillColor: '#7c5cfc', fillOpacity: 0.9, weight: 2
      }).addTo(appState.map).bindTooltip('Ubicación', { permanent: true, direction: 'top', offset: [0, -10] });
      locBanner.style.display = 'none';
      document.getElementById('modal-location').style.visibility = 'visible';
      return;
    }

    // Modo selección de puntos para itinerario (modal oculto, banner visible)
    const banner = document.getElementById('map-pick-banner');
    if (banner && banner.style.display === 'flex') {
      _puntosSeleccionados.push({ lat, lng });

      if (_modoSeleccionTarget) {
        // Punto único (origen/destino): finalizar automáticamente tras el primer clic
        L.circleMarker([parseFloat(lat), parseFloat(lng)], {
          radius: 7, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.9, weight: 2
        }).addTo(appState.map).bindTooltip(_modoSeleccionTarget === 'route-origen' ? 'Origen' : 'Destino',
          { permanent: true, direction: 'top', offset: [0, -10] });
        setTimeout(() => finalizarModoSeleccionMapa(), 300);
      } else {
        // Múltiples puntos: añadir marcador numerado
        document.getElementById('map-pick-count').textContent =
          `${_puntosSeleccionados.length} punto${_puntosSeleccionados.length !== 1 ? 's' : ''}`;
        L.circleMarker([parseFloat(lat), parseFloat(lng)], {
          radius: 6, color: 'hsl(var(--gold-papal))', fillColor: 'hsl(var(--gold-papal))',
          fillOpacity: 0.9, weight: 2
        }).addTo(appState.map).bindTooltip(`${_puntosSeleccionados.length}`,
          { permanent: true, direction: 'top', offset: [0, -8] });
      }
      return;
    }

    const modalTeam = document.getElementById('modal-team');
    if (modalTeam && modalTeam.classList.contains('active')) {
      document.getElementById('team-lat').value = lat;
      document.getElementById('team-lng').value = lng;
      showToast(`📍 Coordenadas fijadas en Equipo: ${lat}, ${lng}`, "info");
    } else if (appState.isAdmin) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(`${lat}, ${lng}`);
        showToast(`📋 Coordenadas copiadas al portapapeles: ${lat}, ${lng}`, "success");
      }
    }
  });
}

// Actualizar marcadores tácticos en el mapa
function updateMapMarkers() {
  if (!appState.map) return;

  // Eliminar marcadores que ya no existen
  Object.keys(appState.mapMarkers).forEach(id => {
    const found = appState.teams.find(t => t.id === id);
    if (!found) {
      appState.map.removeLayer(appState.mapMarkers[id]);
      delete appState.mapMarkers[id];
    }
  });

  // Dibujar o actualizar marcadores
  appState.teams.forEach(team => {
    const lat = parseFloat(team.lat);
    const lng = parseFloat(team.lng);
    if (isNaN(lat) || isNaN(lng)) return;

    // Icono y color según tipos (HELO tiene prioridad visual, luego CUAS, luego UAS)
    const tipos = (team.type || 'UAS').split(',');
    const primerTipo = tipos.includes('HELO') ? 'HELO' : (tipos.includes('CUAS') ? 'CUAS' : 'UAS');
    const colorHex = primerTipo === 'HELO' ? 'hsl(var(--gold-papal))' : (primerTipo === 'CUAS' ? 'hsl(var(--danger))' : 'hsl(var(--police-blue))');
    const iconoEmoji = tipos.map(t => t === 'HELO' ? '🚁' : (t === 'CUAS' ? '🛡️' : '🛸')).join('');
    const badgesPopup = tipos.map(t => {
      const cl = t === 'HELO' ? 'badge-gold' : (t === 'CUAS' ? 'badge-red' : 'badge-blue');
      return `<span class="badge ${cl}">${t}</span>`;
    }).join(' ');

    // Contenido del popup táctico con enlaces de navegación
    const popupContent = `
      <div class="map-popup-card">
        <div class="map-popup-header">
          <span class="map-popup-title">${team.callsign}</span>
          <div style="display:flex;gap:3px;flex-wrap:wrap;">${badgesPopup}</div>
        </div>
        <div class="map-popup-body">
          <strong>Sector:</strong> ${team.sector}<br>
          ${team.officers ? `<strong>Dotación:</strong> ${team.officers}<br>` : ''}
          ${team.phone ? `<strong>Tlf:</strong> <a href="tel:${team.phone}" style="color: hsl(var(--police-blue)); font-weight: 600;">${team.phone}</a><br>` : ''}
          <strong>Radio:</strong> ${team.freq || 'Sin asignar'}<br>
          ${team.notes ? `<div style="margin-top: 4px; border-top: 1px solid var(--border-color); padding-top: 4px; font-style: italic; font-size: 0.75rem;">${team.notes}</div>` : ''}
        </div>
        <div class="map-popup-footer">
          <button class="btn btn-sm" onclick="navigateTo(${lat}, ${lng})" style="font-size: 0.75rem; min-height: 32px; padding: 4px 10px;">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 2a8 8 0 00-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 00-8-8z"/><circle cx="12" cy="10" r="3"/></svg>
            Navegar GPS
          </button>
        </div>
      </div>
    `;

    // Icono HTML
    const tacticalIconHtml = `
      <div class="tactical-marker-icon">
        <div class="marker-pulse" style="background: ${colorHex}44;"></div>
        <div class="marker-pin" style="background: ${colorHex};"></div>
        <div class="marker-inner-icon" style="font-size:${tipos.length > 1 ? '0.65rem' : '1rem'};">${iconoEmoji}</div>
      </div>
    `;

    const customIcon = L.divIcon({
      html: tacticalIconHtml,
      className: 'custom-div-icon',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      popupAnchor: [0, -16]
    });

    if (appState.mapMarkers[team.id]) {
      // Actualizar posición y contenido de popup si el marcador ya existe
      appState.mapMarkers[team.id].setLatLng([lat, lng]);
      appState.mapMarkers[team.id].getPopup().setContent(popupContent);
    } else {
      // Crear nuevo marcador
      const marker = L.marker([lat, lng], { icon: customIcon })
        .addTo(appState.map)
        .bindPopup(popupContent);
      appState.mapMarkers[team.id] = marker;
    }
  });

  // Actualizar el contador flotante del mapa
  const activeCount = Object.keys(appState.mapMarkers).length;
  const countSpan = document.getElementById('map-counter-active');
  if (countSpan) countSpan.textContent = activeCount;
}

// Distancia en km entre dos coordenadas (fórmula de Haversine)
function distanciaKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Devuelve el HTML con los equipos cercanos a unas coordenadas (radio en km)
function htmlEquiposCercanos(lat, lng, radioKm = 2.0) {
  const cercanos = appState.teams.filter(t => {
    const tLat = parseFloat(t.lat);
    const tLng = parseFloat(t.lng);
    return !isNaN(tLat) && !isNaN(tLng) && distanciaKm(lat, lng, tLat, tLng) <= radioKm;
  });

  if (cercanos.length === 0) return '';

  const typeIcon = { HELO: '🚁', UAS: '🛸', CUAS: '🛡️' };
  const items = cercanos.map(t => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding: 5px 0; border-bottom: 1px solid var(--border-color);">
      <div>
        <span style="font-weight:600;">${typeIcon[t.type] || '📡'} ${t.callsign}</span>
        <span style="display:block; font-size:0.73rem; color:hsl(var(--text-muted));">${t.sector}</span>
      </div>
      <div style="display:flex; gap:6px; flex-shrink:0; margin-left:8px;">
        ${t.phone ? `<a href="tel:${t.phone}" class="btn btn-sm btn-secondary" style="font-size:0.72rem; padding:3px 8px; min-height:unset;">📞</a>` : ''}
        <button class="btn btn-sm" onclick="navigateTo(${parseFloat(t.lat)},${parseFloat(t.lng)})" style="font-size:0.72rem; padding:3px 8px; min-height:unset;">📍</button>
      </div>
    </div>`).join('');

  return `
    <div style="margin-top:8px; border-top:1px solid var(--border-color); padding-top:8px;">
      <div style="font-size:0.75rem; font-weight:700; text-transform:uppercase; color:hsl(var(--police-blue)); margin-bottom:4px;">Equipos en zona (${cercanos.length})</div>
      ${items}
    </div>`;
}

// Actualizar ubicaciones (POIs) y rutas de itinerario en el mapa
function updateMapOverlays() {
  if (!appState.map) return;

  // --- Limpiar overlays anteriores ---
  Object.values(appState.mapOverlays.locations).forEach(m => appState.map.removeLayer(m));
  appState.mapOverlays.locations = {};
  appState.mapOverlays.routes.forEach(r => appState.map.removeLayer(r));
  appState.mapOverlays.routes = [];

  // --- Dibujar POIs (ubicaciones de interés) ---
  appState.locations.forEach(loc => {
    const lat = parseFloat(loc.lat);
    const lng = parseFloat(loc.lng);
    if (isNaN(lat) || isNaN(lng)) return;

    const colorMap = { VIP: 'hsl(var(--gold-papal))', RESTRINGIDO: 'hsl(var(--danger))', PMA: '#7c5cfc' };
    const color = colorMap[loc.type] || 'hsl(var(--police-blue))';
    const badgeClass = loc.type === 'VIP' ? 'badge-gold' : (loc.type === 'RESTRINGIDO' ? 'badge-red' : 'badge-blue');

    const iconHtml = `
      <div class="tactical-marker-icon">
        <div class="marker-pulse" style="background: ${color}44;"></div>
        <div class="marker-pin" style="background: ${color};"></div>
        <div class="marker-inner-icon">📍</div>
      </div>`;

    const buildPopup = () => `
      <div class="map-popup-card" style="max-width:280px;">
        <div class="map-popup-header">
          <span class="map-popup-title">${loc.name}</span>
          <span class="badge ${badgeClass}">${loc.type}</span>
        </div>
        <div class="map-popup-body">${loc.desc || ''}</div>
        <div class="map-popup-footer">
          <button class="btn btn-sm" onclick="navigateTo(${lat},${lng})" style="font-size:0.75rem; min-height:32px; padding:4px 10px;">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 2a8 8 0 00-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 00-8-8z"/><circle cx="12" cy="10" r="3"/></svg>
            Navegar GPS
          </button>
        </div>
        ${htmlEquiposCercanos(lat, lng)}
      </div>`;

    const marker = L.marker([lat, lng], {
      icon: L.divIcon({ html: iconHtml, className: 'custom-div-icon', iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16] })
    }).addTo(appState.map).bindPopup(buildPopup(), { maxWidth: 300 });

    appState.mapOverlays.locations[loc.id] = marker;
  });

  // --- Dibujar rutas / itinerarios (solo las visibles) ---
  appState.routes.forEach(route => {
    if (appState.routeVisibility[route.id] === false) return;
    if (!route.coordinates) return;
    const latlngs = route.coordinates.trim().split('\n').map(line => {
      const parts = line.split(',');
      const lat = parseFloat(parts[0]);
      const lng = parseFloat(parts[1]);
      return isNaN(lat) || isNaN(lng) ? null : [lat, lng];
    }).filter(Boolean);

    if (latlngs.length < 2) return;

    const color = route.color || 'hsl(var(--police-blue))';
    const polyline = L.polyline(latlngs, { color, weight: 4, opacity: 0.85, dashArray: '8 5' })
      .addTo(appState.map)
      .bindPopup(`<div class="map-popup-card"><div class="map-popup-header"><span class="map-popup-title">${route.name}</span></div><div class="map-popup-body">${route.desc || ''}</div></div>`);

    appState.mapOverlays.routes.push(polyline);
  });
}

// Navegación GPS (Abre la app nativa de mapas)
function navigateTo(lat, lng) {
  // Soporte universal para redirección a mapas móviles
  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  window.open(url, '_blank');
}


// --- NAVEGACIÓN SPA ---
function switchTab(tabName, pushHistory = true) {
  appState.activeTab = tabName;
  
  // Cambiar clases de pestañas activas en el contenido
  document.querySelectorAll('.tab-view').forEach(view => {
    view.classList.remove('active');
  });
  const activeView = document.getElementById(`${tabName}-tab`);
  if (activeView) activeView.classList.add('active');

  // Cambiar clases de botones activos en el menú
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Mapear pestaña con index del nav
  const indexMap = {
    'dashboard': 0,
    'map': 1,
    'teams': 2,
    'timeline': 3,
    'directory': 4,
    'admin': 5
  };
  
  const navBtns = document.querySelectorAll('.nav-item');
  if (navBtns[indexMap[tabName]]) {
    navBtns[indexMap[tabName]].classList.add('active');
  }

  // Si abrimos la pestaña del mapa, necesitamos redimensionar Leaflet
  if (tabName === 'map') {
    initMap();
    if (appState.map) {
      setTimeout(() => {
        appState.map.invalidateSize();
      }, 100);
    }
  }

  // Sincronizar el historial del navegador si es necesario
  if (pushHistory) {
    history.pushState({ tab: tabName }, '', '#' + tabName);
  }

  // Hacer scroll de la ventana al principio (arriba) de forma nativa
  window.scrollTo(0, 0);
}
window.switchTab = switchTab;


// --- RENDERIZADO DE INTERFAZ ---

// Renderizar Equipos
function renderTeams() {
  const container = document.getElementById('teams-container');
  if (!container) return;

  const searchQuery = document.getElementById('search-teams').value.toLowerCase();
  const filterType = document.getElementById('filter-team-type').value;

  // Filtrar
  const filtered = appState.teams.filter(team => {
    const matchSearch = 
      team.callsign.toLowerCase().includes(searchQuery) ||
      team.sector.toLowerCase().includes(searchQuery) ||
      (team.officers && team.officers.toLowerCase().includes(searchQuery)) ||
      (team.freq && team.freq.toLowerCase().includes(searchQuery));
    
    const matchType = filterType === 'todos' || (team.type || '').split(',').includes(filterType);

    return matchSearch && matchType;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="card" style="text-align: center; color: var(--text-secondary);">
        No se encontraron equipos bajo los criterios de búsqueda.
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(team => {
    const lat = parseFloat(team.lat);
    const lng = parseFloat(team.lng);
    const tipos = (team.type || 'UAS').split(',');
    const iconMap = { HELO: '🚁', UAS: '🛸', CUAS: '🛡️' };
    const classMap = { HELO: 'badge-gold', UAS: 'badge-blue', CUAS: 'badge-red' };
    const icono = tipos.map(t => iconMap[t] || '📡').join('');
    const badges = tipos.map(t => `<span class="badge ${classMap[t] || 'badge-blue'}">${t}</span>`).join(' ');

    return `
      <div class="team-card">
        <div class="team-header">
          <div class="team-callsign">
            <span class="team-callsign-type-icon">${icono}</span>
            <span>${team.callsign}</span>
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">${badges}</div>
        </div>
        <div class="team-grid">
          <div>
            <div class="team-info-label">Sector / Posición</div>
            <div class="team-info-val">${team.sector}</div>
          </div>
          <div>
            <div class="team-info-label">Frecuencia / Radio</div>
            <div class="team-info-val">${team.freq || 'Ninguna'}</div>
          </div>
          <div style="grid-column: span 2; margin-top: 6px;">
            <div class="team-info-label">Dotación Policial</div>
            <div class="team-info-val">${team.officers || 'Sin asignar'}</div>
          </div>
          ${team.notes ? `
          <div style="grid-column: span 2; margin-top: 6px; border-top: 1px dashed var(--border-color); padding-top: 6px; color: var(--text-secondary); font-style: italic;">
            <div class="team-info-label">Instrucciones Operativas</div>
            <div>${team.notes}</div>
          </div>` : ''}
        </div>
        <div class="team-actions">
          ${team.phone ? `
          <a href="tel:${team.phone}" class="btn btn-secondary btn-sm" style="flex: 1;">
            📞 Llamar
          </a>` : ''}
          <button class="btn btn-sm" onclick="navigateTo(${lat}, ${lng})" style="flex: 1.5;">
            📍 Ruta GPS
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Formatea "YYYY-MM-DD" como "Martes, 3 de junio de 2025" en español
function formatearFechaEvento(dateStr) {
  if (!dateStr) return 'Fecha no especificada';
  const [year, month, day] = dateStr.split('-').map(Number);
  const fecha = new Date(Date.UTC(year, month - 1, day));
  return fecha.toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

// Renderizar Eventos / Agenda
function renderEvents() {
  const container = document.getElementById('timeline-container');
  if (!container) return;

  if (appState.events.length === 0) {
    container.innerHTML = `
      <div class="card" style="text-align: center; color: var(--text-secondary);">
        No hay hitos programados en la agenda.
      </div>
    `;
    return;
  }

  // Agrupar eventos por fecha (los sin fecha van bajo la clave '')
  const grupos = {};
  appState.events.forEach(event => {
    const clave = event.date || '';
    if (!grupos[clave]) grupos[clave] = [];
    grupos[clave].push(event);
  });

  // Ordenar las claves: fechas reales primero (cronológico), sin fecha al final
  const claves = Object.keys(grupos).sort((a, b) => {
    if (a === '' && b === '') return 0;
    if (a === '') return 1;
    if (b === '') return -1;
    return a.localeCompare(b);
  });

  container.innerHTML = claves.map(clave => {
    const titulo = formatearFechaEvento(clave || null);
    const itemsHtml = grupos[clave].map(event => {
      const isVip = event.vip === 'si';
      const fechaCorta = event.date ? new Date(event.date + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }).replace('.', '') : '';
      return `
        <div class="timeline-item ${isVip ? 'vip' : ''}">
          <div class="timeline-time">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <span class="timeline-date-time">${event.time} H${fechaCorta ? ` · ${fechaCorta}` : ''}</span>
          </div>
          <div class="timeline-card">
            <div class="timeline-title">${event.title}</div>
            <div class="timeline-desc">${event.desc}</div>
            ${appState.isAdmin ? `
            <div class="admin-inline-actions">
              <button class="btn btn-sm btn-secondary" onclick="openEditEventModal('${event.id}')">Editar</button>
              <button class="btn btn-sm btn-danger" onclick="deleteItem('eventos', '${event.id}', 'events')">Borrar</button>
            </div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="timeline-day-group">
        <div class="timeline-day-header">${titulo}</div>
        ${itemsHtml}
      </div>
    `;
  }).join('');
}

// Renderizar Contactos
function renderContacts() {
  const container = document.getElementById('contacts-container');
  if (!container) return;

  if (appState.contacts.length === 0) {
    container.innerHTML = `
      <div class="card" style="text-align: center; color: var(--text-secondary);">
        No hay contactos registrados.
      </div>
    `;
    return;
  }

  container.innerHTML = appState.contacts.map(contact => {
    return `
      <div class="contact-card">
        <div class="contact-info">
          <span class="contact-name">${contact.name}</span>
          <span class="contact-role">${contact.role}</span>
          <span class="contact-phone">${contact.phone}</span>
          ${appState.isAdmin ? `
          <div class="admin-inline-actions">
            <button class="btn btn-sm btn-secondary" onclick="openEditContactModal('${contact.id}')">Editar</button>
            <button class="btn btn-sm btn-danger" onclick="deleteItem('contactos', '${contact.id}', 'contacts')">Borrar</button>
          </div>` : ''}
        </div>
        <a href="tel:${contact.phone}" class="contact-call-btn">
          <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </a>
      </div>
    `;
  }).join('');
}

// Renderizar panel de itinerarios en el mapa
function renderRoutesPanel() {
  const panel = document.getElementById('routes-panel');
  const handle = document.getElementById('routes-panel-handle');
  const list = document.getElementById('routes-panel-list');
  const counter = document.getElementById('routes-panel-counter');
  if (!panel || !handle || !list || !counter) return;

  if (appState.routes.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';

  // Inicializar visibilidad para rutas nuevas (por defecto visible)
  appState.routes.forEach(route => {
    if (appState.routeVisibility[route.id] === undefined) {
      appState.routeVisibility[route.id] = true;
    }
  });

  // Limpiar rutas eliminadas del estado de visibilidad
  const activeIds = new Set(appState.routes.map(r => r.id));
  Object.keys(appState.routeVisibility).forEach(id => {
    if (!activeIds.has(id)) delete appState.routeVisibility[id];
  });

  const visibles = appState.routes.filter(r => appState.routeVisibility[r.id] !== false).length;
  counter.textContent = `${visibles} / ${appState.routes.length}`;

  list.innerHTML = appState.routes.map(route => {
    const checked = appState.routeVisibility[route.id] !== false;
    const color = route.color || 'hsl(var(--police-blue))';
    return `
      <label class="route-panel-item">
        <span class="route-panel-dot" style="background:${color};"></span>
        <span class="route-panel-name">${route.name}</span>
        <input type="checkbox" class="route-panel-checkbox" ${checked ? 'checked' : ''}
          onchange="toggleRouteVisibility('${route.id}', this.checked)">
      </label>
    `;
  }).join('');
}

window.toggleRouteVisibility = function(id, visible) {
  appState.routeVisibility[id] = visible;
  updateMapOverlays();
  // Actualizar contador del tirador
  const counter = document.getElementById('routes-panel-counter');
  if (counter) {
    const visibles = appState.routes.filter(r => appState.routeVisibility[r.id] !== false).length;
    counter.textContent = `${visibles} / ${appState.routes.length}`;
  }
};

window.toggleRoutesPanel = function() {
  const list = document.getElementById('routes-panel-list');
  const arrow = document.getElementById('routes-panel-arrow');
  if (!list) return;
  const expanded = list.classList.toggle('expanded');
  if (arrow) arrow.textContent = expanded ? '↓' : '↑';
};

// Renderizar Canales y Frecuencias
function renderChannels() {
  const container = document.getElementById('channels-container');
  if (!container) return;

  if (appState.channels.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-secondary); padding: 12px 0;">
        No hay canales configurados.
      </div>
    `;
    return;
  }

  container.innerHTML = appState.channels.map(channel => {
    const badgeClass = channel.priority === 'emergency' ? 'badge-red' :
                       channel.priority === 'high' ? 'badge-gold' : 'badge-blue';
    const urgentClass = channel.priority === 'emergency' ? ' urgent' : '';
    return `
      <div class="alert-item${urgentClass}">
        <div class="alert-header">
          <span>${channel.name}</span>
          <span class="badge ${badgeClass}">${channel.type}</span>
        </div>
        <div>
          <strong>${channel.frequency}</strong>${channel.channel ? ' (Canal ' + channel.channel + ')' : ''}
          ${channel.description ? '<br>' + channel.description : ''}
        </div>
        ${appState.isAdmin ? `
        <div class="admin-inline-actions" style="margin-top:8px;">
          <button class="btn btn-sm btn-secondary" onclick="openEditChannelModal('${channel.id}')">Editar</button>
          <button class="btn btn-sm btn-danger" onclick="deleteItem('canales', '${channel.id}', 'channels')">Borrar</button>
        </div>` : ''}
      </div>
    `;
  }).join('');
}

// Actualizar Estadísticas en Dashboard
function updateDashboardStats() {
  const tiene = (team, tipo) => (team.type || '').split(',').includes(tipo);
  const uasCount  = appState.teams.filter(t => tiene(t, 'UAS')).length;
  const cuasCount = appState.teams.filter(t => tiene(t, 'CUAS')).length;
  const heloCount = appState.teams.filter(t => tiene(t, 'HELO')).length;
  const totalCount = appState.teams.length;

  const uasBadge = document.getElementById('stat-uas');
  const cuasBadge = document.getElementById('stat-cuas');
  const heloBadge = document.getElementById('stat-helo');
  const totalBadge = document.getElementById('stat-total');

  if (uasBadge) uasBadge.textContent = uasCount;
  if (cuasBadge) cuasBadge.textContent = cuasCount;
  if (heloBadge) heloBadge.textContent = heloCount;
  if (totalBadge) totalBadge.textContent = totalCount;
}


// --- SISTEMA DE GESTIÓN ADMINISTRATIVA ---

// Configuración y enlazado de botones admin en la inicialización
function initUI() {
  // Input y Filtro de Búsqueda de Equipos
  const searchInput = document.getElementById('search-teams');
  const typeFilter = document.getElementById('filter-team-type');
  
  if (searchInput) searchInput.addEventListener('input', renderTeams);
  if (typeFilter) typeFilter.addEventListener('change', renderTeams);

  // Botones de login/logout admin
  const loginBtn = document.getElementById('admin-login-btn');
  const logoutBtn = document.getElementById('admin-logout-btn');
  const pinInput = document.getElementById('admin-pin-input');

  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      if (pinInput.value === appState.adminPin) {
        setAdminAccess(true);
        pinInput.value = '';
      } else {
        showToast("PIN Incorrecto. Acceso Denegado.", "danger");
        pinInput.value = '';
      }
    });
  }

  // Permitir submit al pulsar ENTER
  if (pinInput) {
    pinInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') loginBtn.click();
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      setAdminAccess(false);
    });
  }

  // Importar / Exportar JSON
  const btnExport = document.getElementById('btn-export-json');
  const btnImport = document.getElementById('btn-import-json');
  const fileInput = document.getElementById('import-json-file');

  if (btnExport) {
    btnExport.addEventListener('click', exportDeploymentPlan);
  }

  if (btnImport) {
    btnImport.addEventListener('click', () => fileInput.click());
  }

  if (fileInput) {
    fileInput.addEventListener('change', importDeploymentPlan);
  }

}

// Establecer acceso administrativo
function setAdminAccess(granted) {
  appState.isAdmin = granted;

  // Añadir/quitar clase de administrador en el body
  document.body.classList.toggle('is-admin', granted);

  const loginCard = document.getElementById('admin-login-card');
  const adminContent = document.getElementById('admin-panel-content');

  if (granted) {
    loginCard.style.display = 'none';
    adminContent.style.display = 'block';
    renderAdminLists();
    showToast("Sesión de Administración Activa", "success");
  } else {
    loginCard.style.display = 'block';
    adminContent.style.display = 'none';
    showToast("Sesión Cerrada", "warning");
  }

  // Recargar vistas para renderizar u ocultar botones de edición contextual
  renderTeams();
  renderEvents();
  renderContacts();
  updateMapOverlays();
}

// Renderizar las listas dentro del panel de administración
function renderAdminLists() {
  const adminTeams = document.getElementById('admin-teams-list');
  const adminEvents = document.getElementById('admin-events-list');
  const adminContacts = document.getElementById('admin-contacts-list');
  const adminLocations = document.getElementById('admin-locations-list');
  const adminRoutes = document.getElementById('admin-routes-list');
  const adminChannels = document.getElementById('admin-channels-list');

  // Counters
  document.getElementById('admin-count-teams').textContent = appState.teams.length;
  document.getElementById('admin-count-events').textContent = appState.events.length;
  document.getElementById('admin-count-contacts').textContent = appState.contacts.length;
  if (document.getElementById('admin-count-locations')) {
    document.getElementById('admin-count-locations').textContent = appState.locations.length;
  }
  if (document.getElementById('admin-count-routes')) {
    document.getElementById('admin-count-routes').textContent = appState.routes.length;
  }
  if (document.getElementById('admin-count-channels')) {
    document.getElementById('admin-count-channels').textContent = appState.channels.length;
  }

  // Equipos Admin
  if (adminTeams) {
    adminTeams.innerHTML = appState.teams.map(team => `
      <div class="admin-list-item">
        <div class="admin-list-item-info">
          <span class="admin-list-item-title">${team.callsign} (${team.type})</span>
          <span class="admin-list-item-subtitle">${team.sector}</span>
        </div>
        <div class="admin-list-item-actions">
          <button class="btn btn-sm btn-secondary" onclick="openEditTeamModal('${team.id}')">Editar</button>
          <button class="btn btn-sm btn-danger" onclick="deleteItem('equipos', '${team.id}', 'teams')">Borrar</button>
        </div>
      </div>
    `).join('');
  }

  // Eventos Admin
  if (adminEvents) {
    adminEvents.innerHTML = appState.events.map(event => `
      <div class="admin-list-item">
        <div class="admin-list-item-info">
          <span class="admin-list-item-title">${event.date ? event.date + ' · ' : ''}${event.time} H - ${event.title}</span>
          <span class="admin-list-item-subtitle">${event.vip === 'si' ? '⭐ Comitiva VIP' : 'Normal'}</span>
        </div>
        <div class="admin-list-item-actions">
          <button class="btn btn-sm btn-secondary" onclick="openEditEventModal('${event.id}')">Editar</button>
          <button class="btn btn-sm btn-danger" onclick="deleteItem('eventos', '${event.id}', 'events')">Borrar</button>
        </div>
      </div>
    `).join('');
  }

  // Contactos Admin
  if (adminContacts) {
    adminContacts.innerHTML = appState.contacts.map(contact => `
      <div class="admin-list-item">
        <div class="admin-list-item-info">
          <span class="admin-list-item-title">${contact.name}</span>
          <span class="admin-list-item-subtitle">${contact.role} | ${contact.phone}</span>
        </div>
        <div class="admin-list-item-actions">
          <button class="btn btn-sm btn-secondary" onclick="openEditContactModal('${contact.id}')">Editar</button>
          <button class="btn btn-sm btn-danger" onclick="deleteItem('contactos', '${contact.id}', 'contacts')">Borrar</button>
        </div>
      </div>
    `).join('');
  }

  // Ubicaciones Admin
  if (adminLocations) {
    adminLocations.innerHTML = appState.locations.map(loc => `
      <div class="admin-list-item">
        <div class="admin-list-item-info">
          <span class="admin-list-item-title">${loc.name} (${loc.type})</span>
          <span class="admin-list-item-subtitle">${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}</span>
        </div>
        <div class="admin-list-item-actions">
          <button class="btn btn-sm btn-secondary" onclick="openEditLocationModal('${loc.id}')">Editar</button>
          <button class="btn btn-sm btn-danger" onclick="deleteItem('ubicaciones', '${loc.id}', 'locations')">Borrar</button>
        </div>
      </div>
    `).join('');
  }

  // Rutas Admin
  if (adminRoutes) {
    adminRoutes.innerHTML = appState.routes.map(route => {
      const pointCount = route.coordinates ? route.coordinates.split('\n').filter(Boolean).length : 0;
      return `
        <div class="admin-list-item">
          <div class="admin-list-item-info">
            <span class="admin-list-item-title">${route.name}</span>
            <span class="admin-list-item-subtitle">${pointCount} puntos | Color: ${route.color.replace('hsl(var(--', '').replace('))', '')}</span>
          </div>
          <div class="admin-list-item-actions">
            <button class="btn btn-sm btn-secondary" onclick="openEditRouteModal('${route.id}')">Editar</button>
            <button class="btn btn-sm btn-danger" onclick="deleteItem('itinerarios', '${route.id}', 'routes')">Borrar</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Canales Admin
  if (adminChannels) {
    adminChannels.innerHTML = appState.channels.length === 0
      ? '<div style="color:var(--text-secondary); font-size:0.85rem; padding:8px 0;">No hay canales registrados.</div>'
      : appState.channels.map(channel => `
        <div class="admin-list-item">
          <div class="admin-list-item-info">
            <span class="admin-list-item-title">${channel.name} (${channel.type})</span>
            <span class="admin-list-item-subtitle">${channel.frequency}${channel.channel ? ' · Canal ' + channel.channel : ''}</span>
          </div>
          <div class="admin-list-item-actions">
            <button class="btn btn-sm btn-secondary" onclick="openEditChannelModal('${channel.id}')">Editar</button>
            <button class="btn btn-sm btn-danger" onclick="deleteItem('canales', '${channel.id}', 'channels')">Borrar</button>
          </div>
        </div>
      `).join('');
  }
}


// --- FORMULARIOS CRUD ---

// --- OPERACIONES DE EQUIPOS ---
window.openAddTeamModal = function() {
  document.getElementById('form-team').reset();
  document.getElementById('team-id').value = '';
  document.getElementById('modal-team-title').textContent = 'Añadir Medio Aéreo / Equipo';
  actualizarDisplayCoordsEquipo();
  openModal('modal-team');
};

window.openEditTeamModal = function(id) {
  const team = appState.teams.find(t => t.id === id);
  if (!team) return;

  document.getElementById('team-id').value = team.id;
  document.getElementById('team-callsign').value = team.callsign;
  const tiposActivos = (team.type || '').split(',');
  ['HELO', 'UAS', 'CUAS'].forEach(t => {
    const cb = document.getElementById(`team-type-${t.toLowerCase()}`);
    if (cb) cb.checked = tiposActivos.includes(t);
  });
  document.getElementById('team-sector').value = team.sector;
  document.getElementById('team-lat').value = team.lat;
  document.getElementById('team-lng').value = team.lng;
  actualizarDisplayCoordsEquipo();
  document.getElementById('team-officers').value = team.officers || '';
  document.getElementById('team-phone').value = team.phone || '';
  document.getElementById('team-freq').value = team.freq || '';
  document.getElementById('team-notes').value = team.notes || '';

  document.getElementById('modal-team-title').textContent = 'Editar Medio Aéreo / Equipo';
  openModal('modal-team');
};

window.saveTeam = function() {
  const form = document.getElementById('form-team');
  if (!form.reportValidity()) return;

  const lat = normalizarInputCoordenada('team-lat');
  const lng = normalizarInputCoordenada('team-lng');
  if (isNaN(lat) || isNaN(lng)) {
    showToast("Formato de coordenadas no reconocido. Usa decimal (28.1003) o grados (28°6'1.4\"N).", "danger");
    return;
  }

  const tipos = ['HELO', 'UAS', 'CUAS'].filter(t =>
    document.getElementById(`team-type-${t.toLowerCase()}`)?.checked
  );
  if (tipos.length === 0) {
    showToast("Selecciona al menos un tipo de medio.", "warning");
    return;
  }

  const id = document.getElementById('team-id').value;
  const teamData = {
    callsign: document.getElementById('team-callsign').value,
    type: tipos.join(','),
    sector: document.getElementById('team-sector').value,
    lat,
    lng,
    officers: document.getElementById('team-officers').value,
    phone: document.getElementById('team-phone').value,
    freq: document.getElementById('team-freq').value,
    notes: document.getElementById('team-notes').value
  };

  if (appState.firebaseEnabled) {
    const col = appState.db.collection('equipos');
    let promise;
    if (id) {
      promise = col.doc(id).set(teamData);
    } else {
      promise = col.add(teamData);
    }
    promise.then(() => {
      showToast("Equipo guardado en la nube", "success");
      closeModal('modal-team');
    }).catch(err => {
      console.error(err);
      showToast("Error al guardar en la nube", "danger");
    });
  } else {
    // Local
    if (id) {
      const idx = appState.teams.findIndex(t => t.id === id);
      if (idx !== -1) {
        appState.teams[idx] = { id, ...teamData };
      }
    } else {
      const newId = 'team-' + Date.now();
      appState.teams.push({ id: newId, ...teamData });
    }
    saveLocalData('teams');
    showToast("Equipo guardado localmente", "success");
    closeModal('modal-team');
  }
};

// --- OPERACIONES DE EVENTOS ---
window.openAddEventModal = function() {
  document.getElementById('form-event').reset();
  document.getElementById('event-id').value = '';
  document.getElementById('modal-event-title').textContent = 'Añadir Hito en Agenda';
  openModal('modal-event');
};

window.openEditEventModal = function(id) {
  const event = appState.events.find(e => e.id === id);
  if (!event) return;

  document.getElementById('event-id').value = event.id;
  document.getElementById('event-title').value = event.title;
  document.getElementById('event-date').value = event.date || '';
  document.getElementById('event-time').value = event.time;
  document.getElementById('event-vip').value = event.vip;
  document.getElementById('event-desc').value = event.desc;

  document.getElementById('modal-event-title').textContent = 'Editar Hito en Agenda';
  openModal('modal-event');
};

window.saveEvent = function() {
  const form = document.getElementById('form-event');
  if (!form.reportValidity()) return;

  const id = document.getElementById('event-id').value;
  const eventData = {
    title: document.getElementById('event-title').value,
    date: document.getElementById('event-date').value,
    time: document.getElementById('event-time').value,
    vip: document.getElementById('event-vip').value,
    desc: document.getElementById('event-desc').value
  };

  if (appState.firebaseEnabled) {
    const col = appState.db.collection('eventos');
    let promise;
    if (id) {
      promise = col.doc(id).set(eventData);
    } else {
      promise = col.add(eventData);
    }
    promise.then(() => {
      showToast("Evento guardado en la nube", "success");
      closeModal('modal-event');
    }).catch(err => {
      console.error(err);
      showToast("Error al guardar evento", "danger");
    });
  } else {
    // Local
    if (id) {
      const idx = appState.events.findIndex(e => e.id === id);
      if (idx !== -1) {
        appState.events[idx] = { id, ...eventData };
      }
    } else {
      const newId = 'event-' + Date.now();
      appState.events.push({ id: newId, ...eventData });
    }
    saveLocalData('events');
    showToast("Evento guardado localmente", "success");
    closeModal('modal-event');
  }
};

// --- OPERACIONES DE CONTACTOS ---
window.openAddContactModal = function() {
  document.getElementById('form-contact').reset();
  document.getElementById('contact-id').value = '';
  document.getElementById('modal-contact-title').textContent = 'Añadir Contacto Directo';
  openModal('modal-contact');
};

window.openEditContactModal = function(id) {
  const contact = appState.contacts.find(c => c.id === id);
  if (!contact) return;

  document.getElementById('contact-id').value = contact.id;
  document.getElementById('contact-name').value = contact.name;
  document.getElementById('contact-role').value = contact.role;
  document.getElementById('contact-phone').value = contact.phone;

  document.getElementById('modal-contact-title').textContent = 'Editar Contacto Directo';
  openModal('modal-contact');
};

window.saveContact = function() {
  const form = document.getElementById('form-contact');
  if (!form.reportValidity()) return;

  const id = document.getElementById('contact-id').value;
  const contactData = {
    name: document.getElementById('contact-name').value,
    role: document.getElementById('contact-role').value,
    phone: document.getElementById('contact-phone').value
  };

  if (appState.firebaseEnabled) {
    const col = appState.db.collection('contactos');
    let promise;
    if (id) {
      promise = col.doc(id).set(contactData);
    } else {
      promise = col.add(contactData);
    }
    promise.then(() => {
      showToast("Contacto guardado en la nube", "success");
      closeModal('modal-contact');
    }).catch(err => {
      console.error(err);
      showToast("Error al guardar contacto", "danger");
    });
  } else {
    // Local
    if (id) {
      const idx = appState.contacts.findIndex(c => c.id === id);
      if (idx !== -1) {
        appState.contacts[idx] = { id, ...contactData };
      }
    } else {
      const newId = 'contact-' + Date.now();
      appState.contacts.push({ id: newId, ...contactData });
    }
    saveLocalData('contacts');
    showToast("Contacto guardado localmente", "success");
    closeModal('modal-contact');
  }
};

// --- OPERACIONES DE ITINERARIOS / RUTAS ---

// Normaliza el textarea de coordenadas: convierte cada línea de DMS a decimal si es necesario
function normalizarCoordsTextarea(textareaId) {
  const ta = document.getElementById(textareaId);
  if (!ta) return ta.value;
  const lineas = ta.value.trim().split('\n').map(linea => {
    linea = linea.trim();
    if (!linea) return null;
    // Separar los dos valores de la línea (lat,lng o "lat, lng")
    const partes = linea.split(/,(?![^°]*[NSEWnsew])/).map(p => p.trim()).filter(Boolean);
    if (partes.length < 2) return null;
    const lat = parseCoordenada(partes[0]);
    const lng = parseCoordenada(partes[1]);
    if (isNaN(lat) || isNaN(lng)) return null;
    return `${lat},${lng}`;
  }).filter(Boolean);
  ta.value = lineas.join('\n');
  return ta.value;
}

// --- MODO SELECCIÓN DE PUNTOS EN MAPA ---
let _puntosSeleccionados = [];
let _modoSeleccionTarget = null; // null = textarea de puntos, o ID del input de origen/destino

window.toggleSeccionRutaAuto = function(btn) {
  const sec = document.getElementById('ruta-auto-section');
  const visible = sec.style.display !== 'none';
  sec.style.display = visible ? 'none' : 'block';
  btn.textContent = visible
    ? '🗺️ Calcular ruta automática entre dos puntos ▸'
    : '🗺️ Calcular ruta automática entre dos puntos ▾';
};

window.activarModoSeleccionMapa = function(targetInputId) {
  _puntosSeleccionados = [];
  _modoSeleccionTarget = targetInputId || null;
  document.getElementById('modal-route').style.visibility = 'hidden';
  switchTab('map', false);

  const banner = document.getElementById('map-pick-banner');
  banner.style.display = 'flex';
  const esPuntoUnico = !!targetInputId;
  document.getElementById('map-pick-count').textContent = esPuntoUnico
    ? 'Haz clic para fijar el punto'
    : '0 puntos';

  if (!appState.map) initMap();
  setTimeout(() => appState.map && appState.map.invalidateSize(), 150);
};

window.finalizarModoSeleccionMapa = function() {
  document.getElementById('map-pick-banner').style.display = 'none';
  document.getElementById('modal-route').style.visibility = 'visible';

  if (_modoSeleccionTarget) {
    // Modo punto único: origen o destino
    if (_puntosSeleccionados.length > 0) {
      const p = _puntosSeleccionados[0];
      document.getElementById(_modoSeleccionTarget).value = `${p.lat},${p.lng}`;
    }
  } else {
    // Modo múltiples puntos: añadir al textarea
    if (_puntosSeleccionados.length > 0) {
      const ta = document.getElementById('route-coordinates');
      const existentes = ta.value.trim();
      const nuevos = _puntosSeleccionados.map(p => `${p.lat},${p.lng}`).join('\n');
      ta.value = existentes ? existentes + '\n' + nuevos : nuevos;
    }
  }
  _puntosSeleccionados = [];
  _modoSeleccionTarget = null;
};

window.cancelarModoSeleccionMapa = function() {
  document.getElementById('map-pick-banner').style.display = 'none';
  document.getElementById('modal-route').style.visibility = 'visible';
  _puntosSeleccionados = [];
  _modoSeleccionTarget = null;
};

// Reduce una lista de coordenadas a un máximo de puntos manteniendo inicio y fin
function simplificarRuta(coords, maxPuntos = 80) {
  if (coords.length <= maxPuntos) return coords;
  const paso = Math.ceil((coords.length - 2) / (maxPuntos - 2));
  const resultado = [coords[0]];
  for (let i = 1; i < coords.length - 1; i += paso) resultado.push(coords[i]);
  resultado.push(coords[coords.length - 1]);
  return resultado;
}

window.calcularRutaAutomatica = async function() {
  const btn = document.getElementById('btn-calcular-ruta');
  const origenStr = document.getElementById('route-origen').value.trim();
  const destinoStr = document.getElementById('route-destino').value.trim();

  if (!origenStr || !destinoStr) {
    showToast("Introduce origen y destino antes de calcular.", "warning");
    return;
  }

  // Parsear coordenadas de origen y destino (acepta "lat,lng" o "DMS,DMS")
  const parsearPar = (str) => {
    // Intentar separar por coma sin partir DMS (que ya tiene comas internas no)
    // Los DMS usan °, ', " pero no comas entre lat y lng — separamos por la primera coma fuera de DMS
    const idx = str.search(/,(?![^°]*[°])/);  // primera coma que no está dentro de grados
    if (idx === -1) return null;
    const lat = parseCoordenada(str.substring(0, idx).trim());
    const lng = parseCoordenada(str.substring(idx + 1).trim());
    return isNaN(lat) || isNaN(lng) ? null : { lat, lng };
  };

  const origen = parsearPar(origenStr);
  const destino = parsearPar(destinoStr);

  if (!origen) { showToast("Formato de origen no reconocido.", "danger"); return; }
  if (!destino) { showToast("Formato de destino no reconocido.", "danger"); return; }

  btn.textContent = 'Calculando...';
  btn.disabled = true;

  try {
    // OSRM usa orden lng,lat (inverso al habitual)
    const url = `https://router.project-osrm.org/route/v1/driving/${origen.lng},${origen.lat};${destino.lng},${destino.lat}?overview=full&geometries=geojson`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.code !== 'Ok' || !data.routes?.length) {
      showToast("OSRM no pudo calcular la ruta. Comprueba las coordenadas.", "danger");
      return;
    }

    // GeoJSON devuelve [lng, lat] — lo invertimos a lat,lng
    const coords = data.routes[0].geometry.coordinates;
    const puntos = simplificarRuta(coords).map(([lng, lat]) =>
      `${lat.toFixed(6)},${lng.toFixed(6)}`
    );

    document.getElementById('route-coordinates').value = puntos.join('\n');
    const km = (data.routes[0].distance / 1000).toFixed(2);
    showToast(`Ruta calculada: ${puntos.length} puntos · ${km} km`, "success");
  } catch (err) {
    console.error(err);
    showToast("Error de red al contactar con el servidor de rutas.", "danger");
  } finally {
    btn.textContent = 'Calcular ruta';
    btn.disabled = false;
  }
};

// --- OPERACIONES DE UBICACIONES ---

window.openAddLocationModal = function() {
  document.getElementById('form-location').reset();
  document.getElementById('location-id').value = '';
  document.getElementById('modal-location-title').textContent = 'Añadir Ubicación';
  openModal('modal-location');
};

window.openEditLocationModal = function(id) {
  const loc = appState.locations.find(l => l.id === id);
  if (!loc) return;
  document.getElementById('location-id').value = loc.id;
  document.getElementById('location-name').value = loc.name;
  document.getElementById('location-type').value = loc.type;
  document.getElementById('location-lat').value = loc.lat;
  document.getElementById('location-lng').value = loc.lng;
  document.getElementById('location-desc').value = loc.desc || '';
  document.getElementById('modal-location-title').textContent = 'Editar Ubicación';
  openModal('modal-location');
};

window.saveLocation = function() {
  const form = document.getElementById('form-location');
  if (!form.reportValidity()) return;

  const lat = normalizarInputCoordenada('location-lat');
  const lng = normalizarInputCoordenada('location-lng');
  if (isNaN(lat) || isNaN(lng)) {
    showToast("Formato de coordenadas no reconocido.", "danger");
    return;
  }

  const id = document.getElementById('location-id').value;
  const locData = {
    name: document.getElementById('location-name').value,
    type: document.getElementById('location-type').value,
    lat, lng,
    desc: document.getElementById('location-desc').value
  };

  if (appState.firebaseEnabled) {
    const col = appState.db.collection('ubicaciones');
    const promise = id ? col.doc(id).set(locData) : col.add(locData);
    promise.then(() => {
      showToast("Ubicación guardada en la nube", "success");
      closeModal('modal-location');
    }).catch(err => { console.error(err); showToast("Error al guardar", "danger"); });
  } else {
    if (id) {
      const idx = appState.locations.findIndex(l => l.id === id);
      if (idx !== -1) appState.locations[idx] = { id, ...locData };
    } else {
      appState.locations.push({ id: 'loc-' + Date.now(), ...locData });
    }
    saveLocalData('locations');
    showToast("Ubicación guardada localmente", "success");
    closeModal('modal-location');
  }
};

// Modo selección de punto en mapa para ubicación
// Actualiza el texto de coordenadas visible en el modal de equipo
function actualizarDisplayCoordsEquipo() {
  const lat = document.getElementById('team-lat').value;
  const lng = document.getElementById('team-lng').value;
  const display = document.getElementById('team-coords-display');
  if (display) {
    display.textContent = lat && lng
      ? `${parseFloat(lat).toFixed(6)}, ${parseFloat(lng).toFixed(6)}`
      : 'Sin posición fijada';
    display.style.color = lat && lng ? 'hsl(var(--gold-papal))' : 'var(--text-secondary)';
  }
}

window.activarModoSeleccionEquipo = function() {
  document.getElementById('modal-team').style.visibility = 'hidden';
  switchTab('map', false);
  document.getElementById('team-pick-banner').style.display = 'flex';
  if (!appState.map) initMap();
  setTimeout(() => appState.map && appState.map.invalidateSize(), 150);
};

window.cancelarModoSeleccionEquipo = function() {
  document.getElementById('team-pick-banner').style.display = 'none';
  document.getElementById('modal-team').style.visibility = 'visible';
};

window.activarModoSeleccionUbicacion = function() {
  document.getElementById('modal-location').style.visibility = 'hidden';
  switchTab('map', false);
  document.getElementById('location-pick-banner').style.display = 'flex';
  if (!appState.map) initMap();
  setTimeout(() => appState.map && appState.map.invalidateSize(), 150);
};

window.cancelarModoSeleccionUbicacion = function() {
  document.getElementById('location-pick-banner').style.display = 'none';
  document.getElementById('modal-location').style.visibility = 'visible';
};

window.openAddRouteModal = function() {
  document.getElementById('form-route').reset();
  document.getElementById('route-id').value = '';
  document.getElementById('modal-route-title').textContent = 'Añadir Itinerario';
  openModal('modal-route');
};

window.openEditRouteModal = function(id) {
  const route = appState.routes.find(r => r.id === id);
  if (!route) return;
  document.getElementById('route-id').value = route.id;
  document.getElementById('route-name').value = route.name;
  document.getElementById('route-color').value = route.color || 'hsl(var(--gold-papal))';
  document.getElementById('route-desc').value = route.desc || '';
  document.getElementById('route-coordinates').value = route.coordinates || '';
  document.getElementById('modal-route-title').textContent = 'Editar Itinerario';
  openModal('modal-route');
};

window.saveRoute = function() {
  const form = document.getElementById('form-route');
  if (!form.reportValidity()) return;

  const coordsNorm = normalizarCoordsTextarea('route-coordinates');
  const puntos = coordsNorm.trim().split('\n').filter(Boolean);
  if (puntos.length < 2) {
    showToast("El itinerario necesita al menos 2 puntos.", "danger");
    return;
  }

  const id = document.getElementById('route-id').value;
  const routeData = {
    name: document.getElementById('route-name').value,
    color: document.getElementById('route-color').value,
    desc: document.getElementById('route-desc').value,
    coordinates: coordsNorm
  };

  if (appState.firebaseEnabled) {
    const col = appState.db.collection('itinerarios');
    const promise = id ? col.doc(id).set(routeData) : col.add(routeData);
    promise.then(() => {
      showToast("Itinerario guardado en la nube", "success");
      closeModal('modal-route');
    }).catch(err => {
      console.error(err);
      showToast("Error al guardar itinerario", "danger");
    });
  } else {
    if (id) {
      const idx = appState.routes.findIndex(r => r.id === id);
      if (idx !== -1) appState.routes[idx] = { id, ...routeData };
    } else {
      appState.routes.push({ id: 'route-' + Date.now(), ...routeData });
    }
    saveLocalData('routes');
    showToast("Itinerario guardado localmente", "success");
    closeModal('modal-route');
  }
};

// --- BORRAR ELEMENTO GENERAL ---
window.deleteItem = function(firestoreCollection, id, localArrayKey) {
  if (!confirm("¿Está seguro de eliminar este elemento?")) return;

  if (appState.firebaseEnabled) {
    appState.db.collection(firestoreCollection).doc(id).delete()
      .then(() => {
        showToast("Elemento eliminado de la nube", "success");
      }).catch(err => {
        console.error(err);
        showToast("Error al eliminar", "danger");
      });
  } else {
    // Local
    appState[localArrayKey] = appState[localArrayKey].filter(item => item.id !== id);
    saveLocalData(localArrayKey);
    showToast("Elemento eliminado localmente", "success");
  }
};


// --- CONVERSIÓN DE COORDENADAS ---

// Convierte una cadena de coordenada a número decimal.
// Acepta: decimal ("28.1003"), decimal negativo ("-15.4567"),
//         DMS con símbolo ("28°6'1.4\"N") y formato mixto con espacios.
function parseCoordenada(str) {
  if (!str) return NaN;
  str = str.trim();

  // Si ya es un número decimal válido, devolverlo directamente
  const decimal = parseFloat(str);
  if (!isNaN(decimal) && /^-?\d+(\.\d+)?$/.test(str)) return decimal;

  // Intentar parsear formato DMS: 28°6'1.39"N  /  15°23'36.7"W
  const match = str.match(
    /(\d+)[°º]\s*(\d+)[''']\s*([\d.]+)["""]\s*([NSEWnsew])?/
  );
  if (!match) return NaN;

  const grados  = parseFloat(match[1]);
  const minutos = parseFloat(match[2]);
  const segundos = parseFloat(match[3]);
  const dir = (match[4] || '').toUpperCase();

  let resultado = grados + minutos / 60 + segundos / 3600;
  if (dir === 'S' || dir === 'W') resultado = -resultado;

  return parseFloat(resultado.toFixed(8));
}

// Normaliza el valor de un input de coordenada: si el usuario pegó DMS,
// lo convierte a decimal y actualiza el campo visualmente.
function normalizarInputCoordenada(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return NaN;
  const valor = parseCoordenada(input.value);
  if (!isNaN(valor)) input.value = valor;
  return valor;
}

// --- SEGURIDAD Y ADMINISTRACIÓN ---

window.cambiarPin = function() {
  const nuevo = document.getElementById('pin-nuevo').value;
  const confirmar = document.getElementById('pin-confirmar').value;
  if (!nuevo || nuevo.length < 4) {
    showToast("El PIN debe tener al menos 4 caracteres.", "warning");
    return;
  }
  if (nuevo !== confirmar) {
    showToast("Los PINs no coinciden.", "danger");
    return;
  }
  appState.adminPin = nuevo;
  localStorage.setItem('uap_admin_pin', nuevo);
  document.getElementById('pin-nuevo').value = '';
  document.getElementById('pin-confirmar').value = '';
  showToast("PIN actualizado correctamente.", "success");
};

window.borrarTodosLosDatos = function() {
  if (!confirm("¿Seguro? Esto borrará TODOS los equipos, eventos, contactos, ubicaciones e itinerarios. No se puede deshacer.")) return;

  const colecciones = ['equipos', 'eventos', 'contactos', 'ubicaciones', 'itinerarios'];

  if (appState.firebaseEnabled) {
    const borrarColeccion = (nombre) =>
      appState.db.collection(nombre).get().then(snap => {
        const batch = appState.db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        return batch.commit();
      });
    Promise.all(colecciones.map(borrarColeccion))
      .then(() => showToast("Todos los datos borrados de la nube.", "success"))
      .catch(err => { console.error(err); showToast("Error al borrar datos.", "danger"); });
  } else {
    ['teams','events','contacts','locations','routes'].forEach(k => {
      appState[k] = [];
      localStorage.removeItem(`uap_local_${k}`);
    });
    renderTeams(); renderEvents(); renderContacts();
    updateMapMarkers(); updateMapOverlays(); updateDashboardStats();
    if (appState.isAdmin) renderAdminLists();
    showToast("Todos los datos borrados localmente.", "success");
  }
};

// --- UTILIDADES DEL SISTEMA ---

// Asignar Coordenadas Semilla al Formulario
window.setSeedCoordinatesToForm = function(latInputId, lngInputId, seedIndex) {
  const coords = SEED_COORDS[seedIndex];
  if (coords) {
    document.getElementById(latInputId).value = coords.lat;
    document.getElementById(lngInputId).value = coords.lng;
    showToast(`Cargada Coordenada Semilla: ${coords.label}`, "info");
  }
};

// Obtener GPS del dispositivo e inyectarlo en el formulario
window.getCurrentCoordinatesInForm = function(latInputId, lngInputId) {
  if (!navigator.geolocation) {
    showToast("Tu navegador no soporta geolocalización GPS", "danger");
    return;
  }
  
  showToast("Obteniendo posición GPS del dispositivo...", "info");

  navigator.geolocation.getCurrentPosition(
    (position) => {
      document.getElementById(latInputId).value = position.coords.latitude;
      document.getElementById(lngInputId).value = position.coords.longitude;
      if (latInputId === 'team-lat') actualizarDisplayCoordsEquipo();
      showToast("Coordenadas GPS obtenidas correctamente", "success");
    },
    (error) => {
      console.error(error);
      let msg = "No se pudo obtener la ubicación GPS";
      if (error.code === 1) msg = "Acceso denegado al GPS del dispositivo";
      else if (error.code === 2) msg = "Señal GPS no disponible";
      showToast(msg, "danger");
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
};

// Modales abrir / cerrar
window.openModal = function(modalId) {
  document.getElementById(modalId).classList.add('active');
};

window.closeModal = function(modalId) {
  document.getElementById(modalId).classList.remove('active');
};

// Mostrar Notificación Flotante (Toast)
window.showToast = function(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = message;

  container.appendChild(toast);

  // Eliminar a los 3.5 segundos
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px) translateX(-50%)';
    setTimeout(() => toast.remove(), 400);
  }, 3500);
};

// --- IMPORTAR / EXPORTAR JSON (Backup de Despliegue) ---

// Exportar plan a JSON
function exportDeploymentPlan() {
  const exportData = {
    teams: appState.teams,
    events: appState.events,
    contacts: appState.contacts,
    exportDate: new Date().toISOString(),
    unit: "Unidad Aérea de la Policía",
    event: "Visita SS León XIV"
  };

  const jsonStr = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `Despliegue_Aereo_LEON_XIV_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  showToast("Plan de despliegue exportado correctamente", "success");
}

// Importar plan desde JSON
function importDeploymentPlan(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(evt) {
    try {
      const data = JSON.parse(evt.target.result);
      if (!data.teams || !data.events || !data.contacts) {
        throw new Error("Formato de JSON de despliegue no válido.");
      }

      if (confirm(`Se van a importar:\n- ${data.teams.length} Equipos\n- ${data.events.length} Eventos\n- ${data.contacts.length} Contactos\n\n¿Desea continuar? Esto reemplazará los datos existentes.`)) {
        
        if (appState.firebaseEnabled) {
          // Si Firebase está activo, limpiamos colecciones y cargamos las nuevas en lotes
          showToast("Importando datos en la nube. Por favor, espere...", "info");
          
          // Nota: El borrado completo en producción se haría por backend, aquí lo hacemos limpiando
          // Pero para evitar colapso de borrado masivo, agregamos los nuevos elementos.
          // Para esta escala, hacemos importación agregando o reemplazando por lote
          const batch = appState.db.batch();
          
          // Importar Equipos
          data.teams.forEach(t => {
            const cleanT = { ...t };
            delete cleanT.id;
            batch.set(appState.db.collection('equipos').doc(), cleanT);
          });
          
          // Importar Eventos
          data.events.forEach(ev => {
            const cleanEv = { ...ev };
            delete cleanEv.id;
            batch.set(appState.db.collection('eventos').doc(), cleanEv);
          });

          // Importar Contactos
          data.contacts.forEach(c => {
            const cleanC = { ...c };
            delete cleanC.id;
            batch.set(appState.db.collection('contactos').doc(), cleanC);
          });

          batch.commit().then(() => {
            showToast("Plan importado y sincronizado con éxito", "success");
          }).catch(err => {
            console.error(err);
            showToast("Error al importar datos en Firebase", "danger");
          });

        } else {
          // Local storage
          appState.teams = data.teams;
          appState.events = data.events;
          appState.contacts = data.contacts;
          
          saveLocalData('teams');
          saveLocalData('events');
          saveLocalData('contacts');
          
          showToast("Plan importado localmente con éxito", "success");
        }
      }
    } catch (err) {
      console.error(err);
      showToast("Error al leer archivo JSON: Formato incorrecto", "danger");
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // Limpiar input file
}

// --- OPERACIONES DE CANALES Y FRECUENCIAS ---

window.openAddChannelModal = function() {
  document.getElementById('form-channel').reset();
  document.getElementById('channel-id').value = '';
  document.getElementById('modal-channel-title').textContent = 'Añadir Canal / Frecuencia';
  openModal('modal-channel');
};

window.openEditChannelModal = function(id) {
  const channel = appState.channels.find(c => c.id === id);
  if (!channel) return;
  document.getElementById('channel-id').value = channel.id;
  document.getElementById('channel-name').value = channel.name || '';
  document.getElementById('channel-type').value = channel.type || 'TETRA';
  document.getElementById('channel-priority').value = channel.priority || 'normal';
  document.getElementById('channel-frequency').value = channel.frequency || '';
  document.getElementById('channel-number').value = channel.channel || '';
  document.getElementById('channel-desc').value = channel.description || '';
  document.getElementById('modal-channel-title').textContent = 'Editar Canal / Frecuencia';
  openModal('modal-channel');
};

window.saveChannel = function() {
  const form = document.getElementById('form-channel');
  if (!form.reportValidity()) return;

  const id = document.getElementById('channel-id').value;
  const channelData = {
    name: document.getElementById('channel-name').value.trim(),
    type: document.getElementById('channel-type').value,
    priority: document.getElementById('channel-priority').value,
    frequency: document.getElementById('channel-frequency').value.trim(),
    channel: document.getElementById('channel-number').value.trim(),
    description: document.getElementById('channel-desc').value.trim()
  };

  if (appState.firebaseEnabled) {
    const col = appState.db.collection('canales');
    const promise = id ? col.doc(id).set(channelData) : col.add(channelData);
    promise.then(() => {
      showToast("Canal guardado en la nube", "success");
      closeModal('modal-channel');
    }).catch(err => {
      console.error(err);
      showToast("Error al guardar canal", "danger");
    });
  } else {
    if (id) {
      const idx = appState.channels.findIndex(c => c.id === id);
      if (idx !== -1) appState.channels[idx] = { id, ...channelData };
    } else {
      appState.channels.push({ id: 'channel-' + Date.now(), ...channelData });
    }
    saveLocalData('channels');
    showToast("Canal guardado localmente", "success");
    closeModal('modal-channel');
  }
};
