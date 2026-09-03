#!/usr/bin/env python3
"""真实存档配对一致性验收（binary-save-melt-integration-plan §6.2）。

对每对 votc_save_testN.ck3（二进制）/ votc_save_testN_1.ck3（明文）分别跑
sidecar probe 与 extract，diff 响应的 identity/entities/facts/warnings。
只读存档，不复制进仓库。用法：
    python tools/votc-save-facts/run_pair_acceptance.py [N ...]
"""
import json
import subprocess
import sys

SIDECAR = r"F:\github\votc\Voices_of_the_Court1\tools\votc-save-facts\target\release\votc-save-facts.exe"
SAVE_DIR = r"C:\Users\A\Documents\Paradox Interactive\Crusader Kings III\save games"

LIMITS = {
    "maxFacts": 500,
    "maxEntities": 250,
    "maxRelatedCharacters": 100,
    "maxOutputBytes": 2097152,
    "maxDecompressedBytes": 536870912,
    "maxNestingDepth": 128,
    "maxScalarBytes": 65536,
}

# extract 全类别；participant 用 probe 实际发现的玩家 ID。
CATEGORIES = ["identity", "family", "realm", "war", "activity", "location", "court"]


def run(op, path, request):
    args = [
        SIDECAR, op, "--input", path, "--allowed-root", SAVE_DIR,
        "--max-output-bytes", "2097152",
    ]
    out = subprocess.run(args, input=json.dumps(request).encode(), capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(f"{op} {path} exit {out.returncode}: {out.stderr.decode(errors='replace')[:400]}")
    return json.loads(out.stdout)


def make_request(op, player_id):
    return {
        "protocolVersion": 2,
        "operation": op,
        "expected": {
            "playerCharacterId": player_id,
            "participantCharacterIds": [player_id],
            "gameDateNumeric": 0,
            "campaignId": "placeholder",
            "campaignIdParts": [0, 0, 0, 0],
            "snapshotSequence": 0,
            "snapshotSlot": 0,
        },
        "categories": CATEGORIES if op == "extract" else ["identity"],
        "limits": LIMITS,
    }


def comparable(resp):
    """去掉 envelope/字节级差异字段，只留语义结果。"""
    return {
        "status": resp["status"],
        "sourceFormat": resp["manifest"]["sourceFormat"],
        "ck3Version": resp["manifest"].get("ck3Version"),
        "snapshotId": resp["manifest"]["snapshotId"],
        "identity": resp.get("identity"),
        "joinCandidates": resp.get("joinCandidates"),
        "entities": resp.get("entities", []),
        "facts": resp.get("facts", []),
        "warnings": sorted(w["code"] for w in resp.get("warnings", [])),
        "error": resp.get("error"),
    }


def main():
    pairs = [int(x) for x in sys.argv[1:]] or [1, 2, 3, 4, 5, 6]
    all_ok = True
    for n in pairs:
        binary = rf"{SAVE_DIR}\votc_save_test{n}.ck3"
        text = rf"{SAVE_DIR}\votc_save_test{n}_1.ck3"
        # 先 probe 拿真实玩家 ID，再据此构造配对请求（participant 用玩家自身）。
        pb0 = run("probe", binary, make_request("probe", "1"))
        player = (pb0.get("identity") or {}).get("playerCharacterId") or "1"
        for op in ("probe", "extract"):
            pb = run(op, binary, make_request(op, player))
            pt = run(op, text, make_request(op, player))
            cb, ct = comparable(pb), comparable(pt)
            # sourceFormat 必然不同（zip_binary vs zip_text），剔除后比较。
            fb, ft = cb.pop("sourceFormat"), ct.pop("sourceFormat")
            # TOKENS_PARTIALLY_UNRESOLVED 是 binary 独有 warning，剔除后比较。
            wb = [w for w in cb.pop("warnings") if w != "TOKENS_PARTIALLY_UNRESOLVED"]
            wt = ct.pop("warnings")
            same = cb == ct
            all_ok &= same
            status = "MATCH" if same else "DIFF "
            print(f"pair {n} {op}: {status} binary={fb} text={ft} "
                  f"status={pb['status']}/{pt['status']} "
                  f"facts={len(pb.get('facts', []))}/{len(pt.get('facts', []))} "
                  f"entities={len(pb.get('entities', []))}/{len(pt.get('entities', []))} "
                  f"durationMs={pb['metrics']['durationMs']}/{pt['metrics']['durationMs']} "
                  f"warnings(b,t)=({sorted(set(wb))},{sorted(set(wt))})")
            if not same:
                for key in cb:
                    if cb[key] != ct[key]:
                        print(f"    field {key}:")
                        print(f"      binary: {json.dumps(cb[key], ensure_ascii=False)[:400]}")
                        print(f"      text:   {json.dumps(ct[key], ensure_ascii=False)[:400]}")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
