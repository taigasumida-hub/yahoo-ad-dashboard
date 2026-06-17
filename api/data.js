const { BigQuery } = require('@google-cloud/bigquery');

const getClient = () => {
  const keyJson = JSON.parse(process.env.GCP_KEY);
  return new BigQuery({ projectId: 'tu-hacci-ad', credentials: keyJson });
};

const PROJECT = 'tu-hacci-ad';
const DATASET = 'yahoo_ads';

const getPeriodFilter = (period) => {
  switch (period) {
    case 'last':   return `DATE_TRUNC(date, MONTH) = DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 1 MONTH), MONTH)`;
    case 'before': return `DATE_TRUNC(date, MONTH) = DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 2 MONTH), MONTH)`;
    default:       return `DATE_TRUNC(date, MONTH) = DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH)`;
  }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type = 'summary', period = 'now' } = req.query;
  const pf = getPeriodFilter(period);

  try {
    const bq = getClient();
    let query = '';

    if (type === 'ai_analysis_disabled') {
      const aiQuery = `
        SELECT
          DATE_TRUNC(date, MONTH) AS month,
          campaign_name,
          SUM(use_amount) AS spend,
          SUM(gmv) AS sales,
          SUM(order_count) AS cv,
          SUM(clicks) AS clicks,
          SUM(imps) AS imps,
          SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 AS roas
        FROM \`${PROJECT}.${DATASET}.item_daily\`
        WHERE date >= DATE_SUB(DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH), INTERVAL 2 MONTH)
        GROUP BY month, campaign_name
        ORDER BY month DESC, spend DESC
      `;
      const kwQuery = `
        SELECT
          DATE_TRUNC(date, MONTH) AS month,
          ad_group_name,
          SUM(use_amount) AS spend,
          SUM(gmv) AS sales,
          SUM(order_count) AS cv,
          SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 AS roas
        FROM \`${PROJECT}.${DATASET}.kw_daily\`
        WHERE date >= DATE_SUB(DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH), INTERVAL 2 MONTH)
        GROUP BY month, ad_group_name
        ORDER BY month DESC, spend DESC
      `;

      const [[itemRows], [kwRows]] = await Promise.all([
        bq.query({ query: aiQuery, location: 'asia-northeast1' }),
        bq.query({ query: kwQuery, location: 'asia-northeast1' }),
      ]);

      const fmtRows = rows => rows.map(r => ({
        ...r,
        month: r.month?.value || r.month,
        spend: Math.round(r.spend || 0),
        sales: Math.round(r.sales || 0),
        cv: Math.round(r.cv || 0),
        clicks: Math.round(r.clicks || 0),
        imps: Math.round(r.imps || 0),
        roas: Math.round(r.roas || 0),
      }));

      const geminiKey = process.env.GEMINI_API_KEY;
      const prompt = `
あなたはEC広告の専門アナリストです。tu-hacci（女性向けランジェリーブランド）のYahoo!広告データを分析してください。

【過去3ヶ月のアイテムマッチデータ】
${JSON.stringify(fmtRows(itemRows), null, 2)}

【過去3ヶ月のキーワード広告データ（グループ別）】
${JSON.stringify(fmtRows(kwRows), null, 2)}

以下の観点で日本語で分析してください（合計400〜500文字程度）：
1. 今月の評価（良い点・悪い点を前月比で具体的に）
2. 特に注目すべきキャンペーン・グループ（良い/悪い理由）
3. 原因の仮説（なぜそうなっているか）
4. 具体的なアクション提案（2〜3個、優先度順）

回答はJSON形式で返してください：
{
  "overall": "総合評価の一言（15文字以内）",
  "score": 数値（0〜100、前月比での評価）,
  "points": [
    {"type": "good"|"bad"|"action", "text": "内容"}
  ]
}
JSONのみ返してください。マークダウンのコードブロックは不要です。
      `;

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
          }),
        }
      );
      const geminiJson = await geminiRes.json();
      if (geminiJson.error) throw new Error('Gemini API: ' + geminiJson.error.message);
      const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || '{"overall":"データ不足","score":50,"points":[]}';
      let analysis;
      try {
        analysis = JSON.parse(rawText.replace(/```json|```/g, '').trim());
      } catch(parseErr) {
        analysis = { overall: 'Gemini応答エラー', score: 50, points: [{ type: 'bad', text: rawText.slice(0,300) }] };
      }
      return res.status(200).json({ ok: true, data: analysis });
    }

    switch (type) {
      case 'summary':
        query = `SELECT campaign_name, campaign_id, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(clicks) AS clicks, SUM(imps) AS imps, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas, SAFE_DIVIDE(SUM(use_amount),SUM(clicks)) AS cpc FROM \`${PROJECT}.${DATASET}.item_daily\` WHERE ${pf} GROUP BY campaign_name, campaign_id ORDER BY spend DESC`;
        break;
      case 'kw_summary':
        query = `SELECT campaign_name, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(clicks) AS clicks, SUM(imps) AS imps, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas, SAFE_DIVIDE(SUM(use_amount),SUM(clicks)) AS cpc FROM \`${PROJECT}.${DATASET}.kw_daily\` WHERE ${pf} GROUP BY campaign_name`;
        break;
      case 'daily':
        query = `SELECT date, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(clicks) AS clicks, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas FROM \`${PROJECT}.${DATASET}.item_daily\` WHERE ${pf} GROUP BY date ORDER BY date ASC`;
        break;
      case 'items':
        query = `SELECT campaign_name, ysrid, item_name, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(clicks) AS clicks, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas, SAFE_DIVIDE(SUM(use_amount),SUM(clicks)) AS cpc FROM \`${PROJECT}.${DATASET}.item_daily\` WHERE ${pf} AND item_name IS NOT NULL AND item_name != '' GROUP BY campaign_name, ysrid, item_name ORDER BY spend DESC LIMIT 50`;
        break;
      case 'kw_groups':
        query = `SELECT ad_group_name, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(clicks) AS clicks, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas, SAFE_DIVIDE(SUM(use_amount),SUM(clicks)) AS cpc FROM \`${PROJECT}.${DATASET}.kw_daily\` WHERE ${pf} GROUP BY ad_group_name ORDER BY spend DESC`;
        break;
      case 'kw_detail':
        query = `SELECT ad_group_name AS grp, search_keyword AS kw, ysrid, item_name AS item, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(imps) AS imps, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas FROM \`${PROJECT}.${DATASET}.kw_daily\` WHERE ${pf} AND search_keyword IS NOT NULL AND search_keyword != '' GROUP BY grp, kw, ysrid, item ORDER BY spend DESC LIMIT 100`;
        break;
      case 'items_sku':
        query = `SELECT ysrid, ANY_VALUE(item_name) AS item_name, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv FROM \`${PROJECT}.${DATASET}.item_daily\` WHERE ${pf} AND ysrid IS NOT NULL AND ysrid != '' GROUP BY ysrid ORDER BY spend DESC LIMIT 20`;
        break;
      case 'kw_sku':
        query = `SELECT ysrid, ANY_VALUE(item_name) AS item_name, SUM(use_amount) AS spend, SUM(gmv) AS sales FROM \`${PROJECT}.${DATASET}.kw_daily\` WHERE ${pf} AND ysrid IS NOT NULL AND ysrid != '' GROUP BY ysrid ORDER BY spend DESC LIMIT 20`;
        break;
      case 'kw_keywords':
        query = `SELECT search_keyword AS kw, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv FROM \`${PROJECT}.${DATASET}.kw_daily\` WHERE ${pf} AND search_keyword IS NOT NULL AND search_keyword != '' GROUP BY kw ORDER BY spend DESC LIMIT 20`;
        break;
      default:
        return res.status(400).json({ ok: false, error: 'Invalid type' });
    }

    const [rows] = await bq.query({ query, location: 'asia-northeast1' });
    const data = rows.map(row => {
      const r = { ...row };
      if (r.date && r.date.value) r.date = r.date.value;
      ['spend','sales','roas','cpc'].forEach(k => { if (r[k] != null) r[k] = Math.round(r[k]*100)/100; });
      return r;
    });
    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
};