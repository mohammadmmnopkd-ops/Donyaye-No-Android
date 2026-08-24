# دنیای نو — نسخه Production

## Render
Build: `npm install`
Start: `node server/server.js`
Port: `10000`
Health check: `/api/ai-team/status`

Environment Variables:
- `OPENAI_API_KEY` = کلید واقعی OpenAI
- `AI_GROUP_PASSWORD` = `Iran_2626`
- `ADMIN_PANEL_PASSWORD` = `Iran_2626`

رمزها را در Render وارد کنید؛ مقدارهای واقعی کلید API را داخل کد، ZIP یا APK قرار ندهید.

## Android
اپ به آدرس HTTPS سرور بازی متصل می‌شود:
`https://donyaye-no-online.onrender.com`

این APK باید فقط کلاینت باشد؛ منطق AI و کلید API سمت سرور می‌ماند.
