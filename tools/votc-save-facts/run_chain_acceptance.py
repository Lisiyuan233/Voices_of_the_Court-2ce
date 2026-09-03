#!/usr/bin/env python3
"""全链路验收（binary-save-melt-integration-plan §6 补充）：
probe -> verify(v2 typed checks) -> session(open/search/profile/close)。

用法：
    python tools/votc-save-facts/run_chain_acceptance.py <save.ck3> [<save2.ck3> ...]

对每个存档：先 probe 取 identity/fingerprint，再用存档自身的 identity 构造
verify 与 session 请求（模拟 App 侧行为）。campaignIdParts 取自 probe 结果，
因此 snapshot 已清除（protocol=0）的存档会在门禁处失败——这本身也是
正确的 fail-closed 行为。

已知输出基线：
- votc_context.ck3（明文，snapshot 活跃）：session open/ready -> search/ok ->
  profile/ok -> close/closed（maxCharacters 需 100000，该档有 46027 个 living
  characters，HARD_MAX_SESSION_CHARACTERS=100000；title 记录嵌套在第二层
  landed_titles 块中，数量超过 maxTitles=5000 时 index 按设计报
  partial + INDEX_TITLE_LIMIT）；verify ok，三项 typed checks 全部 known
  （真实 1.19 存档 gold 序列化为 gold={ value=<decimal> } 块且可为负）。
- votc_save_test1.ck3 / _1（snapshot 已清除）：verify 与 session_open 均在
  campaign 门禁 fail-closed，二进制与明文行为完全一致。
"""
import json
import subprocess
import sys

SIDECAR = r"F:\github\votc\Voices_of_the_Court1\tools\votc-save-facts\target\release\votc-save-facts.exe"
LIMITS_PROBE = {
    "maxFacts": 500, "maxEntities": 250, "maxRelatedCharacters": 100,
    "maxOutputBytes": 262144, "maxDecompressedBytes": 536870912,
    "maxNestingDepth": 128, "maxScalarBytes": 65536,
}
LIMITS_VERIFY = {
    "maxChecks": 16, "maxCharacters": 8, "maxOutputBytes": 262144,
    "maxDecompressedBytes": 536870912, "maxNestingDepth": 128, "maxScalarBytes": 65536,
}


def call(op, path, req):
    out = subprocess.run(
        [SIDECAR, op, "--input", path, "--allowed-root", SAVE_DIR,
         "--max-output-bytes", "262144"],
        input=json.dumps(req).encode(), capture_output=True)
    return json.loads(out.stdout)


def session(path, frames):
    stdin = "".join(json.dumps(f) + "\n" for f in frames).encode()
    out = subprocess.run(
        [SIDECAR, "session", "--input", path, "--allowed-root", SAVE_DIR,
         "--max-output-bytes", "262144"],
        input=stdin, capture_output=True, timeout=300)
    return [json.loads(line) for line in out.stdout.decode().splitlines() if line.strip()]


def chain(path):
    print(f"=== {path}")
    probe_req = {
        "protocolVersion": 2, "operation": "probe",
        "expected": {"playerCharacterId": "1", "participantCharacterIds": ["1"],
                     "gameDateNumeric": 0, "campaignId": "x", "campaignIdParts": [0, 0, 0, 0],
                     "snapshotSequence": 0, "snapshotSlot": 0},
        "categories": ["identity"], "limits": LIMITS_PROBE,
    }
    p = call("probe", path, probe_req)
    ident = p.get("identity") or {}
    fp = p["manifest"]["sourceFingerprint"]
    pid = ident.get("playerCharacterId", "1")
    print(f"probe: {p['status']} fmt={p['manifest']['sourceFormat']} identity={json.dumps(ident, ensure_ascii=False)[:200]}")

    expected = {
        "playerCharacterId": pid, "participantCharacterIds": [pid],
        "gameDateNumeric": ident.get("gameDateNumeric", 0),
        "campaignId": "chain-acceptance",
        "campaignIdParts": ident.get("campaignIdParts", [0, 0, 0, 0]),
        "snapshotSequence": ident.get("snapshotSequence", 0),
        "snapshotSlot": ident.get("snapshotSlot", 0),
        "sourceFingerprint": fp,
    }
    v = call("verify", path, {
        "protocolVersion": 2, "operation": "verify", "expected": expected,
        "checks": [
            {"kind": "character_life_state", "checkId": "c1", "characterId": pid},
            {"kind": "character_skill_at_least", "checkId": "c2", "characterId": pid, "skill": "diplomacy", "value": 1},
            {"kind": "character_gold_at_least", "checkId": "c3", "characterId": pid, "value": 0},
        ],
        "limits": LIMITS_VERIFY,
    })
    results = {r["checkId"]: (r["status"], r.get("lifeState", r.get("value", r.get("reasonCode"))))
               for r in v.get("results", [])}
    print(f"verify: {v['status']} error={v.get('error')} results={results}")

    frames = [
        {"protocolVersion": 3, "requestId": "r1", "sessionId": "chain-s1", "operation": "session_open",
         "expected": expected,
         "limits": {"maxDecompressedBytes": 536870912, "maxNestingDepth": 128, "maxScalarBytes": 65536,
                    "maxCharacters": 100000, "maxTitles": 5000, "maxRelationsPerCharacter": 64,
                    "maxIdleMs": 600000}},
        {"protocolVersion": 3, "requestId": "r2", "sessionId": "chain-s1", "operation": "character_search",
         "selectors": {"candidateCharacterIds": [pid]}, "limit": 5},
        {"protocolVersion": 3, "requestId": "r3", "sessionId": "chain-s1", "operation": "character_profile",
         "characterId": pid, "sections": ["identity", "public_family", "realm", "court", "location"]},
        {"protocolVersion": 3, "requestId": "r4", "sessionId": "chain-s1", "operation": "session_close"},
    ]
    for frame in session(path, frames):
        slim = {k: frame[k] for k in ("operation", "status", "errorCode") if k in frame}
        print(f"session: {json.dumps(slim, ensure_ascii=False)}")


if __name__ == "__main__":
    import os
    SAVE_DIR = r"C:\Users\A\Documents\Paradox Interactive\Crusader Kings III\save games"
    for arg in sys.argv[1:]:
        chain(arg if os.path.isabs(arg) else os.path.join(SAVE_DIR, arg))
