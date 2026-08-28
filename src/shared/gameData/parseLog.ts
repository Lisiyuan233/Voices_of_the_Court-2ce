import { GameData, Memory, Trait, OpinionModifier, Secret, Relative, KnownSecret} from "./GameData";
import { MilitarySnapshot, WarInfo, SiegeInfo, ArmyInfo, MilitaryAttendee, MilitaryAttendeeRole, WarSide } from "./GameData";
import { Character } from "./Character";
const fs = require('fs');

export interface LogSnapshotRange {
    startOffset: number;
    endOffset: number;
}

export async function parseLog(debugLogPath: string, snapshotRange?: LogSnapshotRange): Promise<GameData | undefined>{
async function readLastRelevantBlock(filePath: string): Promise<string | undefined> {
    const CHUNK_SIZE = 256 * 1024; // 256KB chunks
    const SEARCH_STRING = 'VOTC:IN/;/init';

    let handle;
    try {
        handle = await fs.promises.open(filePath, 'r');
        const { size } = await handle.stat();

        let position = Math.max(0, size - CHUNK_SIZE);
        let currentReadSize = size - position;

        while (true) {
            const buffer = Buffer.alloc(currentReadSize);
            await handle.read(buffer, 0, currentReadSize, position);
            const content = buffer.toString('utf8');

            const lastIndex = content.lastIndexOf(SEARCH_STRING);
            if (lastIndex !== -1) {
                const lineStartIndex = content.lastIndexOf('\n', lastIndex);
                const absoluteStart = position + (lineStartIndex === -1 ? 0 : Buffer.byteLength(content.substring(0, lineStartIndex + 1), 'utf8'));

                const resultSize = size - absoluteStart;
                const resultBuffer = Buffer.alloc(resultSize);
                await handle.read(resultBuffer, 0, resultSize, absoluteStart);
                return resultBuffer.toString('utf8');
            }

            if (position === 0) break;

            // Move back another chunk, with overlap to ensure we don't miss the search string
            const newPosition = Math.max(0, position - CHUNK_SIZE);
            currentReadSize = position - newPosition + SEARCH_STRING.length;
            position = newPosition;
        }
    } catch (err) {
        console.error(`Error reading log file efficiently: ${err}`);
    } finally {
        if (handle) await handle.close();
    }
    return undefined;
}
    console.log(`Starting to parse log file at: ${debugLogPath}`);
    if (!fs.existsSync(debugLogPath)) {
        console.error(`Error: Log file not found at ${debugLogPath}`);
        return undefined;
    }

    let gameData: GameData | undefined = undefined;

    //some data are passed through multiple lines
    let multiLineTempStorage: any[] = [];
    let isWaitingForMultiLine: boolean = false;
    let multiLineType: string = ""; //relation or opinionModifier

    const deferredRelations: { charAID: number, charBID: number, relationship: string }[] = [];

    const pendingKnownSecrets = new Map<number, Partial<KnownSecret> & { otherKnowers: { id: number; name: string }[] }>();

    // P3 military snapshot accumulation state (block-scoped). Regiments follow
    // the most recent army line, mirroring 1.x GameDataRecordAccumulator.
    let lastMilitaryArmyId: number | undefined = undefined;

    // Efficiently find the last block by reading from the end of the file.
    // When a snapshot byte range is supplied (incoming-letter context parsing),
    // parse exactly that selection instead of scanning for the last block.
    const relevantLogBlock = snapshotRange
        ? (await fs.promises.readFile(debugLogPath, 'utf8')).slice(snapshotRange.startOffset, snapshotRange.endOffset)
        : await readLastRelevantBlock(debugLogPath);

    if (!relevantLogBlock) {
        console.debug("Finished parsing log file, but 'VOTC:IN/;/init' was not found. No game data will be loaded.");
        return undefined;
    }

    const lines = relevantLogBlock.split(/\r?\n/);

    console.log(`Starting to parse last VOTC:IN block from log file: ${debugLogPath}`);
    console.log(`--- Relevant Log Block Start ---`);
    console.log(relevantLogBlock);
    console.log(`--- Relevant Log Block End ---`);

    for (const line of lines) {
        console.log(`[parseLog] Processing line: ${line}`);
        if(isWaitingForMultiLine){
            if (!gameData) continue; // Should not happen if logic is correct, but good for safety
            console.log(`Parsing multi-line data of type "${multiLineType}": ${line}`);
            let value = line.split('#')[0]
            switch (multiLineType){
                case "new_relations": {
                    const pending = multiLineTempStorage[0] as { charAID: number, charBID: number, relationship: string };
                    // Accumulate any relationship text that fell on a continuation line
                    const addition = removeTooltip(value);
                    if (addition) {
                        pending.relationship = pending.relationship
                            ? pending.relationship + ' ' + addition
                            : addition;
                    }
                    // Commit once the full relationship text is known
                    if (line.includes('#ENDMULTILINE')) {
                        commitNewRelation(pending.charAID, pending.charBID, pending.relationship);
                    }
                break; }
                case "relations":
                    const relation = removeTooltip(value);
                    multiLineTempStorage.push(relation);
                    console.log(`Parsed multi-line relation: "${relation}"`);
                break;
                case "opinionBreakdown":
                        const opinionModifier = parseOpinionModifier(value);
                        multiLineTempStorage.push(opinionModifier);
                        console.log(`Parsed multi-line opinion breakdown: ${opinionModifier.reason}: ${opinionModifier.value}`);
                break;
            }

            if(line.includes('#ENDMULTILINE')){         
                console.log(`Finished parsing multi-line data of type "${multiLineType}".`);
                isWaitingForMultiLine = false;
            }
           continue;
        }

        if(line.includes("VOTC:IN")){
            //0: VOTC:IN, 1: dataType, 2: rootID 3...: data
            // Lines may end with "/;" when the template's last field is empty (e.g. laws); normalize so split yields a clean trailing element.
            const splittableLine = line.endsWith("/;") ? `${line}/` : line;
            let data = splittableLine.split("/;/")

            const dataType = data[1];
            console.log(`Parsing data type: ${dataType}`);

            data.splice(0,2)

            const rootID = Number(data[0]);

            console.log(`Processing data for rootID: ${rootID}`);

            for(let i=0;i<data.length;i++){
                data[i] = removeTooltip(data[i])
            }

            switch (dataType){
                case "stress": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.stress = { value: Number(data[1]), level: data[2], progress: Number(data[3]) };
                    break;
                }
                case "legitimacy": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    if (data[1] === 'no') { c.legitimacy = undefined; break; }
                    c.legitimacy = {
                        value: Number(data[1]), level: Number(data[2]), type: data[3],
                        powerfulVassalExpectation: data[4], vassalExpectation: data[5], liegeExpectation: data[6]
                    };
                    break;
                }
                case "income": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.incomeGold = Number(data[1]);
                    c.incomeBalance = Number(data[2]);
                    c.incomeBreakdown = extractMultilinePayload(data[3]);
                    break;
                }
                case "treasury": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.treasuryAmount = Number(data[1]);
                    c.treasuryTooltip = extractMultilinePayload(data[2]);
                    break;
                }
                case "influence": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.influenceAmount = Number(data[1]);
                    c.influenceTooltip = extractMultilinePayload(data[2]);
                    break;
                }
                case "herd": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.herdAmount = Number(data[1]);
                    c.herdBreakdown = extractMultilinePayload(data[2]);
                    break;
                }
                case "levies_vassals": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.vassalLeviesTotal = Number(data[1]);
                    break;
                }
                case "levies_dom": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.domainLevyHoldings.push(Number(data[1]));
                    break;
                }
                case "levies_theo": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.theocraticLeaseLevies = Number(data[1]);
                    break;
                }
                case "maa": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.maaRegiments.push({
                        name: data[1],
                        isPersonal: data[2] === '1' || data[2]?.toLowerCase() === 'yes',
                        menAlive: Number(data[3])
                    });
                    break;
                }
                case "troops_eob":
                    break;
                case "laws": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    const name = (data[1] || '').trim();
                    if (!name || name === '-' || name === '—' || name.toLowerCase() === 'no') break;
                    if (c.laws.length < MAX_LAWS) c.laws.push(name);
                    break;
                }
                case "persona_numbers": {
                    if (data.length < 10) break;
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    c.personaNumbers = {
                        boldness: Number(data[1]), compassion: Number(data[2]), energy: Number(data[3]),
                        greed: Number(data[4]), honor: Number(data[5]), rationality: Number(data[6]),
                        sociability: Number(data[7]), vengefulness: Number(data[8]), zeal: Number(data[9])
                    };
                    break;
                }
                case "modifier": {
                    if (!gameData) continue;
                    const c = gameData.characters.get(rootID);
                    if (!c) break;
                    if (c.modifiers.length >= MAX_MODIFIERS_PER_CHARACTER) {
                        console.warn(`Character ${rootID} exceeded modifier cap (${MAX_MODIFIERS_PER_CHARACTER}); dropping "${data[1]}".`);
                        break;
                    }
                    c.modifiers.push({ id: data[1], name: data[2], desc: data[3] });
                    break;
                }
                case "k_secret": {
                    if (!gameData) continue;
                    if (!gameData.characters.has(rootID)) break;
                    pendingKnownSecrets.set(rootID, {
                        name: data[1], desc: data[2], category: data[3], type: data[4],
                        otherKnowers: []
                    });
                    break;
                }
                case "k_secret_owner": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (!p) break;
                    p.ownerId = Number(data[1]); p.ownerName = data[2];
                    break;
                }
                case "k_secret_is_criminal": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (p) p.isCriminal = true;
                    break;
                }
                case "k_secret_is_shunned": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (p) p.isShunned = true;
                    break;
                }
                case "k_secret_target": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (!p) break;
                    p.targetId = Number(data[1]); p.targetName = data[2];
                    break;
                }
                case "k_secret_spent": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (p) p.spent = data[1] === 'yes';
                    break;
                }
                case "k_secret_can_be_exposed": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (p) p.canBeExposed = data[1] === 'yes';
                    break;
                }
                case "k_secret_knower": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (!p) break;
                    p.otherKnowers.push({ id: Number(data[2]), name: data[3] });
                    break;
                }
                case "k_secret_eob": {
                    const p = pendingKnownSecrets.get(rootID);
                    if (!p) break;
                    const c = gameData?.characters.get(rootID);
                    if (c) {
                        c.knownSecrets.push({
                            name: p.name ?? "", desc: p.desc ?? "", category: p.category ?? "", type: p.type ?? "",
                            ownerId: p.ownerId, ownerName: p.ownerName,
                            targetId: p.targetId, targetName: p.targetName,
                            isCriminal: p.isCriminal, isShunned: p.isShunned,
                            spent: p.spent, canBeExposed: p.canBeExposed,
                            otherKnowers: p.otherKnowers
                        });
                    }
                    pendingKnownSecrets.delete(rootID);
                    break;
                }
                case "init":
                    gameData = new GameData(data);
                    console.log(`Initialized GameData for conversation with AI: ${gameData.aiName} (ID: ${gameData.aiID})`); // Updated log
                    if (gameData) {
                        console.log(`[parseLog] GameData initialized with scene: '${gameData.scene}' and location: '${gameData.location}'`);
                    }
                break;
                case "character": 
                    if (!gameData) continue;
                    let char = new Character(data);
                    gameData!.addCharacter(char.id, char);
                    console.log(`[parseLog] ADDED character to map: ID=${char.id}, Name=${char.fullName}`);
                break;
                case "memory": 
                    if (!gameData) continue;
                    let memory = parseMemory(data)
                    gameData!.characters.get(rootID)!.memories.push(memory);
                    console.log(`Parsed memory for character ID ${rootID}: ${memory.desc}`);
                break;
                case "secret": 
                    if (!gameData) continue;
                    let secret = parseSecret(data)
                    gameData!.characters.get(rootID)!.secrets.push(secret);
                    console.log(`Parsed secret for character ID ${rootID}: ${secret.name}`);
                break;
                case "trait":
                    if (!gameData) continue;
                    const characterWithTrait = gameData.characters.get(rootID);
                    if (!characterWithTrait) {
                        console.warn(`Character with ID ${rootID} not found when trying to add trait. Skipping.`);
                        continue;
                    }
                    let trait = parseTrait(data);
                    characterWithTrait.traits.push(trait);
                    console.log(`Parsed trait for character ID ${rootID}: ${trait.name}`);
                break;
                case "opinions":
                    if (!gameData) continue;
                    gameData!.characters.get(rootID)!.opinions.push({id: Number(data[1]), opinion: Number(data[2])});
                    console.log(`Parsed opinion for character ID ${rootID}: targetID=${data[1]}, value=${data[2]}`);
                break;
                case "relations":
                    if (!gameData) continue;
                    if(line.split('#')[1] !== ''){
                        const relation = removeTooltip(line.split('#')[1]);
                        gameData!.characters.get(rootID)!.relationsToPlayer = [relation];
                        console.debug(`Parsed relation for character ID ${rootID} to player: "${relation}"`);
                    }
                    
                    if(!line.includes("#ENDMULTILINE")){
                        multiLineTempStorage = gameData!.characters.get(rootID)!.relationsToPlayer
                        isWaitingForMultiLine = true;
                        multiLineType = "relations";
                        console.debug(`Starting multi-line parse for "relations" for character ID ${rootID}.`);
                    }
                break;
                case "new_relations":
                    if (!gameData) continue;
                    const characterA_ID = rootID;
                    const characterB_ID = Number(data[1]);

                    const initialRelationship = line.includes('#')
                        ? removeTooltip(line.split('#')[1])
                        : "";

                    if (line.includes('#ENDMULTILINE')) {
                        commitNewRelation(characterA_ID, characterB_ID, initialRelationship);
                    } else {
                        multiLineTempStorage = [{ charAID: characterA_ID, charBID: characterB_ID, relationship: initialRelationship }];
                        isWaitingForMultiLine = true;
                        multiLineType = "new_relations";
                    }
                    break;

                case "opinionBreakdown":
                    if(line.split('#')[1] !== ''){
                        gameData!.characters.get(rootID)!.opinionBreakdownToPlayer = [parseOpinionModifier(line.split('#')[1])]
                    }

                    if(!line.includes("#ENDMULTILINE")){
                        multiLineTempStorage = gameData!.characters.get(rootID)!.opinionBreakdownToPlayer
                        isWaitingForMultiLine = true;
                        multiLineType = "opinionBreakdown";
                        console.debug(`Starting multi-line parse for "opinionBreakdown" for character ID ${rootID}.`);
                    }
                    break;

                // --- log_relatives: parents ---
                case "parents":
                    if (!gameData) continue;
                    upsertRelative(rootID, Number(data[1]), data[2], 'Parent', { birthDate: data[4], birthTotalDays: Number(data[3]) });
                    break;
                case "parent_death": {
                    if (!gameData) continue;
                    const pd = findRelative(rootID, Number(data[1]));
                    if (pd) { pd.isDeceased = true; pd.deathDate = data[3]; pd.deathReason = data[4]; }
                    break;
                }

                // --- log_relatives: kids ---
                case "kids":
                    if (!gameData) continue;
                    upsertRelative(rootID, Number(data[1]), data[2], 'Child', { sheHe: data[3], birthDate: data[5], birthTotalDays: Number(data[4]) });
                    break;
                case "kid_other_parent": {
                    if (!gameData) continue;
                    const kop = findRelative(rootID, Number(data[1]));
                    if (kop) { kop.otherParentId = Number(data[2]); kop.otherParentName = data[3]; }
                    break;
                }
                case "kid_death": {
                    if (!gameData) continue;
                    const kd = findRelative(rootID, Number(data[1]));
                    if (kd) { kd.isDeceased = true; kd.deathDate = data[3]; kd.deathReason = data[4]; }
                    break;
                }
                case "kid_trait": {
                    if (!gameData) continue;
                    const kt = findRelative(rootID, Number(data[1]));
                    if (kt) kt.traits.push({ category: data[2], name: data[3], desc: data[4] });
                    break;
                }
                case "kid_is_concubine": {
                    if (!gameData) continue;
                    const kic = findRelative(rootID, Number(data[1]));
                    if (kic) { kic.maritalStatus = 'is_concubine'; kic.partners.push({ id: Number(data[2]), name: data[3], type: 'spouse' }); }
                    break;
                }
                case "kid_concubine": {
                    if (!gameData) continue;
                    const kcon = findRelative(rootID, Number(data[1]));
                    if (kcon) { kcon.maritalStatus = 'married'; kcon.partners.push({ id: Number(data[2]), name: data[3], type: 'concubine' }); }
                    break;
                }
                case "kid_spouse": {
                    if (!gameData) continue;
                    const ks = findRelative(rootID, Number(data[1]));
                    if (ks) { ks.maritalStatus = 'married'; ks.partners.push({ id: Number(data[2]), name: data[3], type: 'spouse' }); }
                    break;
                }
                case "kid_betrothed": {
                    if (!gameData) continue;
                    const kb = findRelative(rootID, Number(data[1]));
                    if (kb) { kb.maritalStatus = 'betrothed'; kb.partners.push({ id: Number(data[2]), name: data[3], type: 'betrothed' }); }
                    break;
                }
                case "kid_unmarried": {
                    if (!gameData) continue;
                    const ku = findRelative(rootID, Number(data[1]));
                    if (ku) ku.maritalStatus = 'unmarried';
                    break;
                }
                case "kid_eob":
                    break;

                // --- log_relatives: siblings ---
                case "siblings":
                    if (!gameData) continue;
                    upsertRelative(rootID, Number(data[1]), data[2], 'Sibling', { sheHe: data[3], birthDate: data[5], birthTotalDays: Number(data[4]) });
                    break;
                case "sibling_other_parent": {
                    if (!gameData) continue;
                    const sop = findRelative(rootID, Number(data[1]));
                    if (sop) { sop.otherParentId = Number(data[2]); sop.otherParentName = data[3]; }
                    break;
                }
                case "sibling_death": {
                    if (!gameData) continue;
                    const sd = findRelative(rootID, Number(data[1]));
                    if (sd) { sd.isDeceased = true; sd.deathDate = data[3]; sd.deathReason = data[4]; }
                    break;
                }
                case "sibling_trait": {
                    if (!gameData) continue;
                    const st = findRelative(rootID, Number(data[1]));
                    if (st) st.traits.push({ category: data[2], name: data[3], desc: data[4] });
                    break;
                }
                case "sibling_is_concubine": {
                    if (!gameData) continue;
                    const sic = findRelative(rootID, Number(data[1]));
                    if (sic) { sic.maritalStatus = 'is_concubine'; sic.partners.push({ id: Number(data[2]), name: data[3], type: 'spouse' }); }
                    break;
                }
                case "sibling_concubine": {
                    if (!gameData) continue;
                    const scon = findRelative(rootID, Number(data[1]));
                    if (scon) { scon.maritalStatus = 'married'; scon.partners.push({ id: Number(data[2]), name: data[3], type: 'concubine' }); }
                    break;
                }
                case "sibling_spouse": {
                    if (!gameData) continue;
                    const ss = findRelative(rootID, Number(data[1]));
                    if (ss) { ss.maritalStatus = 'married'; ss.partners.push({ id: Number(data[2]), name: data[3], type: 'spouse' }); }
                    break;
                }
                case "sibling_betrothed": {
                    if (!gameData) continue;
                    const sbet = findRelative(rootID, Number(data[1]));
                    if (sbet) { sbet.maritalStatus = 'betrothed'; sbet.partners.push({ id: Number(data[2]), name: data[3], type: 'betrothed' }); }
                    break;
                }
                case "sibling_unmarried": {
                    if (!gameData) continue;
                    const su = findRelative(rootID, Number(data[1]));
                    if (su) su.maritalStatus = 'unmarried';
                    break;
                }
                case "sibling_eob":
                    break;

                // --- P3: military council snapshot block ---
                // Field order contract (1.x GameDataRecordAccumulator parity)
                // is pinned by tests/unit/militaryProtocolStatic.test.ts and
                // documented in docs/superpowers/plans/2026-08-28-p3-military-snapshot.md.
                case "military_snapshot": {
                    const snap = ensureMilitarySnapshot();
                    snap.snapshotId = data[1] ?? '';
                    snap.snapshotDate = data[2] ?? '';
                    lastMilitaryArmyId = undefined;
                    break;
                }
                case "war": {
                    const snap = ensureMilitarySnapshot();
                    const id = Number(data[1]);
                    if (!Number.isFinite(id) || id === 0) break;
                    // The war line carries the id twice (root slot + first payload
                    // field); the first copy is the rootID slot and carries no data.
                    const war: WarInfo = {
                        id,
                        name: data[2] ?? '',
                        startDate: data[3],
                        playerSide: (data[4] === 'defender' ? 'defender' : 'attacker') as WarSide,
                        primaryAttacker: { id: Number(data[5]) || 0, name: data[6] ?? '' },
                        primaryDefender: { id: Number(data[7]) || 0, name: data[8] ?? '' },
                        casusBelli: data[9] || undefined,
                        targetTitle: data[10] ? { id: data[10], name: data[11] ?? '' } : undefined,
                        score: {
                            total: Number(data[12]) || 0,
                            battles: Number(data[13]) || 0,
                            occupation: Number(data[14]) || 0,
                            imprisonment: Number(data[15]) || 0,
                            ticking: Number(data[16]) || 0,
                            perspective: 'attacker'
                        },
                        participants: [],
                        armies: [],
                        sieges: [],
                        truncation: { total: 0, omitted: 0 }
                    };
                    snap.wars.set(id, war);
                    break;
                }
                case "war_participant": {
                    const snap = ensureMilitarySnapshot();
                    const war = snap.wars.get(Number(data[1]));
                    if (!war) break;
                    war.participants.push({
                        character: { id: Number(data[2]) || 0, name: data[3] ?? '' },
                        side: (data[4] === 'defender' ? 'defender' : 'attacker') as WarSide,
                        militaryStrength: Number(data[5]) || 0
                    });
                    break;
                }
                case "siege": {
                    const snap = ensureMilitarySnapshot();
                    const siege: SiegeInfo = {
                        id: Number(data[2]) || 0,
                        warId: Number(data[1]) || 0,
                        location: { id: Number(data[3]) || 0, name: data[4] ?? '' },
                        commander: Number(data[5]) ? { id: Number(data[5]), name: data[6] ?? '' } : undefined,
                        attackerMen: Number(data[7]) || 0,
                        defenderMen: Number(data[8]) || 0,
                        progress: Number(data[9]) || 0
                    };
                    const war = snap.wars.get(siege.warId);
                    if (war) war.sieges.push(siege);
                    break;
                }
                case "war_truncation": {
                    const snap = ensureMilitarySnapshot();
                    const war = snap.wars.get(Number(data[1]));
                    if (!war) break;
                    war.truncation = { total: Number(data[2]) || 0, omitted: data[3] === '1' ? 1 : 0 };
                    break;
                }
                case "army": {
                    const snap = ensureMilitarySnapshot();
                    // Contract: root slot = 0, data[1] = filler 0, data[2] = army id
                    // (two fillers before the id, matching the mod emission).
                    const id = Number(data[2]);
                    if (!Number.isFinite(id) || id === 0) break;
                    const soldiers = Number(data[9]) || 0;
                    const levies = Number(data[11]) || 0;
                    const army: ArmyInfo = {
                        commandSlot: Number(data[25]) || undefined,
                        id,
                        name: data[26],
                        owner: { id: Number(data[3]) || 0, name: data[4] ?? '' },
                        commander: Number(data[5]) ? { id: Number(data[5]), name: data[6] ?? '' } : undefined,
                        side: (data[7] === 'defender' ? 'defender' : 'attacker') as WarSide,
                        isPlayerOwned: data[8] === '1',
                        possibleWarAssociation: true,
                        soldiers,
                        maxSoldiers: Number(data[10]) || 0,
                        levies,
                        menAtArms: Math.max(0, soldiers - levies),
                        quality: data[13],
                        location: { id: Number(data[14]) || 0, name: data[15] ?? '' },
                        supply: Number(data[16]) || 0,
                        supplyChange: Number(data[17]) || 0,
                        attrition: Number(data[18]) || 0,
                        state: {
                            gathering: data[19] === 'yes' || data[19] === '1',
                            moving: data[20] === 'yes' || data[20] === '1',
                            embarked: data[21] === 'yes' || data[21] === '1',
                            retreating: data[22] === 'yes' || data[22] === '1',
                            inCombat: data[23] === 'yes' || data[23] === '1',
                            inSiege: data[24] === 'yes' || data[24] === '1'
                        },
                        regiments: []
                    };
                    snap.armies.push(army);
                    lastMilitaryArmyId = id;
                    break;
                }
                case "army_regiment": {
                    const snap = ensureMilitarySnapshot();
                    const army = snap.armies.find(a => a.id === (lastMilitaryArmyId ?? rootID));
                    if (!army) break;
                    army.regiments.push({
                        typeName: data[1] ?? '',
                        count: Number(data[2]) || 0,
                        max: Number(data[3]) || undefined,
                        isLevies: data[4] === 'yes' || data[4] === '1',
                        isMAA: data[5] === 'yes' || data[5] === '1',
                        isKnight: data[6] === 'yes' || data[6] === '1',
                        name: data[7]
                    });
                    break;
                }
                case "war_event": {
                    const snap = ensureMilitarySnapshot();
                    snap.events.push({
                        date: data[1] ?? '',
                        type: data[2] ?? '',
                        payload: data[3] ?? ''
                    });
                    break;
                }
                case "military_attendee": {
                    const snap = ensureMilitarySnapshot();
                    const validRoles: readonly string[] = ['marshal', 'field_commander', 'knight', 'commander_candidate', 'war_leader_adviser'];
                    const roles = (data[2] ?? '')
                        .split(',')
                        .map((s: string) => s.trim())
                        .filter((s: string) => s.length > 0)
                        .map((r: string) => (validRoles.includes(r) ? (r as MilitaryAttendeeRole) : 'war_leader_adviser' as MilitaryAttendeeRole));
                    const slots = (data[3] ?? '')
                        .split(',')
                        .map((s: string) => Number(s))
                        .filter((n: number) => Number.isFinite(n) && n > 0);
                    const canCommand = data[4] !== '0';
                    let attendee = snap.attendees.find(a => a.character.id === rootID);
                    if (!attendee) {
                        const known = gameData?.characters.get(rootID);
                        attendee = {
                            character: { id: rootID, name: data[1] || known?.fullName || '' },
                            roles: [],
                            commandSlots: [],
                            canCommandPlayerArmies: canCommand
                        };
                        snap.attendees.push(attendee);
                    }
                    for (const role of roles) {
                        if (!attendee.roles.includes(role)) attendee.roles.push(role);
                    }
                    for (const slot of slots) {
                        if (!attendee.commandSlots.includes(slot)) attendee.commandSlots.push(slot);
                    }
                    break;
                }
                case "military_snapshot_complete": {
                    const snap = ensureMilitarySnapshot();
                    snap.complete = true;
                    break;
                }
            }
        } else {
            if (line.trim() !== "") {
                console.debug(`Skipping line (no VOTC:IN): ${line}`);
            }
        }
    }

    for (const entry of deferredRelations) {
        const charA = gameData?.characters.get(entry.charAID);
        const charB = gameData?.characters.get(entry.charBID);
        if (!charA || !charB) {
            if (!charA) console.warn(`Character with ID ${entry.charAID} not found after full parse (new_relations)`);
            if (!charB) console.warn(`Character with ID ${entry.charBID} not found after full parse (new_relations)`);
            continue;
        }
        commitNewRelation(entry.charAID, entry.charBID, entry.relationship);
    }

    // Propagate birthTotalDays to Character objects that were added after the relative log was parsed
    if (gameData) {
        for (const char of gameData.characters.values()) {
            for (const rel of char.relatives) {
                if (rel.birthTotalDays !== undefined) {
                    const relChar = gameData.characters.get(rel.id);
                    if (relChar && relChar.birthTotalDays === undefined) {
                        relChar.birthTotalDays = rel.birthTotalDays;
                    }
                }
            }
        }
    }

    console.debug("Finished parsing log file. Game data loaded from last block.");

    function findRelative(rootID: number, relativeID: number): Relative | undefined {
        return gameData?.characters.get(rootID)?.relatives.find(r => r.id === relativeID);
    }

    function upsertRelative(rootID: number, id: number, name: string, relationship: string, extras?: Partial<Relative>): void {
        if (!gameData) return;
        const char = gameData.characters.get(rootID);
        if (!char) return;
        let rel = char.relatives.find(r => r.id === id);
        if (!rel) {
            rel = { id, name, relationship, isDeceased: false, traits: [], partners: [] };
            char.relatives.push(rel);
        } else {
            if (name) rel.name = name;
            if (relationship) rel.relationship = relationship;
        }
        if (extras) Object.assign(rel, extras);
        // Propagate birthTotalDays to the Character object itself if it exists in the map
        if (extras?.birthTotalDays !== undefined) {
            const relativeChar = gameData.characters.get(id);
            if (relativeChar && relativeChar.birthTotalDays === undefined) {
                relativeChar.birthTotalDays = extras.birthTotalDays;
            }
        }
    }

    // Lazily creates the military snapshot. Tolerates init-less military blocks
    // (readLastMilitarySnapshotFromLog tail scans) by creating a bare GameData
    // the same way GameData.fromPlainObject does.
    function ensureMilitarySnapshot(): MilitarySnapshot {
        if (!gameData) {
            gameData = new GameData(new Array(10).fill(''));
        }
        if (!gameData.militarySnapshot) {
            gameData.militarySnapshot = {
                snapshotId: '',
                snapshotDate: '',
                wars: new Map<number, WarInfo>(),
                armies: [],
                attendees: [],
                events: [],
                complete: false
            };
        }
        return gameData.militarySnapshot;
    }

    function commitNewRelation(charAID: number, charBID: number, relationship: string): void {
        if (!gameData || !relationship) return;
        const charA = gameData.characters.get(charAID);
        const charB = gameData.characters.get(charBID);
        if (!charA || !charB) {
            deferredRelations.push({ charAID, charBID, relationship });
            return;
        }
        if (!charA.relatives.some(m => m.id === charBID)) {
            charA.relatives.push({ id: charBID, name: charB.fullName, relationship, isDeceased: false, traits: [], partners: [] });
            console.log(`Parsed family for character ${charAID} (${charA.fullName}): ${relationship} ${charB.fullName} (ID: ${charBID})`);
        }
        if (charBID === gameData.playerID) {
            if (!charA.relationsToPlayer.includes(relationship)) {
                charA.relationsToPlayer.push(relationship);
                console.log(`Parsed relationsToPlayer for character ${charAID} (${charA.fullName}): "${relationship}"`);
            }
        }
    }

    function parseMemory(data: string[]): Memory{
        return {
            type: data[1],
            creationDate: data[2],
            desc: data[3],
            relevanceWeight: Number(data[4])
        }
    }

    function parseSecret(data: string[]): Secret{
        return {
            name: data[1],
            desc: data[2],
            category: data[3],
        }
    }


    function parseTrait(data: string[]): Trait{
        return {
            category: data[1],
            name: data[2],
            desc: data[3],
        }
    }

    function parseOpinionModifier(line: string): OpinionModifier{
        line = line.replace(/ *\([^)]*\) */g, "");

        let splits = line.split(": ");
        const reason = removeTooltip(splits[0]);
        
        // Join the rest back in case the reason contained a colon
        const valueStr = splits.slice(1).join(': ');

        // Use regex to find the number, handles positive/negative values
        const match = valueStr.match(/[+-]?\d+/);
        const value = match ? Number(match[0]) : 0;

        return {
            reason: reason,
            value: value
        }
    }

    console.debug("Finished parsing log. Final GameData object:", gameData!);
    if (gameData && gameData.characters) {
        console.log(`[parseLog] Final character map size: ${gameData.characters.size}`);
        console.log(`[parseLog] Final character map keys: ${Array.from(gameData.characters.keys()).join(', ')}`);
    } else {
        console.log(`[parseLog] Final gameData or characters map is null/undefined.`);
    }
    
    // 初始化角色名称属性，供parseVariables使用
    if (gameData) {
        gameData.setCharacterNames();
    }
    
    return gameData!;
}

/**
 * Extracts the most recent complete military snapshot from anywhere in the
 * debug.log tail (military blocks live in military-council conversation
 * blocks, not necessarily in the block a caller just parsed). Locates the
 * last `VOTC:IN/;/military_snapshot/` line, bounds the block at the next
 * `VOTC:IN/;/init` line (or EOF) and reuses the regular parser over that
 * snapshotRange. Returns undefined when the most recent snapshot block is
 * missing or incomplete (earlier blocks are not retried).
 *
 * All offsets are computed in whole-file STRING space (audit H2 fix): the
 * file is read once as UTF-8 and every index handed to parseLog comes from
 * that same string, so multibyte (CJK) content cannot shift the range the
 * way a byte-window + string-index mix would.
 */
export async function readLastMilitarySnapshotFromLog(debugLogPath: string): Promise<MilitarySnapshot | undefined> {
    const START = 'VOTC:IN/;/military_snapshot/';
    const END = 'VOTC:IN/;/init';
    try {
        if (!fs.existsSync(debugLogPath)) return undefined;
        const content = await fs.promises.readFile(debugLogPath, 'utf8');

        const startIdx = content.lastIndexOf(START);
        if (startIdx === -1) return undefined;
        const rangeStart = Math.max(0, content.lastIndexOf('\n', startIdx) + 1);

        let rangeEnd = content.length;
        const endIdx = content.indexOf(END, startIdx + START.length);
        if (endIdx !== -1) {
            rangeEnd = Math.max(0, content.lastIndexOf('\n', endIdx) + 1);
        }
        if (rangeEnd <= rangeStart) return undefined;

        const gameData = await parseLog(debugLogPath, { startOffset: rangeStart, endOffset: rangeEnd });
        const snapshot = gameData?.militarySnapshot;
        return snapshot?.complete ? snapshot : undefined;
    } catch (err) {
        console.error(`[parseLog] readLastMilitarySnapshotFromLog failed: ${err}`);
        return undefined;
    }
}

const MAX_LAWS = 10;
const MAX_MODIFIERS_PER_CHARACTER = 60;

export function extractMultilinePayload(element: string | undefined): string {
    if (!element) return "";
    const startIdx = element.indexOf('STARTMULTILINE');
    if (startIdx === -1) return element.trim();
    let payloadStart = startIdx + 'STARTMULTILINE'.length;
    if (element[payloadStart] === '#') payloadStart += 1;
    const endIdx = element.lastIndexOf('#ENDMULTILINE');
    const payloadEnd = endIdx === -1 ? element.length : endIdx;
    return element.slice(payloadStart, payloadEnd).trim();
}

export function removeTooltip(str: string): string {
    if (!str) return "";

    // Remove unwanted ASCII control characters and tooltip/onclick prefixes
    let cleanedStr = str.replace(/[\x15]/g, '')
                      .replace(/\^U[^\n]*/g, '')
                      .replace(/\b(?:ONCLICK|TOOLTIP):[A-Z_]+,[^\s)]+/g, '')
                      .replace(/^\s*([A-Z][;\s]\s*)+/, '')
                      .replace(/(?<![A-Za-z])L\s+/g, '')
                      .replace(/(?<![A-Za-z])[A-Z];\s*/g, '');

    // If a tooltip description marker ' L; ' exists, take the text after it
    const lSemicolonIndex = cleanedStr.indexOf(' L; ');
    if (lSemicolonIndex !== -1) {
        cleanedStr = cleanedStr.substring(lSemicolonIndex + 4);
    }

    // Final cleanup on the resulting string
    cleanedStr = cleanedStr.replace(/!+/g, '')
      .replace(/[\s:!']+$/, '')
      .trim();

    return cleanedStr;
}
