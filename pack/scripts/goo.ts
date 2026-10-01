/**
 * The goo lab block's hooks, every one of them logged. Measurement, not behaviour: the point is to
 * learn which of these fire, for what, at which height -- the desk research predicts onStepOn is
 * silent below a 3.2 px collision box, which would make the thinnest goo (2 px) unfeelable natively.
 *
 *   BEDSHOCK EVENT goo <hook> <json>
 *
 * Registered at startup, which is the only time a custom component can be.
 */

import { system, type Block, type Entity } from '@minecraft/server';

import { NAMESPACE } from './generated.ts';

const where = (b: Block) => ({ at: b.location, states: b.permutation.getAllStates() });
const who = (e: Entity | undefined) => (e ? { type: e.typeId, id: e.id, at: e.location } : null);

function log(hook: string, data: Record<string, unknown>): void {
  console.warn(`BEDSHOCK EVENT goo ${hook} ${JSON.stringify(data)}`);
}

export function install(): void {
  system.beforeEvents.startup.subscribe((e) => {
    e.blockComponentRegistry.registerCustomComponent(`${NAMESPACE}:goo_lab`, {
      onStepOn: (ev) => log('stepOn', { ...where(ev.block), entity: who(ev.entity) }),
      onStepOff: (ev) => log('stepOff', { ...where(ev.block), entity: who(ev.entity) }),
      onEntityFallOn: (ev) => log('entityFallOn', { ...where(ev.block), entity: who(ev.entity), fallDistance: ev.fallDistance }),
      onPlayerInteract: (ev) => log('playerInteract', { ...where(ev.block), player: who(ev.player), face: ev.face, faceLocation: ev.faceLocation ?? null }),
      onPlace: (ev) => log('place', { ...where(ev.block), previous: ev.previousBlock.type.id }),
      onBreak: (ev) => log('break', { at: ev.block.location, source: who(ev.entitySource) }),
      onRedstoneUpdate: (ev) => log('redstoneUpdate', { ...where(ev.block), power: ev.powerLevel, previous: ev.previousPowerLevel }),
      onBlockStateChange: (ev) => log('blockStateChange', { ...where(ev.block) }),
    });
  });
}
