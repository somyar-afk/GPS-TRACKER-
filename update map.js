'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Use the serving Flask host in a browser; use the Mac's LAN IP for file/APK access.
// Update the LAN address here and in tracker/secrets.h if your Mac's IP changes.
// ─────────────────────────────────────────────────────────────────────────────
const API_BASE_URL = window.location.protocol === 'file:' ||
  window.Capacitor?.isNativePlatform()
  ? (window.FIELD_TRACKER_API_BASE_URL || 'http://10.165.39.84:8000')
  : '';

// ─────────────────────────────────────────────────────────────────────────────
// Capacitor / FCM integration (gracefully no-ops in a plain browser)
// ─────────────────────────────────────────────────────────────────────────────
let Capacitor = window.Capacitor || null;
let PushNotificationsPlugin = null;
let FCMPlugin = null;

async function initCapacitorPush() {
  if (!Capacitor || !Capacitor.isNativePlatform()) return;
  if (typeof __PUSH_ENABLED__ === 'undefined' || !__PUSH_ENABLED__) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    PushNotificationsPlugin = PushNotifications;
    const { FCM } = await import('@capacitor-community/fcm');
    FCMPlugin = FCM;

    const permResult = await PushNotificationsPlugin.requestPermissions();
    if (permResult.receive !== 'granted') {
      console.warn('Push notification permission denied.');
      return;
    }

    await PushNotificationsPlugin.addListener('registration', async () => {
      try {
        await FCMPlugin.subscribeTo({ topic: 'geofence_alerts' });
        console.log('Subscribed to geofence_alerts topic.');
      } catch (e) {
        console.warn('FCM topic subscribe failed:', e);
      }
    });

    await PushNotificationsPlugin.addListener('pushNotificationReceived', (notification) => {
      console.log('Geofence notification received.');
    });
    await PushNotificationsPlugin.addListener('registrationError', () => {
      console.warn('Push registration failed; check Firebase configuration.');
    });
    await PushNotificationsPlugin.register();
  } catch (e) {
    console.warn('Capacitor push init skipped (browser mode):', e);
  }
}

initCapacitorPush();

// ─────────────────────────────────────────────────────────────────────────────
// Map initialisation
// ─────────────────────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);

let key = '', data = null, received = 0;
let marker = null, geofenceCircle = null, breadcrumb = null;
let first = true, generation = 0, busy = false, apiOK = false;
let geofenceDirty = false, pickingCentre = false, savingGeofence = false;
let geofencePreview = null;
let trackerNameDirty = false, savingTrackerName = false;

const map = L.map('map').setView([29.8656, 77.8961], 15);  // IIT Roorkee default

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).on('tileerror', () => {
  el('map-note').textContent = 'Map tiles unavailable. Coordinates and status may still work.';
}).addTo(map);

L.control.scale({ imperial: false }).addTo(map);
map.on('dragstart', () => { el('follow').checked = false; });

// ─────────────────────────────────────────────────────────────────────────────
// Map helpers
// ─────────────────────────────────────────────────────────────────────────────
function centre(reset = false) {
  if (!data?.position) return;
  const p = data.position;
  const ll = L.latLng(p.lat, p.lon);
  if (!reset) { map.panTo(ll); return; }
  const mode = el('scale').value;
  if (mode === 'region') map.fitBounds(ll.toBounds(200000), { padding: [12, 12] });
  else map.setView(ll, mode === 'campus' ? 16 : 13);
}

el('recentre').onclick = () => centre(true);
el('scale').onchange   = () => centre(true);
el('follow').onchange  = () => { if (el('follow').checked) centre(); };

function clearPosition() {
  if (marker)        { map.removeLayer(marker);        marker = null; }
  if (geofenceCircle){ map.removeLayer(geofenceCircle); geofenceCircle = null; }
  if (breadcrumb)    { map.removeLayer(breadcrumb);    breadcrumb = null; }
  resetGeofenceEditor();
  trackerNameDirty = false;
  el('tracker-fields').disabled = true;
  el('tracker-name-input').value = 'animal-01';
  el('tracker-name').textContent = 'animal-01';
  el('tracker-message').textContent = 'Connect to name your tracker. This name appears in alerts.';
  data = null; first = true;
  for (const id of ['coords','loc-src','activity','geo-dist','fix-time','age','contact','quality','motion','imu','reason']) {
    el(id).textContent = '—';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────
const sessionReady = window.createViewerSession();
sessionReady.catch(() => {
  el('login-note').textContent = 'Local storage is unavailable; login will last for this session only.';
});

el('login').onsubmit = async e => {
  e.preventDefault();
  const g = ++generation;
  const token = el('token').value.trim();
  key = token;
  el('token').value = '';
  clearPosition(); apiOK = false;
  el('status').textContent = 'Connecting…';
  try {
    const session = await sessionReady;
    if (g !== generation) return;
    await session.connect(token);
    if (g !== generation) return;
    el('login-note').textContent = 'Login saved on this device. Disconnect to remove it.';
  } catch (error) {
    if (g !== generation) return;
    el('login-note').textContent = 'Could not save login. You can connect, but may need the token next time.';
  }
  poll();
};

el('logout').onclick = async () => {
  const g = ++generation;
  key = ''; apiOK = false;
  clearPosition();
  el('status').textContent = 'Disconnected';
  el('token').value = '';
  try {
    const session = await sessionReady;
    if (g !== generation) return;
    await session.disconnect();
    if (g === generation) el('login-note').textContent = 'Disconnected. Saved login removed from this device.';
  } catch (error) {
    if (g === generation) el('login-note').textContent = 'Disconnected, but saved login could not be removed. Try Disconnect again.';
  }
};

async function restoreLogin() {
  const g = generation;
  try {
    const session = await sessionReady;
    if (g !== generation) return;
    const token = await session.restore();
    if (g !== generation || !token) return;
    key = token;
    el('status').textContent = 'Reconnecting…';
    el('login-note').textContent = 'Using your saved login. Disconnect to remove it.';
    poll();
  } catch (error) {
    if (g === generation) el('login-note').textContent = 'Saved login unavailable. Enter your viewer token to connect.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling
// ─────────────────────────────────────────────────────────────────────────────
async function poll() {
  if (!key || busy) return;
  busy = true;
  const g = generation;
  try {
    const r = await fetch(`${API_BASE_URL}/api/latest`, {
      headers: { Authorization: 'Bearer ' + key },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000)
    });
    if (g !== generation) return;
    if (r.status === 401) {
      key = ''; clearPosition();
      sessionReady.then(session => {
        if (g === generation) return session.disconnect();
      }).catch(() => {});
      el('login-note').textContent = 'Saved token was rejected. Enter a valid viewer token.';
      throw new Error('Incorrect viewer token');
    }
    if (!r.ok) throw new Error('Server unavailable');
    const next = await r.json();
    if (g !== generation) return;
    data = next;
    received = performance.now();
    apiOK = true;
    updateMap();
    syncGeofenceEditor();
    syncTrackerEditor();
    renderStatus();
  } catch (err) {
    if (g === generation) {
      apiOK = false;
      el('status').textContent = err.message === 'Incorrect viewer token'
        ? err.message
        : 'Cannot reach server — location unconfirmed';
      if (marker) marker.setStyle({ color: '#7b8580' });
    }
  } finally {
    busy = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Map layer updates
// ─────────────────────────────────────────────────────────────────────────────
function updateMap() {
  if (!data) return;

  // ── Animal position marker ───────────────────────────────────────
  if (data.position) {
    const p = data.position;
    const ll = [p.lat, p.lon];
    if (!marker) {
      marker = L.circleMarker(ll, {
        radius: 9, color: '#17644c', weight: 3, fillOpacity: 0.85
      }).addTo(map);
    } else {
      marker.setLatLng(ll);
    }
    el('coords').textContent   = `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
    el('fix-time').textContent = new Date(p.fix_at * 1000).toISOString();
    if (first) { centre(true); first = false; }
    else if (el('follow').checked) centre();
  } else {
    if (marker) { map.removeLayer(marker); marker = null; }
    first = true;
    el('coords').textContent   = '—';
    el('fix-time').textContent = '—';
  }

  // ── Geofence circle ──────────────────────────────────────────────
  if (data.geofence) {
    const gf = data.geofence;
    const gfLL = [gf.home_lat, gf.home_lng];
    const breached = ['breached', 'reentry_buffer'].includes(gf.alert_state);
    const circleOpts = {
      radius: gf.radius_m,
      color: gf.inside === null ? '#7b8580' : breached ? '#c0392b' : '#17644c',
      weight: 2,
      fillOpacity: 0.08,
      dashArray: breached ? '6 4' : null,
      className: breached ? 'geofence-breach' : ''
    };
    if (!geofenceCircle) {
      geofenceCircle = L.circle(gfLL, circleOpts).addTo(map);
    } else {
      geofenceCircle.setLatLng(gfLL);
      geofenceCircle.setRadius(gf.radius_m);
      geofenceCircle.setStyle(circleOpts);
    }
  }

  // ── Breadcrumb trail ─────────────────────────────────────────────
  if (Array.isArray(data.history) && data.history.length > 1) {
    const latlngs = data.history.map(h => [h.lat, h.lon]);
    if (!breadcrumb) {
      breadcrumb = L.polyline(latlngs, {
        color: '#17644c', weight: 2, opacity: 0.55,
        dashArray: '5 7'
      }).addTo(map);
    } else {
      breadcrumb.setLatLngs(latlngs);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status panel
// ─────────────────────────────────────────────────────────────────────────────
function locSourceLabel(src) {
  if (!src || src === 'none') return '—';
  if (src === 'wifi_trilateration') return '<span class="loc-pill src-wifi">Wi-Fi Trilateration (3+ APs)</span>';
  if (src === 'wifi_2ap')           return '<span class="loc-pill src-wifi">Wi-Fi Weighted (2 APs)</span>';
  if (src === 'wifi_1ap')           return '<span class="loc-pill src-wifi">Wi-Fi Anchor (1 AP)</span>';
  if (src === 'wifi_indoor')        return '<span class="loc-pill src-wifi">Wi-Fi Indoor</span>';
  if (src.startsWith('gps+'))       return '<span class="loc-pill src-hybrid">GPS + Wi-Fi</span>';
  return '<span class="loc-pill src-gps">GPS</span>';
}

function activityLabel(act) {
  if (!act) return '—';
  const cls = { Resting: 'act-resting', Grazing: 'act-grazing', Moving: 'act-moving' }[act] || '';
  return `<span class="${cls}">${act}</span>`;
}

function renderStatus() {
  if (!data) return;
  const now = data.server_now + (performance.now() - received) / 1000;
  const hb  = data.heartbeat_at === null ? Infinity : Math.max(0, now - data.heartbeat_at);
  const age = data.position ? Math.max(0, now - data.position.fix_at) : Infinity;
  const t   = data.telemetry;
  const src = t?.loc_source ?? data.position?.loc_source ?? 'none';
  const isWifiPos = src.startsWith('wifi_');

  // Position is live if either GPS fix_ok OR a fresh Wi-Fi trilaterated position exists
  const live = apiOK && hb < 15 && age < 10 && Boolean(data.position) && (t?.fix_ok || isWifiPos);

  // Status line
  if (apiOK) {
    el('status').textContent =
      hb === Infinity         ? 'Waiting for device' :
      hb >= 15                ? 'Device offline / unreachable' :
      live && isWifiPos       ? '🔵 Live Wi-Fi position' :
      live                    ? '🟢 Live position' :
                                'Device online — waiting for position';
  }

  // Marker colour: blue for Wi-Fi fix, green for GPS/hybrid fix, grey when stale
  if (marker) {
    const activeColor = isWifiPos ? '#1a56db' : '#17644c';
    marker.setStyle({ color: live ? activeColor : '#7b8580' });
  }

  // Timing fields
  el('age').textContent     = Number.isFinite(age) ? `${Math.floor(age)} s` : 'No position yet';
  el('contact').textContent = Number.isFinite(hb)  ? `${Math.floor(hb)} s ago` : 'Never';

  // Telemetry fields
  if (t) {
    el('quality').textContent  = `${t.satellites ?? '—'} sats / HDOP ${t.hdop ?? '—'}`;
    el('motion').textContent   = `${t.speed_kmph ?? '—'} km/h  |  ${t.altitude_m ?? '—'} m`;
    el('imu').innerHTML        = t.mpu_ok ? 'Responding <small>(BNO055)</small>' : 'Unavailable — tracking continues';
    el('reason').textContent   = t.reason ?? '—';
    el('activity').innerHTML   = activityLabel(t.activity);
    el('loc-src').innerHTML    = locSourceLabel(src);
  }

  // Geofence
  if (data.geofence) {
    const gf = data.geofence;
    if (gf.inside === null) {
      el('geo-dist').textContent = 'Safe zone saved — waiting for a fresh position';
    } else if (gf.alert_state === 'wifi_only') {
      el('geo-dist').textContent = 'Wi-Fi position only — GPS needed to confirm geofence alerts';
    } else if (gf.alert_state === 'pending') {
      el('geo-dist').textContent = `Outside boundary — confirming ${gf.outside_count}/${gf.required_fixes} fixes (${gf.distance_m} m)`;
    } else if (gf.alert_state === 'reentry_buffer') {
      el('geo-dist').textContent = `Alert active — return within ${gf.reentry_radius_m} m of the centre to reset`;
    } else if (gf.inside) {
      el('geo-dist').innerHTML = `<span class="geo-inside">Inside safe zone (${gf.distance_m} m from centre)</span>`;
    } else {
      el('geo-dist').innerHTML = `<span class="geo-outside">⚠ BREACHED — ${gf.distance_m} m away</span>`;
    }
  }
}

function syncTrackerEditor() {
  el('tracker-fields').disabled = !key || !apiOK || savingTrackerName || savingGeofence;
  const name = data?.tracker?.name ?? 'animal-01';
  el('tracker-name').textContent = name;
  if (!trackerNameDirty) el('tracker-name-input').value = name;
  if (apiOK && el('tracker-message').textContent.startsWith('Connect to name')) {
    el('tracker-message').textContent = 'This name appears in geofence notifications.';
  }
}
el('tracker-name-input').addEventListener('input', () => { trackerNameDirty = true; });
el('tracker-form').onsubmit = async event => {
  event.preventDefault();
  if (!key || savingTrackerName || savingGeofence || !el('tracker-form').reportValidity()) return;
  const name = el('tracker-name-input').value.trim();
  if (!name) {
    el('tracker-message').textContent = 'Enter a tracker name.';
    return;
  }
  const g = ++generation;
  savingTrackerName = true;
  syncTrackerEditor();
  syncGeofenceEditor();
  el('tracker-message').textContent = 'Saving tracker name…';
  try {
    const response = await fetch(`${API_BASE_URL}/api/tracker`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }), signal: AbortSignal.timeout(8000)
    });
    if (g !== generation) return;
    if (response.status === 401) throw new Error('Reconnect with the correct viewer token.');
    if (!response.ok) throw new Error('Could not save the name. Use 1–64 characters and try again.');
    const tracker = await response.json();
    if (g !== generation) return;
    data.tracker = tracker;
    trackerNameDirty = false;
    el('tracker-message').textContent = 'Name saved. Future alerts will use this name.';
  } catch (error) {
    if (g === generation) el('tracker-message').textContent = error.message;
  } finally {
    savingTrackerName = false;
    if (g === generation) { syncTrackerEditor(); syncGeofenceEditor(); }
  }
};

// Safe-zone editor: polling must not overwrite unsaved input.
function setPickingCentre(active) {
  pickingCentre = active;
  el('pick-centre').textContent = active ? 'Cancel map selection' : 'Choose on map';
  el('pick-centre').setAttribute('aria-pressed', String(active));
  map.getContainer().style.cursor = active ? 'crosshair' : '';
}

function resetGeofenceEditor() {
  geofenceDirty = false;
  setPickingCentre(false);
  if (geofencePreview) { map.removeLayer(geofencePreview); geofencePreview = null; }
  for (const id of ['geofence-lat', 'geofence-lng', 'geofence-radius']) el(id).value = '';
  el('geofence-fields').disabled = true;
  el('geofence-message').textContent = 'Connect to edit the safe zone.';
}

function syncGeofenceEditor() {
  el('geofence-fields').disabled = !key || !apiOK || savingGeofence || savingTrackerName;
  el('use-device-centre').disabled = !data?.position ||
    data.server_now - data.position.fix_at > 10;
  if (!data?.geofence || geofenceDirty) return;
  const gf = data.geofence;
  el('geofence-lat').value = gf.home_lat;
  el('geofence-lng').value = gf.home_lng;
  el('geofence-radius').value = gf.radius_m;
  if (el('geofence-message').textContent === 'Connect to edit the safe zone.') {
    el('geofence-message').textContent = 'Choose a centre and radius, then save.';
  }
}

function previewGeofence() {
  geofenceDirty = true;
  const inputs = ['geofence-lat', 'geofence-lng', 'geofence-radius'].map(el);
  if (!inputs.every(input => input.value !== '' && input.validity.valid)) {
    if (geofencePreview) { map.removeLayer(geofencePreview); geofencePreview = null; }
    el('geofence-message').textContent = 'Enter valid coordinates and a radius from 1 to 100,000 metres.';
    return;
  }
  const [lat, lng, radius] = inputs.map(input => Number(input.value));
  if (!geofencePreview) {
    geofencePreview = L.circle([lat, lng], {
      radius, color: '#2463ae', weight: 2, dashArray: '6 4', fillOpacity: 0.1
    }).addTo(map);
  } else {
    geofencePreview.setLatLng([lat, lng]);
    geofencePreview.setRadius(radius);
  }
  el('geofence-message').textContent = 'Preview only — save to apply this safe zone.';
}

for (const id of ['geofence-lat', 'geofence-lng', 'geofence-radius']) {
  el(id).addEventListener('input', previewGeofence);
}
el('pick-centre').onclick = () => {
  setPickingCentre(!pickingCentre);
  if (pickingCentre) {
    el('follow').checked = false;
    el('geofence-message').textContent = 'Tap the map to choose the centre.';
    el('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
};
map.on('click', event => {
  if (!pickingCentre || !key || savingGeofence) return;
  el('geofence-lat').value = event.latlng.lat.toFixed(6);
  el('geofence-lng').value = event.latlng.lng.toFixed(6);
  setPickingCentre(false);
  previewGeofence();
});
el('use-device-centre').onclick = () => {
  if (!data?.position || data.server_now + (performance.now() - received) / 1000 - data.position.fix_at > 10) {
    el('geofence-message').textContent = 'Wait for a fresh tracker location.';
    return;
  }
  el('geofence-lat').value = data.position.lat;
  el('geofence-lng').value = data.position.lon;
  setPickingCentre(false);
  el('follow').checked = false;
  previewGeofence();
  if (geofencePreview) map.fitBounds(geofencePreview.getBounds(), { padding: [20, 20], maxZoom: 18 });
};
el('cancel-geofence').onclick = () => {
  resetGeofenceEditor();
  syncGeofenceEditor();
};
el('geofence-form').onsubmit = async event => {
  event.preventDefault();
  if (!key || savingGeofence || savingTrackerName || !el('geofence-form').reportValidity()) return;
  const g = ++generation;
  savingGeofence = true;
  syncTrackerEditor();
  setPickingCentre(false);
  el('geofence-fields').disabled = true;
  el('geofence-message').textContent = 'Saving safe zone…';
  try {
    const response = await fetch(`${API_BASE_URL}/api/geofence`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        home_lat: Number(el('geofence-lat').value),
        home_lng: Number(el('geofence-lng').value),
        radius_m: Number(el('geofence-radius').value)
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (g !== generation) return;
    if (response.status === 401) throw new Error('Reconnect with the correct viewer token.');
    if (!response.ok) throw new Error('Could not save. Check the values and try again.');
    const gf = await response.json();
    if (g !== generation) return;
    geofenceDirty = false;
    if (geofencePreview) { map.removeLayer(geofencePreview); geofencePreview = null; }
    data.geofence = gf;
    updateMap();
    renderStatus();
    syncGeofenceEditor();
    el('geofence-message').textContent = 'Safe zone saved. Alerts require 3 fresh fixes outside.';
    if (geofenceCircle) map.fitBounds(geofenceCircle.getBounds(), { padding: [20, 20], maxZoom: 18 });
  } catch (error) {
    if (g === generation) el('geofence-message').textContent = error.message;
  } finally {
    savingGeofence = false;
    if (g === generation) { syncGeofenceEditor(); syncTrackerEditor(); }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Tick loops
// ─────────────────────────────────────────────────────────────────────────────
setInterval(poll,          500);
setInterval(renderStatus,  250);

restoreLogin();
