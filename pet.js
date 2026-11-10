import roster from "./characters.json" with { type: "json" };
import { createPet, step, surfaceAt } from "./wander.mjs";
import { arriveLine, feedLine, idleLine, petLine, reply, setCharacter, talkOpenLine } from "./talk.mjs";

const rosterList = roster["角色"] || [];
const rosterIndex = Math.max(0, Number(roster["当前"] || 1) - 1);
const character = rosterList[rosterIndex] || rosterList[0];
setCharacter(character?.["对话"]);

const BASE_W = 200;
const BASE_H = 196;
const FOOT_PAD = Number(character?.["脚底边距"] ?? 7);
const PINCH_Y = Number(character?.["掐头高度"] ?? 0.36);
const characterName = character?.["名字"] || "Doro";
const ROOT = `./${String(character?.["文件夹"] || "icon/icon").replace(/\\/g, "/").replace(/\/?$/, "/")}`;

const frames = {
  idle: ["idle_01.png", "idle_02.png", "idle_03.png", "idle_04.png"],
  walk: ["walk_01.png", "walk_02.png", "walk_03.png", "walk_04.png"],
  climb: ["climb_01.png", "climb_02.png", "climb_03.png", "climb_04.png"],
  eat: ["eat_01.png", "eat_02.png", "eat_03.png", "eat_04.png", "eat_05.png", "eat_06.png"],
  talk: ["talk_01.png", "talk_02.png", "talk_03.png", "talk_04.png"],
  drag: ["front.png"],
  fall: ["side.png"],
  back: ["back.png"],
};

const rates = { idle: 4, walk: 8, climb: 7, eat: 6, talk: 5, drag: 1, fall: 1, back: 1 };

const sprite = document.getElementById("pet");
const hearts = document.getElementById("hearts");
const hit = document.createElement("canvas");
const hitCtx = hit.getContext("2d", { willReadFrequently: true });

let world = { surfaces: [], floors: [], dt: 0.016 };
let pet = null;
let scale = 1;
let hunger = 42;
let pace = "low";
let perch = "high";
let hidden = false;
let talkOpen = false;
let pose = "idle";
let pointer = null;
let press = null;
let dragging = false;
let grab = { x: 0, y: 0 };
let leftWas = false;
let rightWas = false;
let justReleased = false;
let petting = null;
let startEat = null;
let now = 0;
let speakAt = 8;
let saveAt = 0;
let ready = false;
let boot = null;
let animTime = 0;
let shownKey = "";
let flipped = false;
let lastFrame = 0;
let holdSway = 0;
let holdVel = 0;
let lastPointerX = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function listFor(current) {
  return frames[current] || frames.idle;
}

function shouldFlip(current) {
  if (!pet) return false;
  if (current === "climb") return pet.climb?.side === "left";
  if (current === "walk" || current === "fall") return pet.dir > 0;
  return false;
}

function syncHit() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!width || !height || !sprite.complete || !sprite.naturalWidth) return;
  hit.width = width;
  hit.height = height;
  hitCtx.clearRect(0, 0, width, height);
  hitCtx.save();
  if (flipped) {
    hitCtx.translate(width, 0);
    hitCtx.scale(-1, 1);
  }
  hitCtx.drawImage(sprite, 0, 0, width, height);
  hitCtx.restore();
}

sprite.addEventListener("load", syncHit);

function showSprite(current, dt) {
  const list = listFor(current);
  if (shownKey !== current) {
    shownKey = current;
    animTime = 0;
  } else {
    animTime += dt;
  }
  const index = Math.floor(animTime * (rates[current] || 6)) % list.length;
  const next = ROOT + list[index];
  if (sprite.dataset.frame !== next) {
    sprite.dataset.frame = next;
    sprite.src = next;
  }
  flipped = shouldFlip(current);
  const holding = current === "drag";
  document.body.classList.toggle("dragging", holding);
  const bob = current === "walk" ? Math.sin(animTime * 12) * 3 : 0;
  let sway = 0;
  if (holding && pointer) {
    if (lastPointerX != null) {
      const speed = (pointer.x - lastPointerX) / Math.max(dt, 0.008);
      holdVel += -speed * 0.011;
    }
    lastPointerX = pointer.x;
    holdVel += -holdSway * 0.22;
    holdVel *= 0.84;
    holdSway = clamp(holdSway + holdVel, -18, 18);
    sway = holdSway + Math.sin(animTime * 2.2) * 1.6;
  } else {
    holdSway = 0;
    holdVel = 0;
    lastPointerX = null;
  }
  sprite.style.transformOrigin = holding ? "50% 36%" : "50% 72%";
  sprite.style.transform = `${flipped ? "scaleX(-1) " : ""}translateY(${bob}px) rotate(${sway}deg)`;
  const holder = document.getElementById("holder");
  holder.style.transform = `translate(-50%, -100%) rotate(${sway * 0.25}deg)`;
  if (performance.now() - lastFrame > 80) {
    lastFrame = performance.now();
    syncHit();
  }
}

function clampToLedge(ledge, x) {
  if (ledge.x2 - ledge.x1 <= 80) return (ledge.x1 + ledge.x2) / 2;
  return Math.max(ledge.x1 + 24, Math.min(ledge.x2 - 24, x));
}

function placeWindow() {
  const width = Math.round(BASE_W * scale);
  const height = Math.round(BASE_H * scale);
  const pad = Math.round(FOOT_PAD * scale);
  window.doro.place({
    x: pet.x - width / 2,
    y: pet.y - height + pad,
    w: width,
    h: height,
  });
}

function say(text, mode) {
  window.doro.say({ text, mode, hunger, name: characterName });
  window.doro.hunger(hunger);
}

function burst() {
  for (let index = 0; index < 4; index += 1) {
    const heart = document.createElement("span");
    heart.className = "heart";
    heart.textContent = "♥";
    heart.style.left = `${38 + Math.random() * 24}%`;
    heart.style.animationDelay = `${index * 0.08}s`;
    hearts.appendChild(heart);
    setTimeout(() => heart.remove(), 1000);
  }
}

function feed(kind) {
  const amount = kind === "berry" ? 34 : kind === "milk" ? 28 : 24;
  hunger = Math.max(0, hunger - amount);
  startEat = kind;
  say(feedLine(kind), talkOpen ? "chat" : "toast");
  burst();
}

function hitTest(localX, localY) {
  if (!hit.width || localX < 0 || localY < 0 || localX >= hit.width || localY >= hit.height) return null;
  const alpha = hitCtx.getImageData(localX | 0, localY | 0, 1, 1).data[3];
  if (alpha < 20) return null;
  return localY < hit.height * 0.58 ? "head" : "body";
}

function hideSpot() {
  const floors = world.floors || [];
  if (!floors.length) return null;
  const floor = floors.slice().sort((a, b) => a.x1 - b.x1)[0];
  return { x: floor.x1, y: floor.y, ledgeId: floor.id };
}

function tick(stamp) {
  const dt = Math.min((stamp - (tick.last || stamp)) / 1000, 0.05);
  tick.last = stamp;
  requestAnimationFrame(tick);
  now += dt;
  if (!ready || !pet) return;

  hunger = Math.min(100, hunger + dt * 0.055);
  const width = BASE_W * scale;
  const height = BASE_H * scale;
  const pad = FOOT_PAD * scale;
  const dragX = dragging && pointer ? pointer.x : pet.x;
  const dragY = dragging && pointer ? pointer.y + height - pad - height * PINCH_Y : pet.y;
  const spot = hidden ? hideSpot() : null;
  const result = step(pet, { ...world, dt }, {
    now,
    dragging,
    dragX,
    dragY,
    hidden: hidden && !dragging,
    hideX: spot?.x,
    hideY: spot?.y,
    hideLedgeId: spot?.ledgeId,
    justReleasedDrag: justReleased,
    startEat: !!startEat,
    talkOpen,
    pace,
    perch,
    speed: hunger > 82 ? 68 : 96,
  });
  pose = result.pose;
  justReleased = false;
  if (startEat) startEat = null;

  if (petting) {
    say(petLine(petting, { hunger, pose }), talkOpen ? "chat" : "toast");
    burst();
    petting = null;
  }

  if (!talkOpen && pose === "walk" && now > speakAt) {
    speakAt = now + 18 + Math.random() * 16;
    if (Math.random() < 0.8) say(idleLine({ hunger, pose }), "toast");
  }

  showSprite(pose, dt);
  placeWindow();
  saveAt += dt;
  if (saveAt > 4) {
    saveAt = 0;
    window.doro.save({ hunger, scale, pace, perch, hidden, x: pet.x, y: pet.y });
    window.doro.hunger(hunger);
  }
}
requestAnimationFrame(tick);

window.addEventListener("resize", syncHit);

window.doro.onState((state) => {
  boot = state || {};
  scale = boot.scale || 1;
  hunger = boot.hunger ?? 42;
  pace = boot.pace || "low";
  perch = boot.perch || "high";
  hidden = !!boot.hidden;
});

window.doro.onLedges((payload) => {
  world = { surfaces: payload.surfaces || [], floors: payload.floors || [], dt: 0.016 };
  if (!pet && world.floors.length) {
    const floor = world.floors.find((item) => boot?.x >= item.x1 && boot?.x <= item.x2) || world.floors[0];
    const savedOk = boot?.x != null && boot?.y != null && boot.y > floor.y - 2000 && boot.y < floor.y + 40;
    const x = savedOk ? boot.x : (floor.x1 + floor.x2) / 2;
    const stand = (savedOk && surfaceAt(world, x, boot.y)) || floor;
    pet = createPet(x, stand.y, stand.id);
    pet.x = clampToLedge(stand, x);
    pet.y = stand.y;
    pet.ledgeId = stand.id;
    pet.idleUntil = pace === "high" ? 1.6 : pace === "mid" ? 4 : 8;
    ready = true;
    showSprite("idle", 0);
    placeWindow();
    say(arriveLine(), "toast");
  }
});

window.doro.onPointer((payload) => {
  pointer = payload;
  const localX = payload.x - payload.bounds.x;
  const localY = payload.y - payload.bounds.y;
  const zone = hitTest(localX, localY);
  const over = !!zone;
  window.doro.hover(over || dragging);

  if (payload.left && !leftWas && over && pet) {
    press = { x: payload.x, y: payload.y, zone };
    grab = { x: pet.x - payload.x, y: pet.y - payload.y };
    dragging = false;
  }
  if (payload.left && press && Math.hypot(payload.x - press.x, payload.y - press.y) > 8) {
    dragging = true;
    hidden = false;
  }
  if (!payload.left && leftWas) {
    if (dragging) justReleased = true;
    else if (press && over) petting = press.zone;
    dragging = false;
    press = null;
  }
  if (payload.right && !rightWas && over) window.doro.menu();
  leftWas = payload.left;
  rightWas = payload.right;
});

window.doro.onAction((action) => {
  if (action.type === "talk") {
    talkOpen = true;
    say(talkOpenLine(hunger), "chat");
  } else if (action.type === "close-chat" || action.type === "wander") {
    talkOpen = false;
    if (action.type === "wander" && pet) {
      pet.mode = "walk";
      pet.walked = 0;
    }
  } else if (action.type === "feed") {
    feed(action.food || "cookie");
  } else if (action.type === "pace") {
    pace = action.pace || "low";
    if (pet && pet.mode === "idle") {
      pet.idleUntil = Math.max(pet.idleUntil, now + (pace === "high" ? 1 : pace === "mid" ? 3 : 6));
    }
    window.doro.save({ hunger, scale, pace, perch, hidden, x: pet?.x, y: pet?.y });
  } else if (action.type === "perch") {
    perch = action.perch || "high";
    window.doro.save({ hunger, scale, pace, perch, hidden, x: pet?.x, y: pet?.y });
  } else if (action.type === "hide") {
    hidden = action.hidden != null ? !!action.hidden : !hidden;
    if (!hidden && pet) {
      pet.mode = "idle";
      pet.idleUntil = now + 1.2;
    }
    window.doro.save({ hunger, scale, pace, perch, hidden, x: pet?.x, y: pet?.y });
  } else if (action.type === "text") {
    talkOpen = true;
    say(reply(action.text, { hunger, pose }), "chat");
  }
});

window.addEventListener("wheel", (event) => {
  if (!pointer || !pet) return;
  const localX = pointer.x - pointer.bounds.x;
  const localY = pointer.y - pointer.bounds.y;
  if (!hitTest(localX, localY)) return;
  scale = clamp(scale * (event.deltaY > 0 ? 0.94 : 1.06), 0.55, 1.8);
  window.doro.save({ hunger, scale, pace, perch, hidden, x: pet.x, y: pet.y });
});

window.addEventListener("error", (event) => {
  window.doro.log(event.message || "unknown error");
});
