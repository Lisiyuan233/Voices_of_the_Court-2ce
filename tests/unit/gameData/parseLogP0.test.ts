import { parseLog, extractMultilinePayload } from '../../../src/shared/gameData/parseLog';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'debuglog_p0.txt');
const FIXTURE_FB = path.join(__dirname, '..', '..', 'fixtures', 'debuglog_p0_fallbacks.txt');

async function aiChar(file: string) {
    const gd = await parseLog(file);
    expect(gd).toBeDefined();
    const ai = gd!.characters.get(2000)!;
    expect(ai).toBeDefined();
    return ai;
}

describe('P0 scalar state datatypes', () => {
    it('parses stress', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.stress).toEqual({ value: 42, level: 'Stressed', progress: 30 });
    });

    it('parses legitimacy with expectations', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.legitimacy).toEqual({
            value: 55, level: 3, type: 'Feudal Legacy',
            powerfulVassalExpectation: '40', vassalExpectation: '35', liegeExpectation: '50'
        });
    });

    it('handles legitimacy "no" fallback', async () => {
        const ai = await aiChar(FIXTURE_FB);
        expect(ai.legitimacy).toBeUndefined();
    });

    it('parses income with multiline breakdown', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.incomeGold).toBe(250);
        expect(ai.incomeBalance).toBeCloseTo(3.25);
        expect(ai.incomeBreakdown).toContain('Gold from domains: 4.5');
        expect(ai.incomeBreakdown).not.toContain('ENDMULTILINE');
    });

    it('parses treasury / influence / herd', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.treasuryAmount).toBe(500);
        expect(ai.treasuryTooltip).toContain('Treasury: 500 gold');
        expect(ai.influenceAmount).toBe(120);
        expect(ai.influenceTooltip).toContain('Influence: 120');
        expect(ai.herdAmount).toBe(800);
        expect(ai.herdBreakdown).toBe('Herd breakdown here');
    });
});

describe('extractMultilinePayload', () => {
    it('returns trimmed element when no STARTMULTILINE marker', () => {
        expect(extractMultilinePayload('plain text here')).toBe('plain text here');
    });

    it('extracts payload between markers', () => {
        expect(extractMultilinePayload('STARTMULTILINE#line one#line two#ENDMULTILINE')).toBe('line one#line two');
    });

    it('handles truncated block without ENDMULTILINE', () => {
        expect(extractMultilinePayload('STARTMULTILINE#partial data')).toBe('partial data');
    });

    it('returns empty string for undefined or empty input', () => {
        expect(extractMultilinePayload(undefined)).toBe('');
        expect(extractMultilinePayload('')).toBe('');
    });
});

describe('P0 troops datatypes', () => {
    it('parses levies and sums multiple levies_dom lines', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.vassalLeviesTotal).toBe(1200);
        expect(ai.domainLevyHoldings).toEqual([400, 450]);
        expect(ai.getTotalDomainLevies()).toBe(850);
        expect(ai.theocraticLeaseLevies).toBe(100);
    });

    it('parses men-at-arms regiments', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.maaRegiments).toEqual([
            { name: 'Armored Footmen', isPersonal: true, menAlive: 120 },
            { name: 'Spearmen', isPersonal: false, menAlive: 80 },
        ]);
    });

    it('defaults to empty troop state when no troop lines are logged', async () => {
        const ai = await aiChar(FIXTURE_FB);
        expect(ai.vassalLeviesTotal).toBeUndefined();
        expect(ai.domainLevyHoldings).toEqual([]);
        expect(ai.getTotalDomainLevies()).toBe(0);
        expect(ai.theocraticLeaseLevies).toBeUndefined();
        expect(ai.maaRegiments).toEqual([]);
    });
});

describe('P0 laws & persona', () => {
    it('collects non-empty laws in emission order', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.laws).toEqual(['Crown Authority III', 'Male Preference Succession', 'High Tax']);
    });

    it('filters empty law placeholders in fallback fixture', async () => {
        const ai = await aiChar(FIXTURE_FB);
        expect(ai.laws).toEqual([]);
    });

    it('parses nine persona axes in fixed order', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.personaNumbers).toEqual({
            boldness: 40, compassion: 10, energy: 60, greed: 70, honor: 50,
            rationality: 45, sociability: 30, vengefulness: 20, zeal: 55
        });
    });

    it('keeps dangling trailing separator lines from corrupting parsed fields', async () => {
        const ai = await aiChar(FIXTURE_FB);
        expect(ai.stress).toEqual({ value: 7, level: 'Broken', progress: 0 });
    });
});

describe('P0 modifiers', () => {
    it('parses modifier id/name/desc pairs', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.modifiers).toEqual([
            { id: 'mod_wounded', name: 'Wounded', desc: 'This character is wounded and suffers penalties.' },
            { id: 'mod_drunk', name: 'Drunk', desc: 'This character is drunk.' },
        ]);
    });

    it('caps modifiers at 60 entries', async () => {
        const head = readFileSync(FIXTURE, 'utf8').split('\n').slice(0, 2).join('\n'); // init + character
        const lines = Array.from({ length: 65 }, (_, i) =>
            `VOTC:IN/;/modifier/;/2000/;/mod_${i}/;/Name ${i}/;/Desc ${i}`);
        const tmp = path.join(__dirname, 'tmp_cap_fixture.txt');
        writeFileSync(tmp, head + '\n' + lines.join('\n') + '\n');
        try {
            const gd = await parseLog(tmp);
            const mods = gd!.characters.get(2000)!.modifiers;
            expect(mods).toHaveLength(60);
            expect(mods[59].id).toBe('mod_59');
        } finally {
            unlinkSync(tmp);
        }
    });
});

describe('P0 known secrets', () => {
    it('assembles a full known-secret block until eob', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.knownSecrets).toHaveLength(1);
        const ks = ai.knownSecrets[0];
        expect(ks.name).toBe('Murdered Father');
        expect(ks.desc).toBe('He murdered his father.');
        expect(ks.category).toBe('Murder');
        expect(ks.type).toBe('secret_murder');
        expect(ks.ownerId).toBe(3000);
        expect(ks.ownerName).toBe('Count Bad');
        expect(ks.isCriminal).toBe(true);
        expect(ks.isShunned).toBeUndefined();
        expect(ks.targetId).toBe(3000);
        expect(ks.spent).toBe(false);
        expect(ks.canBeExposed).toBe(true);
        expect(ks.otherKnowers).toEqual([{ id: 4000, name: 'Bishop Curious' }]);
    });

    it('warns and starts fresh when a k_secret block is missing its eob line', async () => {
        // A block without k_secret_eob leaves a pending entry behind; the next
        // k_secret for the same character must warn before overwriting it and
        // the final data must only contain the terminated block.
        const head = readFileSync(FIXTURE, 'utf8').split('\n').slice(0, 2).join('\n'); // init + character
        const tmp = path.join(__dirname, 'tmp_missing_eob_fixture.txt');
        writeFileSync(tmp, [
            head,
            'VOTC:IN/;/k_secret/;/2000/;/Stale Secret/;/This block never terminates./;/Murder/;/secret_murder',
            'VOTC:IN/;/k_secret_owner/;/2000/;/3000/;/Count Bad',
            'VOTC:IN/;/k_secret/;/2000/;/Real Secret/;/This one terminates./;/Murder/;/secret_murder',
            'VOTC:IN/;/k_secret_target/;/2000/;/3000/;/Count Bad',
            'VOTC:IN/;/k_secret_eob/;/2000/;/'
        ].join('\n') + '\n');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const gd = await parseLog(tmp);
            expect(warnSpy).toHaveBeenCalledTimes(1);
            const warning = String(warnSpy.mock.calls[0][0]);
            expect(warning).toContain('k_secret');
            expect(warning).toContain('2000');
            expect(warning).toContain('Stale Secret');
            const knownSecrets = gd!.characters.get(2000)!.knownSecrets;
            expect(knownSecrets).toHaveLength(1);
            expect(knownSecrets[0].name).toBe('Real Secret');
            expect(knownSecrets[0].desc).toBe('This one terminates.');
            expect(knownSecrets[0].type).toBe('secret_murder');
            expect(knownSecrets[0].targetId).toBe(3000);
            expect(knownSecrets[0].otherKnowers).toEqual([]);
        } finally {
            warnSpy.mockRestore();
            unlinkSync(tmp);
        }
    });
});

describe('P0 owned secrets', () => {
    it('assembles a full owned-secret block until eob and fills ownedSecrets', async () => {
        const ai = await aiChar(FIXTURE);
        expect(ai.secrets).toHaveLength(1);
        const s = ai.secrets[0];
        expect(s.name).toBe('Hidden Lover');
        expect(s.desc).toBe('Duke AI keeps a secret lover at court.');
        expect(s.category).toBe('Sexual');
        expect(s.type).toBe('secret_lover');
        expect(s.isCriminal).toBeUndefined();
        expect(s.isShunned).toBe(true);
        expect(s.targetId).toBe(3001);
        expect(s.targetName).toBe('Lady Secret');
        expect(s.spent).toBe(true);
        expect(s.canBeExposed).toBe(false);
        expect(s.otherKnowers).toEqual([{ id: 4000, name: 'Bishop Curious' }]);

        // 1.x v1 snapshot-schema parity: owned secrets also land in
        // ownedSecrets as name/type/category/description.
        expect(ai.ownedSecrets).toEqual([{
            name: 'Hidden Lover',
            type: 'secret_lover',
            category: 'Sexual',
            description: 'Duke AI keeps a secret lover at court.'
        }]);
    });
});
