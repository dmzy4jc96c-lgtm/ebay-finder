// eBay Finder - يتطلب Node 18 أو أحدث (بدون أي مكتبات خارجية)
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_ID = process.env.EBAY_APP_ID;
const CERT_ID = process.env.EBAY_CERT_ID;
const MARKET = process.env.EBAY_MARKETPLACE || 'EBAY_US';
const PORT = process.env.PORT || 3000;

const BASE_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const INSIGHTS_SCOPE = 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights';
const tokenCache = {};

async function getToken(scope) {
  const c = tokenCache[scope];
  if (c && c.exp > Date.now() + 60000) return c.token;
  if (!APP_ID || !CERT_ID) throw new Error('EBAY_APP_ID / EBAY_CERT_ID غير مضبوطة');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(APP_ID + ':' + CERT_ID).toString('base64'),
    },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent(scope),
  });
  if (!r.ok) throw new Error('OAuth ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  tokenCache[scope] = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

const hdr = (t) => ({ Authorization: 'Bearer ' + t, 'X-EBAY-C-MARKETPLACE-ID': MARKET });

async function browse(q) {
  const t = await getToken(BASE_SCOPE);
  const url =
    'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + encodeURIComponent(q) +
    '&limit=100&filter=' + encodeURIComponent('buyingOptions:{FIXED_PRICE}');
  const r = await fetch(url, { headers: hdr(t) });
  if (!r.ok) throw new Error('Browse ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

// بيانات المبيعات الفعلية: متاحة فقط للحسابات المعتمدة من إيباي (Marketplace Insights)
async function insights(q) {
  try {
    const t = await getToken(INSIGHTS_SCOPE);
    const r = await fetch(
      'https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search?q=' + encodeURIComponent(q) + '&limit=100',
      { headers: hdr(t) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const list = j.itemSales || [];
    const soldQty = list.reduce((s, i) => s + (Number(i.totalSoldQuantity) || 1), 0);
    return { soldQty: Math.max(soldQty, j.total || 0) };
  } catch {
    return null;
  }
}

const quantile = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);

const VERO = /\b(replica|fake|copy|nike|adidas|gucci|louis vuitton|rolex|apple|iphone|airpods|disney|pokemon|lego|nintendo|supreme|chanel|prada|jordan)\b/i;
const RESTRICTED = /\b(supplement|vitamin|cbd|vape|weapon|knife|gun|ammo|prescription|drug)\b/i;

function analyze(q, b, ins) {
  const items = b.itemSummaries || [];
  const total = b.total || items.length;
  const prices = items.map((i) => Number(i.price && i.price.value)).filter(Boolean).sort((x, y) => x - y);
  const med = quantile(prices, 0.5);
  const sellerCount = {};
  let big = 0;
  items.forEach((i) => {
    const u = (i.seller && i.seller.username) || '?';
    sellerCount[u] = (sellerCount[u] || 0) + 1;
    if (i.seller && Number(i.seller.feedbackScore) > 20000) big++;
  });
  const n = Math.max(items.length, 1);
  const top3 = Object.values(sellerCount).sort((x, y) => y - x).slice(0, 3).reduce((s, v) => s + v, 0) / n;
  const bigShare = big / n;

  const good = [], bad = [];
  let sPrice = med < 8 ? 10 : med < 15 ? 40 : med <= 200 ? 90 : 60;
  (sPrice >= 80 ? good : bad).push(
    sPrice >= 80 ? `سعر وسطي مناسب (~$${med.toFixed(0)}) يترك هامش ربح` :
    med < 15 ? `سعر وسطي منخفض (~$${med.toFixed(0)}) والرسوم والشحن بتاكل الربح` : `سعر مرتفع (~$${med.toFixed(0)}) = رأس مال أكبر ومخاطرة أعلى`
  );

  let sComp = total < 300 ? 90 : total < 2000 ? 75 : total < 10000 ? 50 : total < 50000 ? 30 : 15;
  if (total < 30 && !ins) sComp = 40;
  (sComp >= 70 ? good : bad).push(
    total < 30 && !ins ? `عدد الإعلانات قليل جداً (${total}) وقد يعني ضعف الطلب` :
    sComp >= 70 ? `منافسة معقولة (${total.toLocaleString()} إعلان)` : `منافسة عالية (${total.toLocaleString()} إعلان)`
  );

  let sConc = top3 > 0.5 ? 20 : top3 > 0.3 ? 50 : 85;
  (sConc >= 70 ? good : bad).push(sConc >= 70 ? 'السوق موزع على بائعين كثر' : `${Math.round(top3 * 100)}% من الإعلانات عند 3 بائعين فقط`);

  let sBig = bigShare > 0.6 ? 25 : bigShare > 0.35 ? 55 : 85;
  (sBig >= 70 ? good : bad).push(sBig >= 70 ? 'مكان للبائعين الصغار' : `${Math.round(bigShare * 100)}% من الإعلانات لبائعين كبار (يصعب منافستهم بالسعر)`);

  let score, estimated = !ins, sellThrough = null;
  if (ins) {
    sellThrough = ins.soldQty / (ins.soldQty + total);
    const sDem = ins.soldQty < 10 ? 20 : sellThrough > 0.3 ? 95 : sellThrough > 0.15 ? 80 : sellThrough > 0.07 ? 60 : 30;
    (sDem >= 70 ? good : bad).push(`نسبة البيع ${Math.round(sellThrough * 100)}% (${ins.soldQty} قطعة مباعة مؤخراً)`);
    score = sDem * 0.35 + sComp * 0.2 + sPrice * 0.2 + sConc * 0.1 + sBig * 0.15;
  } else {
    score = Math.min(80, sComp * 0.35 + sPrice * 0.3 + sConc * 0.15 + sBig * 0.2);
  }

  const flags = [];
  if (VERO.test(q)) { score -= 12; flags.push('احتمال مخالفة حقوق علامة تجارية (VeRO). بع فقط الأصلي وبفاتورة'); }
  if (RESTRICTED.test(q)) { score = Math.min(score, 30); flags.push('فئة مقيّدة أو حساسة في إيباي، احتمال حذف الإعلان أو إيقاف الحساب'); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 70 ? 'suitable' : score >= 45 ? 'medium' : 'high_risk';
  return { q, score, verdict, estimated, total, medianPrice: med, sellThrough, good, bad, flags };
}

async function analyzeKeyword(q, soldMap) {
  const mine = soldMap && soldMap[q.toLowerCase()];
  const [b, ins] = await Promise.all([browse(q), mine ? null : insights(q)]);
  const r = analyze(q, b, mine ? { soldQty: Number(mine.soldQty) || 0 } : ins);
  r.soldSource = mine ? 'file' : ins ? 'ebay' : 'none';
  return r;
}

async function discover(seeds, soldMap) {
  const out = [], queue = seeds.slice(0, 25);
  async function worker() {
    while (queue.length) {
      const q = queue.shift();
      try { out.push(await analyzeKeyword(q, soldMap)); }
      catch (e) { out.push({ q, error: e.message }); }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return out.sort((a, b) => (b.score || -1) - (a.score || -1));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (u.pathname === '/api/discover') {
      const seeds = (u.searchParams.get('seeds') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!seeds.length) return json(400, { error: 'أدخل كلمة بحث واحدة على الأقل' });
      let soldMap = {};
      try { soldMap = JSON.parse(u.searchParams.get('sold') || '{}'); } catch {}
      return json(200, { results: await discover(seeds, soldMap) });
    }
    if (u.pathname === '/health') return json(200, { ok: true, keys: !!(APP_ID && CERT_ID) });
    const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    const p = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!p.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(p)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    json(500, { error: e.message });
  }
});
server.listen(PORT, () => console.log('eBay Finder يعمل على المنفذ ' + PORT));
