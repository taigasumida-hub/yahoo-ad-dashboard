const { BigQuery } = require('@google-cloud/bigquery');

const getClient = () => {
  const keyJson = JSON.parse(process.env.GCP_KEY);
  return new BigQuery({ projectId: 'tu-hacci-ad', credentials: keyJson });
};

const PROJECT = 'tu-hacci-ad';
const DATASET = 'yahoo_ads';

const getPeriodFilter = (period) => {
  switch (period) {
    case 'last':   return DATE_TRUNC(date, MONTH) = DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 1 MONTH), MONTH);
    case 'before': return DATE_TRUNC(date, MONTH) = DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 2 MONTH), MONTH);
    default:       return DATE_TRUNC(date, MONTH) = DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH);
  }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type = 'summary', period = 'now' } = req.query;
  const periodFilter = getPeriodFilter(period);

  try {
    const bq = getClient();
    let query = '';

    switch (type) {
      case 'summary':
        query = SELECT campaign_name, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(clicks) AS clicks, SUM(imps) AS imps, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas, SAFE_DIVIDE(SUM(use_amount),SUM(clicks)) AS cpc FROM \${PROJECT}..item_daily\ WHERE  GROUP BY campaign_name ORDER BY spend DESC;
        break;
      case 'kw_summary':
        query = SELECT campaign_name, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(clicks) AS clicks, SUM(imps) AS imps, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas, SAFE_DIVIDE(SUM(use_amount),SUM(clicks)) AS cpc FROM \${PROJECT}..kw_daily\ WHERE  GROUP BY campaign_name;
        break;
      case 'daily':
        query = SELECT date, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(clicks) AS clicks, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas FROM \${PROJECT}..item_daily\ WHERE  GROUP BY date ORDER BY date ASC;
        break;
      case 'items':
        query = SELECT campaign_name, ysrid, item_name, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(clicks) AS clicks, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas, SAFE_DIVIDE(SUM(use_amount),SUM(clicks)) AS cpc FROM \${PROJECT}..item_daily\ WHERE  AND item_name IS NOT NULL AND item_name != '' GROUP BY campaign_name, ysrid, item_name ORDER BY spend DESC LIMIT 50;
        break;
      case 'kw_groups':
        query = SELECT ad_group_name, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(clicks) AS clicks, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas, SAFE_DIVIDE(SUM(use_amount),SUM(clicks)) AS cpc FROM \${PROJECT}..kw_daily\ WHERE  GROUP BY ad_group_name ORDER BY spend DESC;
        break;
      case 'kw_detail':
        query = SELECT ad_group_name AS grp, search_keyword AS kw, item_name AS item, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(imps) AS imps, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas FROM \${PROJECT}..kw_daily\ WHERE  AND search_keyword IS NOT NULL AND search_keyword != '' GROUP BY grp, kw, item ORDER BY spend DESC LIMIT 100;
        break;
      default:
        return res.status(400).json({ ok: false, error: 'Invalid type' });
    }

    const [rows] = await bq.query({ query, location: 'US' });
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
