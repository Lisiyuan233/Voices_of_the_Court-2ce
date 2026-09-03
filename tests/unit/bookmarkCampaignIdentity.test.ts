import { parseBookmarkCampaignIdentityPayload } from '../../src/main/parseLogforbookmarks';

const validPayload = [
    'campaign',
    '12345',
    '7',
    '2',
    '1',
    '101',
    '102',
    '103',
    '104',
    '1',
    '1'
];

describe('parseBookmarkCampaignIdentityPayload', () => {
    it('builds the identity carried by a V2 bookmark command', () => {
        expect(parseBookmarkCampaignIdentityPayload(validPayload, '12345')).toMatchObject({
            campaignId: '101-102-103-104',
            playerId: '12345',
            protocolSchema: 2,
            campaignSchema: 1
        });
    });

    it('rejects a bookmark whose command and log identify different players', () => {
        expect(() => parseBookmarkCampaignIdentityPayload(validPayload, '99999')).toThrow(
            'Bookmark player mismatch'
        );
    });

    it('fails closed for missing or unsupported V2 identity data', () => {
        expect(() => parseBookmarkCampaignIdentityPayload(undefined, '12345')).toThrow(
            'missing its V2 campaign identity'
        );
        expect(() => parseBookmarkCampaignIdentityPayload(
            [...validPayload.slice(0, 3), '3', ...validPayload.slice(4)],
            '12345'
        )).toThrow('Unsupported bookmark protocol schema');
    });

    it('fails closed for a negative or non-integer checkpoint epoch', () => {
        expect(() => parseBookmarkCampaignIdentityPayload(
            [validPayload[0], validPayload[1], '-1', ...validPayload.slice(3)],
            '12345'
        )).toThrow('Bookmark checkpoint epoch is invalid');
        expect(() => parseBookmarkCampaignIdentityPayload(
            [validPayload[0], validPayload[1], 'x', ...validPayload.slice(3)],
            '12345'
        )).toThrow('Bookmark checkpoint epoch is invalid');
    });

    it('fails closed on campaign and player timeline schema mismatches', () => {
        expect(() => parseBookmarkCampaignIdentityPayload(
            [...validPayload.slice(0, 4), '2', ...validPayload.slice(5)],
            '12345'
        )).toThrow('Unsupported bookmark campaign schema');
        expect(() => parseBookmarkCampaignIdentityPayload(
            [...validPayload.slice(0, 10), '2'],
            '12345'
        )).toThrow('Unsupported bookmark player timeline schema');
    });
});
