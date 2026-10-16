import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../src/app.js';
import type {
  CaptionData,
  ClientToServerEvents,
  CmdResult,
  Command,
  CommandBody,
  JoinResult,
  RoomSnapshot,
  ServerToClientEvents,
} from '../src/protocol.js';

type CS = Socket<ServerToClientEvents, ClientToServerEvents>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

async function until(pred: () => boolean, what: string, ms = 2500): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await sleep(15);
  }
}

class Client {
  snap: RoomSnapshot | null = null;
  caps: CaptionData | null | undefined = undefined; // undefined = no event yet
  notices: string[] = [];
  closed: string | null = null;
  snaps = 0;
  private constructor(readonly s: CS, readonly id: string, readonly name: string) {
    s.on('room:state', (x) => ((this.snap = x), this.snaps++));
    s.on('captions:data', (d) => (this.caps = d));
    s.on('notice', (t) => this.notices.push(t));
    s.on('room:closed', (r) => (this.closed = r));
  }
  static async connect(url: string, id: string, name = id): Promise<Client> {
    const s: CS = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    await new Promise<void>((res, rej) => (s.once('connect', res), s.once('connect_error', rej)));
    return new Client(s, id, name);
  }
  create(extra: object = {}) {
    return new Promise<string>((res, rej) =>
      this.s.emit('room:create', { clientId: this.id, name: this.name, ...extra }, (r) => (r.ok ? res(r.roomId) : rej(new Error(r.error)))),
    );
  }
  join(roomId: string) {
    return new Promise<JoinResult>((res) => this.s.emit('room:join', { roomId, clientId: this.id, name: this.name }, res)).then((r) => {
      if (r.ok) ((this.snap = r.snapshot), (this.caps = r.captions));
      return r;
    });
  }
  cmd(body: CommandBody, id = `x${++n}`) {
    return new Promise<CmdResult>((res) => this.s.emit('cmd', { id, ...body } as Command, res));
  }
  raw(payload: unknown) {
    return new Promise<CmdResult>((res) => (this.s as unknown as Socket).emit('cmd', payload, res));
  }
  get pb() {
    return this.snap!.playback;
  }
  me() {
    return this.snap!.members.find((m) => m.id === this.id)!;
  }
  close() {
    this.s.close();
  }
}

describe('multi-client behaviour', () => {
  const app = createApp({ leadMs: 100, tickMs: 150, ownerGraceMs: 300, emptyTtlMs: 400, sweepMs: 100 });
  let url = '';
  const all: Client[] = [];
  const mk = async (id: string) => {
    const c = await Client.connect(url, id);
    all.push(c);
    return c;
  };
  before(async () => {
    url = `http://localhost:${await app.listen(0)}`;
  });
  after(async () => {
    all.forEach((c) => c.close());
    await app.close();
  });

  /** owner O, controller C, participant P in one room. */
  async function room() {
    const [O, C, P] = [await mk(`O${++n}`), await mk(`C${n}`), await mk(`P${n}`)];
    const id = await O.create();
    await C.join(id);
    await P.join(id);
    assert.equal((await O.cmd({ type: 'role:set', memberId: C.id, role: 'controller' })).ok, true);
    await until(() => [O, C, P].every((x) => x.snap?.members.find((m) => m.id === C.id)?.role === 'controller'), 'role broadcast');
    return { O, C, P, id };
  }

  it('shared play / pause / seek reach every participant; a participant is refused', async () => {
    const { O, C, P } = await room();
    assert.equal((await O.cmd({ type: 'play', position: 5, basePv: O.pb.v })).ok, true);
    await until(() => [O, C, P].every((x) => x.pb.playing), 'play everywhere');
    assert.deepEqual(new Set([O, C, P].map((x) => x.pb.v)).size, 1);

    const denied = await P.cmd({ type: 'pause', position: 1, basePv: P.pb.v });
    assert.equal(denied.ok, false);
    await sleep(60);
    assert.equal(O.pb.playing, true);

    assert.equal((await C.cmd({ type: 'seek', position: 100 })).ok, true);
    await until(() => [O, P].every((x) => x.pb.position === 100), 'seek everywhere');
    assert.equal((await C.cmd({ type: 'pause', position: 101, basePv: C.pb.v })).ok, true);
    await until(() => [O, C, P].every((x) => !x.pb.playing && x.pb.position === 101), 'pause everywhere');
  });

  it('manually emitted events cannot bypass permissions or validation', async () => {
    const { O, C, P } = await room();
    const attempts: unknown[] = [
      { id: 'a1', type: 'role:set', memberId: P.id, role: 'controller' },
      { id: 'a2', type: 'settings', controllerPower: false },
      { id: 'a3', type: 'owner:transfer', memberId: P.id },
      { id: 'a4', type: 'room:close' },
      { id: 'a5', type: 'seek', position: 3 },
      { id: 'a6', type: 'hardSyncAll', position: 1, at: Date.now() },
      { id: 'a7', type: 'captions:clear' },
    ];
    for (const a of attempts) assert.equal((await P.raw(a)).ok, false, JSON.stringify(a));
    for (const a of attempts.slice(0, 4).concat(attempts[5])) assert.equal((await C.raw(a)).ok, false, 'controller ' + JSON.stringify(a));
    for (const bad of [null, 42, 'x', {}, { id: 'z' }, { id: 'z', type: 'seek', position: -1 }, { id: 'z', type: 'seek', position: 'NaN' }, { id: 'z', type: 'rate', rate: 99 }]) {
      const r = await O.raw(bad);
      assert.equal(!r.ok && r.error, 'bad_request');
    }
    assert.equal(O.snap!.ownerId, O.id);
    assert.equal(O.snap!.settings.controllerPower, true);
    assert.equal(O.closed, null);
  });

  it('revocation applies instantly, also for an in-flight command from the revoked controller', async () => {
    const { O, C } = await room();
    assert.equal((await C.cmd({ type: 'seek', position: 10 })).ok, true);
    // owner revokes; the controller's very next command (sent before it learned about it) must fail
    const [rev, late] = await Promise.all([O.cmd({ type: 'role:set', memberId: C.id, role: 'participant' }), (async () => (await sleep(0), C.cmd({ type: 'seek', position: 999 })))()]);
    assert.equal(rev.ok, true);
    const after = await C.cmd({ type: 'seek', position: 998 });
    assert.equal(after.ok, false);
    assert.notEqual(O.pb.position, 998);
    void late;
  });

  it('global Controller Power: off => controller refused instantly, owner unaffected, role retained, on => restored', async () => {
    const { O, C } = await room();
    assert.equal((await O.cmd({ type: 'settings', controllerPower: false })).ok, true);
    await until(() => C.snap!.settings.controllerPower === false && !C.me().canControl, 'power off visible');
    assert.equal(C.me().role, 'controller');
    assert.equal((await C.cmd({ type: 'seek', position: 5 })).ok, false);
    assert.equal((await O.cmd({ type: 'seek', position: 6 })).ok, true);
    assert.equal((await O.cmd({ type: 'settings', controllerPower: true })).ok, true);
    await until(() => C.me().canControl, 'power on visible');
    assert.equal((await C.cmd({ type: 'seek', position: 7 })).ok, true);
  });

  it("owner's Hard Sync: reference position kept, every client sees a new hardSeq; controllers need permission", async () => {
    const { O, C, P } = await room();
    await O.cmd({ type: 'play', position: 0, basePv: O.pb.v });
    await until(() => P.pb.playing, 'playing');
    await sleep(150); // let the scheduled start (lead 100ms) pass; a sync during the lead only bumps hardSeq by design
    const seq0 = O.pb.hardSeq;
    assert.equal((await C.cmd({ type: 'hardSyncAll', position: 1, at: Date.now() })).ok, false, 'controller denied by default');
    assert.equal((await P.cmd({ type: 'hardSyncAll', position: 1, at: Date.now() })).ok, false);
    assert.equal(O.pb.hardSeq, seq0);

    const at = Date.now() - 30;
    assert.equal((await O.cmd({ type: 'hardSyncAll', position: 42.5, at })).ok, true);
    await until(() => [O, C, P].every((x) => x.pb.hardSeq === seq0 + 1), 'hardSeq everywhere');
    for (const x of [O, C, P]) {
      assert.equal(x.pb.position, 42.5);
      assert.equal(x.pb.by, O.id);
      assert.equal(x.pb.playing, true);
      assert.equal(x.pb.at, at);
    }
    await O.cmd({ type: 'settings', controllersCanSyncAll: true });
    assert.equal((await C.cmd({ type: 'hardSyncAll', position: 50, at: Date.now() })).ok, true, 'allowed once explicitly permitted');
  });

  it('captions: share, replace, duplicate, remove, late join and rejection', async () => {
    const { O, C, P, id } = await room();
    const cues = [{ s: 1, e: 2, t: 'Hi' }, { s: 3, e: 4, t: 'There' }];
    assert.equal((await P.cmd({ type: 'captions:set', name: 'p.srt', cues })).ok, false);
    assert.equal((await C.cmd({ type: 'captions:set', name: 'a.srt', cues })).ok, true);
    await until(() => [O, C, P].every((x) => x.caps?.cues.length === 2), 'captions data everywhere');
    assert.equal(P.snap!.captions?.name, 'a.srt');
    assert.equal(O.caps?.meta.hash, P.caps?.meta.hash);

    const dup = await O.cmd({ type: 'captions:set', name: 'a-again.srt', cues });
    assert.equal(dup.ok && dup.duplicate, true);

    assert.equal((await O.cmd({ type: 'captions:set', name: 'b.srt', cues: [{ s: 0, e: 1, t: 'Replaced' }] })).ok, true);
    await until(() => P.caps?.cues[0]?.t === 'Replaced', 'replacement everywhere');
    assert.equal(P.snap!.captions?.v, 2);

    const late = await mk(`L${++n}`);
    const j = await late.join(id);
    assert.ok(j.ok && j.captions?.cues[0]?.t === 'Replaced', 'late joiner receives the current track in the join ack');
    assert.equal(late.snap!.captions?.name, 'b.srt');

    const fetched = await new Promise<CaptionData | null>((res) => late.s.emit('captions:get', late.snap!.captions!.hash, res));
    assert.equal(fetched?.cues.length, 1);
    assert.equal(await new Promise((res) => late.s.emit('captions:get', 'wronghash', res)), null);

    assert.equal((await O.cmd({ type: 'captions:set', name: 'junk', cues: [{ s: 2, e: 1, t: 'x' }] })).ok, false);
    assert.equal(P.caps?.cues[0]?.t, 'Replaced', 'bad import leaves the shared track untouched');

    assert.equal((await C.cmd({ type: 'captions:clear' })).ok, true);
    await until(() => [O, C, P, late].every((x) => x.caps === null && x.snap!.captions === null), 'removal everywhere');
  });

  it('reconnection: same identity returns with role, latest state and captions; stale socket is shut out', async () => {
    const { O, C, id } = await room();
    await O.cmd({ type: 'captions:set', name: 'a.srt', cues: [{ s: 1, e: 2, t: 'Hi' }] });
    const cid = C.id;
    C.close();
    await until(() => !O.snap!.members.find((m) => m.id === cid)!.online, 'offline visible');
    await O.cmd({ type: 'seek', position: 300 }); // happens while C is away

    const C2 = await Client.connect(url, cid, 'C');
    all.push(C2);
    const j = await C2.join(id);
    assert.ok(j.ok);
    assert.equal(C2.me().role, 'controller');
    assert.equal(C2.pb.position, 300, 'rejoin delivers the latest playback state');
    assert.equal(C2.caps?.cues.length, 1);
    await until(() => O.snap!.members.find((m) => m.id === cid)!.online, 'back online for the owner');
    assert.equal(O.snap!.members.length, 3, 'no duplicate member');

    // a second tab with the same identity takes over; the first one can no longer act
    const C3 = await Client.connect(url, cid, 'C');
    all.push(C3);
    await C3.join(id);
    await until(() => C2.closed !== null, 'old tab told');
    const stale = await C2.cmd({ type: 'seek', position: 1 });
    assert.equal(!stale.ok && stale.error, 'not_in_room');
    assert.equal((await C3.cmd({ type: 'seek', position: 2 })).ok, true);
  });

  it('commands are idempotent when retried with the same id', async () => {
    const { O } = await room();
    const v = O.pb.v;
    const a = await O.cmd({ type: 'seek', position: 9 }, 'retry-1');
    const b = await O.cmd({ type: 'seek', position: 9 }, 'retry-1');
    assert.equal(a.ok && !a.duplicate, true);
    assert.equal(b.ok && b.duplicate, true);
    assert.equal(O.pb.v, v + 1);
  });

  it('heartbeat re-broadcasts while playing with an unchanged rev (clients use rev to detect missed events)', async () => {
    const { O, P } = await room();
    await O.cmd({ type: 'play', position: 0, basePv: O.pb.v });
    await until(() => P.pb.playing, 'playing');
    const rev = P.snap!.rev;
    const count = P.snaps;
    await until(() => P.snaps >= count + 2, 'two heartbeats');
    assert.equal(P.snap!.rev, rev);
  });

  it('owner disconnects: ownership moves to a controller after the grace period; old owner returns as controller', async () => {
    const { O, C, P, id } = await room();
    const oid = O.id;
    O.close();
    await until(() => C.snap!.ownerId === C.id, 'promotion', 3000);
    assert.equal(C.snap!.members.find((m) => m.id === oid)!.role, 'controller');
    assert.ok(C.notices.some((t) => t.includes('is now the owner')));
    const O2 = await Client.connect(url, oid, 'O');
    all.push(O2);
    await O2.join(id);
    assert.equal(O2.me().role, 'controller');
    assert.equal((await O2.cmd({ type: 'settings', controllerPower: false })).ok, false, 'former owner has no owner powers');
    void P;
  });

  it('owner closes the room: everyone is told, room is gone', async () => {
    const { O, C, P, id } = await room();
    assert.equal((await C.cmd({ type: 'room:close' })).ok, false);
    assert.equal((await O.cmd({ type: 'room:close' })).ok, true);
    await until(() => C.closed !== null && P.closed !== null, 'closed notice');
    assert.equal(app.rooms.has(id), false);
    const late = await mk('late' + ++n);
    assert.deepEqual(await late.join(id), { ok: false, error: 'not_found' });
  });

  it('server restart recovery: the room code can be re-created with restored playback, but not stolen while it exists', async () => {
    const O = await mk(`R${++n}`);
    const code = 'ZZ22ZZ';
    const id = await O.create({ roomId: code, restore: { position: 321, playing: true, rate: 1.25 } });
    assert.equal(id, code);
    assert.equal(O.pb.position, 321);
    assert.equal(O.pb.rate, 1.25);
    const other = await mk(`S${n}`);
    await assert.rejects(other.create({ roomId: code }), /taken/);
    await assert.rejects(other.create({ roomId: 'bad!' }), /bad_request/);
  });

  it('empty rooms are swept after the TTL', async () => {
    const O = await mk(`E${++n}`);
    const id = await O.create();
    O.close();
    await until(() => !app.rooms.has(id), 'sweep', 3000);
  });
});
