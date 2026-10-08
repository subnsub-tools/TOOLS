# Provenance

`ANCHOR.txt` pins this repository's history — the head commit and tree
hashes it names — and `ANCHOR.txt.ots` is an
[OpenTimestamps](https://opentimestamps.org) proof that the anchor existed
no later than its anchor date. The proof commits to the Bitcoin
blockchain, so it stays verifiable independently of any hosting platform.

Verify with the OpenTimestamps client:

    ots verify ANCHOR.txt.ots

A freshly minted proof is *pending attestation* until a calendar commits
it to a block; `ots upgrade ANCHOR.txt.ots` collects the final
attestation. Anchors are refreshed at milestones, not per commit.

Earlier anchors keep a folder of their own, named by their date
(`2026-07-30/`). Each proves the history up to its own head by its own
date — for the code it covers, the earlier date is the stronger claim —
and each carries its upgraded proof, complete without the calendars:

    ots verify 2026-07-30/ANCHOR.txt.ots
