"""Prompts for multi-stage extraction (Stage 1) and classification (Stage 3)."""
from __future__ import annotations

from .schema import CATEGORY_GROUPS, attrs_for_group


def source_text(p: dict) -> str:
    """Canonical source text used both for prompting and for evidence verification."""
    lines = [f"【タイトル】{p.get('title', '')}", f"【ブランド】{p.get('brand', '')}",
             f"【カテゴリ】{p.get('category', '')}", f"【説明文】{p.get('description', '')}", "【属性】"]
    for k, v in (p.get("raw_attributes") or {}).items():
        lines.append(f"{k}: {v}")
    docs = p.get("doc_sources") or []
    if docs:
        lines.append("【資料】")
        for d in docs:
            where = f"{d.get('file_name', '')}" + (f" p.{d['page']}" if d.get("page") else "")
            lines.append(f"[{where}] {d.get('label') or d.get('key', '')}: {d.get('evidence') or d.get('value', '')}")
    return "\n".join(lines)


def stage1_prompt(p: dict, group: str) -> str:
    defs = "\n".join(f"- {a.key}: {a.label}" + (f"（最終単位 {a.unit}）" if a.unit else "") for a in attrs_for_group(group))
    return f"""あなたは総合EC・家電リテーラーの商品マスタ整備担当です。
以下の原本データ（{CATEGORY_GROUPS[group]}）から、指定された属性を抽出してください。

## 厳守ルール
1. raw_value には原文に書かれている値を「単位込みでそのまま」転記すること。単位換算・計算・丸めは絶対にしない（換算は後段のシステムが行う）。
   例: 原文「約W70.0×H177.5×D68.0cm」→ width_mm の raw_value は「約W70.0×H177.5×D68.0cm」
2. evidence には根拠となる原文の連続した文字列を一字一句そのままコピーすること（要約・言い換え禁止、30字以内）。
3. 原文に記載がない属性は推測で埋めず、not_found に入れること（ハルシネーション防止）。
4. 一般常識からの推定（例: 「4ドアだから世帯人数は…」）は、原文に明確な記述がない限り行わない。
5. confidence は原文の記述の明確さに応じて 0.0〜1.0 で自己評価すること。

## 抽出対象の属性
{defs}

## 原本データ
{source_text(p)}
"""


def stage3_prompt(p: dict, group: str) -> str:
    return f"""あなたは総合EC・家電リテーラーのECサイト編集者です。
以下の原本データ（{CATEGORY_GROUPS[group]}）を読み、検索・絞り込みに使う標準機能タグと検索キーワード、要約を作成してください。

## 厳守ルール
1. feature_tags は指定の標準タグ辞書（enum）からのみ選ぶこと。原文に根拠がないタグは付けない。
2. 各タグの evidence には根拠となる原文の文字列を一字一句そのままコピーすること（30字以内）。
3. メーカー独自の機能名（例: 「凍結洗浄」「自動お掃除」）は、意味の近い汎用タグに対応付けること。
4. ai_summary は原文の事実のみで60〜90字にまとめること。

    ## 原本データ
{source_text(p)}
"""


def gmc_prompt(p: dict, group: str) -> str:
    return f"""あなたは Google Merchant Center（GMC）の会話属性（Conversational Attributes: https://support.google.com/merchants/answer/17085370）の構築スペシャリストです。
以下の取扱商品の原本データ（{CATEGORY_GROUPS.get(group, group)}）から、AI検索（Google 検索の AI モード等）や会話型ショッピングエージェントが顧客の質問に正確に答えられるよう、会話属性データを作成してください。

## 厳守ルール
1. **item_group_id / item_group_title**:
   - タイトルの型番から色枝番（例: `-W`, `-H`, `(WU)`, `-WS` 等）を除いたベース型番を `item_group_id` とする。
   - 色や枝番を除いたシリーズ・モデル共通のわかりやすい名称を `item_group_title` とする。
2. **variant_options [variant_option]**:
   - この商品のバリエーションを特定するプロパティ（例: カラー、容量、ドア開閉、畳数目安、電源電圧、モーター方式など）を 2〜4 個抽出し、それぞれ根拠文字列 `evidence` を原文から一字一句コピーする。
3. **questions_and_answers [question_and_answer]**:
   - 購入検討者が実際に尋ねそうな具体的な質問と回答を **3〜5件** 作成する（例: 本体サイズ・設置スペース、消費電力・年間電気代、省エネ性能、手入れ・清潔機能、運転音、バッテリー持ち等）。
   - **回答は必ず原本データの事実・数値のみに基づくこと（推測・ハルシネーション厳禁）**。
   - 各回答の根拠となる原文の連続文字列を `evidence` に一字一句そのままコピーすること（30字以内）。
4. **product_highlights [product_highlight]**:
   - 商品の主要セールスポイントを簡潔な箇条書き（3〜5件、各40字以内）でまとめる。
5. **related_mentions [related_product]**:
   - 説明文中に別売アクセサリ・マグネットシート・交換フィルター・関連型番などの記載があれば抽出する（なければ空配列 `[]`）。

## 原本データ
{source_text(p)}
"""

