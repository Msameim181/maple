<#macro emailLayout>
<!DOCTYPE html>
<html lang="${locale.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${realmName}</title>
</head>
<body style="margin:0;padding:0;background-color:#1a1714;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#1a1714;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#262320;border:1px solid #3a342e;border-radius:12px;">
<tr><td style="padding:24px 28px 16px 28px;font-family:ui-monospace,Menlo,Consolas,monospace;">
<#if properties.logoUrl?has_content>
<img src="${properties.logoUrl}" alt="Maple" width="32" height="32" style="display:inline-block;vertical-align:middle;border:0;outline:none;">
</#if>
<span style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:16px;font-weight:600;color:#e8dfd3;">${realmName}</span>
</td></tr>
<tr><td style="padding:0 28px;"><div style="height:1px;line-height:1px;background-color:#e8872a;">&nbsp;</div></td></tr>
<tr><td style="padding:24px 28px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.6;color:#e8dfd3;">
<#nested>
</td></tr>
<tr><td style="padding:16px 28px 24px 28px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;color:#9b8f80;border-top:1px solid #3a342e;">
${realmName} &middot; Sent by Maple. If you did not expect this email, you can ignore it.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
</#macro>
