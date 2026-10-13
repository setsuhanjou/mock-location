// 移動（ジョイスティック・路線再生）時に位置を更新する間隔
const MOVE_TICK_MS = 200;
const METERS_PER_DEGREE_LAT = 111320;
const JOYSTICK_RADIUS_PX = 45;
const KM_PER_HOUR_TO_METERS_PER_SECOND = 1 / 3.6;
const DEFAULT_ZOOM = 16;

const KEY_VECTORS = {
  ArrowUp: [0, -1],
  KeyW: [0, -1],
  ArrowDown: [0, 1],
  KeyS: [0, 1],
  ArrowLeft: [-1, 0],
  KeyA: [-1, 0],
  ArrowRight: [1, 0],
  KeyD: [1, 0],
};

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let waypoints = [];
// 画面座標系のベクトル（x: 右が正, y: 下が正, 長さ 0〜1）
let joystickVector = { x: 0, y: 0 };
const pressedKeys = new Set();
let moveTimerId = null;
let routeTimerId = null;
// isReversed: 往復モードで終点から始点へ戻っている最中か
let routeProgress = { segmentIndex: 0, distanceOnSegment: 0, isReversed: false };
let lastTickAt = 0;

// ---------- 地図 ----------

const map = L.map('map');
L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
  attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
  maxZoom: 18,
}).addTo(map);

const positionMarker = L.marker([settings.lat, settings.lng], {
  draggable: true,
  zIndexOffset: 1000,
  icon: L.divIcon({
    className: '',
    html: '<div class="position-icon"><div class="position-arrow"></div></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  }),
}).addTo(map);

const routeLine = L.polyline([], { color: '#1a73e8', weight: 4, opacity: 0.7 }).addTo(map);
const waypointLayer = L.layerGroup().addTo(map);

// ---------- 位置の更新 ----------

const saveSettings = (patch) => {
  settings = { ...settings, ...patch };
  chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  renderSettings();
};

// 位置を指定したら差し替えも自動で有効にする（座標と同じ書き込みで反映する）
const setPosition = (lat, lng, motion = { heading: null, speed: null }) => {
  saveSettings({ enabled: true, lat, lng, heading: motion.heading, speed: motion.speed });
};

// 指定方位（北=0°, 時計回り）へ distanceMeters 移動した座標を返す
const offsetPosition = (lat, lng, bearingDegrees, distanceMeters) => {
  const bearingRadians = (bearingDegrees * Math.PI) / 180;
  const northMeters = distanceMeters * Math.cos(bearingRadians);
  const eastMeters = distanceMeters * Math.sin(bearingRadians);
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  return {
    lat: lat + northMeters / METERS_PER_DEGREE_LAT,
    lng: lng + eastMeters / metersPerDegreeLng,
  };
};

const bearingBetween = (from, to) => {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const fromLat = toRadians(from.lat);
  const toLat = toRadians(to.lat);
  const deltaLng = toRadians(to.lng - from.lng);
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

// 背景タブでは setInterval が間引かれるため、移動距離は実際の経過時間から求める
const consumeElapsedSeconds = () => {
  const now = performance.now();
  const elapsedSeconds = (now - lastTickAt) / 1000;
  lastTickAt = now;
  return elapsedSeconds;
};

// ---------- 描画 ----------

const renderSettings = () => {
  const latLng = [settings.lat, settings.lng];
  positionMarker.setLatLng(latLng);
  if ($('follow').checked) {
    map.panTo(latLng, { animate: false });
  }

  const arrow = positionMarker.getElement()?.querySelector('.position-arrow');
  if (arrow) {
    arrow.style.display = settings.heading === null ? 'none' : '';
    arrow.style.transform = `rotate(${settings.heading ?? 0}deg)`;
  }

  $('enabled').checked = settings.enabled;
  const speedText = settings.speed === null ? '' : ` / ${(settings.speed * 3.6).toFixed(0)} km/h`;
  $('current').textContent = `${settings.lat.toFixed(6)}, ${settings.lng.toFixed(6)}${speedText}`;

  // 入力中の欄は上書きしない
  [['lat', settings.lat.toFixed(6)], ['lng', settings.lng.toFixed(6)], ['accuracy', settings.accuracy]]
    .forEach(([id, value]) => {
      if (document.activeElement === $(id)) {
        return;
      }
      $(id).value = value;
    });
};

const routeLengthMeters = () => waypoints.slice(1)
  .reduce((sum, waypoint, index) => sum + L.latLng(waypoints[index]).distanceTo(waypoint), 0);

const renderRoute = () => {
  routeLine.setLatLngs(waypoints);
  waypointLayer.clearLayers();
  waypoints.forEach((waypoint, index) => {
    L.circleMarker(waypoint, { radius: 6, color: '#1a73e8', fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(String(index + 1), { permanent: true, direction: 'top', offset: [0, -6] })
      .addTo(waypointLayer);
  });

  const totalMeters = routeLengthMeters();
  $('route-summary').textContent = `経由点 ${waypoints.length} 個 / 全長 ${(totalMeters / 1000).toFixed(2)} km`;
  $('route-play').textContent = routeTimerId === null ? '▶ 再生' : '❚❚ 一時停止';
};

// ---------- ジョイスティック・キーボード ----------

const currentMoveVector = () => {
  if (joystickVector.x !== 0 || joystickVector.y !== 0) {
    return joystickVector;
  }

  const summed = [...pressedKeys].reduce(
    (vector, code) => ({ x: vector.x + KEY_VECTORS[code][0], y: vector.y + KEY_VECTORS[code][1] }),
    { x: 0, y: 0 },
  );
  const length = Math.hypot(summed.x, summed.y);
  return length === 0 ? summed : { x: summed.x / length, y: summed.y / length };
};

const moveTick = () => {
  const vector = currentMoveVector();
  const magnitude = Math.min(1, Math.hypot(vector.x, vector.y));
  if (magnitude === 0) {
    stopMoveLoop();
    return;
  }

  const speedMetersPerSecond = Number($('joystick-speed').value) * KM_PER_HOUR_TO_METERS_PER_SECOND * magnitude;
  // 画面の上方向を北として方位角に変換する
  const heading = ((Math.atan2(vector.x, -vector.y) * 180) / Math.PI + 360) % 360;
  const next = offsetPosition(settings.lat, settings.lng, heading, speedMetersPerSecond * consumeElapsedSeconds());
  setPosition(next.lat, next.lng, { heading, speed: speedMetersPerSecond });
};

const startMoveLoop = () => {
  if (moveTimerId !== null) {
    return;
  }
  pauseRoute();
  lastTickAt = performance.now();
  moveTick();
  moveTimerId = setInterval(moveTick, MOVE_TICK_MS);
};

const stopMoveLoop = () => {
  if (moveTimerId === null) {
    return;
  }
  clearInterval(moveTimerId);
  moveTimerId = null;
  // 停止したことを speed = 0 で通知する
  saveSettings({ speed: 0 });
};

const updateJoystick = (event) => {
  const rect = $('joystick').getBoundingClientRect();
  const offsetX = event.clientX - (rect.left + rect.width / 2);
  const offsetY = event.clientY - (rect.top + rect.height / 2);
  const distance = Math.hypot(offsetX, offsetY);
  const scale = distance > JOYSTICK_RADIUS_PX ? JOYSTICK_RADIUS_PX / distance : 1;
  const knobX = offsetX * scale;
  const knobY = offsetY * scale;

  $('joystick-knob').style.transform = `translate(${knobX}px, ${knobY}px)`;
  joystickVector = { x: knobX / JOYSTICK_RADIUS_PX, y: knobY / JOYSTICK_RADIUS_PX };
};

const releaseJoystick = () => {
  $('joystick-knob').style.transform = '';
  joystickVector = { x: 0, y: 0 };
};

$('joystick').addEventListener('pointerdown', (event) => {
  $('joystick').setPointerCapture(event.pointerId);
  updateJoystick(event);
  startMoveLoop();
});
$('joystick').addEventListener('pointermove', (event) => {
  if (!$('joystick').hasPointerCapture(event.pointerId)) {
    return;
  }
  updateJoystick(event);
});
$('joystick').addEventListener('pointerup', releaseJoystick);
$('joystick').addEventListener('pointercancel', releaseJoystick);

const isTypingInInput = () => ['INPUT', 'SELECT'].includes(document.activeElement?.tagName)
  && !['checkbox', 'radio'].includes(document.activeElement.type);

document.addEventListener('keydown', (event) => {
  if (!KEY_VECTORS[event.code] || isTypingInInput()) {
    return;
  }
  event.preventDefault();
  pressedKeys.add(event.code);
  startMoveLoop();
});
document.addEventListener('keyup', (event) => {
  pressedKeys.delete(event.code);
});
// ウィンドウ外でキーを離すと keyup が届かないため、フォーカスが外れたらリセットする
window.addEventListener('blur', () => pressedKeys.clear());

// ---------- 路線再生 ----------

const saveRoute = () => {
  chrome.storage.local.set({ [ROUTE_STORAGE_KEY]: waypoints });
  renderRoute();
};

const resetRouteProgress = () => {
  routeProgress = { segmentIndex: 0, distanceOnSegment: 0, isReversed: false };
};

// 復路は経由点を逆順にたどる
const routePath = (isReversed) => (isReversed ? [...waypoints].reverse() : waypoints);

const routeTick = () => {
  const speedMetersPerSecond = Number($('route-speed').value) * KM_PER_HOUR_TO_METERS_PER_SECOND;
  let remainingMeters = speedMetersPerSecond * consumeElapsedSeconds();
  let { segmentIndex, distanceOnSegment, isReversed } = routeProgress;
  let path = routePath(isReversed);

  while (remainingMeters > 0) {
    const segmentMeters = L.latLng(path[segmentIndex]).distanceTo(path[segmentIndex + 1]);
    const metersToSegmentEnd = segmentMeters - distanceOnSegment;
    if (remainingMeters < metersToSegmentEnd) {
      distanceOnSegment += remainingMeters;
      break;
    }

    remainingMeters -= metersToSegmentEnd;
    segmentIndex += 1;
    distanceOnSegment = 0;
    if (segmentIndex < path.length - 1) {
      continue;
    }

    const loopMode = $('route-loop-mode').value;
    if (loopMode === 'stop') {
      const lastWaypoint = path[path.length - 1];
      setPosition(lastWaypoint.lat, lastWaypoint.lng, { heading: settings.heading, speed: 0 });
      stopRoute();
      return;
    }
    if (loopMode === 'round-trip') {
      isReversed = !isReversed;
      path = routePath(isReversed);
    }
    segmentIndex = 0;
  }

  routeProgress = { segmentIndex, distanceOnSegment, isReversed };
  const from = path[segmentIndex];
  const to = path[segmentIndex + 1];
  const segmentMeters = L.latLng(from).distanceTo(to);
  const ratio = segmentMeters === 0 ? 0 : distanceOnSegment / segmentMeters;
  setPosition(
    from.lat + (to.lat - from.lat) * ratio,
    from.lng + (to.lng - from.lng) * ratio,
    { heading: bearingBetween(from, to), speed: speedMetersPerSecond },
  );
};

const playRoute = () => {
  // 全長 0 だと routeTick のループが進まないため、異なる経由点が 2 つ以上必要
  if (waypoints.length < 2 || routeLengthMeters() === 0) {
    alert('地図上で経由点を 2 つ以上追加してください（「路線の経由点を追加」を選択してクリック）');
    return;
  }
  stopMoveLoop();
  lastTickAt = performance.now();
  routeTick();
  routeTimerId = setInterval(routeTick, MOVE_TICK_MS);
  renderRoute();
};

// 一時停止は進捗を残し、停止は始点に戻す
const pauseRoute = () => {
  if (routeTimerId === null) {
    return;
  }
  clearInterval(routeTimerId);
  routeTimerId = null;
  renderRoute();
};

const stopRoute = () => {
  pauseRoute();
  resetRouteProgress();
};

$('route-play').addEventListener('click', () => {
  if (routeTimerId === null) {
    playRoute();
    return;
  }
  pauseRoute();
});
$('route-stop').addEventListener('click', stopRoute);
$('route-undo').addEventListener('click', () => {
  stopRoute();
  waypoints = waypoints.slice(0, -1);
  saveRoute();
});
$('route-clear').addEventListener('click', () => {
  stopRoute();
  waypoints = [];
  saveRoute();
});

// ---------- 地図操作・直接入力 ----------

const selectedMode = () => document.querySelector('input[name="mode"]:checked').value;

map.on('click', (event) => {
  const { lat, lng } = event.latlng;
  if (selectedMode() === 'route') {
    stopRoute();
    waypoints = [...waypoints, { lat, lng }];
    saveRoute();
    return;
  }
  stopRoute();
  setPosition(lat, lng);
});

positionMarker.on('dragstart', stopRoute);
positionMarker.on('dragend', () => {
  const { lat, lng } = positionMarker.getLatLng();
  setPosition(lat, lng);
});

$('enabled').addEventListener('change', (event) => saveSettings({ enabled: event.target.checked }));

// Google マップ等からコピーした「緯度, 経度」を緯度欄に貼り付けたら自動で分割する
$('lat').addEventListener('input', (event) => {
  const parts = event.target.value.split(',').map((part) => part.trim());
  if (parts.length !== 2 || parts.includes('')) {
    return;
  }
  [$('lat').value, $('lng').value] = parts;
});

$('preset').addEventListener('change', (event) => {
  if (!event.target.value) {
    return;
  }
  [$('lat').value, $('lng').value] = event.target.value.split(',');
  event.target.value = '';
});

$('apply').addEventListener('click', () => {
  const lat = Number($('lat').value);
  const lng = Number($('lng').value);
  const accuracy = Number($('accuracy').value);
  const isValidLat = $('lat').value.trim() !== '' && lat >= -90 && lat <= 90;
  const isValidLng = $('lng').value.trim() !== '' && lng >= -180 && lng <= 180;
  if (!isValidLat || !isValidLng || !(accuracy > 0)) {
    alert('緯度は -90〜90、経度は -180〜180、精度は 1 以上で入力してください');
    return;
  }

  stopRoute();
  // 追従オフでも、直接指定した地点は見えるように移動する
  map.setView([lat, lng], map.getZoom());
  saveSettings({ enabled: true, lat, lng, accuracy, heading: null, speed: null });
});

// ---------- 初期化 ----------

const initialize = async () => {
  settings = await loadSettings();
  const stored = await chrome.storage.local.get(ROUTE_STORAGE_KEY);
  waypoints = stored[ROUTE_STORAGE_KEY] ?? [];

  map.setView([settings.lat, settings.lng], DEFAULT_ZOOM);
  renderSettings();
  renderRoute();
};

initialize();
