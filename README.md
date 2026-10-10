# باحث منتجات إيباي

## النشر على Render (مجاني)
1. ارفع هذا المجلد كاملاً إلى مستودع GitHub.
2. في render.com اختر New > Blueprint واربطه بالمستودع.
3. ضع EBAY_APP_ID و EBAY_CERT_ID (من developer.ebay.com، Production keyset).
4. افتح الرابط الذي يعطيك إياه Render.

## تشغيل محلي
EBAY_APP_ID=xxx EBAY_CERT_ID=yyy node server.js
ثم افتح http://localhost:3000

## بيانات المبيعات
- إذا اعتمدت إيباي حسابك على Marketplace Insights، تُستخدم تلقائياً.
- وإلا: صدّر المبيعات من Terapeak (Research) كملف CSV لكل كلمة بحث، وارفعه من داخل الموقع.
