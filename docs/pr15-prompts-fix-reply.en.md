@szmania The Prompts-tab error is fixed in `91757886`. I reproduced the exact `configTextarea.js:73:53` stack on both the upstream base and this PR: the component still read `config.prompts[language]`, although prompt loading and saving now belong to the preset editor. The fix removes that competing read/write path, including language updates and stale prompt `config-change` messages; it does not overwrite existing presets.

Validation covers opening the page without `config.prompts`, editing/saving/reopening custom prompts, changing language, and ordinary configuration fields. The TypeScript build passes. The full Jest failure set is unchanged from the upstream base in the same environment (21 suite-load failures and one token-count assertion).

I've also updated the [roadmap](https://github.com/szmania/Voices_of_the_Court/pull/15#issuecomment-5747421043) and the earlier compatibility note: **existing conversation/memory compatibility must be completed before #15 merges**. That work is still pending; this prompt fix does not complete the data migration work.

The roadmap now includes separate feature PRs for [the CK3 mod repository](https://github.com/szmania/voices_of_the_court_mod), each paired with the relevant app PR. Those mod PRs have not been opened yet. Please retest the Prompts tab using the updated app branch.
