from app.rules import (AUTO_APPROVED, NEEDS_REVIEW, REJECTED, check_consistency, check_limits, composite_score, decide,
                       evidence_match, token_confidence)


SRC = "【説明文】●自動製氷機能搭載。\n【属性】\ndimensions: W70.0×H177.5×D68.0cm\nweight: 110kg"


def test_evidence_match_levels():
    assert evidence_match("W70.0×H177.5×D68.0cm", SRC) == 1.0
    assert evidence_match("自動製氷 機能搭載", SRC) == 0.8          # whitespace difference
    assert evidence_match("重量は110kgです", SRC, raw_value="110kg") == 0.5
    assert evidence_match("ガラストップドア", SRC) == 0.0
    assert evidence_match("", SRC) == 0.0


def test_composite_score_weights():
    assert composite_score(1.0, 1.0, 1.0) == 1.0
    assert composite_score(1.0, 0.8, None) == 0.92                  # 0.6*1 + 0.4*0.8
    assert composite_score(1.0, 0.8, 0.5) == round(0.5 + 0.24 + 0.1, 3)
    assert token_confidence(0.0) == 1.0
    assert token_confidence(None) is None


def test_limits_and_consistency():
    assert check_limits("width_mm", 8000) is not None
    assert check_limits("width_mm", 700) is None
    issues = check_consistency({"total_capacity_l": 400, "freezer_capacity_l": 300, "fridge_capacity_l": 200})
    assert "freezer_capacity_l" in issues and "fridge_capacity_l" in issues
    assert check_consistency({"cooling_tatami_min": 10, "cooling_tatami_max": 6})


def test_gate_decisions():
    th = 0.9
    assert decide(True, "", "物理限界値外", None, 1.0, 1.0, th)[0] == REJECTED
    assert decide(False, "単位なし", None, None, 1.0, 1.0, th)[0] == NEEDS_REVIEW
    assert decide(True, "", None, "整合性違反", 1.0, 1.0, th)[0] == NEEDS_REVIEW
    st, gate, reason = decide(True, "", None, None, 0.0, 0.95, th)
    assert st == NEEDS_REVIEW and "根拠" in reason                    # evidence missing => forced review
    assert decide(True, "", None, None, 1.0, 0.95, th)[0] == AUTO_APPROVED
    assert decide(True, "", None, None, 1.0, 0.85, th)[0] == NEEDS_REVIEW
