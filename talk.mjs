import packs from "./dialogue.json" with { type: "json" };

function firstPack() {
  const id = Object.keys(packs).find((key) => key !== "说明" && packs[key]?.actions);
  return packs[id];
}

let dialogue = firstPack();

export function setCharacter(id) {
  if (packs[id]?.actions) dialogue = packs[id];
}

function pick(list) {
  if (!list || list.length === 0) return "";
  return list[Math.floor(Math.random() * list.length)];
}

function textList(entry) {
  if (!entry) return [];
  if (Array.isArray(entry)) return entry;
  return entry["台词"] || [];
}

function lines(name) {
  return textList(dialogue.actions[name]);
}

function has(text, words) {
  return words.some((word) => text.includes(word));
}

export function actionLine(name) {
  return pick(lines(name));
}

export function arriveLine() {
  return actionLine("arrive");
}

export function talkOpenLine(hunger) {
  if (hunger > 76) return actionLine("talkHungry") || actionLine("talk");
  return actionLine("talk");
}

export function idleLine(ctx) {
  if (ctx.hunger > 74 && Math.random() < 0.65) return actionLine("hungry");
  if (ctx.pose === "climb") return actionLine("climb");
  if (ctx.pose === "walk") return actionLine("walk") || actionLine("idle");
  if (ctx.pose === "fall") return actionLine("fall") || actionLine("idle");
  if (ctx.pose === "drag") return actionLine("drag") || actionLine("idle");
  return actionLine("idle");
}

export function petLine(zone, ctx) {
  if (ctx.hunger > 80) return actionLine("petHungry");
  if (zone === "head") return actionLine("petHead");
  return actionLine("petBody");
}

export function feedLine(food) {
  const group = textList(dialogue.eat[food]);
  return pick(group.length ? group : textList(dialogue.eat.cookie));
}

export function reply(raw, ctx) {
  const text = (raw || "").trim();
  if (!text) return pick(textList(dialogue.empty));
  const hungry = ctx.hunger > 72;

  for (const item of dialogue.replies["规则"]) {
    if (!has(text, item.keywords)) continue;
    if (hungry && item.hungry && item.hungry.length) return pick(item.hungry);
    return pick(item.normal);
  }

  if (hungry) return pick(textList(dialogue.fallbackHungry));
  const line = pick(textList(dialogue.fallback));
  return line.replace("{text}", text.slice(0, 18));
}
