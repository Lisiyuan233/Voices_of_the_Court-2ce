@szmania Thanks for testing both the app and the mod. Yes, #15 adds the extra character/realm attributes and includes fixes to the existing letter-reply path, together with the timeline/checkpoint foundation.

You're also right about the battle scripts: the test mod archive was packaged from my broader 2CE development line, so it contains work intended for later PRs. I should have made that distinction clearer in the download comment. On the app side, the battle-report modules included here are not wired into `main.ts` yet; the complete battle-report flow, UI, and prompt integration are planned as a separate PR after the military-snapshot work. The broader incoming-letter generation port is a follow-up too.

I've added the [proposed PR roadmap above](https://github.com/szmania/Voices_of_the_Court/pull/15#issuecomment-5747421043) to make those boundaries and dependencies explicit.

Could you share the app bugs you're seeing, with the steps to reproduce, expected versus actual behaviour, and any relevant app/CK3 log excerpts? Please also note whether each case follows loading an older save or switching the player/campaign, and which app commit and mod package you used. That should help distinguish #15 regressions from app/mod pairing issues. I can then reproduce the failures and address the ones belonging to this PR here.

The automated checks are useful, but they don't replace these in-game tests. One known limitation is that letter delivery still uses a single `run/letters.txt` channel, so overlapping deliveries can overwrite a pending script; this PR does not introduce a delivery queue.

