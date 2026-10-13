importScripts('defaults.js');

const CONTROL_PAGE_URL = chrome.runtime.getURL('control.html');
const DEBUGGER_PROTOCOL_VERSION = '1.3';

// DevTools の「Sensors」と同じく、CDP でタブ単位に位置情報を上書きする
const attachedTabIds = new Set();
const attachingTabIds = new Set();
// 接続処理中に届いた更新を取りこぼさないよう、接続完了時は常に最新の設定を送る
let latestSettings = { ...DEFAULT_SETTINGS };

// アイコンクリックでコントロール画面を開く（既に開いていればそのウィンドウへ移動）
chrome.action.onClicked.addListener(async () => {
  // tabs.query の url 指定は "tabs" 権限が必要なため、権限不要の getContexts で探す
  const [existingContext] = await chrome.runtime.getContexts({
    contextTypes: ['TAB'],
    documentUrls: [CONTROL_PAGE_URL],
  });
  if (!existingContext) {
    // 確認したいページと並べて操作できるよう、独立した小さいウィンドウで開く
    await chrome.windows.create({ url: CONTROL_PAGE_URL, type: 'popup', width: 1000, height: 720 });
    return;
  }
  await chrome.tabs.update(existingContext.tabId, { active: true });
  await chrome.windows.update(existingContext.windowId, { focused: true });
});

// 有効化したまま忘れないよう、アイコンにバッジを表示する
const updateBadge = async (settings) => {
  await chrome.action.setBadgeText({ text: settings.enabled ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
};

const buildGeolocationOverride = (settings) => {
  const override = { latitude: settings.lat, longitude: settings.lng, accuracy: settings.accuracy };
  if (settings.heading !== null) {
    override.heading = settings.heading;
  }
  if (settings.speed !== null) {
    override.speed = settings.speed;
  }
  return override;
};

const sendOverride = async (tabId, settings) => {
  try {
    const override = buildGeolocationOverride(settings);
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setGeolocationOverride', override);
  } catch (error) {
    console.warn(`tab ${tabId}: 位置情報の上書きに失敗しました`, error);
  }
};

const attachTab = async (tabId) => {
  if (attachingTabIds.has(tabId)) {
    return;
  }
  if (!attachedTabIds.has(tabId)) {
    attachingTabIds.add(tabId);
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
      attachedTabIds.add(tabId);
    } catch {
      // chrome:// やウェブストアなど、デバッガを接続できないタブは対象外
      return;
    } finally {
      attachingTabIds.delete(tabId);
    }
  }
  await sendOverride(tabId, latestSettings);
};

const attachAllTabs = async () => {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => attachTab(tab.id)));
};

// デタッチすると上書きも解除され、ブラウザ上部の「デバッグ中」バーも消える
const detachAllTabs = async () => {
  const tabIds = [...attachedTabIds];
  attachedTabIds.clear();
  await Promise.all(tabIds.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
};

const applySettings = async (settings) => {
  latestSettings = settings;
  await updateBadge(settings);
  if (!settings.enabled) {
    await detachAllTabs();
    return;
  }
  // 有効化した直後と Service Worker の再起動直後は、接続済みのタブが無いので全タブに接続する
  if (attachedTabIds.size === 0) {
    await attachAllTabs();
    return;
  }
  await Promise.all([...attachedTabIds].map((tabId) => sendOverride(tabId, settings)));
};

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[SETTINGS_STORAGE_KEY]) {
    return;
  }
  applySettings({ ...DEFAULT_SETTINGS, ...changes[SETTINGS_STORAGE_KEY].newValue });
});

// 有効中に開いたタブ・遷移したタブにも上書きを適用する
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') {
    return;
  }
  latestSettings = await loadSettings();
  if (!latestSettings.enabled) {
    return;
  }
  await attachTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => attachedTabIds.delete(tabId));

// 「デバッグ中」バーの「キャンセル」で切断された場合は、差し替え自体を無効にする
chrome.debugger.onDetach.addListener(async (source, reason) => {
  attachedTabIds.delete(source.tabId);
  if (reason !== 'canceled_by_user') {
    return;
  }
  const settings = await loadSettings();
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: { ...settings, enabled: false } });
});

const initialize = async () => applySettings(await loadSettings());
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
