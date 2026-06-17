const { BigQuery } = require('@google-cloud/bigquery');

const getClient = () => {
  const keyJson = JSON.parse(process.env.GCP_KEY);
  return new BigQuery({ projectId: 'tu-hacci-ad', credentials: keyJson });
};

const PROJECT = 'tu-hacci-ad';
const DATASET = 'yahoo_ads';

const getPeriodFilter = (period) => {
  if (typeof period === 'string' && /^\d{4}-\d{2}$/.test(period)) {
    return `DATE_TRUNC(date, MONTH) = DATE('${period}-01')`;
  }
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

    if (type === 'months') {
      const q = `SELECT FORMAT_DATE('%Y-%m', DATE_TRUNC(date, MONTH)) AS m FROM \`${PROJECT}.${DATASET}.item_daily\` GROUP BY m ORDER BY m DESC`;
      const [rows] = await bq.query({ query: q, location: 'asia-northeast1' });
      return res.status(200).json({ ok: true, data: rows.map(r => r.m).filter(Boolean) });
    }

    if (type === 'ai_analysis') {
      const compare = req.query.compare;
      const tgtPf = getPeriodFilter(period);
      const cmpPf = (compare && compare !== 'none') ? getPeriodFilter(compare) : null;

      const itemSQL = (pf) => `SELECT ysrid, ANY_VALUE(item_name) AS name, ANY_VALUE(campaign_name) AS camp, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas FROM \`${PROJECT}.${DATASET}.item_daily\` WHERE ${pf} AND ysrid IS NOT NULL AND ysrid != '' GROUP BY ysrid ORDER BY spend DESC LIMIT 30`;
      const kwSQL = (pf) => `SELECT ad_group_name AS grp, search_keyword AS kw, ANY_VALUE(ysrid) AS ysrid, ANY_VALUE(item_name) AS item, SUM(use_amount) AS spend, SUM(gmv) AS sales, SUM(order_count) AS cv, SUM(imps) AS imps, SAFE_DIVIDE(SUM(gmv),SUM(use_amount))*100 AS roas FROM \`${PROJECT}.${DATASET}.kw_daily\` WHERE ${pf} AND search_keyword IS NOT NULL AND search_keyword != '' GROUP BY grp, kw ORDER BY spend DESC LIMIT 50`;

      const qs = [
        bq.query({ query: itemSQL(tgtPf), location: 'asia-northeast1' }),
        bq.query({ query: kwSQL(tgtPf), location: 'asia-northeast1' }),
      ];
      if (cmpPf) {
        qs.push(bq.query({ query: itemSQL(cmpPf), location: 'asia-northeast1' }));
        qs.push(bq.query({ query: kwSQL(cmpPf), location: 'asia-northeast1' }));
      }
      const results = await Promise.all(qs);
      const itemT = results[0][0], kwT = results[1][0];
      const itemC = cmpPf ? results[2][0] : [];
      const kwC = cmpPf ? results[3][0] : [];

      const num = (x) => Math.round(x || 0);
      const itemPrev = {}; itemC.forEach(r => { itemPrev[r.ysrid] = { spend: num(r.spend), sales: num(r.sales), roas: num(r.roas), cv: num(r.cv) }; });
      const kKey = (r) => `${r.grp}|${r.kw}`;
      const kwPrev = {}; kwC.forEach(r => { kwPrev[kKey(r)] = { spend: num(r.spend), sales: num(r.sales), roas: num(r.roas), cv: num(r.cv) }; });

      const items = itemT.map(r => ({ ysrid: r.ysrid, name: String(r.name || '').slice(0, 36), spend: num(r.spend), sales: num(r.sales), cv: num(r.cv), roas: num(r.roas), prev: itemPrev[r.ysrid] || null }));
      const keywords = kwT.map(r => ({ grp: r.grp, kw: r.kw, ysrid: r.ysrid, spend: num(r.spend), sales: num(r.sales), cv: num(r.cv), imps: num(r.imps), roas: num(r.roas), prev: kwPrev[kKey(r)] || null }));
      const kwYsrids = new Set(keywords.map(k => k.ysrid).filter(Boolean));
      const itemsNoKw = items.filter(i => i.ysrid && !kwYsrids.has(i.ysrid)).map(i => ({ ysrid: i.ysrid, name: i.name, roas: i.roas, cv: i.cv }));

      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) throw new Error('GEMINI_API_KEY \u304c\u672a\u8a2d\u5b9a\u3067\u3059');

      const prompt = `\u3042\u306a\u305f\u306fEC\u5e83\u544a\u306e\u5c02\u9580\u30a2\u30ca\u30ea\u30b9\u30c8\u3067\u3059\u3002tu-hacci\uff08\u5973\u6027\u5411\u3051\u30e9\u30f3\u30b8\u30a7\u30ea\u30fc\uff09\u306eYahoo!\u30b7\u30e7\u30c3\u30d4\u30f3\u30b0\u5e83\u544a\u3092\u5206\u6790\u3057\u3001\u904b\u7528\u62c5\u5f53\u8005\u304c\u5373\u5b9f\u884c\u3067\u304d\u308b\u5177\u4f53\u7684\u306a\u6307\u793a\u3092\u51fa\u3057\u3066\u304f\u3060\u3055\u3044\u3002

# \u524d\u63d0\u30fb\u5224\u5b9a\u57fa\u6e96
- \u76ee\u6a19ROAS\u306f\u5168\u30ad\u30e3\u30f3\u30da\u30fc\u30f3\u5171\u901a\u3067500\u301c600%\u3092\u57fa\u6e96\u3068\u3059\u308b\uff08\u4e0a\u56de\u308c\u3070\u52b9\u7387\u826f\u3057\u2192\u4e88\u7b97\u3092\u5bc4\u305b\u308b\u3001\u4e0b\u56de\u308c\u3070\u8981\u6539\u5584\uff09\u3002
- ROAS\u3060\u3051\u3067\u306a\u304fCV\u6570\u30fb\u5e83\u544a\u8cbb\u306e\u898f\u6a21\u30fb\u524d\u6708\u6bd4\u30c8\u30ec\u30f3\u30c9\u3082\u4f75\u305b\u3066\u5224\u65ad\u3002prev\u306f\u6bd4\u8f03\u6708\u306e\u5024\uff08null\u306a\u3089\u6bd4\u8f03\u30c7\u30fc\u30bf\u7121\u3057\uff09\u3002
- \u30a2\u30a4\u30c6\u30e0\u30de\u30c3\u30c1\u306b\u306f\u9664\u5916\u30ad\u30fc\u30ef\u30fc\u30c9\u6a5f\u80fd\u304c\u7121\u3044\u3002\u30ad\u30fc\u30ef\u30fc\u30c9\u5e83\u544a\u306f\u5165\u672d\u30fb\u8ffd\u52a0\u30fb\u9664\u5916\u304c\u53ef\u80fd\u3002

# \u5bfe\u8c61\u6708\u306e\u54c1\u756a\u5225\u30a2\u30a4\u30c6\u30e0\u30de\u30c3\u30c1
${JSON.stringify(items)}

# \u5bfe\u8c61\u6708\u306e\u30ad\u30fc\u30ef\u30fc\u30c9\u5e83\u544a\uff08\u30b0\u30eb\u30fc\u30d7\u00d7KW\u5225\u3001ysrid\u306f\u7d10\u3065\u304f\u54c1\u756a\uff09
${JSON.stringify(keywords)}

# \u30a2\u30a4\u30c6\u30e0\u30de\u30c3\u30c1\u3067\u51fa\u7a3f\u4e2d\u3060\u304cKW\u5e83\u544a\u306b\u672a\u51fa\u7a3f\u306e\u54c1\u756a\uff08\uff1dKW\u5207\u308a\u51fa\u3057\u5019\u88dc\u306e\u6bcd\u96c6\u56e3\uff09
${JSON.stringify(itemsNoKw)}

# \u51fa\u529b\u6307\u793a
- items: \u30a2\u30af\u30b7\u30e7\u30f3\u304c\u5fc5\u8981\u306a\u54c1\u756a\u3092\u512a\u5148\u5ea6\u9806\u306b\u6700\u592712\u4ef6\u3002\u5404\u3005 action(\u5f37\u5316/\u7dad\u6301/\u6291\u5236) \u3068 root(\u6839\u62e0\u3092\u6570\u5024\u8fbc\u307f\u30671\u6587)\u3002
- keywords: \u6ce8\u76ee\u3059\u3079\u304dKW\u3092\u6700\u592715\u4ef6\u3002action \u306f \u5f37\u5316/\u7dad\u6301/\u6291\u5236/\u8ffd\u52a0/\u524a\u9664\u3002\u300c\u8ffd\u52a0\u300d\u306f\u4e0a\u8a18\u300cKW\u5207\u308a\u51fa\u3057\u5019\u88dc\u300d\u3084\u65e2\u5b58\u597d\u8abfKW\u306e\u6a2a\u5c55\u958b\u304b\u3089\u3001\u300c\u54c1\u756a\u25cb\u25cb\u3092\u300e\u25cb\u25cb\u300f\u3068\u3044\u3046KW\u3067\u5207\u308a\u51fa\u3059\u300dor\u300c\u300e\u25cb\u25cb\u300f\u3092\u25b3\u25b3\u30b0\u30eb\u30fc\u30d7\u306b\u8ffd\u52a0\u300d\u306e\u5f62\u3067\u5177\u4f53\u7684\u306b\u3002\u5404\u3005 root(\u6839\u62e0\uff11\u6587)\u3002
- target_roas: \u30c7\u30fc\u30bf\u3092\u8e0f\u307e\u3048\u305f\u76ee\u6a19ROAS\u306e\u63d0\u6848\uff08\u30ad\u30e3\u30f3\u30da\u30fc\u30f3\u3054\u3068\u306b\u5dee\u3092\u3064\u3051\u308b\u3079\u304d\u306a\u3089\u8a00\u53ca\u3002\u57fa\u6e96\u306f500\u301c600\uff09\u30021\u301c2\u6587\u3002
- summary: \u5168\u4f53\u6240\u898b2\u301c3\u6587\u3002overall: 15\u6587\u5b57\u4ee5\u5185\u306e\u7dcf\u5408\u8a55\u4fa1\u3002score: 0\u301c100\u3002

\u56de\u7b54\u306fJSON\u306e\u307f\uff08\u30de\u30fc\u30af\u30c0\u30a6\u30f3\u4e0d\u8981\uff09:
{"overall":"","score":0,"summary":"","target_roas":"","items":[{"ysrid":"","name":"","roas":0,"action":"","root":""}],"keywords":[{"kw":"","group":"","roas":0,"action":"","root":""}]}`;

      const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-flash-lite'];
      let rawText = '';
      let lastErr = '';
      for (const model of models) {
        try {
          const gRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
              }),
            }
          );
          const gJson = await gRes.json();
          if (gJson.error) { lastErr = gJson.error.message; continue; }
          const t = gJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (t) { rawText = t; break; }
          lastErr = '\u7a7a\u306e\u5fdc\u7b54';
        } catch (e) { lastErr = e.message; }
      }
      if (!rawText) throw new Error('Gemini API: ' + (lastErr || '\u5168\u30e2\u30c7\u30eb\u3067\u5931\u6557'));

      const looseJSON = (raw) => {
        const tryP = (s) => { try { return JSON.parse(s); } catch { return null; } };
        let s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
        let v = tryP(s); if (v) return v;
        const start = s.indexOf('{');
        if (start < 0) return null;
        s = s.slice(start).replace(/[\u0000-\u001F]+/g, ' ');
        v = tryP(s); if (v) return v;
        const lb = s.lastIndexOf('}');
        if (lb > 0) { v = tryP(s.slice(0, lb + 1)); if (v) return v; }
        const stack = []; let inStr = false, esc = false;
        for (let k = 0; k < s.length; k++) {
          const ch = s[k];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
          else if (ch === '}' || ch === ']') stack.pop();
        }
        let t = s;
        if (inStr) t += '"';
        t = t.replace(/,\s*$/, '');
        while (stack.length) t += stack.pop();
        t = t.replace(/,\s*([}\]])/g, '$1');
        return tryP(t);
      };
      let analysis = looseJSON(rawText);
      if (!analysis || typeof analysis !== 'object') {
        analysis = { overall: '\u5fdc\u7b54\u89e3\u6790\u30a8\u30e9\u30fc', score: 50, summary: String(rawText).slice(0, 300), target_roas: '', items: [], keywords: [] };
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