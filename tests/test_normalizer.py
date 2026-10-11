from app.normalizer import normalize, parse_dimensions


def test_dimensions_real_patterns():
    assert parse_dimensions("約W44.1×H48.8×D36.4cm") == {"w": 441.0, "h": 488.0, "d": 364.0}
    assert parse_dimensions("W70.0×H177.5×D68.0cm") == {"w": 700.0, "h": 1775.0, "d": 680.0}
    assert parse_dimensions("幅600×高さ1820×奥行650mm") == {"w": 600.0, "h": 1820.0, "d": 650.0}
    assert parse_dimensions("700×1775×680mm") == {"w": 700.0, "h": 1775.0, "d": 680.0}
    assert normalize("depth_mm", "W79.8×H25.0×D25.5cm").value == 255.0


def test_weight_volume_power():
    assert normalize("weight_kg", "約11.5kg").value == 11.5
    assert normalize("weight_kg", "約350g").value == 0.35
    assert normalize("total_capacity_l", "406L").value == 406
    assert normalize("total_capacity_l", "約18L").value == 18
    assert normalize("power_consumption_w", "55W").value == 55
    assert normalize("annual_power_kwh", "267kWh/年").value == 267
    assert normalize("annual_cost_jpy", "約7,210円").value == 7210


def test_aircon_patterns():
    assert normalize("cooling_tatami_min", "15～23畳").value == 15
    assert normalize("cooling_tatami_max", "15～23畳").value == 23
    assert normalize("cooling_tatami_max", "6〜9畳").value == 9
    assert normalize("cooling_tatami_min", "17").value == 17  # already split by the model
    assert normalize("cooling_capacity_kw", "5.6(0.7～5.7)kW").value == 5.6
    assert normalize("energy_rating", "多段階評価 3.6").value == 3.6
    assert normalize("energy_rating", "★★☆☆☆").value == 2
    assert normalize("power_supply_v", "単相200V20A").value == 200


def test_fan_patterns():
    assert normalize("battery_hours", "約4時間30分").value == 4.5
    assert normalize("charging_hours", "240分").value == 4
    assert normalize("blade_count", "5枚").value == 5
    assert normalize("motor_type", "DCモーター搭載").value == "DCモーター"
    assert normalize("is_cordless", "コードレス").value is True
    assert normalize("is_cordless", "なし").value is False


def test_failures_are_flagged():
    r = normalize("weight_kg", "重い")
    assert not r.ok and "単位" in r.note
    assert not normalize("width_mm", "大きめ").ok
    assert not normalize("unknown_key", "1").ok
