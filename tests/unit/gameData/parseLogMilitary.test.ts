import { parseLog, readLastMilitarySnapshotFromLog } from '../../../src/shared/gameData/parseLog';
import { writeFileSync, mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';

// P3: pins the military snapshot block parser against the exact debug_log
// templates emitted by "voices_of_the_court_mod2 ce/common/scripted_effects/
// votc_military_effects.txt" (ported from mod1). Field order here must match
// the mod emission 1:1; the cross-repo contract is pinned separately by
// militaryProtocolStatic.test.ts.

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'votc-military-parse-'));
const FULL_BLOCK_LOG = path.join(tmpDir, 'military_full.log');
const TAIL_SCAN_LOG = path.join(tmpDir, 'military_tail.log');

// Field-for-field reproduction of the mod's military council stream (init,
// attendees, snapshot header, wars, participants, truncation, armies,
// regiments, siege, ring-buffer events, complete marker).
const MILITARY_BODY = [
    'VOTC:IN/;/military_attendee/;/2002/;/Marshal/;/marshal/;//;/1',
    'VOTC:IN/;/military_attendee/;/2003/;/Knight One/;/knight/;//;/1',
    'VOTC:IN/;/military_attendee/;/2004/;/Old Adviser/;/war_leader_adviser/;//;/0',
    'VOTC:IN/;/military_snapshot/;/0/;/1066.1.1/;/1066.1.1/;/1',
    'VOTC:IN/;/war/;/101/;/101/;/War of succession/;/1066.1.1/;/attacker/;/1001/;/Player/;/3001/;/Duke Enemy/;/war_conquest/;/e_france/;/France/;/65/;/40/;/25/;/0/;/0',
    'VOTC:IN/;/war_participant/;/101/;/101/;/1001/;/Player/;/attacker/;/5000',
    'VOTC:IN/;/war_participant/;/101/;/101/;/3001/;/Duke Enemy/;/defender/;/4000',
    'VOTC:IN/;/war_truncation/;/101/;/101/;/2/;/0',
    'VOTC:IN/;/war/;/102/;/102/;/Border raid/;/1066.2.1/;/defender/;/1001/;/Player/;/3002/;/Earl Foe/;/raid/;//;/;/10/;/10/;/0/;/0/;/0',
    'VOTC:IN/;/war_truncation/;/102/;/102/;/0/;/0',
    // army line: root slot 0, filler 0, then id 51 — the two-filler contract.
    'VOTC:IN/;/army/;/0/;/0/;/51/;/1001/;/Player/;/1001/;/Player/;/attacker/;/1/;/1000/;/1200/;/700/;/0/;/3/;/401/;/Paris/;/25/;/2/;/5/;/yes/;/no/;/no/;/no/;/no/;/yes/;/1/;/Player levies/;/800/;/400/;/12/;/0/;/0/;/1',
    'VOTC:IN/;/army_regiment/;/0/;/men_at_arms/;/200/;/200/;/no/;/yes/;/no/;/Knightly band',
    'VOTC:IN/;/army/;/0/;/0/;/52/;/1001/;/Player/;/1001/;/Player/;/defender/;/1/;/300/;/300/;/300/;/0/;/1/;/402/;/Rouen/;/10/;/0/;/0/;/no/;/no/;/no/;/no/;/no/;/no/;//;/Second host/;/300/;/0/;/0/;/0/;/0/;/0',
    'VOTC:IN/;/siege/;/101/;/101/;/7/;/402/;/Rouen/;/3001/;/Duke Enemy/;/900/;/250/;/45',
    'VOTC:IN/;/war_event/;/0/;/1066.1.10/;/war_started/;/war',
    'VOTC:IN/;/war_event/;/0/;/1066.2.2/;/siege_completed/;/siege',
    'VOTC:IN/;/military_snapshot_complete/;/0/;/1'
].join('\n');

writeFileSync(FULL_BLOCK_LOG, [
    'VOTC:IN/;/init/;/1001/;/Player/;/2002/;/Marshal/;/1066.1.1/;/talk_scene_military_council/;/Paris/;/King X',
    'VOTC:IN/;/character/;/2002/;/Marshal/;/45/;/m/;/Marshal of the realm/;/dyn_001/;/house_001/;/no/;/no/;/no/;/no/;/0/;/0/;/0/;/no/;/no/;/no/;/no/;/no/;/no/;/no/;/no/;/no/;/no/;/no/',
    MILITARY_BODY
].join('\n'));

const CONVERSATION_BLOCK_A = 'VOTC:IN/;/init/;/1001/;/Player/;/2002/;/Marshal/;/1066.1.1/;/talk_scene_throne_room/;/Paris/;/King X';
const CONVERSATION_BLOCK_B = 'VOTC:IN/;/init/;/1001/;/Player/;/2003/;/Knight One/;/1066.3.1/;/talk_scene_bedchamber/;/Paris/;/King X';

// The military block sits between two newer/older conversation blocks: the
// regular parser must return the LAST conversation block (B, no snapshot),
// while the tail scan must recover the complete snapshot from the middle.
writeFileSync(TAIL_SCAN_LOG, [
    CONVERSATION_BLOCK_A,
    MILITARY_BODY,
    CONVERSATION_BLOCK_B
].join('\n'));

describe('military snapshot block parsing', () => {
    it('parses the snapshot header and completion flag', async () => {
        const gd = await parseLog(FULL_BLOCK_LOG);
        expect(gd).toBeDefined();
        expect(gd!.scene).toBe('military_council');
        const snap = gd!.militarySnapshot!;
        expect(snap).toBeDefined();
        expect(snap.snapshotId).toBe('1066.1.1');
        expect(snap.snapshotDate).toBe('1066.1.1');
        expect(snap.complete).toBe(true);
    });

    it('parses wars with sides, casus belli, title target and score', async () => {
        const gd = await parseLog(FULL_BLOCK_LOG);
        const snap = gd!.militarySnapshot!;
        expect(snap.wars.size).toBe(2);

        const war101 = snap.wars.get(101)!;
        expect(war101).toBeDefined();
        expect(war101.name).toBe('War of succession');
        expect(war101.playerSide).toBe('attacker');
        expect(war101.startDate).toBe('1066.1.1');
        expect(war101.casusBelli).toBe('war_conquest');
        expect(war101.targetTitle).toEqual({ id: 'e_france', name: 'France' });
        expect(war101.primaryAttacker).toEqual({ id: 1001, name: 'Player' });
        expect(war101.primaryDefender).toEqual({ id: 3001, name: 'Duke Enemy' });
        expect(war101.score).toEqual({
            total: 65, battles: 40, occupation: 25, imprisonment: 0, ticking: 0, perspective: 'attacker'
        });
        expect(war101.truncation).toEqual({ total: 2, omitted: 0 });

        const war102 = snap.wars.get(102)!;
        expect(war102.playerSide).toBe('defender');
        expect(war102.casusBelli).toBe('raid');
        expect(war102.targetTitle).toBeUndefined();
    });

    it('parses war participants onto their war', async () => {
        const gd = await parseLog(FULL_BLOCK_LOG);
        const snap = gd!.militarySnapshot!;
        const participants = snap.wars.get(101)!.participants;
        expect(participants).toHaveLength(2);
        expect(participants[0]).toEqual({
            character: { id: 1001, name: 'Player' },
            side: 'attacker',
            militaryStrength: 5000
        });
        expect(participants[1].side).toBe('defender');
        expect(snap.wars.get(102)!.participants).toHaveLength(0);
    });

    it('parses armies with the two-filler id contract and derives menAtArms', async () => {
        const gd = await parseLog(FULL_BLOCK_LOG);
        const snap = gd!.militarySnapshot!;
        expect(snap.armies).toHaveLength(2);

        const army51 = snap.armies[0];
        expect(army51.id).toBe(51);
        expect(army51.owner).toEqual({ id: 1001, name: 'Player' });
        expect(army51.commander).toEqual({ id: 1001, name: 'Player' });
        expect(army51.side).toBe('attacker');
        expect(army51.isPlayerOwned).toBe(true);
        expect(army51.soldiers).toBe(1000);
        expect(army51.maxSoldiers).toBe(1200);
        expect(army51.levies).toBe(700);
        expect(army51.menAtArms).toBe(300);
        expect(army51.quality).toBe('3');
        expect(army51.location).toEqual({ id: 401, name: 'Paris' });
        expect(army51.supply).toBe(25);
        expect(army51.supplyChange).toBe(2);
        expect(army51.attrition).toBe(5);
        expect(army51.state).toEqual({
            gathering: true, moving: false, embarked: false, retreating: false, inCombat: false, inSiege: true
        });
        expect(army51.commandSlot).toBe(1);
        expect(army51.name).toBe('Player levies');

        const army52 = snap.armies[1];
        expect(army52.id).toBe(52);
        expect(army52.side).toBe('defender');
        // "//" slot field parses to undefined, not 0
        expect(army52.commandSlot).toBeUndefined();
    });

    it('associates regiment lines with the most recent army', async () => {
        const gd = await parseLog(FULL_BLOCK_LOG);
        const snap = gd!.militarySnapshot!;
        expect(snap.armies[0].regiments).toHaveLength(1);
        expect(snap.armies[0].regiments[0]).toEqual({
            typeName: 'men_at_arms', count: 200, max: 200,
            isLevies: false, isMAA: true, isKnight: false, name: 'Knightly band'
        });
        expect(snap.armies[1].regiments).toHaveLength(0);
    });

    it('parses sieges, truncation markers and ring-buffer events', async () => {
        const gd = await parseLog(FULL_BLOCK_LOG);
        const snap = gd!.militarySnapshot!;
        const sieges = snap.wars.get(101)!.sieges;
        expect(sieges).toHaveLength(1);
        expect(sieges[0]).toEqual({
            id: 7,
            warId: 101,
            location: { id: 402, name: 'Rouen' },
            commander: { id: 3001, name: 'Duke Enemy' },
            attackerMen: 900,
            defenderMen: 250,
            progress: 45
        });
        expect(snap.wars.get(102)!.sieges).toHaveLength(0);

        expect(snap.events).toHaveLength(2);
        expect(snap.events[0]).toEqual({ date: '1066.1.10', type: 'war_started', payload: 'war' });
        expect(snap.events[1].type).toBe('siege_completed');
    });

    it('parses military attendees with role union clamping and slot filtering', async () => {
        const gd = await parseLog(FULL_BLOCK_LOG);
        const snap = gd!.militarySnapshot!;
        expect(snap.attendees).toHaveLength(3);

        const marshal = snap.attendees.find(a => a.character.id === 2002)!;
        expect(marshal.roles).toEqual(['marshal']);
        expect(marshal.canCommandPlayerArmies).toBe(true);

        const adviser = snap.attendees.find(a => a.character.id === 2004)!;
        expect(adviser.roles).toEqual(['war_leader_adviser']);
        expect(adviser.canCommandPlayerArmies).toBe(false);
        expect(adviser.commandSlots).toEqual([]);
    });

    it('recovers the snapshot from the log tail even when a newer conversation block exists', async () => {
        const regular = await parseLog(TAIL_SCAN_LOG);
        expect(regular).toBeDefined();
        expect(regular!.scene).toBe('bedchamber');
        expect(regular!.militarySnapshot).toBeUndefined();

        const snapshot = await readLastMilitarySnapshotFromLog(TAIL_SCAN_LOG);
        expect(snapshot).toBeDefined();
        expect(snapshot!.complete).toBe(true);
        expect(snapshot!.wars.size).toBe(2);
        expect(snapshot!.armies).toHaveLength(2);
    });

    it('returns undefined when no complete military snapshot exists', async () => {
        const noMilitary = path.join(tmpDir, 'no_military.log');
        writeFileSync(noMilitary, CONVERSATION_BLOCK_A);

        expect(await readLastMilitarySnapshotFromLog(noMilitary)).toBeUndefined();

        const incomplete = path.join(tmpDir, 'incomplete_military.log');
        writeFileSync(incomplete, [
            CONVERSATION_BLOCK_A,
            'VOTC:IN/;/military_snapshot/;/0/;/1066.1.1/;/1066.1.1/;/1',
            'VOTC:IN/;/war/;/101/;/101/;/Broken/;/1066.1.1/;/attacker/;/1001/;/Player/;/3001/;/Foe/;/raid/;//;/;/0/;/0/;/0/;/0/;/0'
            // no military_snapshot_complete line
        ].join('\n'));
        expect(await readLastMilitarySnapshotFromLog(incomplete)).toBeUndefined();
    });
});
