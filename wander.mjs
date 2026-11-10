const MARGIN = 64;
const CLIMB_SPEED = 150;
const FALL_G = 2400;

export function createPet(x, y, ledgeId) {
  return {
    x,
    y,
    dir: 1,
    mode: "idle",
    ledgeId,
    vy: 0,
    idleUntil: 1.1,
    modeUntil: 0,
    walked: 0,
    nextPause: 240,
    climb: null,
    squash: 0,
    prevY: y,
    speed: 92,
  };
}

function byId(list, id) {
  return list.find((item) => item.id === id) || null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function surfaceAt(world, x, y) {
  const all = world.surfaces.filter(
    (item) => x >= item.x1 - 48 && x <= item.x2 + 48 && item.y >= y - 6
  );
  all.sort((a, b) => a.y - b.y);
  return all[0] || world.floors[0] || null;
}

function nearestAbove(surfaces, x, y) {
  const found = surfaces.filter(
    (item) => !item.floor && x >= item.x1 - 80 && x <= item.x2 + 80 && item.y < y - 72
  );
  found.sort((a, b) => b.y - a.y);
  return found[0] || null;
}

function neighbor(surfaces, pet, dir) {
  return (
    surfaces.find((item) => {
      if (item.id === pet.ledgeId || item.floor) return false;
      if (Math.abs(item.y - pet.y) > 26) return false;
      return dir > 0
        ? item.x1 < pet.x + 70 && item.x2 > pet.x + 16
        : item.x2 > pet.x - 70 && item.x1 < pet.x - 16;
    }) || null
  );
}

function stick(pet, ledge) {
  if (!ledge) return false;
  pet.y = ledge.y;
  pet.ledgeId = ledge.id;
  const span = ledge.x2 - ledge.x1;
  if (span <= 80) {
    pet.x = (ledge.x1 + ledge.x2) / 2;
    return true;
  }
  pet.x = clamp(pet.x, ledge.x1 + 18, ledge.x2 - 18);
  return true;
}

function startClimb(pet, target, edgeX, side) {
  pet.mode = "climb";
  pet.climb = { targetId: target.id, edgeX, side };
  pet.vy = 0;
}

function startFall(pet) {
  pet.mode = "fall";
  pet.vy = 30;
  pet.climb = null;
}

function landOn(pet, ledge, now) {
  pet.y = ledge.y;
  pet.x = clamp(pet.x, ledge.x1 + 24, ledge.x2 - 24);
  pet.ledgeId = ledge.id;
  pet.vy = 0;
  pet.mode = "idle";
  pet.idleUntil = now + 0.45;
  pet.squash = 0.18;
  pet.climb = null;
}

function nearestFloor(floors, x) {
  return floors
    .map((floor) => {
      const clamped = clamp(x, floor.x1, floor.x2);
      return { floor, dist: Math.abs(clamped - x) };
    })
    .sort((a, b) => a.dist - b.dist)[0]?.floor;
}

function updateFall(pet, world, now) {
  pet.vy = Math.min(pet.vy + FALL_G * world.dt, 1600);
  pet.y += pet.vy * world.dt;
  const landing = world.surfaces
    .filter(
      (item) =>
        pet.x >= item.x1 - 36 &&
        pet.x <= item.x2 + 36 &&
        item.y >= pet.prevY - 8 &&
        item.y <= pet.y + 4
    )
    .sort((a, b) => a.y - b.y)[0];
  if (landing) {
    landOn(pet, landing, now);
    return { pose: "idle" };
  }
  const floor = nearestFloor(world.floors, pet.x);
  if (floor && pet.y >= floor.y - 2) {
    pet.x = clamp(pet.x, floor.x1 + 36, floor.x2 - 36);
    landOn(pet, floor, now);
    return { pose: "idle" };
  }
  return { pose: "fall" };
}

function considerWindow(pet, world) {
  if (!world.floors.some((floor) => floor.id === pet.ledgeId)) return false;
  for (const ledge of world.surfaces) {
    if (ledge.floor || ledge.y > pet.y - 80) continue;
    const fromLeft = pet.dir > 0 && Math.abs(pet.x - ledge.x1) < 28;
    const fromRight = pet.dir < 0 && Math.abs(pet.x - ledge.x2) < 28;
    if (!fromLeft && !fromRight) continue;
    const key = `${ledge.id}:${fromLeft ? "L" : "R"}`;
    if (pet.skipClimbKey === key) return false;
    pet.skipClimbKey = key;
    if (world.rng() > perchChance(world.perch).onto) return false;
    startClimb(pet, ledge, fromLeft ? ledge.x1 : ledge.x2, fromLeft ? "left" : "right");
    return true;
  }
  pet.skipClimbKey = "";
  return false;
}

function perchChance(perch) {
  if (perch === "low") return { onto: 0.12, up: 0.15, down: 0.45 };
  if (perch === "mid") return { onto: 0.4, up: 0.35, down: 0.28 };
  return { onto: 0.82, up: 0.7, down: 0.12 };
}

function paceTiming(pace, rng) {
  if (pace === "high") return { idle: 1.4 + rng() * 2.2, walk: 220 + rng() * 260 };
  if (pace === "mid") return { idle: 4 + rng() * 4, walk: 110 + rng() * 120 };
  return { idle: 8 + rng() * 7, walk: 50 + rng() * 70 };
}

function updateWalk(pet, world, now) {
  const ledge = byId(world.surfaces, pet.ledgeId);
  if (!ledge) {
    startFall(pet);
    return { pose: "fall" };
  }
  stick(pet, ledge);
  const speed = pet.speed * (ledge.floor ? 1 : 0.92);
  pet.x += pet.dir * speed * world.dt;
  pet.walked += speed * world.dt;

  if (considerWindow(pet, world)) return { pose: "climb" };

  const span = ledge.x2 - ledge.x1;
  const edge = 52;
  const atLeft = span > edge * 2 && pet.x <= ledge.x1 + edge;
  const atRight = span > edge * 2 && pet.x >= ledge.x2 - edge;
  if (atLeft || atRight) {
    const beside = neighbor(world.surfaces, pet, atLeft ? -1 : 1);
    if (beside) {
      pet.ledgeId = beside.id;
      pet.y = beside.y;
      return { pose: "walk" };
    }
    const edgeX = atLeft ? ledge.x1 : ledge.x2;
    const above = nearestAbove(world.surfaces, edgeX, pet.y);
    const below = world.surfaces
      .filter(
        (item) =>
          item.id !== ledge.id &&
          edgeX >= item.x1 - 70 &&
          edgeX <= item.x2 + 70 &&
          item.y > pet.y + 48
      )
      .sort((a, b) => a.y - b.y)[0];
    const perch = perchChance(world.perch);
    if (above && world.rng() < perch.up) {
      startClimb(pet, above, edgeX, atLeft ? "left" : "right");
      return { pose: "climb" };
    }
    if (below && !ledge.floor && world.rng() < perch.down) {
      if (below.y - pet.y > 170) startFall(pet);
      else startClimb(pet, below, edgeX, atLeft ? "left" : "right");
      return { pose: pet.mode };
    }
    pet.dir *= -1;
    pet.x = clamp(pet.x, ledge.x1 + edge + 16, ledge.x2 - edge - 16);
  }

  if (pet.walked >= pet.nextPause) {
    const timing = paceTiming(world.pace, world.rng);
    pet.mode = "idle";
    pet.idleUntil = now + timing.idle;
    pet.walked = 0;
    pet.nextPause = timing.walk;
    return { pose: "idle" };
  }
  return { pose: "walk" };
}

function updateClimb(pet, world, now) {
  const target = byId(world.surfaces, pet.climb?.targetId);
  if (!target) {
    startFall(pet);
    return { pose: "fall" };
  }
  pet.x = pet.climb.edgeX;
  const dy = target.y - pet.y;
  const step = CLIMB_SPEED * world.dt;
  if (Math.abs(dy) <= step + 1) {
    pet.y = target.y;
    pet.ledgeId = target.id;
    pet.mode = "walk";
    pet.dir = pet.climb.side === "left" ? 1 : -1;
    const span = target.x2 - target.x1;
    if (span > MARGIN * 2) {
      pet.x =
        pet.climb.side === "left"
          ? Math.min(target.x2 - MARGIN, target.x1 + MARGIN)
          : Math.max(target.x1 + MARGIN, target.x2 - MARGIN);
    } else {
      pet.x = (target.x1 + target.x2) / 2;
    }
    pet.climb = null;
    pet.walked = 0;
    return { pose: "walk" };
  }
  pet.y += Math.sign(dy) * step;
  return { pose: "climb" };
}

export function step(pet, world, input) {
  const now = input.now;
  world.rng = world.rng || Math.random;
  world.pace = input.pace || "low";
  world.perch = input.perch || "high";
  world.dt = Math.min(world.dt ?? 0.016, 0.05);
  pet.prevY = pet.y;
  pet.squash = Math.max(0, pet.squash - world.dt);
  pet.speed = input.speed || 92;

  if (input.dragging) {
    pet.mode = "drag";
    pet.climb = null;
    pet.x = input.dragX;
    pet.y = input.dragY;
    pet.vy = 0;
    return { pose: "drag" };
  }
  if (input.hidden) {
    pet.mode = "idle";
    pet.climb = null;
    pet.vy = 0;
    if (input.hideX != null) {
      pet.x = input.hideX;
      pet.y = input.hideY;
      pet.ledgeId = input.hideLedgeId || pet.ledgeId;
    }
    return { pose: "idle" };
  }
  if (input.justReleasedDrag) {
    startFall(pet);
  }
  if (input.startEat && pet.mode !== "drag") {
    pet.mode = "eat";
    pet.modeUntil = now + 2.15;
    pet.climb = null;
  }
  if (pet.mode !== "drag" && pet.mode !== "fall" && pet.mode !== "eat") {
    if (input.talkOpen) pet.mode = "talk";
    else if (pet.mode === "talk") {
      pet.mode = "idle";
      pet.idleUntil = now + 0.5;
    }
  }

  if (pet.mode === "eat") {
    const ledge = byId(world.surfaces, pet.ledgeId);
    if (ledge) stick(pet, ledge);
    if (now >= pet.modeUntil) {
      pet.mode = "idle";
      pet.idleUntil = now + 0.7;
    }
    return { pose: "eat" };
  }
  if (pet.mode === "talk") {
    const ledge = byId(world.surfaces, pet.ledgeId);
    if (ledge) stick(pet, ledge);
    else startFall(pet);
    if (pet.mode === "fall") return updateFall(pet, world, now);
    return { pose: "talk" };
  }
  if (pet.mode === "fall") return updateFall(pet, world, now);
  if (pet.mode === "climb") return updateClimb(pet, world, now);
  if (pet.mode === "idle") {
    const ledge = byId(world.surfaces, pet.ledgeId);
    if (!ledge) {
      startFall(pet);
      return { pose: "fall" };
    }
    stick(pet, ledge);
    if (now >= pet.idleUntil) {
      pet.mode = "walk";
      pet.walked = 0;
    }
    return { pose: "idle" };
  }
  return updateWalk(pet, world, now);
}
