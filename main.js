const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Menu,
  Tray,
  nativeImage,
} = require("electron");
const fs = require("fs");
const path = require("path");
const koffi = require("koffi");

const SNAPSHOT = process.argv.includes("--snapshot");
const BASE_W = 200;
const BASE_H = 196;

let petWin;
let bubbleWin;
let tray;
let chatOpen = false;
let toastTimer = null;
let lastHunger = 58;
let lastSurfaces = [];
let lastFloors = [];
let hover = false;
let capture = false;
let saved = { hunger: 42, scale: 1, pace: "low", perch: "high", hidden: false };

const statePath = () => path.join(app.getPath("userData"), "doro-state.json");

function loadState() {
  try {
    saved = { ...saved, ...JSON.parse(fs.readFileSync(statePath(), "utf8")) };
  } catch {
    saved = { hunger: 42, scale: 1 };
  }
}

function writeState(next) {
  saved = { ...saved, ...next };
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(saved));
  } catch {
    /* ignore disk errors */
  }
}

const user32 = koffi.load("user32.dll");
const dwmapi = koffi.load("dwmapi.dll");
const RECT = koffi.struct("RECT", {
  left: "int32",
  top: "int32",
  right: "int32",
  bottom: "int32",
});
const WNDENUMPROC = koffi.proto("bool WNDENUMPROC(void *hwnd, intptr lparam)");
const EnumWindows = user32.func("bool __stdcall EnumWindows(WNDENUMPROC *cb, intptr lparam)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void *hwnd)");
const IsIconic = user32.func("bool __stdcall IsIconic(void *hwnd)");
const GetWindowRect = user32.func("bool __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)");
const GetWindowThreadProcessId = user32.func(
  "uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)"
);
const GetClassNameW = user32.func("int __stdcall GetClassNameW(void *hwnd, uint16_t *buf, int max)");
const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
const DwmGetWindowAttribute = dwmapi.func(
  "int32 __stdcall DwmGetWindowAttribute(void *hwnd, uint32 attr, _Out_ uint32 *value, uint32 size)"
);
const GetAsyncKeyState = user32.func("short __stdcall GetAsyncKeyState(int key)");

const enumCallback = koffi.register((hwnd) => {
  try {
    collectWindow(hwnd);
  } catch (error) {
    console.error(error);
  }
  return true;
}, koffi.pointer(WNDENUMPROC));

const skipClass = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);
let collecting = [];

function className(hwnd) {
  const buf = new Uint16Array(128);
  const length = GetClassNameW(hwnd, buf, buf.length);
  if (!length) return "";
  return Buffer.from(buf.buffer, 0, length * 2).toString("utf16le");
}

function toDipRect(rect) {
  const a = screen.screenToDipPoint({ x: rect.left, y: rect.top });
  const b = screen.screenToDipPoint({ x: rect.right, y: rect.bottom });
  return { x1: a.x, y: a.y, x2: b.x, bottom: b.y };
}

function coversMonitor(rect) {
  return screen.getAllDisplays().some((display) => {
    const bounds = display.bounds;
    return (
      rect.x1 <= bounds.x + 4 &&
      rect.y <= bounds.y + 4 &&
      rect.x2 >= bounds.x + bounds.width - 4 &&
      rect.bottom >= bounds.y + bounds.height - 4
    );
  });
}

function collectWindow(hwnd) {
  if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return;
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  if (pid[0] === process.pid) return;
  const cloaked = [0];
  if (DwmGetWindowAttribute(hwnd, 14, cloaked, 4) === 0 && cloaked[0]) return;
  const name = className(hwnd);
  if (skipClass.has(name)) return;
  const rect = {};
  if (!GetWindowRect(hwnd, rect)) return;
  const dip = toDipRect(rect);
  const width = dip.x2 - dip.x1;
  const height = dip.bottom - dip.y;
  if (width < 180 || height < 140) return;
  if (coversMonitor(dip)) return;
  const onScreen = screen.getAllDisplays().some((display) => {
    const bounds = display.bounds;
    return (
      dip.x2 > bounds.x + 8 &&
      dip.x1 < bounds.x + bounds.width - 8 &&
      dip.bottom > bounds.y + 8 &&
      dip.y < bounds.y + bounds.height - 8
    );
  });
  if (!onScreen) return;
  const home = screen.getDisplayNearestPoint({ x: (dip.x1 + dip.x2) / 2, y: dip.y });
  if (dip.y < home.bounds.y + BASE_H - 8) return;
  collecting.push({
    id: `win-${dip.x1}-${dip.y}-${dip.x2}-${dip.bottom}`,
    x1: dip.x1,
    x2: dip.x2,
    y: dip.y,
    floor: false,
  });
}

function scanSurfaces() {
  const floors = screen.getAllDisplays().map((display) => {
    const area = display.workArea;
    return {
      id: `floor-${display.id}`,
      x1: area.x,
      x2: area.x + area.width,
      y: area.y + area.height,
      floor: true,
    };
  });
  collecting = [];
  try {
    EnumWindows(enumCallback, 0);
  } catch (error) {
    console.error(error);
  }
  lastFloors = floors;
  lastSurfaces = [...collecting, ...floors];
  return { surfaces: lastSurfaces, floors: lastFloors };
}

function currentFloor() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  return lastFloors.find((floor) => floor.id === `floor-${display.id}`) || lastFloors[0];
}

function placeBubble() {
  if (!bubbleWin || bubbleWin.isDestroyed() || !bubbleWin.isVisible()) return;
  const bounds = petWin.getBounds();
  const width = chatOpen
    ? Math.round(Math.max(228, Math.min(252, bounds.width * 1.2)))
    : Math.round(Math.max(156, Math.min(188, bounds.width * 0.96)));
  const height = chatOpen ? 208 : 68;
  const display = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y });
  const headX = bounds.x + bounds.width / 2;
  const headY = bounds.y + Math.round(bounds.height * 0.3);
  let x = Math.round(headX - width / 2);
  let y = Math.round(headY - height - 4);
  const area = display.workArea;
  if (y < area.y + 4) {
    y = Math.min(headY, area.y + area.height - height - 4);
    x = Math.round(bounds.x + bounds.width * 0.55);
  }
  x = Math.max(area.x + 4, Math.min(x, area.x + area.width - width - 4));
  y = Math.max(area.y + 4, Math.min(y, area.y + area.height - height - 4));
  bubbleWin.setBounds({ x, y, width, height });
  if (!bubbleWin.webContents.isLoading()) bubbleWin.webContents.setZoomFactor(1);
}

function showBubble(payload) {
  if (SNAPSHOT) return;
  chatOpen = payload.mode === "chat";
  bubbleWin.webContents.send("show-bubble", { ...payload, hunger: payload.hunger ?? lastHunger });
  if (chatOpen) bubbleWin.show();
  else bubbleWin.showInactive();
  placeBubble();
  clearTimeout(toastTimer);
  if (!chatOpen) {
    toastTimer = setTimeout(() => {
      if (!chatOpen && bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.hide();
    }, 3400);
  }
}

function hideIfFullscreen() {
  if (!petWin || capture || SNAPSHOT) return;
  const hwnd = GetForegroundWindow();
  if (!hwnd) return;
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  if (pid[0] === process.pid) return;
  const rect = {};
  if (!GetWindowRect(hwnd, rect)) return;
  const dip = toDipRect(rect);
  const hidden = coversMonitor(dip);
  if (hidden && petWin.isVisible()) petWin.hide();
  if (!hidden && !petWin.isVisible()) petWin.showInactive();
}

function createWindows() {
  const floor = currentFloor();
  const scale = saved.scale || 1;
  const width = Math.round(BASE_W * scale);
  const height = Math.round(BASE_H * scale);
  const x = Math.round((saved.x ?? (floor.x1 + floor.x2) / 2) - width / 2);
  const y = Math.round((saved.y ?? floor.y) - height + 7 * scale);

  petWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    fullscreenable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: SNAPSHOT ? ["--snapshot"] : [],
      backgroundThrottling: false,
    },
  });
  petWin.setAlwaysOnTop(true, "screen-saver");
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  petWin.webContents.on("console-message", (_event, level, message, line, source) => {
    console.log(`[pet ${level}] ${message} (${source}:${line})`);
  });
  petWin.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.log(`[fail] ${code} ${description} ${url}`);
  });
  petWin.webContents.on("render-process-gone", (_event, details) => {
    console.log(`[gone] ${details.reason}`);
  });
  petWin.loadFile(path.join(__dirname, "pet.html"));
  petWin.once("ready-to-show", () => petWin.showInactive());

  bubbleWin = new BrowserWindow({
    width: 300,
    height: 248,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "bubble-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  bubbleWin.setAlwaysOnTop(true, "screen-saver");
  bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  bubbleWin.loadFile(path.join(__dirname, "bubble.html"));

  function setPace(pace) {
    writeState({ pace });
    petWin.webContents.send("action", { type: "pace", pace });
  }

  function setPerch(perch) {
    writeState({ perch });
    petWin.webContents.send("action", { type: "perch", perch });
  }

  function setHidden(hidden) {
    writeState({ hidden });
    petWin.webContents.send("action", { type: "hide", hidden });
  }

  function buildMenu() {
    const pace = saved.pace || "low";
    const perch = saved.perch || "high";
    const hidden = !!saved.hidden;
    return Menu.buildFromTemplate([
      { label: "跟 Doro 说话", click: () => petWin.webContents.send("action", { type: "talk" }) },
      { label: "喂饼干", click: () => petWin.webContents.send("action", { type: "feed", food: "cookie" }) },
      { label: "喂草莓", click: () => petWin.webContents.send("action", { type: "feed", food: "berry" }) },
      { label: "喂牛奶", click: () => petWin.webContents.send("action", { type: "feed", food: "milk" }) },
      { type: "separator" },
      {
        label: "走动频率",
        submenu: [
          { label: "较少", type: "radio", checked: pace === "low", click: () => setPace("low") },
          { label: "适中", type: "radio", checked: pace === "mid", click: () => setPace("mid") },
          { label: "较多", type: "radio", checked: pace === "high", click: () => setPace("high") },
        ],
      },
      {
        label: "趴窗口频率",
        submenu: [
          { label: "较少", type: "radio", checked: perch === "low", click: () => setPerch("low") },
          { label: "适中", type: "radio", checked: perch === "mid", click: () => setPerch("mid") },
          { label: "较多", type: "radio", checked: perch === "high", click: () => setPerch("high") },
        ],
      },
      {
        label: hidden ? "从角落出来" : "躲到左下角",
        click: () => setHidden(!hidden),
      },
      { label: "继续闲逛", click: () => petWin.webContents.send("action", { type: "wander" }) },
      { label: "退出", click: () => app.quit() },
    ]);
  }

  ipcMain.on("menu", () => buildMenu().popup({ window: petWin }));
  ipcMain.on("hover", (_event, over) => {
    hover = !!over;
    if (!capture) petWin.setIgnoreMouseEvents(!hover, { forward: true });
  });
  ipcMain.on("place", (_event, rect) => {
    if (!petWin || petWin.isDestroyed()) return;
    const next = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.w),
      height: Math.round(rect.h),
    };
    const current = petWin.getBounds();
    if (
      current.x !== next.x ||
      current.y !== next.y ||
      current.width !== next.width ||
      current.height !== next.height
    ) {
      petWin.setBounds(next);
    }
    placeBubble();
  });
  ipcMain.on("say", (_event, payload) => showBubble(payload));
  ipcMain.on("hunger", (_event, value) => {
    lastHunger = value;
  });
  ipcMain.on("save", (_event, state) => writeState(state));
  ipcMain.on("log", (_event, message) => {
    fs.appendFileSync(path.join(app.getPath("userData"), "doro.log"), message + "\n");
  });
  ipcMain.on("preview", (_event, dataUrl) => {
    const body = String(dataUrl).replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(path.join(__dirname, "preview.png"), Buffer.from(body, "base64"));
    app.quit();
  });
  ipcMain.on("user-text", (_event, text) => {
    petWin.webContents.send("action", { type: "text", text });
  });
  ipcMain.on("user-feed", (_event, food) => {
    petWin.webContents.send("action", { type: "feed", food });
  });
  ipcMain.on("user-close", () => {
    chatOpen = false;
    bubbleWin.hide();
    petWin.webContents.send("action", { type: "close-chat" });
  });

  petWin.webContents.on("did-finish-load", () => {
    scanSurfaces();
    petWin.webContents.send("state", saved);
    petWin.webContents.send("ledges", { surfaces: lastSurfaces, floors: lastFloors });
  });
}

function createTray() {
  const roster = require("./characters.json");
  const rosterList = roster["角色"] || [];
  const rosterIndex = Math.max(0, Number(roster["当前"] || 1) - 1);
  const character = rosterList[rosterIndex] || rosterList[0] || { 文件夹: "icon/icon" };
  const iconPath = path.join(__dirname, character["文件夹"], "front.png");
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("Doro");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "跟 Doro 说话", click: () => petWin.webContents.send("action", { type: "talk" }) },
      { label: "喂草莓", click: () => petWin.webContents.send("action", { type: "feed", food: "berry" }) },
      { label: "退出", click: () => app.quit() },
    ])
  );
  tray.on("double-click", () => petWin.webContents.send("action", { type: "talk" }));
}

app.whenReady().then(() => {
  loadState();
  scanSurfaces();
  createWindows();
  if (!SNAPSHOT) createTray();

  setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    const ledges = scanSurfaces();
    petWin.webContents.send("ledges", ledges);
  }, 400);

  setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const left = (GetAsyncKeyState(0x01) & 0x8000) !== 0;
    const right = (GetAsyncKeyState(0x02) & 0x8000) !== 0;
    capture = left && hover;
    petWin.webContents.send("pointer", {
      x: point.x,
      y: point.y,
      left,
      right,
      bounds: petWin.getBounds(),
    });
  }, 16);

  setInterval(hideIfFullscreen, 700);

  if (SNAPSHOT) {
    setTimeout(async () => {
      const image = await petWin.capturePage();
      fs.writeFileSync(path.join(__dirname, "preview.png"), image.toPNG());
      app.quit();
    }, 1800);
  }
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
