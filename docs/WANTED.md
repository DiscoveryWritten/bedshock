# The questions this battery does not ask

Every row in `content/capabilities/` names a `probe` or states what `established_by` it.
`tools/catalog.ts` enforces that, and it should: a question with no way to answer it is a
question nobody will ever read the result of.

But that leaves a gap with nowhere to live. When a pack cites this battery and finds
**nothing on the subject at all**, that absence is itself a finding — and today it survives
only in whoever noticed it. This file is where those go: **a question, and the decision it
blocks, written down before the probe exists.**

Nothing here is a capability. Nothing here has an answer. Promoting an entry means writing
its probe and moving it into `content/capabilities/`, at which point it leaves this file.

**Read an entry as "we do not know", never as "no".** A negative that a design can rest on
has to be measured and cited like any other answer — see *Citing a negative* in the README.

---

## Blocks

There is no `block.*` id anywhere in the battery. Across seven files and seventy questions the
only block question is inside `entity.yaml`
(`entity.container.is_the_only_container_host`, which asks whether a custom block can carry a
container *at all*). Any pack whose content is mostly custom blocks is citing nothing.

- **Can a custom block carry a multi-state height, and how many states before something
  complains?** — Decides whether a "partial block" family is one block with states or N
  separate blocks, which is the difference between a handful of definitions and a combinatorial
  set. Also decides whether the states can be walked through by script.
- **Can an add-on intercept a right-click made with a *vanilla* tool on a custom block, and
  suppress that tool's vanilla behaviour?** — Decides whether existing tools can be given new
  verbs on custom content, or whether every interaction needs a custom item to hold.
- **Can a custom block emit a redstone signal that vanilla redstone reads?** — Decides whether
  custom content can be an *input* to vanilla contraptions rather than only a consumer of them.
  This is the one most likely to be assumed rather than checked.
- **Can a custom block read the redstone power applied to it?** — The other direction, and not
  implied by the first.

## Light

Nothing in the battery asks about light. `render.yaml` is entirely Molang, attachables and
render controllers.

- **Can anything an add-on controls emit light at a chosen level — a custom block, and
  separately an entity?** — Decides whether a design can light a space as an effect rather than
  by placing vanilla light sources, which are visible, breakable and wrong-coloured.
- **Can emitted light be coloured?** — Decides whether "coloured light" is a real mechanic or a
  particle-and-fog impression of one. Worth asking as its own question because the answer is
  very likely no, and a cited no is worth more than a design that quietly assumes yes and gets
  a white glow. Vanilla Bedrock light is a level, not a colour; this asks whether anything
  available to a pack changes that.

## Potions, effects and projectiles

Nothing on any of it — no potion, effect, projectile or arrow question exists.

- **Can a custom status effect be defined?** — Decides whether a bespoke effect is a real
  effect (with a HUD icon, a duration the game ticks, and vanilla milk/immunity interactions)
  or a script-side timer wearing an effect's clothes. Note the neighbouring measured answer:
  `ui.enchanting.custom_enchantments_or_interception` is **no**, which suggests but does not
  establish the same wall here.
- **Can a custom potion be brewed, and can it be loaded into a Bedrock potion cauldron?** —
  Decides whether the vanilla arrow-dipping path is available to custom content. Bedrock's
  cauldron holds potions and dips arrows, which is an unusually generous piece of vanilla
  infrastructure to inherit if custom potions can reach it.
- **On a projectile hit, can script read which potion a vanilla tipped arrow carried?** —
  Decides whether an existing vanilla tipped arrow can be used as a *carrier* for custom
  behaviour, inheriting brewing, dipping, stacking and the particle trail for free, with the
  pack writing only the hit handler. Cheaper than custom projectiles if it holds.

## Item entities

`entity.yaml` has sixteen questions, all containers, collision, stash and falling blocks.

- **Can a dropped item entity's despawn be prevented or extended?** — Decides whether "items
  put here stay here" is implementable without a chunk-loaded script babysitting every stack.
- **Do nearby dropped stacks still merge on their own, and within what radius?** — Decides
  whether a design that gathers items can get stack consolidation from vanilla for free rather
  than implementing merge logic. A number, so a candidate for `solved` rather than yes/no.

## Fluid movement

`physics.yaml` has five rows, all falling blocks, throwing and knockback.

- **Can a custom block reproduce water's movement behaviour closely enough that
  water-movement enchantments apply to a player inside it?** — Decides whether a
  swim-through-something design inherits Depth Strider and the rest, or has to implement its
  own dampening and accept that player gear does nothing. The failure mode is quiet: movement
  that feels approximately right while the enchantments silently do nothing.

## Cauldrons

- **Can a cauldron hold anything an add-on defines, and can its fill state be read and written
  by script?** — Decides whether the cauldron is a reusable custom container with vanilla
  affordances already attached, or whether custom content has to build its own.

## The world as storage

Nothing in the battery asks whether a pack can keep **arbitrary state in the world itself**:
as blocks it owns, in a block array the save file keeps, or in chunks nobody visits. The only
persistence rows are `item.dynamic_properties.*`, which cover one item's properties and nothing
larger. Every answer below is wanted *as a primitive*, so any pack can cite it. None of it is a
storage design.

The shape these questions are for is a **reader**, not a dump. State lives canonically in
storage the pack owns. It is read when it is needed and written a little at a time, so that
nothing ever spends fifteen seconds of load writing everything out, and a power cut loses at most
the last small write. Scoreboards used as a RAM stand-in are explicitly not this.

**Promoted 2026-09-27** to `content/capabilities/storage.yaml`: whether a script-written
structure reads back, survives a reload and a hard kill, what saving it costs, and how many bits
one custom block holds and whether every symbol comes back exactly. What is left here has no
probe yet.

- **How large can one `createEmpty` be, and how many world structures before something
  complains?** — Decides how much a pack can keep this way, and how it is paged.
- **Can a structure made by one behavior pack be read by another in the same world?** — Decides
  whether world state can be shared between packs installed side by side. `item.dynamic_properties`
  rows do not answer this for world dynamic properties, which are believed to be scoped to the pack
  that wrote them. If structures are not scoped that way, they are the shared channel that
  dynamic properties are not.

**Chunks the pack owns.**

- **Can script write and read blocks in the bedrock floor (y -64 to -60), and does anything put
  bedrock back?** — Decides whether state can live directly under the chunks a pack already uses,
  out of the player's way, with no extra chunks to keep loaded.
- **Can a pack load a far region on demand without a player** (a ticking area through
  `runCommand`, or anything else), how many at once, how large, and how many ticks from asking to
  the first readable block? — Decides whether storage somewhere nobody goes is readable when it is
  needed. The tick count is the latency of every cold read. A number.
- **Do `setBlockPermutation`, `getBlock` and `getBlocks` keep working, exactly, at extreme
  coordinates**: the far lands and the stripe lands, where the float error that dampens player
  movement lives? — Block positions are integers, so they might be untouched by what breaks
  movement there. Nobody has to walk to storage for it to work. Decides whether the extremes of
  the world are usable address space.
- **How many block writes, and how many reads, fit in one tick before the tick overruns?** —
  Decides how fast a reader can page state in and out without being felt. Separately for single
  calls, `fillBlocks` and `getBlocks`, because the bulk calls may be the whole answer. Numbers.

**Structure blocks as references.**

- **Can script read or write a placed structure block's configuration** (structure name, size,
  offset)? — Decides whether a block in storage can point at a structure by name, which is the
  cheap way to store something large: the reference is serialised, and the thing it refers to is
  placed when read. If the answer is no, the name has to be encoded in blocks like any other
  string.
