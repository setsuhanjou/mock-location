// background / control で共有する定数
const SETTINGS_STORAGE_KEY = 'mockSettings';
const ROUTE_STORAGE_KEY = 'mockRoute';

// 初期位置は東京駅。heading（度）と speed（m/s）はジョイスティック・路線再生で移動中のみ値が入る
const DEFAULT_SETTINGS = {
  enabled: false,
  lat: 35.681236,
  lng: 139.767125,
  accuracy: 10,
  heading: null,
  speed: null,
};

const loadSettings = async () => {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...stored[SETTINGS_STORAGE_KEY] };
};
