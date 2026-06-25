import { BigQuery } from "@google-cloud/bigquery";

const bigquery = new BigQuery({
  projectId: "tu-hacci-ad",
  credentials: JSON.parse(process.env.GCP_KEY),
});

const LOCATION = "asia-northeast1";
const DS = "`tu-hacci-ad.yahoo_ads`";

// 値のシリアライズ（BQの{value:}ラッパを外す）
function serialize(rows) {
  return rows.map((row) => {
    const r = {};
    for (const [k, v] of Object.entries(row)) {
      r[k] = v && typeof v === "object" && v.value !== undefined ? v.value : v;
    }
    return r;
  });
}

async function run(query, params) {
  const opts = { query, location: LOCATION };
  if (params) opts.params = params;
  const [rows] = await bigquery.query(opts);
  return serialize(rows);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "POST") return await handlePost(req, res);
    return await handleGet(req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}

// ============================================================
// GET
// ============================================================
async function handleGet(req, res) {
  const { type, since, until, keyword, days, n } = req.query;
  let query = "";
  let params = null;

  if (type === "summary") {
    query = `
      SELECT campaign_name,
        SUM(imps) as imps, SUM(clicks) as clicks, SUM(use_amount) as cost,
        SUM(order_count) as orders, SUM(gmv) as sales,
        SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas,
        SAFE_DIVIDE(SUM(clicks), SUM(imps)) * 100 as ctr,
        SAFE_DIVIDE(SUM(order_count), SUM(clicks)) * 100 as cvr,
        SAFE_DIVIDE(SUM(use_amount), SUM(clicks)) as cpc
      FROM ${DS}.item_daily
      WHERE date BETWEEN '${since}' AND '${until}'
      GROUP BY campaign_name ORDER BY cost DESC`;
  } else if (type === "daily") {
    query = `
      SELECT date, SUM(imps) as imps, SUM(clicks) as clicks, SUM(use_amount) as cost,
        SUM(order_count) as orders, SUM(gmv) as sales,
        SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas
      FROM ${DS}.item_daily
      WHERE date BETWEEN '${since}' AND '${until}'
      GROUP BY date ORDER BY date ASC`;
  } else if (type === "items") {
    query = `
      SELECT ysrid, item_name, campaign_name, search_keyword, category_name,
        SUM(imps) as imps, SUM(clicks) as clicks, SUM(use_amount) as cost,
        SUM(order_count) as orders, SUM(gmv) as sales,
        SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas,
        SAFE_DIVIDE(SUM(order_count), SUM(clicks)) * 100 as cvr
      FROM ${DS}.item_daily
      WHERE date BETWEEN '${since}' AND '${until}' AND use_amount > 0
      GROUP BY ysrid, item_name, campaign_name, search_keyword, category_name
      ORDER BY cost DESC LIMIT 100`;
  } else if (type === "keywords") {
    query = `
      SELECT ad_group_name,
        SUM(imps) as imps, SUM(clicks) as clicks, SUM(use_amount) as cost,
        SUM(order_count) as orders, SUM(gmv) as sales,
        SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas,
        SAFE_DIVIDE(SUM(order_count), SUM(clicks)) * 100 as cvr
      FROM ${DS}.kw_daily
      WHERE date BETWEEN '${since}' AND '${until}' AND use_amount > 0
      GROUP BY ad_group_name ORDER BY cost DESC`;
  } else if (type === "kw_daily") {
    query = `
      SELECT date, SUM(imps) as imps, SUM(clicks) as clicks, SUM(use_amount) as cost,
        SUM(order_count) as orders, SUM(gmv) as sales,
        SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas
      FROM ${DS}.kw_daily
      WHERE date BETWEEN '${since}' AND '${until}'
      GROUP BY date ORDER BY date ASC`;
  } else if (type === "kw_detail") {
    query = `
      SELECT search_keyword, ad_group_name, ysrid, item_name,
        SUM(imps) as imps, SUM(clicks) as clicks, SUM(use_amount) as cost,
        SUM(order_count) as orders, SUM(gmv) as sales,
        SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas,
        SAFE_DIVIDE(SUM(order_count), SUM(clicks)) * 100 as cvr,
        SAFE_DIVIDE(SUM(use_amount), SUM(clicks)) as cpc
      FROM ${DS}.kw_daily
      WHERE date BETWEEN '${since}' AND '${until}' AND use_amount > 0
      GROUP BY search_keyword, ad_group_name, ysrid, item_name
      ORDER BY cost DESC LIMIT 100`;
  } else if (type === "kw_keywords") {
    query = `
      SELECT search_keyword, ad_group_name,
        SUM(imps) as imps, SUM(clicks) as clicks, SUM(use_amount) as cost,
        SUM(order_count) as orders, SUM(gmv) as sales,
        SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas,
        SAFE_DIVIDE(SUM(order_count), SUM(clicks)) * 100 as cvr,
        SAFE_DIVIDE(SUM(use_amount), SUM(clicks)) as cpc
      FROM ${DS}.kw_daily
      WHERE date BETWEEN '${since}' AND '${until}' AND use_amount > 0
      GROUP BY search_keyword, ad_group_name ORDER BY cost DESC LIMIT 50`;

  // ---------- 順位監視：設定の読み出し ----------
  } else if (type === "rank_config") {
    query = `SELECT keyword, source, strategy, note, active, updated_at
             FROM ${DS}.rank_config ORDER BY updated_at DESC`;
  } else if (type === "rank_settings") {
    query = `SELECT * FROM ${DS}.rank_settings WHERE id='default' LIMIT 1`;

  // ---------- 順位監視：広告消化上位プレビュー（auto候補） ----------
  } else if (type === "kw_top_spenders") {
    query = `
      WITH kw_union AS (
        SELECT search_keyword, use_amount, gmv, order_count FROM ${DS}.item_daily
        WHERE date >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @days DAY)
        UNION ALL
        SELECT search_keyword, use_amount, gmv, order_count FROM ${DS}.kw_daily
        WHERE date >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL @days DAY)
      )
      SELECT search_keyword AS keyword, SUM(use_amount) AS spend, SUM(gmv) AS sales,
        SUM(order_count) AS orders,
        SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 AS roas
      FROM kw_union
      WHERE search_keyword IS NOT NULL AND TRIM(search_keyword) != ''
      GROUP BY search_keyword ORDER BY spend DESC LIMIT @n`;
    params = { days: parseInt(days || "30", 10), n: parseInt(n || "100", 10) };

  // ---------- 順位監視：キーワード別 統合ビュー（順位×広告） ----------
  } else if (type === "rank_keywords") {
    query = `
      WITH latest AS (
        SELECT keyword, MAX(snapshot_at) AS mx
        FROM ${DS}.rank_snapshots
        WHERE snapshot_date >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 2 DAY)
        GROUP BY keyword
      ),
      snap AS (
        SELECT s.* FROM ${DS}.rank_snapshots s
        JOIN latest l ON s.keyword=l.keyword AND s.snapshot_at=l.mx
        WHERE s.snapshot_date >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 2 DAY)
      ),
      own AS (
        SELECT keyword,
          MIN(IF(is_own_store AND NOT is_ad, rank_organic, NULL)) AS own_organic,
          MIN(IF(is_own_store AND is_ad, rank_ad, NULL))           AS own_ad,
          COUNTIF(is_own_store)  AS own_items,
          COUNT(*)               AS result_count,
          MAX(snapshot_at)       AS snapshot_at
        FROM snap GROUP BY keyword
      ),
      spend AS (
        SELECT search_keyword AS keyword,
          SUM(use_amount) AS cost, SUM(gmv) AS sales, SUM(order_count) AS orders,
          SUM(clicks) AS clicks,
          SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 AS roas
        FROM (
          SELECT search_keyword, use_amount, gmv, order_count, clicks FROM ${DS}.item_daily
          WHERE date BETWEEN '${since}' AND '${until}'
          UNION ALL
          SELECT search_keyword, use_amount, gmv, order_count, clicks FROM ${DS}.kw_daily
          WHERE date BETWEEN '${since}' AND '${until}'
        )
        GROUP BY search_keyword
      )
      SELECT o.keyword, o.own_organic, o.own_ad, o.own_items, o.result_count, o.snapshot_at,
        s.cost, s.sales, s.orders, s.clicks, s.roas
      FROM own o LEFT JOIN spend s ON o.keyword=s.keyword
      ORDER BY s.cost DESC NULLS LAST, o.own_organic ASC NULLS LAST`;

  // ---------- 順位監視：競合ビュー（指定KWの最新スナップショット全件） ----------
  } else if (type === "rank_competitors") {
    query = `
      WITH latest AS (
        SELECT MAX(snapshot_at) AS mx FROM ${DS}.rank_snapshots
        WHERE keyword=@kw AND snapshot_date >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 3 DAY)
      )
      SELECT rank_overall, rank_organic, rank_ad, is_ad, item_code, store_id, is_own_store,
        item_name, price, review_count, review_score, thumbnail_url, snapshot_at
      FROM ${DS}.rank_snapshots
      WHERE keyword=@kw AND snapshot_at=(SELECT mx FROM latest)
      ORDER BY rank_overall ASC`;
    params = { kw: keyword || "" };

  // ---------- 順位監視：順位推移（指定KWの自社ベスト順位の時系列） ----------
  } else if (type === "rank_history") {
    query = `
      SELECT snapshot_at,
        MIN(IF(is_own_store AND NOT is_ad, rank_organic, NULL)) AS own_organic,
        MIN(IF(is_own_store AND is_ad, rank_ad, NULL))           AS own_ad
      FROM ${DS}.rank_snapshots
      WHERE keyword=@kw AND snapshot_date BETWEEN '${since}' AND '${until}'
      GROUP BY snapshot_at ORDER BY snapshot_at ASC`;
    params = { kw: keyword || "" };

  // ---------- AI分析 ----------
  } else if (type === "ai_analysis") {
    return await handleAi(req, res, since, until);

  } else {
    return res.status(400).json({ error: "Invalid type" });
  }

  const rows = await run(query, params);
  res.status(200).json(rows);
}

// ============================================================
// POST（設定の書き込み）
// ============================================================
async function handlePost(req, res) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const action = body.action;

  if (action === "config_upsert") {
    // 手動キーワードの追加・更新（keyword + source で一意）
    const q = `
      MERGE ${DS}.rank_config T
      USING (SELECT @keyword AS keyword, @source AS source) S
      ON T.keyword=S.keyword AND T.source=S.source
      WHEN MATCHED THEN UPDATE SET
        strategy=@strategy, note=@note, active=@active, updated_at=CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN
        INSERT (keyword, source, strategy, note, active, updated_at)
        VALUES (@keyword, @source, @strategy, @note, @active, CURRENT_TIMESTAMP())`;
    await run(q, {
      keyword: (body.keyword || "").trim(),
      source: body.source || "manual",
      strategy: body.strategy || null,
      note: body.note || null,
      active: body.active === undefined ? true : !!body.active,
    });
    return res.status(200).json({ ok: true });
  }

  if (action === "config_delete") {
    const q = `DELETE FROM ${DS}.rank_config WHERE keyword=@keyword AND source=@source`;
    await run(q, { keyword: (body.keyword || "").trim(), source: body.source || "manual" });
    return res.status(200).json({ ok: true });
  }

  if (action === "settings_save") {
    const q = `
      MERGE ${DS}.rank_settings T
      USING (SELECT 'default' AS id) S ON T.id=S.id
      WHEN MATCHED THEN UPDATE SET
        auto_top_n=@auto_top_n, trailing_days=@trailing_days, scrape_pages=@scrape_pages,
        target_roas=@target_roas, roas_floor=@roas_floor, updated_at=CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN
        INSERT (id, auto_top_n, trailing_days, scrape_pages, target_roas, roas_floor, updated_at)
        VALUES ('default', @auto_top_n, @trailing_days, @scrape_pages, @target_roas, @roas_floor, CURRENT_TIMESTAMP())`;
    await run(q, {
      auto_top_n: parseInt(body.auto_top_n ?? 100, 10),
      trailing_days: parseInt(body.trailing_days ?? 30, 10),
      scrape_pages: parseInt(body.scrape_pages ?? 3, 10),
      target_roas: parseFloat(body.target_roas ?? 550),
      roas_floor: parseFloat(body.roas_floor ?? 300),
    });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Invalid action" });
}

// ============================================================
// AI分析（Gemini）— サーバ側で呼ぶ
// ============================================================
async function handleAi(req, res, since, until) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(200).json({ error: "GEMINI_API_KEY 未設定" });

  // 品番別アイテムマッチ（上位30）
  const items = await run(`
    SELECT ysrid, ANY_VALUE(item_name) AS item_name,
      SUM(use_amount) AS cost, SUM(gmv) AS sales, SUM(order_count) AS orders,
      SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 AS roas
    FROM ${DS}.item_daily
    WHERE date BETWEEN '${since}' AND '${until}' AND use_amount > 0
    GROUP BY ysrid ORDER BY cost DESC LIMIT 30`);

  // KW×品番（上位40）
  const kws = await run(`
    SELECT search_keyword, ad_group_name, ysrid,
      SUM(use_amount) AS cost, SUM(gmv) AS sales, SUM(order_count) AS orders,
      SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 AS roas
    FROM ${DS}.kw_daily
    WHERE date BETWEEN '${since}' AND '${until}' AND use_amount > 0
    GROUP BY search_keyword, ad_group_name, ysrid ORDER BY cost DESC LIMIT 40`);

  // 順位：最新スナップショットの自社ベスト順位
  let rank = [];
  try {
    rank = await run(`
      WITH latest AS (
        SELECT keyword, MAX(snapshot_at) AS mx FROM ${DS}.rank_snapshots
        WHERE snapshot_date >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 2 DAY)
        GROUP BY keyword
      ),
      snap AS (
        SELECT s.keyword, s.is_own_store, s.is_ad, s.rank_organic, s.rank_ad
        FROM ${DS}.rank_snapshots s JOIN latest l
          ON s.keyword=l.keyword AND s.snapshot_at=l.mx
      )
      SELECT keyword,
        MIN(IF(is_own_store AND NOT is_ad, rank_organic, NULL)) AS own_organic,
        MIN(IF(is_own_store AND is_ad, rank_ad, NULL))           AS own_ad
      FROM snap GROUP BY keyword`);
  } catch (e) { rank = []; }

  const prompt = buildAiPrompt(items, kws, rank, since, until);
  const result = await callGemini(apiKey, prompt);
  return res.status(200).json(result);
}

function buildAiPrompt(items, kws, rank, since, until) {
  const rankMap = {};
  rank.forEach((r) => { rankMap[r.keyword] = r; });
  const itemLines = items.map((r) =>
    `品番${r.ysrid} 商品[${(r.item_name || "").slice(0, 20)}] 広告費¥${Math.round(r.cost)} 売上¥${Math.round(r.sales)} ROAS${Math.round(r.roas)}% CV${r.orders}`
  ).join("\n");
  const kwLines = kws.map((r) => {
    const rk = rankMap[r.search_keyword];
    const rankStr = rk ? `自然順位${rk.own_organic ?? "圏外"}/広告順位${rk.own_ad ?? "-"}` : "順位データなし";
    return `KW[${r.search_keyword}] 品番${r.ysrid} 広告費¥${Math.round(r.cost)} ROAS${Math.round(r.roas)}% CV${r.orders} ${rankStr}`;
  }).join("\n");

  return `あなたはYahoo!ショッピングの広告運用コンサルタントです。tu-hacci（女性向けランジェリー）の${since}〜${until}の広告データと検索順位を分析し、次の打ち手を提案してください。

目標ROASは550%。これを判定ラインとします。「検索順位」は自然検索(オーガニック)順位と広告順位の両方を考慮し、自然順位が高い(数字が小さい)KWは広告費を抑制、自然順位が低い/圏外だが売れるKWは広告強化、という観点を必ず織り込んでください。

【アイテムマッチ 品番別】
${itemLines}

【キーワード広告 KW×品番別（順位付き）】
${kwLines}

以下のJSONのみを返してください。前後に説明やマークダウンは一切不要です。
{
 "overall":"総合評価15文字以内",
 "score":0-100の整数,
 "summary":"全体所見2〜3文",
 "target_roas":"目標ROASに対する所見1〜2文",
 "items":[{"ysrid":"品番","name":"商品名","roas":数値,"action":"強化|維持|抑制","root":"根拠1文(数値込み)"}],
 "keywords":[{"kw":"キーワード","roas":数値,"action":"強化|維持|抑制|追加|削除","root":"順位と数値を踏まえた根拠1文"}]
}
itemsは最大8件、keywordsは最大8件。actionは順位を踏まえて判断すること。`;
}

async function callGemini(apiKey, prompt) {
  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-flash-lite"];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 4096, temperature: 0.4 },
        }),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      const parsed = parseAiJson(text);
      if (parsed) return parsed;
    } catch (e) { /* 次のモデルへ */ }
  }
  return { error: "AI分析の生成に失敗しました（クォータ切れの可能性）。少し待って再分析してください。" };
}

function parseAiJson(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(t); } catch (e) {}
  const s = t.indexOf("{"); const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) {
    let cand = t.slice(s, e + 1);
    try { return JSON.parse(cand); } catch (e2) {}
  }
  const s2 = t.indexOf("{");
  if (s2 >= 0) {
    let cand = t.slice(s2);
    const open = (cand.match(/{/g) || []).length;
    const close = (cand.match(/}/g) || []).length;
    cand += "}".repeat(Math.max(0, open - close));
    try { return JSON.parse(cand); } catch (e3) {}
  }
  return null;
}
