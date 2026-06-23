import { BigQuery } from "@google-cloud/bigquery";

const bigquery = new BigQuery({
  projectId: "tu-hacci-ad",
  credentials: JSON.parse(process.env.GCP_KEY),
});

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, since, until } = req.query;

  try {
    let query = "";

    if (type === "summary") {
      // サマリー：キャンペーン別集計
      query = `
        SELECT
          campaign_name,
          SUM(imps) as imps,
          SUM(clicks) as clicks,
          SUM(use_amount) as cost,
          SUM(order_count) as orders,
          SUM(gmv) as sales,
          SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas,
          SAFE_DIVIDE(SUM(clicks), SUM(imps)) * 100 as ctr,
          SAFE_DIVIDE(SUM(order_count), SUM(clicks)) * 100 as cvr,
          SAFE_DIVIDE(SUM(use_amount), SUM(clicks)) as cpc
        FROM \`tu-hacci-ad.yahoo_ads.item_daily\`
        WHERE date BETWEEN '${since}' AND '${until}'
        GROUP BY campaign_name
        ORDER BY cost DESC
      `;
    } else if (type === "daily") {
      // 日別推移
      query = `
        SELECT
          date,
          SUM(imps) as imps,
          SUM(clicks) as clicks,
          SUM(use_amount) as cost,
          SUM(order_count) as orders,
          SUM(gmv) as sales,
          SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas
        FROM \`tu-hacci-ad.yahoo_ads.item_daily\`
        WHERE date BETWEEN '${since}' AND '${until}'
        GROUP BY date
        ORDER BY date ASC
      `;
    } else if (type === "items") {
      // 商品別ランキング
      query = `
        SELECT
          ysrid,
          item_name,
          campaign_name,
          SUM(imps) as imps,
          SUM(clicks) as clicks,
          SUM(use_amount) as cost,
          SUM(order_count) as orders,
          SUM(gmv) as sales,
          SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas,
          SAFE_DIVIDE(SUM(order_count), SUM(clicks)) * 100 as cvr
        FROM \`tu-hacci-ad.yahoo_ads.item_daily\`
        WHERE date BETWEEN '${since}' AND '${until}'
          AND use_amount > 0
        GROUP BY ysrid, item_name, campaign_name
        ORDER BY cost DESC
        LIMIT 50
      `;
    } else if (type === "keywords") {
      // KWグループ別集計
      query = `
        SELECT
          ad_group_name,
          SUM(imps) as imps,
          SUM(clicks) as clicks,
          SUM(use_amount) as cost,
          SUM(order_count) as orders,
          SUM(gmv) as sales,
          SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas,
          SAFE_DIVIDE(SUM(order_count), SUM(clicks)) * 100 as cvr
        FROM \`tu-hacci-ad.yahoo_ads.kw_daily\`
        WHERE date BETWEEN '${since}' AND '${until}'
          AND use_amount > 0
        GROUP BY ad_group_name
        ORDER BY cost DESC
      `;
    } else if (type === "kw_daily") {
      // KW日別推移
      query = `
        SELECT
          date,
          SUM(imps) as imps,
          SUM(clicks) as clicks,
          SUM(use_amount) as cost,
          SUM(order_count) as orders,
          SUM(gmv) as sales,
          SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas
        FROM \`tu-hacci-ad.yahoo_ads.kw_daily\`
        WHERE date BETWEEN '${since}' AND '${until}'
        GROUP BY date
        ORDER BY date ASC
      `;
    } else if (type === "kw_detail") {
      // KW×品番別明細（上位100件）
      query = `
        SELECT
          search_keyword,
          ad_group_name,
          ysrid,
          item_name,
          SUM(imps) as imps,
          SUM(clicks) as clicks,
          SUM(use_amount) as cost,
          SUM(order_count) as orders,
          SUM(gmv) as sales,
          SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas,
          SAFE_DIVIDE(SUM(order_count), SUM(clicks)) * 100 as cvr,
          SAFE_DIVIDE(SUM(use_amount), SUM(clicks)) as cpc
        FROM \`tu-hacci-ad.yahoo_ads.kw_daily\`
        WHERE date BETWEEN '${since}' AND '${until}'
          AND use_amount > 0
        GROUP BY search_keyword, ad_group_name, ysrid, item_name
        ORDER BY cost DESC
        LIMIT 100
      `;
    } else if (type === "kw_keywords") {
      // 検索KW別累計（上位50件）
      query = `
        SELECT
          search_keyword,
          ad_group_name,
          SUM(imps) as imps,
          SUM(clicks) as clicks,
          SUM(use_amount) as cost,
          SUM(order_count) as orders,
          SUM(gmv) as sales,
          SAFE_DIVIDE(SUM(gmv), SUM(use_amount)) * 100 as roas,
          SAFE_DIVIDE(SUM(order_count), SUM(clicks)) * 100 as cvr,
          SAFE_DIVIDE(SUM(use_amount), SUM(clicks)) as cpc
        FROM \`tu-hacci-ad.yahoo_ads.kw_daily\`
        WHERE date BETWEEN '${since}' AND '${until}'
          AND use_amount > 0
        GROUP BY search_keyword, ad_group_name
        ORDER BY cost DESC
        LIMIT 50
      `;
    } else {
      return res.status(400).json({ error: "Invalid type" });
    }

    const [rows] = await bigquery.query(query);
    const serialized = rows.map((row) => {
      const r = {};
      for (const [k, v] of Object.entries(row)) {
        r[k] = v && typeof v === "object" && v.value !== undefined ? v.value : v;
      }
      return r;
    });
    res.status(200).json(serialized);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
