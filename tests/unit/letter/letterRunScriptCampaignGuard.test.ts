/**
 * R2 (whole-delivery-block campaign guard in letters.txt): both guarded
 * payloads embed the campaign id parts they were built for into the outer
 * block limit, so a stale letters.txt polled after a campaign switch fails
 * the whole block (thread clear, artifact, message event) instead of
 * consuming the new campaign's slot. Payloads without a usable tuple keep
 * the historical single-line thread-only limit byte-for-byte.
 */
import {
    buildLetterDeliveryPayload,
    buildLetterFallbackPayload
} from '../../../src/main/letter/letterRunScript';

const PARTS_A = { a: 111111111, b: 222222222, c: 333333333, d: 444444444 };

describe('campaign guard in guarded payloads (R2)', () => {
    it('guards the whole delivery block with the campaign tuple', () => {
        const payload = buildLetterDeliveryPayload({
            letterNumber: '5',
            deliveryId: 12345,
            escapedReply: 'hello',
            campaignIdParts: PARTS_A
        });

        expect(payload).toContain('\tlimit = {');
        expect(payload).toContain('\t\texists = global_var:votc_letter_5');
        expect(payload).toContain('\t\tglobal_var:votc_campaign_id_a = 111111111');
        expect(payload).toContain('\t\tglobal_var:votc_campaign_id_b = 222222222');
        expect(payload).toContain('\t\tglobal_var:votc_campaign_id_c = 333333333');
        expect(payload).toContain('\t\tglobal_var:votc_campaign_id_d = 444444444');

        // The guard precedes every effect of the delivery block.
        const limitIndex = payload.indexOf('limit = {');
        expect(limitIndex).toBeLessThan(payload.indexOf('remove_global_variable ?= votc_letter_5'));
        expect(limitIndex).toBeLessThan(payload.indexOf('create_artifact'));
        expect(limitIndex).toBeLessThan(payload.indexOf('trigger_event = message_event.362'));
        expect(payload).toContain('VOTC:LETTER/;/run_skipped/;/letter_5/;/12345');
    });

    it('guards the fallback payload with the campaign tuple as well', () => {
        const payload = buildLetterFallbackPayload({
            letterNumber: '3',
            deliveryId: 777,
            campaignIdParts: PARTS_A
        });

        expect(payload).toContain('\t\texists = global_var:votc_letter_3');
        expect(payload).toContain('\t\tglobal_var:votc_campaign_id_a = 111111111');
        expect(payload).toContain('\t\tglobal_var:votc_campaign_id_d = 444444444');
        const limitIndex = payload.indexOf('limit = {');
        expect(limitIndex).toBeLessThan(payload.indexOf('send_interface_message'));
        expect(limitIndex).toBeLessThan(payload.indexOf('remove_global_variable ?= votc_letter_3'));
    });

    it('keeps the historical thread-only limit when no tuple is provided', () => {
        const delivery = buildLetterDeliveryPayload({ letterNumber: '5', deliveryId: 12345, escapedReply: 'hello' });
        expect(delivery).toContain('limit = { exists = global_var:votc_letter_5 }');
        expect(delivery).not.toContain('global_var:votc_campaign_id_a');

        const fallback = buildLetterFallbackPayload({ letterNumber: '3', deliveryId: 777 });
        expect(fallback).toContain('limit = { exists = global_var:votc_letter_3 }');
        expect(fallback).not.toContain('global_var:votc_campaign_id_a');
    });

    it('does not emit a partial guard tuple', () => {
        const partial = buildLetterDeliveryPayload({
            letterNumber: '5',
            deliveryId: 12345,
            escapedReply: 'hello',
            campaignIdParts: { a: 111111111, b: 222222222, c: 333333333, d: 0 }
        });
        expect(partial).toContain('limit = { exists = global_var:votc_letter_5 }');
        expect(partial).not.toContain('global_var:votc_campaign_id_a');
    });
});
