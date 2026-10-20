// IA sencilla para los equipos controlados por el ordenador.
import { DepKind, type DependItem } from '../data/stats';
import { MINER, MINING_TOWER, DEPLOY_INTO } from './rules';
import { TILE, type Team, type World, type Entity } from './world';

export class AI {
  private t = 0;
  private wave = 4;
  private attacking = false;
  private lastAttack = 0;

  constructor(private world: World, readonly team: Team) {
    this.t = (team.id * 7) % 15;
  }

  private mine(): Entity[] {
    return this.world.ents.filter((e) => e.team === this.team.id && e.alive);
  }

  step(): void {
    if (this.team.defeated || !this.team.active) return;
    if (++this.t % 15 !== 0) return;
    const w = this.world;
    const own = this.mine();
    const army = own.filter((e) => e.kind === 'unit' && w.weapon(e) && e.def.speed > 0 && !MINER.includes(e.type) && e.state !== 'spawn');
    const miners = own.filter((e) => MINER.includes(e.type));
    const towers = own.filter((e) => MINING_TOWER.includes(e.type));

    // mineros ociosos -> respiradero libre más cercano
    for (const m of miners) {
      if (m.order.type !== 'idle' || m.state === 'deploy') continue;
      const v = w.nearestFreeVent(m.x, m.y, true);
      if (v) w.deploy([m], v);
    }

    const items = w.rules.buildable(this.team.race).filter((d) => w.available(this.team, d));
    const unitItem = (pred: (d: DependItem) => boolean) => items.filter((d) => d.kind === DepKind.Unit && pred(d));

    // economía: hasta 4 torres (o tantas como respiraderos libres)
    const freeVents = w.ents.filter((e) => e.kind === 'vent' && e.amount > 0 && e.rate > 0).length;
    const wantMiners = Math.min(4, freeVents) - towers.length - miners.length;
    if (wantMiners > 0 && this.team.queues.unit.length < 2) {
      const mi = unitItem((d) => MINER.includes(d.target))[0];
      if (mi && this.team.money >= mi.cost) w.enqueue(this.team, mi);
    }

    // edificios: el más barato disponible
    if (!this.team.queues.build.length) {
      const b = items.filter((d) => d.kind === DepKind.Building).sort((a, c) => a.cost - c.cost)[0];
      if (b && this.team.money >= b.cost + 400) w.enqueue(this.team, b);
    }

    // ejército
    if (this.team.queues.unit.length < 3) {
      const combat = unitItem((d) => !MINER.includes(d.target) && !!w.rules.weaponFor(d.target));
      if (combat.length) {
        // preferir unidades más caras cuando sobra dinero
        combat.sort((a, c) => c.cost - a.cost);
        const affordable = combat.filter((d) => d.cost <= this.team.money - 200);
        const pick = affordable[Math.floor(Math.random() * Math.min(3, affordable.length))];
        if (pick) w.enqueue(this.team, pick);
      }
    }

    // defensa estática: hasta 2 torres desplegadas entre la ciudad y el enemigo
    const towerBuilders = own.filter((e) => e.kind === 'unit' && (DEPLOY_INTO[e.type] === 41 || DEPLOY_INTO[e.type] === 42));
    const defTowers = own.filter((e) => e.type === 41 || e.type === 42).length;
    if (defTowers + towerBuilders.length < 2 && this.team.money > 3000 && this.team.queues.unit.length < 3) {
      const tb = unitItem((d) => DEPLOY_INTO[d.target] === 41 || DEPLOY_INTO[d.target] === 42)[0];
      if (tb) w.enqueue(this.team, tb);
    }
    for (const b of towerBuilders) {
      if (b.order.type !== 'idle' || b.state === 'deploy' || b.state === 'spawn') continue;
      const spot = this.defenseSpot(towerBuilders.indexOf(b));
      if (!spot) continue;
      if (Math.hypot(b.x - spot.x, b.y - spot.y) > 24) w.command([b], { type: 'move', x: spot.x, y: spot.y });
      else w.deploy([b]);
    }

    // investigación si hay dinero de sobra
    if (this.team.money > 6000 && !this.team.queues.research.length) {
      const up = items.find((d) => d.kind === DepKind.Upgrade);
      if (up) w.enqueue(this.team, up);
    }

    // defensa: enemigos cerca de la ciudad
    const city = this.team.city;
    if (city) {
      const threat = w.near(city.x, city.y, 9 * TILE).find((e) => e.alive && w.enemies(this.team.id, e.team) && e.kind === 'unit');
      if (threat) {
        const idle = army.filter((e) => e.order.type !== 'attack');
        if (idle.length) w.command(idle, { type: 'attackmove', x: threat.x, y: threat.y });
        return;
      }
    }

    // ataque por oleadas
    const idleArmy = army.filter((e) => e.order.type === 'idle');
    if (idleArmy.length >= this.wave || (this.attacking && idleArmy.length >= 2 && w.tick - this.lastAttack > 15 * 40)) {
      const target = this.pickTarget();
      if (target) {
        w.command(idleArmy, { type: 'attackmove', x: target.x, y: target.y + 40 });
        this.attacking = true;
        this.lastAttack = w.tick;
        this.wave = Math.min(18, this.wave + 2);
      }
    } else if (city && idleArmy.length) {
      // reunirse frente a la ciudad
      for (const e of idleArmy) {
        if (Math.hypot(e.x - city.x, e.y - (city.y + 120)) > 6 * TILE) w.command([e], { type: 'move', x: city.x + (Math.random() - 0.5) * 120, y: city.y + 120 + (Math.random() - 0.5) * 60 });
      }
    }
  }

  /** Punto a ~7 casillas de la ciudad en dirección al enemigo (fuera del radio de no despliegue). */
  private defenseSpot(i: number): { x: number; y: number } | null {
    const city = this.team.city;
    const target = this.pickTarget();
    if (!city || !target) return null;
    const dx = target.x - city.x, dy = target.y - city.y;
    const d = Math.hypot(dx, dy) || 1;
    const side = i % 2 ? 1 : -1;
    const x = city.x + (dx / d) * 7 * TILE + (-dy / d) * side * 2 * TILE;
    const y = city.y + (dy / d) * 7 * TILE + (dx / d) * side * 2 * TILE;
    const [tx, ty] = this.world.tileOf(x, y);
    const o = this.world.grid.nearestOpen(tx, ty, 4);
    return o ? { x: o[0] * TILE + 16, y: o[1] * TILE + 16 } : null;
  }

  private pickTarget(): { x: number; y: number } | null {
    const w = this.world;
    const from = this.team.city ?? this.mine()[0];
    if (!from) return null;
    let best: Entity | undefined;
    let bd = 1e18;
    for (const e of w.ents) {
      if (!e.alive || !w.enemies(this.team.id, e.team) || e.kind === 'vent' || e.kind === 'prop') continue;
      const t = w.teams[e.team];
      if (!t || !t.active) continue;
      const d = (e.x - from.x) ** 2 + (e.y - from.y) ** 2 + (e.kind === 'building' ? 0 : 4e5);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }
}
